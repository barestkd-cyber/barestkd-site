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
import { familyCustomer, findOrCreateGuardian } from "../_shared/family.ts";
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
/** "Wed, Sep 16" for a dated list. */
function shortDate(ymd: string): string {
  const p = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return DAYS[d.getUTCDay()].slice(0, 3) + ", " + MONTHS[p[1] - 1].slice(0, 3) + " " + p[2];
}

/** "9:30-10:10 AM" → { start: "0930", end: "1010" } in 24h, or null if the
 *  class_time is written some way this cannot read (which just means no
 *  calendar button, never a wrong one).
 *
 *  The meridiem is written once and belongs to the END time. The start
 *  usually shares it, but not always: "11:30-12:10 PM" starts in the morning.
 *  So convert the end first, then pull the start back a half-day if sharing
 *  the meridiem would put it after the end. */
function parseClassTime(t: string): { start: string; end: string } | null {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t).trim());
  if (!m) return null;
  const sMin = +m[2], eMin = +m[4];
  if (+m[1] > 12 || +m[3] > 12 || sMin > 59 || eMin > 59) return null;
  const pm = m[5].toUpperCase() === "PM";
  const to24 = (h: number) => (pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h));
  const eh = to24(+m[3]);
  let sh = to24(+m[1]);
  if (sh * 60 + sMin >= eh * 60 + eMin) sh -= 12;           // e.g. 11:30-12:10 PM
  if (sh < 0) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return { start: pad(sh) + pad(sMin), end: pad(eh) + pad(eMin) };
}

/** A Google Calendar "add event" link for the WHOLE session: one recurring
 *  entry (weekly, COUNT = weeks) rather than six separate links. */
function googleCalUrl(opts: {
  title: string; startYMD: string; time: { start: string; end: string };
  weeks: number; location: string; details: string;
}): string {
  const d = opts.startYMD.replace(/-/g, "");
  const p = new URLSearchParams({
    action: "TEMPLATE",
    text: opts.title,
    dates: `${d}T${opts.time.start}00/${d}T${opts.time.end}00`,
    ctz: "America/Chicago",
    recur: `RRULE:FREQ=WEEKLY;COUNT=${opts.weeks}`,
    location: opts.location,
    details: opts.details,
  });
  return "https://calendar.google.com/calendar/render?" + p.toString();
}

const PLAN_CODE = "little_kickers_session";
const TSHIRT_NAME = "Little Kickers T-Shirt";
// The site-wide classic tee rides along at half price: the same enrollment-only
// offer (and the same numbers) as cubs-checkout. The discount is computed HERE
// and never sent by the browser.
const GRAY_TEE_NAME = "Classic gray tee";
const TEE_DISCOUNT_BPS = 5000;                // 50% off, enrollment only
const TEE_SIZES = ["Youth XS", "Youth S", "Youth M", "Youth L", "Adult S", "Adult M", "Adult L", "Adult XL", "Adult 2XL"];
const TAX_RATE = 0.0825;          // matches the POS (posBlank taxRate)
const SITE = "https://www.barestkd.fit";

const ALLOWED_ORIGINS = [
  "https://www.barestkd.fit",
  "https://barestkd.fit",
  "https://crm.barestkd.fit",   // the CRM registry reads this page's GET
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

/** Stripe REST, form-encoded. No SDK: one less dependency to pin. */
async function stripe(path: string, key: string, form?: URLSearchParams, method = "POST") {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? (form ?? new URLSearchParams()) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || ("Stripe " + res.status));
  return body;
}

/** Fire the receipt server-to-server, exactly as the webhook does. Never
 *  throws into the payment path: the money is already taken. */
async function sendReceipt(saleId: string): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const r = await fetch(`${url}/functions/v1/send-receipt`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        "Origin": "https://crm.barestkd.fit",
      },
      body: JSON.stringify({ sale_id: saleId, notify_owner: true }),
    });
    if (!r.ok) console.error("receipt send failed", r.status, await r.text().catch(() => ""));
  } catch (e) {
    console.error("receipt send threw", e);
  }
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const money = (c: number) => "$" + (c / 100).toFixed(2);
const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const fmtMDY = (ymd: string) => { const p = ymd.split("-"); return p.length === 3 ? `${p[1]}-${p[2]}-${p[0]}` : ymd; };

/* The card admin fee, exactly as the POS suggests it: basis points on the
 * pre-fee pre-tax base, plus the flat part. Never taxed. */
function adminFeeCents(baseCents: number, bps: number, flat: number): number {
  if (baseCents <= 0) return 0;
  // GROSSED UP (owner, 2026-08-22). Stripe charges its percentage on the
  // TOTAL it collects, and the total includes this fee, so working the fee
  // out on the subtotal always left the studio short. Same implementation
  // as BTKDPricing.cardFeeCents; kept local so this file has no new import.
  if (baseCents <= 0) return 0;
  if (!bps && !flat) return 0;
  if (bps >= 10000) return 0;
  const nets = (t: number) => t - (Math.floor(t * bps / 10000 + 0.5) + flat);
  let total = Math.ceil((baseCents + flat) * 10000 / (10000 - bps));
  while (total > baseCents && nets(total - 1) >= baseCents) total--;
  while (nets(total) < baseCents) total++;
  return total - baseCents;
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
  // ── the page switch (CRM → Checkout pages → Memberships) ─────────────────
  // A missing row means live, so a page never disappears because nobody has
  // registered it yet. finalize is exempt: money already moving must land.
  const pageRow = await admin.from("checkout_pages").select("live").eq("slug", "little-kickers").maybeSingle();
  const pageLive = !pageRow.data || pageRow.data.live !== false;
  const closedMsg = "Little Kickers" + " enrollment is closed right now. Call 903-561-2966.";

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
  // Every class date, derived once: the receipt lists them and the calendar
  // link repeats weekly from the first.
  const classDates: string[] = [];
  for (let i = 0; i < weeks; i++) classDates.push(addDays(startYMD, i * 7));
  const classTime = parseClassTime(String(row.class_time));

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
    .in("name", [TSHIRT_NAME, GRAY_TEE_NAME]).eq("active", true);
  const prodRows = shirtRes.data ?? [];
  const shirt = prodRows.find((r: { name: string }) => r.name === TSHIRT_NAME) ?? null;
  const grayTee = prodRows.find((r: { name: string }) => r.name === GRAY_TEE_NAME) ?? null;
  const setRes = await admin.from("pricing_settings").select("key,value_cents")
    .in("key", ["admin_fee_bps", "admin_fee_flat_cents"]);
  const settings: Record<string, number> = {};
  (setRes.data ?? []).forEach((r: { key: string; value_cents: number }) => settings[r.key] = r.value_cents);
  const feeBps = settings.admin_fee_bps ?? 290;
  const feeFlat = settings.admin_fee_flat_cents ?? 30;
  const sessionCents = Number(plan.pif_cents) || 0;
  const shirtCents = shirt ? Number(shirt.price_cents) || 0 : 0;
  const grayFullCents = grayTee ? Number(grayTee.price_cents) || 0 : 0;
  const grayCents = Math.round(grayFullCents * (10000 - TEE_DISCOUNT_BPS) / 10000);

  let reqBody: Record<string, unknown> = {};
  try {
    if (req.method === "GET") {
      if (!pageLive) return json({ error: closedMsg, closed: true }, 503, cors);
      return json({
        enrollment_open: ENROLLMENT_OPEN,
        opens_text: SESSION.opensText,
        // Publishable keys are meant to be public; this is how the page boots
        // Stripe.js without a key hardcoded in HTML, so test/live follow the
        // secrets and there is nothing to forget on go-live.
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? null,
        session: SESSION,
        price_cents: sessionCents,
        tshirt_cents: shirtCents,
        tshirt_available: !!shirt,
        gray_tee_available: !!grayTee,
        gray_tee_full_cents: grayFullCents,
        gray_tee_cents: grayCents,
        gray_tee_sizes: TEE_SIZES,
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        tax_rate: TAX_RATE,
        agreement_version: LK_TEMPLATE.version,
      }, 200, cors);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    const body = await req.json().catch(() => ({}));
    reqBody = body;
    if (str(body.hp)) return json({ ok: true }, 200, cors); // honeypot: swallow silently
    if (!pageLive && str(body.action) !== "finalize") return json({ error: closedMsg, closed: true }, 503, cors);
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");

    // ── finalize: the card cleared in the browser, so verify with STRIPE and
    //    only then record the money. Never takes the client's word for it.
    if (str(body.action) === "finalize") {
      if (!secretKey) return json({ error: "Payments are not configured." }, 503, cors);
      const fSale = str(body.sale_id).toLowerCase();
      const piId = str(body.payment_intent_id);
      if (!UUID_RE.test(fSale) || !piId.startsWith("pi_")) return json({ error: "Bad payment reference." }, 400, cors);

      const pi = await stripe("payment_intents/" + encodeURIComponent(piId), secretKey, undefined, "GET");
      if (pi.status !== "succeeded") return json({ error: "That payment did not complete." }, 409, cors);
      if (str(pi.metadata?.sale_id).toLowerCase() !== fSale) return json({ error: "That payment is for a different enrollment." }, 409, cors);
      const amt = Number(pi.amount_received ?? pi.amount ?? 0);
      if (amt <= 0) return json({ error: "No amount on that payment." }, 409, cors);

      // Same dedupe key the webhook uses, so a duplicate is a no-op.
      const seen = await admin.from("pos_payments")
        .select("id").eq("sale_id", fSale).eq("stripe_object_id", pi.id).maybeSingle();
      if (!seen.data) {
        const ins = await admin.from("pos_payments").insert({
          sale_id: fSale, kind: "charge", amount_cents: amt, method: "card",
          stripe_object_id: pi.id, note: "Card payment (online enrollment)",
        });
        if (ins.error) throw ins.error;
      }
      const sale = await admin.from("pos_sales").select("total_cents,status,view_token").eq("id", fSale).single();
      if (sale.error || !sale.data) return json({ error: "Enrollment not found." }, 404, cors);
      const pays = await admin.from("pos_payments").select("amount_cents").eq("sale_id", fSale);
      const net = (pays.data ?? []).reduce((a: number, p: { amount_cents: number }) => a + p.amount_cents, 0);
      if (net >= sale.data.total_cents && sale.data.status !== "paid") {
        const upd = await admin.from("pos_sales").update({
          status: "paid", tender_method: "card",
          confirmed_at: new Date().toISOString(), stripe_payment_intent: pi.id,
        }).eq("id", fSale);
        if (!upd.error) {
          // The money landed, so the membership and the roster place are
          // real now. Until this point they were pending on purpose: an
          // abandoned checkout must not leave an active member behind.
          await admin.from("memberships").update({ status: "active" })
            .eq("sale_id", fSale).eq("status", "pending");
          await admin.from("enrollments").update({ status: "active" })
            .eq("sale_id", fSale).eq("status", "pending");
          await sendReceipt(fSale);
        }
      }
      return json({ ok: true, paid: true, receipt_url: `${SITE}/invoice/?t=${sale.data.view_token}` }, 200, cors);
    }


    // ── validate the enrollment ─────────────────────────────────────────────
    const saleId = str(body.sale_id).toLowerCase();
    const studentFirst = str(body.student_first), studentLast = str(body.student_last);
    const dob = str(body.student_dob);
    const parentFirst = str(body.parent_first), parentLast = str(body.parent_last);
    const email = str(body.email).toLowerCase(), phone = str(body.phone);
    const address = str(body.address).slice(0, 300);

    // Optional people. All of it is fill-what-you-want: a second guardian,
    // emergency contacts, pickup people. Empty entries are dropped, counts
    // are capped, and a failure to save one never blocks the enrollment.
    const g2raw = (body.guardian2 && typeof body.guardian2 === "object") ? body.guardian2 as Record<string, unknown> : null;
    const guardian2 = g2raw ? {
      name: str(g2raw.name).slice(0, 120), email: str(g2raw.email).toLowerCase().slice(0, 200),
      phone: str(g2raw.phone).slice(0, 40), address: str(g2raw.address).slice(0, 300),
    } : null;
    const people = (raw: unknown, kind: string) =>
      (Array.isArray(raw) ? raw : []).slice(0, 5)
        .map((r) => ({
          kind,
          name: str((r as Record<string, unknown>).name).slice(0, 120),
          phone: str((r as Record<string, unknown>).phone).slice(0, 40),
          relationship: str((r as Record<string, unknown>).relationship).slice(0, 60) || null,
        }))
        .filter((r) => r.name && r.phone);
    const extraPeople = [...people(body.emergency, "emergency"), ...people(body.pickup, "pickup")];
    const wantShirt = body.tshirt === true, shirtSize = str(body.tshirt_size);
    const wantGray = body.gray_tee === true, graySize = str(body.gray_tee_size);
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
    if (!address) return json({ error: "Enter your home address." }, 400, cors);
    if (wantShirt && !shirt) return json({ error: "The t-shirt isn't available right now. Uncheck it." }, 400, cors);
    if (wantShirt && !shirtSize) return json({ error: "Pick a t-shirt size." }, 400, cors);
    if (wantShirt && !DESIGNS.includes(shirtDesign)) return json({ error: "Pick the girl or boy shirt design." }, 400, cors);
    if (wantGray && !grayTee) return json({ error: "The gray tee isn't available right now. Uncheck it." }, 400, cors);
    if (wantGray && !TEE_SIZES.includes(graySize)) return json({ error: "Pick a size for the gray tee." }, 400, cors);
    if (!signerName) return json({ error: "Type the parent/guardian name as the signature name." }, 400, cors);
    if (body.agreed !== true) return json({ error: "Please read and agree to the enrollment agreement." }, 400, cors);
    if (!signature.startsWith("data:image/png;base64,") || signature.length > 300_000) {
      return json({ error: "Please sign in the signature box." }, 400, cors);
    }

    // ── idempotency: a resubmit returns the same invoice ───────────────────
    // Little Kickers is one fixed session, so the plan cannot move; the
    // tee can. Shirts are ledger lines, so a change in how many lines this
    // sale has is exactly a change in what it costs.
    const wantLines = 1 + (wantGray ? 1 : 0) + (wantShirt ? 1 : 0);
    const priorLines = await admin.from("pos_sale_lines")
      .select("id", { count: "exact", head: true }).eq("sale_id", saleId);
    if (priorLines.count !== null && priorLines.count > 0 && priorLines.count !== wantLines) {
      return json({
        error: "Your selection changed. Please reload the page and start again.",
        reload: true,
      }, 409, cors);
    }

    const existing = await admin.from("pos_sales").select("id,view_token,status,total_cents,stripe_payment_intent").eq("id", saleId).maybeSingle();
    if (existing.data) {
      // Already enrolled (a double submit, or a retry after a declined card).
      // Reuse the SAME PaymentIntent so a retry cannot double-charge.
      if (existing.data.status === "paid") {
        return json({ ok: true, paid: true, receipt_url: `${SITE}/invoice/?t=${existing.data.view_token}` }, 200, cors);
      }
      if (secretKey && existing.data.stripe_payment_intent) {
        const pi0 = await stripe("payment_intents/" + encodeURIComponent(existing.data.stripe_payment_intent), secretKey, undefined, "GET");
        // Retry a card that failed; do not hand back an intent that is
        // mid-flight or already spent.
        if (pi0.status === "requires_payment_method" || pi0.status === "requires_confirmation"
            || pi0.status === "requires_action") {
          return json({ ok: true, client_secret: pi0.client_secret, payment_intent_id: pi0.id, sale_id: saleId, total_cents: existing.data.total_cents }, 200, cors);
        }
      }
      return json({ ok: true, receipt_url: `${SITE}/invoice/?t=${existing.data.view_token}` }, 200, cors);
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
    if (wantGray) lines.push({ cents: grayCents, taxable: true });
    const preTaxBase = due + (wantShirt ? shirtCents : 0) + (wantGray ? grayCents : 0);
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
      dob, email, phone, address,
    }).select("id").single();
    if (contactIns.error) throw contactIns.error;
    const studentId = contactIns.data.id as string;

    // 2. The guardian, name and all.
    const guardianName = (parentFirst + " " + parentLast).trim();
    // The payer becomes (or already is) a real guardians PERSON, linked to
    // the student (_shared/family.ts). The old inserts wrote legacy
    // name/email link rows with no guardian person behind them - data the
    // CRM\u0027s guardian UI cannot see. The legacy insert survives only for
    // the case find-or-create refuses: two guardians sharing one address.
    const gId = await findOrCreateGuardian(admin,
      { name: guardianName, email, phone, studentId, label: "parent" });
    if (!gId) {
      const gIns = await admin.from("student_guardians").insert({
        student_id: studentId, email, name: guardianName, label: "parent",
      });
      if (gIns.error) problems.push("guardian row: " + gIns.error.message);
    }

    if (guardian2 && (guardian2.name || guardian2.email || guardian2.phone)) {
      const g2Id = guardian2.email
        ? await findOrCreateGuardian(admin, { name: guardian2.name || guardian2.email,
            email: guardian2.email, phone: guardian2.phone, studentId, label: "guardian" })
        : null;   // no email = nothing to match a person on; keep the legacy row
      if (!g2Id) {
        const g2Ins = await admin.from("student_guardians").insert({
          student_id: studentId, label: "guardian",
          name: guardian2.name || null, email: guardian2.email || null,
          phone: guardian2.phone || null, address: guardian2.address || null,
        });
        if (g2Ins.error) problems.push("second guardian: " + g2Ins.error.message);
      }
    }
    if (extraPeople.length) {
      const epIns = await admin.from("student_contacts").insert(
        extraPeople.map((r) => ({ student_id: studentId, ...r })));
      if (epIns.error) problems.push("extra contacts: " + epIns.error.message);
    }

    // 3. The sale header FIRST. The membership carries sale_id, so the sale
    //    row has to exist before it or the foreign key has nothing to point
    //    at. (This is the order posTender uses in the CRM; getting it
    //    backwards here failed every enrollment with a sale_id FK violation.)
    //    Unpaid: the money arrives through create-checkout → stripe-webhook,
    //    which marks it paid and emails the receipt.
    const saleIns = await admin.from("pos_sales").insert({
      id: saleId, buyer_contact_id: studentId, payer_name: guardianName || null, payer_email: email || null, sale_date: today,
      staff_email: "lk-checkout@website", brand: "btkd",
      // pending_payment, not unpaid: an abandoned checkout must not leave a
      // debt on anybody\u0027s profile (owner 2026-08-25). Payment flips it
      // paid; the sweep abandons it after 24h.
      tender_method: null, status: "pending_payment",
      subtotal_cents: totals.subtotalCents, discount_cents: 0,
      admin_fee_cents: fee, tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      // What the PARENT reads on their receipt. Without this the only email
      // they get says "$112.46 PAID" and never mentions September 16.
      calendar_url: classTime
        ? googleCalUrl({
            title: "Little Kickers at Bares Taekwondo Fitness",
            startYMD: SESSION.start, time: classTime, weeks: SESSION.weeks,
            location: "1901 Deerbrook Dr, Tyler, TX 75703",
            details: "Little Kickers, ages 2-3. A grown-up trains on the mat with your child every class. Wear comfortable clothes; no uniform needed.",
          })
        : null,
      customer_note:
        "You're enrolled in Little Kickers.\n\n"
        + "All " + SESSION.weeks + " classes, " + String(row.class_time) + ":\n"
        + classDates.map((d, i) => "  " + (i + 1) + ". " + shortDate(d)).join("\n") + "\n\n"
        + "1901 Deerbrook Dr, Tyler\n\n"
        + "A grown-up is on the mat for every class. It doesn't have to be a parent, "
        + "but it does have to be an adult your child knows. Little Kickers is not a drop-off class.\n\n"
        + "Wear comfortable clothes you can move in. No uniform needed, and the belt is included.\n"
        + (wantShirt ? "\nT-shirt: " + shirtDesign + " design, size " + shirtSize + ", white. We'll have it for you at the first class.\n" : "")
        + (wantGray ? "\nClassic gray tee: size " + graySize + ". We'll have it for you at the first class.\n" : "")
        + "\nQuestions? Call 903-561-2966 or just reply to this email.",
      notes: "Little Kickers online enrollment, " + SESSION.blurb
        + (wantShirt ? `, t-shirt: ${shirtDesign} design, size ${shirtSize} (white)` : "")
        + (wantGray ? `, gray tee: size ${graySize} (half-price enrollment special)` : ""),
    }).select("view_token").single();
    if (saleIns.error) throw saleIns.error;
    const token = saleIns.data.view_token as string;

    // 4. The membership - frozen snapshot, session dates baked in. The term
    //    runs with the COHORT (Sept 16 start), not the purchase date.
    const snap = BTKDPricing.buildMembershipSnapshot({
      calc, contactId: studentId, program: "Little Kickers",
      startedOn: SESSION.start, createdBy: "lk-checkout (website)", override: null,
    });
    (snap as Record<string, unknown>).ended_on = SESSION.end;
    (snap as Record<string, unknown>).sale_id = saleId;
    (snap as Record<string, unknown>).status = "pending";
    const memIns = await admin.from("memberships").insert(snap).select("id").single();
    if (memIns.error) throw memIns.error;
    const membershipId = memIns.data.id as string;

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
    if (wantGray && grayTee) {
      // Recorded honestly, same as cubs-checkout: full price with the discount
      // alongside it, so the ledger shows what was given away.
      lineRows.push({
        sale_id: saleId, kind: "prod", label: grayTee.name + " (" + graySize + ")", qty: 1,
        unit_cents: grayFullCents, discount_cents: grayFullCents - grayCents, taxable: true,
        line_total_cents: grayCents,
        student_contact_id: null, product_id: grayTee.id, membership_row: null, membership_id: null,
      });
    }
    const lIns = await admin.from("pos_sale_lines").insert(lineRows);
    if (lIns.error) problems.push("sale lines: " + lIns.error.message);

    // 7. Class roster.
    const eIns = await admin.from("enrollments").insert({
      student_id: studentId, program: "Little Kickers", status: "pending", sale_id: saleId,
    });
    if (eIns.error) problems.push("roster: " + eIns.error.message);

    if (problems.length) console.error("[lk-checkout] partial writes:", saleId, problems);

    // 8. The payment, taken ON THIS PAGE. Sending them to an invoice page to
    //    press Pay again was a wasted click, so the card fields live in the
    //    form and this returns the intent for the browser to confirm.
    //    The amount comes from the totals computed above, never the client.
    if (!secretKey) {
      // No Stripe configured: fall back to the invoice link so the enrollment
      // is not lost, and they can be taken payment another way.
      return json({ ok: true, receipt_url: `${SITE}/invoice/?t=${token}`, total_cents: totals.totalCents }, 200, cors);
    }
    // Card on file, same as every other rail (owner's locked model): attach
    // a customer so this card can be charged again later by staff.
    // Whose card it is: the family\u0027s guardian, one shared answer for all
    // five checkouts (_shared/family.ts). The old block minted a customer
    // per sale and stamped it on the KID\u0027s contact row.
    const fam = await familyCustomer(admin, stripe, secretKey,
      { email, name: guardianName, phone, studentId });
    await admin.from("pos_sales").update({ stripe_customer_id: fam.custId }).eq("id", saleId);

    const f = new URLSearchParams();
    f.set("amount", String(totals.totalCents));
    f.set("currency", "usd");
    f.set("payment_method_types[]", "card");
    f.set("description", "Little Kickers - " + studentFirst + " " + studentLast);
    f.set("receipt_email", email);
    f.set("customer", fam.custId);
    f.set("setup_future_usage", "off_session");
    f.set("metadata[sale_id]", saleId);
    f.set("metadata[source]", "lk-checkout");
    const pi = await stripe("payment_intents", secretKey, f);
    await admin.from("pos_sales").update({ stripe_payment_intent: pi.id }).eq("id", saleId);

    return json({
      ok: true,
      client_secret: pi.client_secret,
      payment_intent_id: pi.id,
      sale_id: saleId,
      total_cents: totals.totalCents,
      receipt_url: `${SITE}/invoice/?t=${token}`,
    }, 200, cors);
  } catch (e) {
    // A parent must never see a database error, but a silent 500 is
    // undiagnosable from the outside. `debug:true` (staff only, sent by hand)
    // returns the real message; the public path keeps the friendly one.
    console.error("[lk-checkout] failed:", e);
    const detail = (e as { message?: string })?.message || String(e);
    return json({
      error: "Could not complete enrollment. Please try again or call us.",
      // The detail is logged above, never returned to the caller.
    }, 500, cors);
  }
});
