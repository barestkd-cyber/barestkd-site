// ===========================================================================
// Supabase Edge Function: tournament-checkout - public tournament signup
// ---------------------------------------------------------------------------
// Owner, 2026-10-20: "look at this tournament and make me a checkout page with
// the same details", about the host's page for the 2026 Texas Showdown. Our
// families register and pay the studio here; Race then enters each
// competitor with the host himself.
//
// Built from testing-checkout, and lean for the same reason: everyone here is
// already a student, so no contact is created, no membership, no agreement.
// A signup is a paid seat at a dated event.
//
// GET  -> whether the page is open, the divisions, belts, heights, shirt
//         sizes and every price.
// POST -> writes sale + lines + event_registrations (pending), returns a
//         PaymentIntent.
// POST {action:"finalize"} -> re-reads the intent FROM STRIPE, records the
//         money, and makes the registrations real.
//
// HARD RULES (same as every checkout):
//   * Every price is set HERE. The client sends choices, never amounts.
//   * sale_id is client-minted and is the idempotency key: a double submit
//     returns the same intent instead of registering anyone twice.
//   * The page is open while the CRM event (Checkout Pages > Events) has
//     "Public page open" on and is not archived. That switch is the only
//     way to close it. The sign-up and shirt deadlines are printed, never
//     enforced (owner, for testing: "dont close registration just say the
//     deadline lol").
//   * A registration is written pending and only turns registered when the
//     sale is paid, so an abandoned checkout never shows in Participants.
//     The stripe-webhook backstop does the same flip if this finalize never
//     runs.
//
// Deploy, from the barestkd-site repo root:
//   supabase functions deploy tournament-checkout --no-verify-jwt
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";
import { familyCustomer } from "../_shared/family.ts";

const SITE = "https://www.barestkd.fit";
const TAX_RATE = 0.0825;

// THE TOURNAMENT. Hand-set, like the testing week on the testing page: the
// next tournament changes these and the page copy, and adds its own event.
// eventId is the CRM events row this page sells and files registrations
// under; it is created with this exact id when the page ships.
const TOURNAMENT = {
  eventId: "607a51a9-45aa-40e5-b2c2-39d4d6493e3e",
  name: "2026 Texas Showdown Regional Tournament",
  short: "Texas Showdown",
  date: "2026-11-14",
  signupBy: "2026-11-04",     // printed, never enforced
  shirtsBy: "2026-10-30",     // printed, never enforced
  venue: "Watauga Community Center",
  address: "7901 Indian Springs Rd, Watauga, TX 76148",
  // The tournament falls on testing day, so a competing family tests another
  // time that week at half price: every signup gets its family a code for 50%
  // off that testing, for everyone in it (owner, 2026-10-21: "code works for
  // all testing in that family no matter who competes"). Good once paid.
  testingCycle: "nov-2026",
  testingPctOff: 50,
};

/** "TXS-7KQ4P". No 0/O, 1/I/L, so it reads right off a phone. */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode(): string {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return "TXS-" + Array.from(b).map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

// The host's prices, unchanged. The card fee is added on top, as on every
// card charge.
const DIVISIONS = [
  { key: "cubs", label: "Cubs (Tiny Tigers)", cents: 5500, program: "Cubs" },
  { key: "jta", label: "Juniors, Teens & Adults", cents: 9000, program: "TKD" },
];
const BOARD_CENTS = 3500;
const SHIRT_CENTS = 2500;

// Entry fees and board breaking are a SERVICE, booked untaxed like a testing
// fee. The shirt is a tangible good and carries sales tax.
const ENTRY_TAXABLE = false;
const SHIRT_TAXABLE = true;

// The host prints these shirts, so these are the host's own sizes.
const SHIRT_SIZES = ["Child S", "Child M", "Child L", "Adult S", "Adult M",
  "Adult L", "Adult XL", "Adult XXL", "Adult XXXL"];
const MAX_FAMILY_SHIRTS = 10;

// Height decides ring placement, so it is a fixed list (3 ft to 7 ft), never
// free text the host would have to interpret.
const MIN_HEIGHT_IN = 36, MAX_HEIGHT_IN = 84;
const GENDERS = ["Female", "Male"];

// The belt ladders, exactly as testing-checkout carries them. Cubs run their
// own; the rest are verbatim from portal/shared/belts.js.
const CUB_RANKS = [
  "Cub White Belt", "Cub Yellow Belt", "Cub Orange Belt", "Cub Green Belt",
  "Cub Purple Belt", "Cub Blue Belt", "Cub Brown Belt", "Cub Red Belt",
  "Cub Black Belt", "2nd Degree Cub Black Belt",
];
const TKD_RANKS = [
  "White Belt", "Yellow Belt", "Senior Yellow Belt", "Orange Belt",
  "Senior Orange Belt", "Green Belt", "Senior Green Belt", "Purple Belt",
  "Senior Purple Belt", "Blue Belt", "Senior Blue Belt", "Brown Belt",
  "Senior Brown Belt", "Red Belt", "Senior Red Belt",
  "Probationary Black Belt", "Recommended Black Belt",
  "1st Degree Decided Black Belt", "1st Degree Decided Black Belt Lvl 2.",
  "1st Degree Senior Black Belt", "1st Degree Senior Black Belt Lvl 2.",
  "2nd Degree Black Belt", "2nd Degree Black Belt Lvl 2.",
  "2nd Degree Decided Black Belt", "2nd Degree Decided Black Belt Lvl 2.",
  "2nd Degree Senior Black Belt", "2nd Degree Senior Black Belt Lvl 2.",
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

/** "Saturday, November 14" built without new Date(str): that parses as UTC
 *  and reads a day early in Central. */
function prettyDay(ymd: string): string {
  const p = String(ymd).split("-").map(Number);
  if (p.length !== 3 || !p[0]) return String(ymd);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return DAYS[d.getUTCDay()] + ", " + MONTHS[p[1] - 1] + " " + p[2];
}

/** A real calendar date, or null. "2015-02-30" is not a birthday. */
function parseYmd(ymd: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ""));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Age in whole years ON the tournament day, which is what the host places
 *  by. Computed here from the birthday so it can never disagree with it. */
function ageOn(dob: string, on: string): number | null {
  const b = parseYmd(dob), t = parseYmd(on);
  if (!b || !t) return null;
  let age = t.y - b.y;
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age--;
  return age;
}

/** 54 -> 4' 6"; 48 -> 4'. */
function heightLabel(inches: number): string {
  const ft = Math.floor(inches / 12), rest = inches % 12;
  return rest ? ft + "' " + rest + '"' : ft + "'";
}
const usDate = (ymd: string) => { const p = parseYmd(ymd); return p ? String(p.m).padStart(2, "0") + "/" + String(p.d).padStart(2, "0") + "/" + p.y : ymd; };

/** A Google Calendar "add event" link. Competition times are only sent two
 *  days before, so this is an all-day entry rather than a guessed hour. */
function googleCalUrl(): string {
  const d = TOURNAMENT.date.replace(/-/g, "");
  const p = parseYmd(TOURNAMENT.date)!;
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1)).toISOString().slice(0, 10).replace(/-/g, "");
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: TOURNAMENT.name,
    dates: d + "/" + next,
    ctz: "America/Chicago",
    location: TOURNAMENT.venue + ", " + TOURNAMENT.address,
    details: "Competition times are sent two days before the tournament. Spectators are $10 at the door, free under 4.",
  });
  return "https://calendar.google.com/calendar/render?" + q.toString();
}

/** The card admin fee, exactly as the POS suggests it: basis points on the
 *  pre-fee base, plus the flat part. Never taxed. */
function adminFeeCents(baseCents: number, bps: number, flat: number): number {
  // GROSSED UP (owner, 2026-08-22). Stripe charges its percentage on the
  // TOTAL it collects, and the total includes this fee, so working the fee
  // out on the subtotal always left the studio short. Same implementation
  // as BTKDPricing.cardFeeCents and testing-checkout.
  if (baseCents <= 0) return 0;
  if (!bps && !flat) return 0;
  if (bps >= 10000) return 0;
  const nets = (t: number) => t - (Math.floor(t * bps / 10000 + 0.5) + flat);
  let total = Math.ceil((baseCents + flat) * 10000 / (10000 - bps));
  while (total > baseCents && nets(total - 1) >= baseCents) total--;
  while (nets(total) < baseCents) total++;
  return total - baseCents;
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

/* Brand and last four of the card that paid, wherever Stripe put them on
 * this object. Same walk the stripe-webhook uses. */
function cardBits(obj: Record<string, unknown>): { card_brand: string | null; card_last4: string | null } {
  const seen = new Set<unknown>();
  const walk = (o: unknown, depth: number): Record<string, unknown> | null => {
    if (!o || typeof o !== "object" || depth > 5 || seen.has(o)) return null;
    seen.add(o);
    const rec = o as Record<string, unknown>;
    if (typeof rec.last4 === "string" && typeof rec.brand === "string") return rec;
    for (const v of Object.values(rec)) { const hit = walk(v, depth + 1); if (hit) return hit; }
    return null;
  };
  const c = walk(obj, 0);
  return {
    card_brand: c && typeof c.brand === "string" ? String(c.brand).slice(0, 32) : null,
    card_last4: c && /^[0-9]{4}$/.test(String(c.last4)) ? String(c.last4) : null,
  };
}

/** Paid means registered. One row at a time, so a competitor who somehow
 *  already holds a seat (the one-seat index) cannot stop the others. */
async function confirmRegistrations(admin: { from: (t: string) => any }, saleId: string): Promise<void> {
  const regs = await admin.from("event_registrations").select("id")
    .eq("sale_id", saleId).eq("status", "pending");
  for (const r of (regs.data ?? []) as Record<string, unknown>[]) {
    const u = await admin.from("event_registrations").update({ status: "registered" }).eq("id", r.id);
    if (u.error) console.error("[tournament-checkout] registration not confirmed", saleId, r.id, u.error);
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // -- the one switch: the CRM event -----------------------------------
    const evRes = await admin.from("events")
      .select("id,label,public_open,archived").eq("id", TOURNAMENT.eventId).maybeSingle();
    const ev = evRes.data;
    const pageLive = !!ev && ev.public_open === true && ev.archived !== true;

    const psRes = await admin.from("pricing_settings").select("key,value_cents");
    const settings: Record<string, number> = {};
    (psRes.data ?? []).forEach((r: { key: string; value_cents: number }) => settings[r.key] = r.value_cents);
    const feeBps = settings.admin_fee_bps ?? 290;
    const feeFlat = settings.admin_fee_flat_cents ?? 30;

    if (req.method === "GET") {
      const heights: { inches: number; label: string }[] = [];
      for (let h = MIN_HEIGHT_IN; h <= MAX_HEIGHT_IN; h++) heights.push({ inches: h, label: h + '" (' + heightLabel(h) + ")" });
      return json({
        page_live: pageLive,
        // Publishable keys are meant to be public; this is how the page boots
        // Stripe.js with nothing hardcoded.
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? null,
        tournament: {
          name: TOURNAMENT.name, date: TOURNAMENT.date, pretty_day: prettyDay(TOURNAMENT.date),
          signup_by: TOURNAMENT.signupBy, shirts_by: TOURNAMENT.shirtsBy,
          venue: TOURNAMENT.venue, address: TOURNAMENT.address,
        },
        divisions: DIVISIONS.map((d) => ({ key: d.key, label: d.label, cents: d.cents, program: d.program })),
        ranks: { cub: CUB_RANKS, tkd: TKD_RANKS },
        heights,
        genders: GENDERS,
        shirt_sizes: SHIRT_SIZES,
        board_cents: BOARD_CENTS,
        shirt_cents: SHIRT_CENTS,
        max_family_shirts: MAX_FAMILY_SHIRTS,
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        tax_rate: TAX_RATE,
        shirt_taxable: SHIRT_TAXABLE,
      }, 200, cors);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    const body = await req.json().catch(() => ({}));
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

      const pi = await stripe("payment_intents/" + encodeURIComponent(piId)
          + "?expand[]=latest_charge.payment_method_details", secretKey, undefined, "GET");
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
          ...cardBits(pi),
          stripe_object_id: pi.id, note: "Card payment (tournament signup)",
        });
        if (ins.error) throw ins.error;
      }
      const sale = await admin.from("pos_sales")
        .select("total_cents,status,view_token").eq("id", fSale).single();
      if (sale.error || !sale.data) return json({ error: "Signup not found." }, 404, cors);
      const pays = await admin.from("pos_payments").select("amount_cents").eq("sale_id", fSale);
      const net = (pays.data ?? []).reduce((a: number, p: { amount_cents: number }) => a + p.amount_cents, 0);
      let paid = sale.data.status === "paid";
      if (net >= sale.data.total_cents && !paid) {
        const upd = await admin.from("pos_sales").update({
          status: "paid", tender_method: "card",
          confirmed_at: new Date().toISOString(), stripe_payment_intent: pi.id,
        }).eq("id", fSale);
        if (!upd.error) { paid = true; await sendReceipt(fSale); }
      }
      // Outside the flip on purpose: the webhook can win the race and mark
      // the sale paid first, and the registrations still have to follow.
      if (paid) await confirmRegistrations(admin, fSale);
      // The family's testing code, shown on the page as soon as it is good.
      const dc = paid
        ? await admin.from("discount_codes").select("code").eq("source_sale_id", fSale).maybeSingle()
        : { data: null };
      return json({ ok: true, paid: true, receipt_url: SITE + "/invoice/?t=" + sale.data.view_token,
        testing_code: dc.data?.code ?? null, testing_pct_off: TOURNAMENT.testingPctOff }, 200, cors);
    }

    // -- a new signup ------------------------------------------------------
    if (!pageLive) return json({ error: "Tournament registration is not open right now." }, 503, cors);

    const saleId = str(body.sale_id).toLowerCase();
    if (!UUID_RE.test(saleId)) return json({ error: "Bad signup id. Reload the page." }, 400, cors);

    const parentFirst = str(body.parent_first), parentLast = str(body.parent_last);
    const email = str(body.email).toLowerCase(), phone = str(body.phone);
    const comments = str(body.comments).slice(0, 2000);

    if (!parentFirst || !parentLast) return json({ error: "Enter your first and last name." }, 400, cors);
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "Enter a valid email." }, 400, cors);
    if (!phone || phone.length > 40) return json({ error: "Enter a phone number." }, 400, cors);

    const rawStudents = Array.isArray(body.students) ? body.students : [];
    if (!rawStudents.length) return json({ error: "Add at least one competitor." }, 400, cors);
    if (rawStudents.length > 8) {
      return json({ error: "That is more competitors than one checkout takes. Please call us." }, 400, cors);
    }

    type Seat = {
      first: string; last: string; division: typeof DIVISIONS[number];
      rank: string; dob: string; age: number; gender: string; height: number;
      board: boolean; shirt: string;
    };
    const seats: Seat[] = [];
    for (const raw of rawStudents) {
      const r = raw as Record<string, unknown>;
      const first = str(r.first).slice(0, 60), last = str(r.last).slice(0, 60);
      const who = first || "each competitor";
      if (!first || !last) return json({ error: "Every competitor needs a first and last name." }, 400, cors);
      const division = DIVISIONS.find((d) => d.key === str(r.division));
      if (!division) return json({ error: "Pick a division for " + who + "." }, 400, cors);
      const rank = str(r.rank);
      const ladder = division.program === "Cubs" ? CUB_RANKS : TKD_RANKS;
      if (!ladder.includes(rank)) return json({ error: "Pick the belt " + who + " will have on the tournament day." }, 400, cors);
      const dob = str(r.dob);
      const age = parseYmd(dob) ? ageOn(dob, TOURNAMENT.date) : null;
      if (age == null || dob > todayCT() || age < 3 || age > 100) {
        return json({ error: "Enter a real date of birth for " + who + "." }, 400, cors);
      }
      const gender = str(r.gender);
      if (!GENDERS.includes(gender)) return json({ error: "Pick a gender for " + who + "." }, 400, cors);
      const height = Math.round(Number(r.height_in));
      if (!(height >= MIN_HEIGHT_IN && height <= MAX_HEIGHT_IN)) {
        return json({ error: "Pick a height for " + who + "." }, 400, cors);
      }
      const shirt = str(r.shirt);
      if (shirt && !SHIRT_SIZES.includes(shirt)) return json({ error: "Pick a shirt size for " + who + "." }, 400, cors);
      seats.push({ first, last, division, rank, dob, age, gender, height, board: r.board === true, shirt });
    }

    const familyShirts = (Array.isArray(body.family_shirts) ? body.family_shirts : []).map(str).filter(Boolean);
    if (familyShirts.length > MAX_FAMILY_SHIRTS) {
      return json({ error: "That is more shirts than one checkout takes. Please call us." }, 400, cors);
    }
    if (familyShirts.some((s: string) => !SHIRT_SIZES.includes(s))) {
      return json({ error: "Pick a size for every family shirt." }, 400, cors);
    }

    // -- idempotency: a resubmit returns the same intent --------------------
    const existing = await admin.from("pos_sales")
      .select("id,view_token,status,total_cents,stripe_payment_intent").eq("id", saleId).maybeSingle();
    if (existing.data) {
      if (existing.data.status === "paid") {
        return json({ ok: true, paid: true, receipt_url: SITE + "/invoice/?t=" + existing.data.view_token }, 200, cors);
      }
      if (secretKey && existing.data.stripe_payment_intent) {
        const pi0 = await stripe("payment_intents/" + encodeURIComponent(existing.data.stripe_payment_intent)
          + "?expand[]=latest_charge.payment_method_details",
          secretKey, undefined, "GET");
        if (pi0.status !== "succeeded" && pi0.status !== "canceled") {
          return json({
            ok: true, client_secret: pi0.client_secret, payment_intent_id: pi0.id,
            sale_id: saleId, total_cents: existing.data.total_cents,
          }, 200, cors);
        }
      }
      // Never "ok" with a receipt and no way to pay: the page treats a
      // missing client_secret as a finished sale (2026-08-26, cubs-checkout).
      if (secretKey) {
        try {
          const rf = new URLSearchParams();
          rf.set("amount", String(existing.data.total_cents));
          rf.set("currency", "usd");
          rf.set("payment_method_types[]", "card");
          rf.set("metadata[sale_id]", saleId);
          rf.set("metadata[source]", "tournament-checkout");
          const rpi = await stripe("payment_intents", secretKey, rf);
          const st = await admin.from("pos_sales")
            .update({ stripe_payment_intent: rpi.id }).eq("id", saleId);
          if (st.error) console.error("retry intent stamp failed", saleId, st.error);
          return json({ ok: true, client_secret: rpi.client_secret, payment_intent_id: rpi.id,
            sale_id: saleId, total_cents: existing.data.total_cents,
            receipt_url: SITE + "/invoice/?t=" + existing.data.view_token }, 200, cors);
        } catch (e) {
          console.error("retry intent failed", saleId, e);
        }
      }
      return json({ error: "We could not start the payment. Please call 903-561-2966 and we will finish this for you." }, 503, cors);
    }

    // -- who is who. Exact SINGLE name match first, then within the payer's
    // own family, exactly as testing-checkout does it: a loose match would
    // file one student's registration on another student's record.
    const seatIds: (string | null)[] = [];
    for (const st of seats) {
      const m = await admin.from("contacts").select("id")
        .ilike("first_name", st.first).ilike("last_name", st.last).limit(2);
      seatIds.push((m.data ?? []).length === 1 ? (m.data![0].id as string) : null);
    }
    if (seatIds.some((x) => !x)) {
      const norm = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
      const circle = new Map<string, { first: string; last: string }>();
      const own = await admin.from("contacts").select("id,first_name,last_name").ilike("email", email);
      for (const c of (own.data ?? []) as Record<string, any>[]) {
        circle.set(String(c.id), { first: String(c.first_name ?? ""), last: String(c.last_name ?? "") });
      }
      const gm2 = await admin.from("guardian_emails").select("guardian_id").ilike("email", email);
      const gids = (gm2.data ?? []).map((r: Record<string, unknown>) => String(r.guardian_id));
      if (gids.length) {
        const famKids = await admin.from("student_guardians")
          .select("student_id,contacts:student_id(first_name,last_name)").in("guardian_id", gids);
        for (const k of (famKids.data ?? []) as Record<string, any>[]) {
          if (k.contacts) circle.set(String(k.student_id),
            { first: String(k.contacts.first_name ?? ""), last: String(k.contacts.last_name ?? "") });
        }
      }
      for (let i = 0; i < seats.length; i++) {
        if (seatIds[i]) continue;
        const wantLast = norm(seats[i].last);
        const tokens = String(seats[i].first).toLowerCase().split(/\s+/)
          .map((t) => t.replace(/[^a-z]/g, "")).filter(Boolean);
        const hits: string[] = [];
        for (const [id, c] of circle) {
          if (norm(c.last) !== wantLast) continue;
          const cf = norm(c.first);
          const ok = tokens.some((t) => t === cf
            || (t.length >= 3 && cf.startsWith(t))
            || (cf.length >= 3 && t.startsWith(cf)));
          if (ok) hits.push(id);
        }
        if (hits.length === 1) seatIds[i] = hits[0];
      }
    }

    // One seat per competitor. A second paid entry for the same student is a
    // double charge, so it stops here, before anything is written.
    for (let i = 0; i < seats.length; i++) {
      const id = seatIds[i];
      if (!id) continue;
      if (seatIds.indexOf(id) !== i) {
        return json({ error: seats[i].first + " is on this signup twice." }, 400, cors);
      }
      const held = await admin.from("event_registrations").select("id")
        .eq("event_id", TOURNAMENT.eventId).eq("contact_id", id).eq("status", "registered").limit(1);
      if ((held.data ?? []).length) {
        return json({ error: seats[i].first + " " + seats[i].last + " is already registered for the tournament." }, 409, cors);
      }
    }

    // -- the money ----------------------------------------------------------
    type Line = { label: string; cents: number; taxable: boolean; seat: number | null; kind: "event" | "prod"; note: string | null };
    const items: Line[] = [];
    seats.forEach((s, i) => {
      const name = s.first + " " + s.last;
      items.push({
        kind: "event", seat: i, cents: s.division.cents, taxable: ENTRY_TAXABLE,
        label: TOURNAMENT.short + " " + s.division.label + " entry - " + name,
        // What Race needs to enter this competitor with the host, folded
        // under the line on the invoice.
        note: [s.rank, "Age " + s.age + " on tournament day", heightLabel(s.height), s.gender,
          "Born " + usDate(s.dob)].join(" · "),
      });
      if (s.board) items.push({ kind: "event", seat: i, cents: BOARD_CENTS, taxable: ENTRY_TAXABLE,
        label: TOURNAMENT.short + " board breaking - " + name, note: null });
      if (s.shirt) items.push({ kind: "prod", seat: i, cents: SHIRT_CENTS, taxable: SHIRT_TAXABLE,
        label: TOURNAMENT.short + " T-shirt (" + s.shirt + ") - " + name, note: null });
    });
    familyShirts.forEach((size: string) => items.push({ kind: "prod", seat: null, cents: SHIRT_CENTS,
      taxable: SHIRT_TAXABLE, label: TOURNAMENT.short + " T-shirt (" + size + ") - family", note: null }));

    const lines = items.map((x) => ({ cents: x.cents, taxable: x.taxable }));
    // Gross up on what Race must NET: the entries PLUS the sales tax on the
    // shirts, because Stripe takes its percentage of the whole charge.
    const preFee = BTKDPricing.invoiceTotals({
      lines, discountCents: 0, adminFeeCents: 0, taxRate: TAX_RATE,
    });
    const fee = adminFeeCents(preFee.totalCents, feeBps, feeFlat);   // card-only online
    const totals = BTKDPricing.invoiceTotals({
      lines, discountCents: 0, adminFeeCents: fee, taxRate: TAX_RATE,
    });

    // -- whose sale it is. Never a new contact: these are students already
    // on the roll. Same fallbacks as testing-checkout.
    let buyerId: string | null = null;
    const buyerMatch = await admin.from("contacts").select("id").ilike("email", email).limit(2);
    if ((buyerMatch.data ?? []).length === 1) buyerId = buyerMatch.data![0].id as string;
    if (!buyerId) buyerId = seatIds.find((x) => x) ?? null;
    if (!buyerId) {
      const bg = await admin.from("guardian_emails").select("guardian_id").ilike("email", email).limit(2);
      if ((bg.data ?? []).length === 1) {
        const kid = await admin.from("student_guardians").select("student_id")
          .eq("guardian_id", bg.data![0].guardian_id).limit(1);
        if ((kid.data ?? []).length === 1) buyerId = kid.data![0].student_id as string;
      }
    }

    const parentName = (parentFirst + " " + parentLast).trim();
    const noteLines = seats.map((s) => "  " + s.first + " " + s.last + ": " + s.division.label + ", " + s.rank
      + (s.board ? ", board breaking" : "") + (s.shirt ? ", shirt " + s.shirt : ""));
    if (familyShirts.length) noteLines.push("  Family shirts: " + familyShirts.join(", "));

    const problems: string[] = [];

    // The family's testing code, made before the sale so the receipt can
    // carry it. It is good only once this sale is paid (testing-checkout
    // checks), so an abandoned checkout leaves a code that never works.
    let testingCode: string | null = null;
    for (let tries = 0; tries < 4 && !testingCode; tries++) {
      const c = makeCode();
      const ins = await admin.from("discount_codes").insert({
        code: c, kind: "testing", pct_off: TOURNAMENT.testingPctOff, testing_cycle: TOURNAMENT.testingCycle,
        note: TOURNAMENT.short + " family: " + parentName,
      });
      if (!ins.error) testingCode = c;
    }
    if (!testingCode) problems.push("testing code: none made");

    const saleIns = await admin.from("pos_sales").insert({
      id: saleId, buyer_contact_id: buyerId, payer_name: parentName || null, sale_date: todayCT(),
      staff_email: "tournament-checkout@website", brand: "btkd",
      // pending_payment, not unpaid: an abandoned checkout must not leave a
      // debt on anybody's profile. Payment flips it paid; the sweep abandons
      // it after 24h.
      tender_method: null, status: "pending_payment",
      subtotal_cents: totals.subtotalCents, discount_cents: 0,
      admin_fee_cents: fee, tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      payer_email: email,
      calendar_url: googleCalUrl(),
      // What the PARENT reads on their receipt.
      customer_note:
        "You're registered for the " + TOURNAMENT.name + ".\n\n"
        + noteLines.join("\n") + "\n\n"
        + prettyDay(TOURNAMENT.date) + ", " + TOURNAMENT.date.slice(0, 4) + "\n"
        + TOURNAMENT.venue + "\n" + TOURNAMENT.address + "\n\n"
        + "Each competitor's time is sent two days before the tournament. Competition takes 60 to 90 minutes on average.\n"
        + "Spectators are $10 at the door, free under 4.\n"
        + (testingCode
          ? "\nTesting discount: the tournament falls on testing day, so your family gets " + TOURNAMENT.testingPctOff
            + "% off November belt testing, for everyone in the family. Use code " + testingCode
            + " at " + SITE + "/testing-checkout/\n"
          : "")
        + "\nQuestions? Call 903-561-2966 or just reply to this email.",
      notes: "Tournament signup from the website, " + seats.length + " competitor"
        + (seats.length === 1 ? "" : "s") + ", paid by " + parentName
        + (comments ? " | parent comments: " + comments : ""),
    }).select("view_token").single();
    if (saleIns.error) throw saleIns.error;
    const token = saleIns.data.view_token as string;
    if (testingCode) {
      const tie = await admin.from("discount_codes").update({ source_sale_id: saleId }).eq("code", testingCode);
      if (tie.error) problems.push("testing code: " + tie.error.message);
    }

    // -- ledger line detail --------------------------------------------------
    const lineRows = items.map((x) => ({
      sale_id: saleId, kind: x.kind, label: x.label,
      qty: 1, unit_cents: x.cents, discount_cents: 0,
      taxable: x.taxable, line_total_cents: x.cents,
      // The competitor the line is FOR, so the invoice shows on their profile.
      student_contact_id: x.seat == null ? null : seatIds[x.seat],
      event_id: x.kind === "event" ? TOURNAMENT.eventId : null,
      note: x.note,
      product_id: null, membership_row: null, membership_id: null,
    }));
    const lIns = await admin.from("pos_sale_lines").insert(lineRows);
    if (lIns.error) problems.push("sale lines: " + lIns.error.message);

    // -- the registrations, pending until the money lands -------------------
    const regRows = seats.map((s, i) => ({
      event_id: TOURNAMENT.eventId,
      contact_id: seatIds[i],
      student_name: s.first + " " + s.last,
      buyer_contact_id: buyerId,
      sale_id: saleId,
      source: "website",
      status: "pending",
      note: [s.division.label, s.rank, "age " + s.age, heightLabel(s.height), s.gender,
        "born " + usDate(s.dob)].concat(s.board ? ["board breaking"] : [])
        .concat(s.shirt ? ["shirt " + s.shirt] : []).join(" · "),
      details: {
        division: s.division.key, division_label: s.division.label, rank: s.rank,
        dob: s.dob, age_on_day: s.age, height_in: s.height, gender: s.gender,
        board_breaking: s.board, shirt: s.shirt || null,
      },
    }));
    const rIns = await admin.from("event_registrations").insert(regRows);
    if (rIns.error) problems.push("registrations: " + rIns.error.message);

    if (problems.length) console.error("[tournament-checkout] partial writes:", saleId, problems);

    // -- payment, taken on this page ---------------------------------------
    if (!secretKey) {
      console.error("[tournament-checkout] STRIPE_SECRET_KEY missing - refusing to imply registration");
      return json({ error: "Card payments are not available right now. Please call 903-561-2966 and we will finish this for you." }, 503, cors);
    }
    // The card belongs to the family's guardian, never to a kid
    // (_shared/family.ts), and stays on file like every other rail.
    const fam = await familyCustomer(admin, stripe, secretKey,
      { email, name: parentName, phone, studentId: buyerId });
    await admin.from("pos_sales").update({ stripe_customer_id: fam.custId }).eq("id", saleId);

    const f = new URLSearchParams();
    f.set("amount", String(totals.totalCents));
    f.set("currency", "usd");
    f.set("payment_method_types[]", "card");
    f.set("description", TOURNAMENT.name + " - " + seats.map((s) => s.first + " " + s.last).join(", "));
    f.set("receipt_email", email);
    f.set("customer", fam.custId);
    f.set("setup_future_usage", "off_session");
    f.set("metadata[sale_id]", saleId);
    f.set("metadata[source]", "tournament-checkout");
    const pi = await stripe("payment_intents", secretKey, f);
    const piStamp = await admin.from("pos_sales")
      .update({ stripe_payment_intent: pi.id }).eq("id", saleId);
    if (piStamp.error) console.error("payment intent stamp FAILED", saleId, piStamp.error);

    return json({
      ok: true,
      client_secret: pi.client_secret,
      payment_intent_id: pi.id,
      sale_id: saleId,
      total_cents: totals.totalCents,
      receipt_url: SITE + "/invoice/?t=" + token,
    }, 200, cors);
  } catch (e) {
    // A parent must never see a database error. The detail is logged here,
    // never returned.
    console.error("[tournament-checkout] failed:", e);
    return json({ error: "Could not complete the signup. Please try again or call us." }, 500, cors);
  }
});
