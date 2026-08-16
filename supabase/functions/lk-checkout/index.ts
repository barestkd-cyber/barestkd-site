// ===========================================================================
// Supabase Edge Function: lk-checkout - public Little Kickers enrollment
// ---------------------------------------------------------------------------
// The self-serve counterpart of the POS membership sale, for the one program
// that fits a one-time checkout: a 6-week session paid in full, no recurring
// billing, the simplest agreement.
//
// GET  → the page's config: live price/t-shirt/fee/tax numbers straight from
//        pricing_plans/products/pricing_settings, plus the current session's
//        dates (SESSION below - the one thing edited per cohort).
// POST → creates student contact + guardian + membership (frozen snapshot) +
//        SIGNED agreement + ledger sale + lines + roster enrollment, then
//        returns the existing invoice pay URL. Payment itself runs through
//        the SAME create-checkout/webhook/receipt rail every invoice uses -
//        this function never touches Stripe.
//
// HARD RULES (mirrors pos-sale):
//   * Every price is re-derived HERE from the catalog via the vendored
//     pricing engine. The client sends choices, never amounts.
//   * The agreement text is frozen server-side from the vendored template -
//     what the page displayed is NOT trusted as what was signed.
//   * sale_id is client-minted and is the idempotency key: a resubmit
//     returns the same invoice URL instead of enrolling twice.
//
// Deploy, from the barestkd-site repo root (public - the page calls it):
//   supabase functions deploy lk-checkout --no-verify-jwt
// After attorney revisions or engine changes: node tools/vendor-lk.js first.
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";
import LK_TEMPLATE from "../_shared/lk_agreement.js";

// ── THE COHORT AND THE GATE both live in `program_sessions` ────────────────
// Nothing about the session is hardcoded here any more. One row in
// program_sessions carries the start date, how many weeks, the class time and
// the status; the class dates and the calendar entries are derived from it.
//
// The session's status ('draft' vs 'open') tells the WEBSITE BUTTONS whether
// to advertise enrollment yet. The checkout page itself always works: it is
// unlinked and noindex, and Race needs it live to test. Owner's call,
// 2026-08-16: gate the button, not the page.
const PROGRAM = "Little Kickers";

type Session = {
  id: string;
  start: string;
  end: string;
  weeks: number;
  label: string;
  blurb: string;
  status: string;
  opensText: string;
};

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Add days to a yyyy-mm-dd without new Date(str): that parses as UTC and
 *  reads a day early in Central, which would shift every class date. */
function addDays(ymd: string, days: number): string {
  const p = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function prettyDate(ymd: string): string {
  const p = ymd.split("-").map(Number);
  return MONTHS[p[1] - 1] + " " + p[2];
}
function weekdayOf(ymd: string): string {
  const p = ymd.split("-").map(Number);
  return DAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
}

const PLAN_CODE = "little_kickers_session";
const TSHIRT_NAME = "Little Kickers T-Shirt";
const TAX_RATE = 0.0825;          // matches the POS (posBlank taxRate)
const SITE = "https://www.barestkd.fit";

const ALLOWED_ORIGINS = [
  "https://www.barestkd.fit",
  "https://barestkd.fit",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];
function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(obj: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const str = (v: unknown) => (v == null ? "" : String(v)).trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const money = (c: number) => "$" + (c / 100).toFixed(2);
const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const fmtMDY = (ymd: string) => { const p = ymd.split("-"); return p.length === 3 ? `${p[1]}-${p[2]}-${p[0]}` : ymd; };

/* The card admin fee, exactly as the POS suggests it: basis points on the
 * pre-fee pre-tax base, plus the flat part. Never taxed. */
function adminFeeCents(baseCents: number, bps: number, flat: number): number {
  if (baseCents <= 0) return 0;
  return Math.round(baseCents * bps / 10000) + flat;
}

/* Freeze the agreement into plain text - the document of record stored with
 * the signature. Same shape the CRM's agrDocText produces: title block,
 * filled fields, FEES with the real amount, then the attorney's sections. */
function buildBodyText(tpl: typeof LK_TEMPLATE, ctx: {
  participant: string; dob: string; guardian: string; today: string;
  sessionStart: string; sessionEnd: string; priceCents: number;
  signerName: string; signerRelationship: string;
}): string {
  const out: string[] = [];
  out.push("Grizzly Martial Arts & Fitness LLC");
  out.push("doing business as Bares Taekwondo Fitness");
  out.push(String(tpl.title).toUpperCase());
  out.push("");
  out.push("Participant (Student) Name: " + ctx.participant);
  out.push("Date of Birth: " + ctx.dob);
  out.push("Parent / Guardian: " + ctx.guardian);
  out.push("Today's Date: " + ctx.today);
  out.push("Session Start Date: " + ctx.sessionStart);
  out.push("Session End Date: " + ctx.sessionEnd);
  out.push("");
  out.push("FEES");
  // The fee sentence itself is composed at render time (the docx kept a
  // blank); this wording mirrors the CRM's agrBuildDoc session branch so the
  // web-signed and desk-signed documents read identically.
  out.push("The Little Kickers six (6) week session is a single payment of "
    + money(ctx.priceCents) + ", due in full at enrollment.");
  for (const line of tpl.feesTail as string[]) {
    out.push(line.replace("$________", money(ctx.priceCents)));
  }
  for (const sec of tpl.sections as Array<{ h: string; p: string[] }>) {
    out.push("");
    out.push(sec.h);
    for (const p of sec.p) out.push(p);
  }
  out.push("");
  out.push(String(tpl.signNote));
  out.push("");
  out.push("Signed by: " + ctx.signerName + " (" + ctx.signerRelationship + ")   Date: " + ctx.today);
  return out.join("\n");
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── the cohort: the sellable session, else the next draft one ───────────
  const sesRes = await admin.from("program_sessions")
    .select("id,program,label,starts_on,weeks,class_time,status,enrollment_opens_on")
    .eq("program", PROGRAM)
    .in("status", ["open", "draft"])
    .order("status", { ascending: true })   // 'draft' < 'open' alphabetically, so...
    .order("starts_on", { ascending: true });
  const rows = sesRes.data ?? [];
  // ...prefer an OPEN cohort; fall back to the soonest draft one.
  const row = rows.find((r: Record<string, unknown>) => r.status === "open") ?? rows[0];
  if (!row) {
    return json({ error: "No Little Kickers session is scheduled right now." }, 503, cors);
  }
  const weeks = Number(row.weeks) || 6;
  const startYMD = String(row.starts_on);
  const endYMD = addDays(startYMD, (weeks - 1) * 7);
  const SESSION: Session = {
    id: String(row.id),
    start: startYMD,
    end: endYMD,
    weeks,
    label: weekdayOf(startYMD) + "s " + String(row.class_time),
    blurb: weeks + " " + weekdayOf(startYMD) + "s, " + prettyDate(startYMD) + " to " + prettyDate(endYMD),
    status: String(row.status),
    opensText: row.enrollment_opens_on ? prettyDate(String(row.enrollment_opens_on)) : "soon",
  };
  const ENROLLMENT_OPEN = SESSION.status === "open";

  // ── shared catalog reads: both verbs price from the same rows ───────────
  const planRes = await admin.from("pricing_plans")
    .select("id,code,name,program,billing_frequency,recurring_cents,down_cents,pif_cents,duration_weeks,active")
    .eq("code", PLAN_CODE).maybeSingle();
  if (!planRes.data || planRes.data.active === false) {
    return json({ error: "Little Kickers enrollment isn't open right now." }, 503, cors);
  }
  const plan = planRes.data;
  const shirtRes = await admin.from("products")
    .select("id,name,price_cents,taxable,active")
    .eq("name", TSHIRT_NAME).maybeSingle();
  const shirt = shirtRes.data && shirtRes.data.active !== false ? shirtRes.data : null;
  const setRes = await admin.from("pricing_settings").select("key,value_cents")
    .in("key", ["admin_fee_bps", "admin_fee_flat_cents"]);
  const settings: Record<string, number> = {};
  (setRes.data ?? []).forEach((r: { key: string; value_cents: number }) => settings[r.key] = r.value_cents);
  const feeBps = settings.admin_fee_bps ?? 290;
  const feeFlat = settings.admin_fee_flat_cents ?? 30;
  const sessionCents = Number(plan.pif_cents) || 0;
  const shirtCents = shirt ? Number(shirt.price_cents) || 0 : 0;

  try {
    if (req.method === "GET") {
      return json({
        enrollment_open: ENROLLMENT_OPEN,
        opens_text: SESSION.opensText,
        session: SESSION,
        price_cents: sessionCents,
        tshirt_cents: shirtCents,
        tshirt_available: !!shirt,
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        tax_rate: TAX_RATE,
        agreement_version: LK_TEMPLATE.version,
      }, 200, cors);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    const body = await req.json().catch(() => ({}));
    if (str(body.hp)) return json({ ok: true }, 200, cors); // honeypot: swallow silently


    // ── validate the enrollment ─────────────────────────────────────────────
    const saleId = str(body.sale_id).toLowerCase();
    const studentFirst = str(body.student_first), studentLast = str(body.student_last);
    const dob = str(body.student_dob);
    const parentFirst = str(body.parent_first), parentLast = str(body.parent_last);
    const email = str(body.email).toLowerCase(), phone = str(body.phone);
    const wantShirt = body.tshirt === true, shirtSize = str(body.tshirt_size);
    // White shirt; the artwork is the choice. Constrained to the two designs
    // that exist so the packing slip can't say something unprintable.
    const shirtDesign = str(body.tshirt_design);
    const DESIGNS = ["Girl", "Boy"];
    const signerName = str(body.signer_name);
    const signerRel = str(body.signer_relationship) || "Parent";
    const signature = str(body.signature_png);

    if (!UUID_RE.test(saleId)) return json({ error: "Bad enrollment id. Reload the page." }, 400, cors);
    if (!studentFirst || !studentLast) return json({ error: "Enter the student's name." }, 400, cors);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return json({ error: "Enter the student's date of birth." }, 400, cors);
    if (!parentFirst || !parentLast) return json({ error: "Enter the parent or guardian's name." }, 400, cors);
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "Enter a valid email." }, 400, cors);
    if (!phone || phone.length > 40) return json({ error: "Enter a phone number." }, 400, cors);
    if (wantShirt && !shirt) return json({ error: "The t-shirt isn't available right now. Uncheck it." }, 400, cors);
    if (wantShirt && !shirtSize) return json({ error: "Pick a t-shirt size." }, 400, cors);
    if (wantShirt && !DESIGNS.includes(shirtDesign)) return json({ error: "Pick the girl or boy shirt design." }, 400, cors);
    if (!signerName) return json({ error: "Type the parent/guardian name as the signature name." }, 400, cors);
    if (body.agreed !== true) return json({ error: "Please read and agree to the enrollment agreement." }, 400, cors);
    if (!signature.startsWith("data:image/png;base64,") || signature.length > 300_000) {
      return json({ error: "Please sign in the signature box." }, 400, cors);
    }

    // ── idempotency: a resubmit returns the same invoice ───────────────────
    const existing = await admin.from("pos_sales").select("id,view_token").eq("id", saleId).maybeSingle();
    if (existing.data) {
      return json({ ok: true, invoice_url: `${SITE}/invoice/?t=${existing.data.view_token}` }, 200, cors);
    }

    // ── price it OURSELVES, with the engine the POS uses ───────────────────
    const calc = BTKDPricing.calculatePrice({
      plan, settings, person: { contact_id: null, activeMemberships: [] },
      householdMembers: [], plans: [plan],
    });
    if (!calc.eligible) return json({ error: "This plan can't be sold right now." }, 409, cors);
    const due = BTKDPricing.dueTodayCents(calc, null);         // one_time → the full session fee
    const lines = [{ cents: due, taxable: false }];
    if (wantShirt) lines.push({ cents: shirtCents, taxable: true });
    const preTaxBase = due + (wantShirt ? shirtCents : 0);
    // Online checkout is card-only, and a card always carries the fee.
    const fee = adminFeeCents(preTaxBase, feeBps, feeFlat);
    const totals = BTKDPricing.invoiceTotals({ lines, discountCents: 0, adminFeeCents: fee, taxRate: TAX_RATE });

    const today = todayCT();
    const problems: string[] = [];

    // ── writes, dependency order (mirrors pos-sale) ────────────────────────
    // 1. The student. Email/phone are the PARENT's - for a toddler program
    //    the guardian IS the contact channel, same as the trial funnel.
    const contactIns = await admin.from("contacts").insert({
      first_name: studentFirst, last_name: studentLast,
      segment: "active", member_role: "student",
      source: "website-lk-checkout", entered_on: today,
      dob, email, phone,
    }).select("id").single();
    if (contactIns.error) throw contactIns.error;
    const studentId = contactIns.data.id as string;

    // 2. The guardian, name and all.
    const guardianName = (parentFirst + " " + parentLast).trim();
    const gIns = await admin.from("student_guardians").insert({
      student_id: studentId, email, name: guardianName, label: "parent",
    });
    if (gIns.error) problems.push("guardian row: " + gIns.error.message);

    // 3. The membership - frozen snapshot, session dates baked in. The term
    //    runs with the COHORT (Sept 16 start), not the purchase date.
    const snap = BTKDPricing.buildMembershipSnapshot({
      calc, contactId: studentId, program: "Little Kickers",
      startedOn: SESSION.start, createdBy: "lk-checkout (website)", override: null,
    });
    (snap as Record<string, unknown>).ended_on = SESSION.end;
    (snap as Record<string, unknown>).sale_id = saleId;
    const memIns = await admin.from("memberships").insert(snap).select("id").single();
    if (memIns.error) throw memIns.error;
    const membershipId = memIns.data.id as string;

    // 4. The sale header. Unpaid: the money arrives through create-checkout →
    //    stripe-webhook, which marks it paid and emails the receipt.
    const saleIns = await admin.from("pos_sales").insert({
      id: saleId, buyer_contact_id: studentId, sale_date: today,
      staff_email: "lk-checkout@website", brand: "btkd",
      tender_method: null, status: "unpaid",
      subtotal_cents: totals.subtotalCents, discount_cents: 0,
      admin_fee_cents: fee, tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      notes: "Little Kickers online enrollment, " + SESSION.blurb
        + (wantShirt ? `, t-shirt: ${shirtDesign} design, size ${shirtSize} (white)` : ""),
    }).select("view_token").single();
    if (saleIns.error) throw saleIns.error;
    const token = saleIns.data.view_token as string;

    // 5. The signed agreement, frozen. What we store is OUR render of OUR
    //    template with OUR numbers - never markup posted by the page.
    const bodyText = buildBodyText(LK_TEMPLATE, {
      participant: studentFirst + " " + studentLast, dob: fmtMDY(dob),
      guardian: guardianName, today: fmtMDY(today),
      sessionStart: fmtMDY(SESSION.start), sessionEnd: fmtMDY(SESSION.end),
      priceCents: due, signerName, signerRelationship: signerRel,
    });
    const agrIns = await admin.from("membership_agreements").insert({
      membership_id: membershipId, contact_id: studentId, sale_id: saleId,
      template_key: LK_TEMPLATE.key, template_version: LK_TEMPLATE.version,
      document_title: LK_TEMPLATE.title, program: "Little Kickers",
      plan_code: PLAN_CODE,
      body_json: {
        title: LK_TEMPLATE.title, version: LK_TEMPLATE.version,
        session: SESSION, price_cents: due,
        participant: studentFirst + " " + studentLast, dob, guardian: guardianName,
      },
      body_text: bodyText,
      down_cents: 0, recurring_cents: null, pif_cents: due,
      agreed_payment_date: null,
      signer_name: signerName, signer_relationship: signerRel,
      signature_png: signature, signed_with_staff: "website checkout",
      user_agent: str(req.headers.get("User-Agent")).slice(0, 300),
    });
    if (agrIns.error) problems.push("agreement: " + agrIns.error.message);

    // 6. Ledger line detail.
    const lineRows: Record<string, unknown>[] = [{
      sale_id: saleId, kind: "mem", label: plan.name, qty: 1,
      unit_cents: due, discount_cents: 0, taxable: false, line_total_cents: due,
      student_contact_id: studentId, product_id: null,
      membership_row: snap, membership_id: membershipId,
    }];
    if (wantShirt && shirt) {
      lineRows.push({
        sale_id: saleId, kind: "prod", label: shirt.name + " (" + shirtDesign + ", " + shirtSize + ", white)", qty: 1,
        unit_cents: shirtCents, discount_cents: 0, taxable: true, line_total_cents: shirtCents,
        student_contact_id: null, product_id: shirt.id, membership_row: null, membership_id: null,
      });
    }
    const lIns = await admin.from("pos_sale_lines").insert(lineRows);
    if (lIns.error) problems.push("sale lines: " + lIns.error.message);

    // 7. Class roster.
    const eIns = await admin.from("enrollments").insert({
      student_id: studentId, program: "Little Kickers", status: "active", sale_id: saleId,
    });
    if (eIns.error) problems.push("roster: " + eIns.error.message);

    if (problems.length) console.error("[lk-checkout] partial writes:", saleId, problems);

    return json({ ok: true, invoice_url: `${SITE}/invoice/?t=${token}`, total_cents: totals.totalCents }, 200, cors);
  } catch (e) {
    console.error("[lk-checkout] failed:", e);
    return json({ error: "Could not complete enrollment. Please try again or call us." }, 500, cors);
  }
});
