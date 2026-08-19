// ===========================================================================
// Supabase Edge Function: testing-checkout - public belt-testing signup
// ---------------------------------------------------------------------------
// The third public checkout, and deliberately the LEANEST. Everyone signing up
// for a belt testing is ALREADY a member, so none of the enrollment machinery
// applies: no contact creation, no membership snapshot, no agreement, no
// signature, no guardian or emergency-contact records. A testing signup is a
// paid seat at a dated event and nothing more.
//
// GET  -> whether the page is live, the groups a parent can pick, the belt
//         ladders, and the fee numbers. Every price comes from the database.
// POST -> writes sale + lines + testing_signups, returns a PaymentIntent.
// POST {action:"finalize"} -> re-reads the intent FROM STRIPE, then records
//         the money. A lying client cannot mark a signup paid.
//
// HARD RULES (same as cubs-checkout and lk-checkout):
//   * Every price is re-derived HERE through the shared pricing engine. The
//     client sends choices, never amounts.
//   * sale_id is client-minted and is the idempotency key: a double submit
//     returns the same intent instead of signing anyone up twice.
//   * The page being live is ONE switch, settings.testing_page_live. The
//     sign-up-by date is printed for parents and never enforced (owner:
//     "dont close registration just say the deadline lol").
//
// Deploy, from the barestkd-site repo root:
//   supabase functions deploy testing-checkout --no-verify-jwt
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";

const SITE = "https://www.barestkd.fit";
const TAX_RATE = 0.0825;

// A testing fee is a SERVICE, priced and charged like the Little Kickers
// session fee, which lk-checkout also books untaxed. Only tangible goods carry
// tax on these pages. Flagged for the owner's accountant alongside the other
// tax questions in STRIPE_PLAN.
const TESTING_TAXABLE = false;

// The two belt ladders. Cubs run their own and it does not exist in
// portal/shared/belts.js; the owner gave it 2026-08-19. Order IS the ladder,
// so the dropdown reads the way a student actually progresses.
const CUB_RANKS = [
  "Cub White Belt", "Cub Yellow Belt", "Cub Orange Belt", "Cub Green Belt",
  "Cub Purple Belt", "Cub Blue Belt", "Cub Brown Belt", "Cub Red Belt",
  "Cub Black Belt", "2nd Degree Cub Black Belt",
];
// Verbatim from portal/shared/belts.js, the single source of truth for TKD
// rank names, and matching the strings already sitting in contacts.rank.
const TKD_RANKS = [
  "White Belt", "Yellow Belt", "Senior Yellow Belt", "Orange Belt",
  "Senior Orange Belt", "Green Belt", "Senior Green Belt", "Purple Belt",
  "Senior Purple Belt", "Blue Belt", "Senior Blue Belt", "Brown Belt",
  "Senior Brown Belt", "Red Belt", "Senior Red Belt",
  "Probationary Black Belt", "Recommended Black Belt",
  "1st Degree Decided Black Belt", "1st Degree Decided Level 2",
  "1st Degree Senior Black Belt", "1st Degree Senior Level 2",
  "2nd Degree Black Belt", "2nd Degree Black Belt Level 2",
  "2nd Degree Decided Black Belt", "2nd Degree Decided Black Belt Level 2",
  "2nd Degree Senior Black Belt", "2nd Degree Senior Black Belt Level 2",
  "3rd Degree Black Belt", "3rd Degree Decided Black Belt",
  "3rd Degree Senior Black Belt", "4th Degree Black Belt",
  "4th Degree Senior Black Belt",
];

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
const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Friday, August 28" built without new Date(str): that parses as UTC and
 *  reads a day early in Central, which would tell a parent the wrong day. */
function prettyDay(ymd: string): string {
  const p = String(ymd).split("-").map(Number);
  if (p.length !== 3 || !p[0]) return String(ymd);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return DAYS[d.getUTCDay()] + ", " + MONTHS[p[1] - 1] + " " + p[2];
}

/** The card admin fee, exactly as the POS suggests it: basis points on the
 *  pre-fee pre-tax base, plus the flat part. Never taxed. */
function adminFeeCents(baseCents: number, bps: number, flat: number): number {
  if (baseCents <= 0) return 0;
  return Math.round(baseCents * bps / 10000) + flat;
}

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
    const r = await fetch(url + "/functions/v1/send-receipt", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + serviceKey,
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

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let reqBody: Record<string, unknown> = {};
  try {
    // -- the one switch, and the groups ------------------------------------
    const setRow = await admin.from("settings").select("testing_page_live").limit(1).maybeSingle();
    const pageLive = setRow.data?.testing_page_live === true;

    const today = todayCT();
    const groupsRes = await admin.from("testing_dates")
      .select("id,label,test_date,start_time,applies_to,fee_cents,signup_by,program,sort_order")
      .gte("test_date", today).order("sort_order");
    const groups = groupsRes.data ?? [];

    const psRes = await admin.from("pricing_settings").select("key,value_cents");
    const settings: Record<string, number> = {};
    (psRes.data ?? []).forEach((r: { key: string; value_cents: number }) => settings[r.key] = r.value_cents);
    const feeBps = settings.admin_fee_bps ?? 290;
    const feeFlat = settings.admin_fee_flat_cents ?? 30;

    if (req.method === "GET") {
      return json({
        page_live: pageLive,
        // Publishable keys are meant to be public; this is how the page boots
        // Stripe.js with nothing hardcoded, so test and live follow the
        // secrets and there is nothing to forget at go-live.
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? null,
        groups: groups.map((g: Record<string, unknown>) => ({
          id: g.id,
          label: g.label,
          program: g.program,
          test_date: g.test_date,
          start_time: g.start_time,
          applies_to: g.applies_to,
          flat_fee_cents: g.fee_cents,      // null means the family ladder
          signup_by: g.signup_by,           // printed, never enforced
          pretty_day: prettyDay(String(g.test_date)),
        })),
        ranks: { cub: CUB_RANKS, tkd: TKD_RANKS },
        fees: {
          seat1_cubs_cents: settings.testing_fee_cubs_cents ?? 5000,
          seat1_standard_cents: settings.testing_fee_standard_cents ?? 6000,
          seat2_cents: settings.testing_fee_2nd_cents ?? 5000,
          seat3_cents: settings.testing_fee_3rd_cents ?? 3000,
          seat4plus_cents: settings.testing_fee_addl_cents ?? 1000,
        },
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        tax_rate: TAX_RATE,
        testing_taxable: TESTING_TAXABLE,
      }, 200, cors);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    const body = await req.json().catch(() => ({}));
    reqBody = body;
    if (str(body.hp)) return json({ ok: true }, 200, cors);   // honeypot
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");

    // -- finalize: the card cleared in the browser, so ask STRIPE ----------
    if (str(body.action) === "finalize") {
      if (!secretKey) return json({ error: "Payments are not configured." }, 503, cors);
      const fSale = str(body.sale_id).toLowerCase();
      const piId = str(body.payment_intent_id);
      if (!UUID_RE.test(fSale) || !piId.startsWith("pi_")) {
        return json({ error: "Bad payment reference." }, 400, cors);
      }

      const pi = await stripe("payment_intents/" + encodeURIComponent(piId), secretKey, undefined, "GET");
      if (pi.status !== "succeeded") return json({ error: "That payment did not complete." }, 409, cors);
      if (str(pi.metadata?.sale_id).toLowerCase() !== fSale) {
        return json({ error: "That payment is for a different signup." }, 409, cors);
      }
      const amt = Number(pi.amount_received ?? pi.amount ?? 0);
      if (amt <= 0) return json({ error: "No amount on that payment." }, 409, cors);

      // Same dedupe key the webhook uses, so a duplicate is a no-op.
      const seen = await admin.from("pos_payments")
        .select("id").eq("sale_id", fSale).eq("stripe_object_id", pi.id).maybeSingle();
      if (!seen.data) {
        const ins = await admin.from("pos_payments").insert({
          sale_id: fSale, kind: "charge", amount_cents: amt, method: "card",
          stripe_object_id: pi.id, note: "Card payment (testing signup)",
        });
        if (ins.error) throw ins.error;
      }
      const sale = await admin.from("pos_sales")
        .select("total_cents,status,view_token").eq("id", fSale).single();
      if (sale.error || !sale.data) return json({ error: "Signup not found." }, 404, cors);
      const pays = await admin.from("pos_payments").select("amount_cents").eq("sale_id", fSale);
      const net = (pays.data ?? []).reduce((a: number, p: { amount_cents: number }) => a + p.amount_cents, 0);
      if (net >= sale.data.total_cents && sale.data.status !== "paid") {
        const upd = await admin.from("pos_sales").update({
          status: "paid", tender_method: "card",
          confirmed_at: new Date().toISOString(), stripe_payment_intent: pi.id,
        }).eq("id", fSale);
        if (!upd.error) {
          await admin.from("testing_signups").update({ paid: true }).eq("sale_id", fSale);
          await sendReceipt(fSale);
        }
      }
      return json({ ok: true, paid: true, receipt_url: SITE + "/invoice/?t=" + sale.data.view_token }, 200, cors);
    }

    // -- a new signup ------------------------------------------------------
    if (!pageLive) return json({ error: "Testing signups are not open right now." }, 503, cors);

    const saleId = str(body.sale_id).toLowerCase();
    if (!UUID_RE.test(saleId)) return json({ error: "Bad signup id. Reload the page." }, 400, cors);

    const parentFirst = str(body.parent_first), parentLast = str(body.parent_last);
    const email = str(body.email).toLowerCase(), phone = str(body.phone);
    const comments = str(body.comments).slice(0, 2000);

    if (!parentFirst || !parentLast) return json({ error: "Enter your first and last name." }, 400, cors);
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "Enter a valid email." }, 400, cors);
    if (!phone || phone.length > 40) return json({ error: "Enter a phone number." }, 400, cors);

    const rawStudents = Array.isArray(body.students) ? body.students : [];
    if (!rawStudents.length) return json({ error: "Add at least one student." }, 400, cors);
    if (rawStudents.length > 8) {
      return json({ error: "That is more students than one checkout takes. Please call us." }, 400, cors);
    }

    type Seat = {
      first: string; last: string; group: Record<string, unknown>;
      rank: string; position: number; cents: number;
    };
    const seats: Seat[] = [];
    for (const raw of rawStudents) {
      const r = raw as Record<string, unknown>;
      const first = str(r.first), last = str(r.last), rank = str(r.rank);
      const groupId = str(r.group_id);
      const position = Math.max(Math.round(Number(r.position) || 1), 1);
      const group = groups.find((g: Record<string, unknown>) => String(g.id) === groupId);
      if (!first || !last) return json({ error: "Every student needs a first and last name." }, 400, cors);
      if (!group) return json({ error: "Pick a testing group for " + first + "." }, 400, cors);
      const allowed = group.program === "Cubs" ? CUB_RANKS
        : group.program === "Any" ? CUB_RANKS.concat(TKD_RANKS)
        : TKD_RANKS;
      if (!allowed.includes(rank)) return json({ error: "Pick the current belt for " + first + "." }, 400, cors);

      // A per-event flat fee wins: Late Testing is $70 and never laddered.
      // Otherwise the family ladder, where seat 1 follows the group's program
      // and every later seat is flat.
      const cents = group.fee_cents != null
        ? Number(group.fee_cents)
        : BTKDPricing.testingFeeCents({
            program: group.program === "Cubs" ? "Cubs" : "TKD",
            position,
            settings,
          });
      seats.push({ first, last, group, rank, position, cents });
    }

    // -- idempotency: a resubmit returns the same intent --------------------
    const existing = await admin.from("pos_sales")
      .select("id,view_token,status,total_cents,stripe_payment_intent").eq("id", saleId).maybeSingle();
    if (existing.data) {
      if (existing.data.status === "paid") {
        return json({ ok: true, paid: true, receipt_url: SITE + "/invoice/?t=" + existing.data.view_token }, 200, cors);
      }
      if (secretKey && existing.data.stripe_payment_intent) {
        const pi0 = await stripe("payment_intents/" + encodeURIComponent(existing.data.stripe_payment_intent),
          secretKey, undefined, "GET");
        if (pi0.status !== "succeeded" && pi0.status !== "canceled") {
          return json({
            ok: true, client_secret: pi0.client_secret, payment_intent_id: pi0.id,
            sale_id: saleId, total_cents: existing.data.total_cents,
          }, 200, cors);
        }
      }
      return json({ ok: true, receipt_url: SITE + "/invoice/?t=" + existing.data.view_token }, 200, cors);
    }

    const lines = seats.map((s) => ({ cents: s.cents, taxable: TESTING_TAXABLE }));
    const preTaxBase = seats.reduce((a, s) => a + s.cents, 0);
    const fee = adminFeeCents(preTaxBase, feeBps, feeFlat);   // card-only online
    const totals = BTKDPricing.invoiceTotals({
      lines, discountCents: 0, adminFeeCents: fee, taxRate: TAX_RATE,
    });

    const problems: string[] = [];

    // Who is paying. We deliberately do NOT create a contact: these are
    // existing members, and inventing one per signup would fill the roster
    // with duplicates of people already on it. Match on email only when it is
    // unambiguous; otherwise leave the buyer null and let the receipt carry
    // the address.
    let buyerId: string | null = null;
    const buyerMatch = await admin.from("contacts").select("id").ilike("email", email).limit(2);
    if ((buyerMatch.data ?? []).length === 1) buyerId = buyerMatch.data![0].id as string;

    const parentName = (parentFirst + " " + parentLast).trim();
    const noteLines = seats.map((s) =>
      "  " + s.first + " " + s.last + " (" + s.rank + ") - " + String(s.group.label)
      + ", " + prettyDay(String(s.group.test_date))
      + (s.group.start_time ? " at " + String(s.group.start_time) : ""));

    const saleIns = await admin.from("pos_sales").insert({
      id: saleId, buyer_contact_id: buyerId, sale_date: today,
      staff_email: "testing-checkout@website", brand: "btkd",
      tender_method: null, status: "unpaid",
      subtotal_cents: totals.subtotalCents, discount_cents: 0,
      admin_fee_cents: fee, tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      receipt_email: email,
      // What the PARENT reads on their receipt. Without this the only email
      // they get is a total, and never says which day to show up.
      customer_note:
        "You're signed up for belt testing.\n\n"
        + noteLines.join("\n") + "\n\n"
        + "1901 Deerbrook Dr, Tyler\n\n"
        + "Please arrive at least 5 minutes early, in full uniform, with all required gear.\n"
        + "Family and friends are welcome to come and watch.\n"
        + "\nQuestions? Call 903-561-2966 or just reply to this email.",
      notes: "Testing signup from the website, " + seats.length + " student"
        + (seats.length === 1 ? "" : "s") + ", paid by " + parentName
        + (comments ? " | parent comments: " + comments : ""),
    }).select("view_token").single();
    if (saleIns.error) throw saleIns.error;
    const token = saleIns.data.view_token as string;

    // -- ledger line detail --------------------------------------------------
    const lineRows = seats.map((s) => ({
      sale_id: saleId, kind: "event",
      label: "Belt testing - " + s.first + " " + s.last + " (" + String(s.group.label) + ")",
      qty: 1, unit_cents: s.cents, discount_cents: 0,
      taxable: TESTING_TAXABLE, line_total_cents: s.cents,
      student_contact_id: null, product_id: null,
      membership_row: null, membership_id: null,
    }));
    const lIns = await admin.from("pos_sale_lines").insert(lineRows);
    if (lIns.error) problems.push("sale lines: " + lIns.error.message);

    // -- the signups. contact_id is best-effort: an exact, SINGLE name match
    // only. The whole point of collecting rank is a clean census, and a loose
    // match would write one student's belt onto another student's record.
    const signupRows: Record<string, unknown>[] = [];
    for (const s of seats) {
      let contactId: string | null = null;
      const m = await admin.from("contacts").select("id")
        .ilike("first_name", s.first).ilike("last_name", s.last).limit(2);
      if ((m.data ?? []).length === 1) contactId = m.data![0].id as string;
      signupRows.push({
        testing_date_id: s.group.id,
        contact_id: contactId,
        student_name: s.first + " " + s.last,
        rank: s.rank,
        source: "link",
        paid: false,
        sale_id: saleId,
        program: s.group.program === "Cubs" ? "Cubs" : "TKD",
        family_position: s.position,
        fee_cents: s.cents,
      });
    }
    const sIns = await admin.from("testing_signups").insert(signupRows);
    if (sIns.error) problems.push("signups: " + sIns.error.message);

    if (problems.length) console.error("[testing-checkout] partial writes:", saleId, problems);

    // -- payment, taken on this page ---------------------------------------
    if (!secretKey) {
      return json({ ok: true, receipt_url: SITE + "/invoice/?t=" + token, total_cents: totals.totalCents }, 200, cors);
    }
    // Card on file, same as every other rail (owner's locked model): attach a
    // customer so this card can be charged again later by staff.
    const cf = new URLSearchParams();
    cf.set("name", parentName);
    cf.set("email", email);
    if (phone) cf.set("phone", phone);
    if (buyerId) cf.set("metadata[contact_id]", buyerId);
    const cust = await stripe("customers", secretKey, cf);
    if (buyerId) await admin.from("contacts").update({ stripe_customer_id: cust.id }).eq("id", buyerId);
    await admin.from("pos_sales").update({ stripe_customer_id: cust.id }).eq("id", saleId);

    const f = new URLSearchParams();
    f.set("amount", String(totals.totalCents));
    f.set("currency", "usd");
    f.set("payment_method_types[]", "card");
    f.set("description", "Belt testing - " + seats.map((s) => s.first + " " + s.last).join(", "));
    f.set("receipt_email", email);
    f.set("customer", cust.id);
    f.set("setup_future_usage", "off_session");
    f.set("metadata[sale_id]", saleId);
    f.set("metadata[source]", "testing-checkout");
    const pi = await stripe("payment_intents", secretKey, f);
    await admin.from("pos_sales").update({ stripe_payment_intent: pi.id }).eq("id", saleId);

    return json({
      ok: true,
      client_secret: pi.client_secret,
      payment_intent_id: pi.id,
      sale_id: saleId,
      total_cents: totals.totalCents,
      receipt_url: SITE + "/invoice/?t=" + token,
    }, 200, cors);
  } catch (e) {
    // A parent must never see a database error, but a silent 500 is
    // undiagnosable from outside. debug:true (staff only, sent by hand)
    // returns the real message; the public path keeps the friendly one.
    console.error("[testing-checkout] failed:", e);
    const detail = (e as { message?: string })?.message || String(e);
    return json({
      error: "Could not complete the signup. Please try again or call us.",
      ...(reqBody.debug === true ? { detail } : {}),
    }, 500, cors);
  }
});
