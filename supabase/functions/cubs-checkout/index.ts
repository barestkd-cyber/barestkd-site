// ===========================================================================
// Supabase Edge Function: cubs-checkout - public Cubs membership enrollment
// ---------------------------------------------------------------------------
// The second self-serve checkout page (LK was the prototype), and the first
// with a PAYMENT OPTION PICKER: the buyer chooses Paid in Full, a
// down+monthly option, or weekly, signs the Cubs agreement with that
// option's amounts filled in, and pays today's amount on the page. The card
// attaches to a Stripe customer with setup_future_usage, so the recurring
// payments the buyer just agreed to can be charged later without them.
//
// Owner's architecture (2026-08-17): checkout pages are how people join when
// they are NOT at the studio. They pick their own option; nobody plays
// email-tag about prices. An invoice is the RESULT of a purchase, never the
// way in.
//
// GET  -> { options } from the live Cubs catalog rows + fee settings, so a
//         price change in the CRM shows here on the next page load.
// POST -> validates the chosen plan_code against those same rows, re-derives
//         every amount with the vendored pricing engine, then writes:
//         contact + guardian + sale + membership snapshot + SIGNED agreement
//         + lines + roster, and returns a PaymentIntent for the page to
//         confirm. finalize verifies with Stripe and records the money.
//
// HARD RULES (same as lk-checkout / pos-sale):
//   * The client sends CHOICES (a plan code), never amounts.
//   * The stored agreement is OUR render of OUR template with OUR numbers.
//   * sale_id is client-minted and idempotent: resubmits return the same
//     sale and its live PaymentIntent instead of enrolling twice.
//
// Deploy, from the barestkd-site repo root (public - the page calls it):
//   supabase functions deploy cubs-checkout --no-verify-jwt
// After attorney or engine changes: node tools/vendor-lk.js, then redeploy.
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";
import { familyCustomer, findOrCreateGuardian } from "../_shared/family.ts";
import CUBS_TEMPLATE from "../_shared/cubs_agreement.js";

const PROGRAM = "Cubs";
const UNIFORM_NAME = "Cubs uniform";
// The enrollment shirt offer. Half price ONLY through a checkout page, so
// the discount is computed here and never sent by the browser.
// Every shirt sellable at enrollment. The classic gray is the featured offer
// at half price; the rest are full price behind "See other shirts". Race sells
// more merch when it is in front of people, so the others are one tap away
// rather than absent.
const TEE_NAME = "Classic gray tee";          // the featured, discounted one
const TEE_DISCOUNT_BPS = 5000;                // 50% off, enrollment only
const SHIRT_NAMES = ["Classic gray tee", "Lego tee", "Alternate design tee"];
const SHIRT_ART: Record<string, { front: string; back: string | null }> = {
  "Classic gray tee": { front: "/assets/img/logo.png", back: "/assets/img/shirts/art-bear-patch.png" },
  "Lego tee":         { front: "/assets/img/shirts/art-lego.jpg", back: null },
  "Alternate design tee":   { front: "/assets/img/shirts/art-bares-bar.jpg", back: null },
};
const SHIRT_COLOR: Record<string, string> = {
  "Classic gray tee": "#B4B6B9", "Lego tee": "#1F51A8", "Alternate design tee": "#141414",
};
const TAX_RATE = 0.0825;          // memberships are untaxed; kept for shape
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const money = (c: number) => "$" + (c / 100).toFixed(2);
const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const fmtMDY = (ymd: string) => { const p = ymd.split("-"); return p.length === 3 ? `${p[1]}-${p[2]}-${p[0]}` : ymd; };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
/* The contractual payment date for the chosen cadence, from the signup date.
 * Monthly bills on the signup day-of-month (anniversary), weekly on the
 * signup weekday. Paid in Full has no recurring date. */
function agreedPaymentDate(freq: string, ymd: string): string | null {
  const p = ymd.split("-").map(Number);
  if (freq === "monthly") return "the " + ordinal(p[2]) + " of each month";
  if (freq === "weekly") return "each " + DAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  return null;
}

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

/** Fire the receipt server-to-server; never throws into the payment path. */
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

type PlanRow = {
  id: string; code: string; name: string; billing_frequency: string;
  recurring_cents: number | null; down_cents: number | null;
  pif_cents: number | null; payment_count: number | null;
};

/* One fee-table line per catalog option, exactly the shape the printed
 * agreement uses. The docx keeps blanks; the numbers come from the catalog. */
function optionLine(p: PlanRow): string {
  if (p.billing_frequency === "one_time") {
    return p.name + " is a " + String(CUBS_TEMPLATE.fees.pifText).replace("{{pif}}", money(p.pif_cents || 0)).toLowerCase();
  }
  const unit = p.billing_frequency === "weekly" ? "weekly" : "monthly";
  return p.name + " is a down payment of " + money(p.down_cents || 0)
    + " and a " + unit + " payment of " + money(p.recurring_cents || 0) + ".";
}

/* Freeze the agreement into plain text - the document of record stored with
 * the signature. Lists EVERY option like the paper form, then records which
 * one was selected, with initials and the agreed payment date. */
function buildBodyText(ctx: {
  participant: string; dob: string; guardian: string; today: string;
  options: PlanRow[]; chosen: PlanRow; payDate: string | null;
  initials: string; signerName: string; signerRelationship: string;
}): string {
  const tpl = CUBS_TEMPLATE;
  const out: string[] = [];
  out.push("Grizzly Martial Arts & Fitness LLC");
  out.push("doing business as Bares Taekwondo Fitness");
  out.push(String(tpl.title).toUpperCase());
  out.push("");
  out.push("Participant (Student) Name: " + ctx.participant);
  out.push("Date of Birth: " + ctx.dob);
  out.push("Parent / Guardian: " + ctx.guardian);
  out.push("Today's Date: " + ctx.today);
  out.push("Membership Start Date: " + ctx.today);
  out.push("");
  out.push("FEES");
  for (const p of ctx.options) out.push(optionLine(p));
  out.push("");
  out.push("Selected option: " + ctx.chosen.name
    + "   Initials: " + ctx.initials
    + "   Payment date: " + (ctx.payDate ?? "none (paid in full)"));
  for (const line of tpl.feesTail as string[]) out.push(line);
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
  const pageRow = await admin.from("checkout_pages").select("live").eq("slug", "cubs").maybeSingle();
  const pageLive = !pageRow.data || pageRow.data.live !== false;
  const closedMsg = "Cubs" + " enrollment is closed right now. Call 903-561-2966.";

  // ── the live catalog: both verbs price from the same rows ────────────────
  const plansRes = await admin.from("pricing_plans")
    .select("id,code,name,billing_frequency,recurring_cents,down_cents,pif_cents,payment_count,promo_label,sellable,active,display_order")
    .eq("program", PROGRAM).eq("sellable", true).eq("active", true)
    .order("display_order");
  const options = (plansRes.data ?? []) as (PlanRow & { sellable: boolean; active: boolean; display_order: number })[];
  if (!options.length) return json({ error: "Cubs enrollment isn't open right now. Call 903-561-2966." }, 503, cors);

  const teeRes = await admin.from("products")
    .select("id,name,price_cents,taxable,active")
    .in("name", SHIRT_NAMES).eq("active", true);
  const shirtRows = teeRes.data ?? [];
  const shirtPrice = (r: { name: string; price_cents: number }) =>
    r.name === TEE_NAME ? Math.round(r.price_cents * (10000 - TEE_DISCOUNT_BPS) / 10000) : r.price_cents;
  const tee = shirtRows.find((r: { name: string }) => r.name === TEE_NAME) ?? null;
  const teeFull = tee ? tee.price_cents : 0;
  const teeNow = tee ? shirtPrice(tee) : 0;

  const uniRes = await admin.from("products")
    .select("id,name,price_cents,taxable,active")
    .eq("name", UNIFORM_NAME).eq("active", true).maybeSingle();
  const uniform = uniRes.data ?? null;

  const setRes = await admin.from("pricing_settings").select("key,value_cents")
    .in("key", ["admin_fee_bps", "admin_fee_flat_cents"]);
  const settings: Record<string, number> = {};
  (setRes.data ?? []).forEach((r: { key: string; value_cents: number }) => settings[r.key] = r.value_cents);
  const feeBps = settings.admin_fee_bps ?? 290;
  const feeFlat = settings.admin_fee_flat_cents ?? 30;

  const dueFor = (p: PlanRow) =>
    p.billing_frequency === "one_time" ? (p.pif_cents || 0) : (p.down_cents || 0) + (p.recurring_cents || 0);

  let reqBody: Record<string, unknown> = {};
  try {
    if (req.method === "GET") {
      if (!pageLive) return json({ error: closedMsg, closed: true }, 503, cors);
      return json({
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? null,
        program: PROGRAM,
        options: options.map((p) => ({
          code: p.code, name: p.name, billing_frequency: p.billing_frequency,
          down_cents: p.down_cents || 0, recurring_cents: p.recurring_cents || 0,
          pif_cents: p.pif_cents || 0, payment_count: p.payment_count,
          due_today_cents: dueFor(p),
          promo: p.promo_label || null,
        })),
        uniform_available: !!uniform,
        uniform_cents: uniform ? uniform.price_cents : 0,
        tee_available: !!tee,
        tee_full_cents: teeFull,
        tee_cents: teeNow,
        tee_sizes: ["Youth XS", "Youth S", "Youth M", "Youth L", "Adult S", "Adult M", "Adult L", "Adult XL", "Adult 2XL"],
        shirts: shirtRows.map((r: { id: string; name: string; price_cents: number }) => ({
          name: r.name,
          full_cents: r.price_cents,
          cents: shirtPrice(r),
          featured: r.name === TEE_NAME,
          front: SHIRT_ART[r.name] ? SHIRT_ART[r.name].front : null,
          back: SHIRT_ART[r.name] ? SHIRT_ART[r.name].back : null,
          color: SHIRT_COLOR[r.name] || "#B4B6B9",
        })).sort((a: { featured: boolean }, b: { featured: boolean }) => (a.featured ? -1 : 0) - (b.featured ? -1 : 0)),
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        tax_rate: TAX_RATE,
        agreement_version: CUBS_TEMPLATE.version,
      }, 200, cors);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    const body = await req.json().catch(() => ({}));
    reqBody = body;
    if (str(body.hp)) return json({ ok: true }, 200, cors); // honeypot
    if (!pageLive && str(body.action) !== "finalize") return json({ error: closedMsg, closed: true }, 503, cors);
    const secretKey = Deno.env.get("STRIPE_SECRET_KEY");

    // ── finalize: verify with STRIPE, then record ──────────────────────────
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

    // ── the enrollment itself ──────────────────────────────────────────────
    const saleId = str(body.sale_id).toLowerCase();
    if (!UUID_RE.test(saleId)) return json({ error: "Bad enrollment id. Reload the page." }, 400, cors);

    const chosen = options.find((p) => p.code === str(body.plan_code));
    if (!chosen) return json({ error: "Pick a payment option." }, 400, cors);

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
    const initials = str(body.initials).toUpperCase();
    const signerName = str(body.signer_name), signerRel = str(body.signer_relationship) || "Parent";
    const signature = str(body.signature_png);

    if (!studentFirst || !studentLast) return json({ error: "Enter the student's name." }, 400, cors);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return json({ error: "Enter the student's date of birth." }, 400, cors);
    // Cubs is ages 3-4: the guardian is the contracting adult, always.
    if (!parentFirst || !parentLast) return json({ error: "Enter the parent or guardian's name." }, 400, cors);
    if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email." }, 400, cors);
    if (!phone) return json({ error: "Enter a phone number." }, 400, cors);
    if (!address) return json({ error: "Enter your home address." }, 400, cors);
    if (!/^[A-Z.]{2,6}$/.test(initials)) return json({ error: "Enter the signer's initials (2 to 4 letters)." }, 400, cors);
    if (!signerName) return json({ error: "Enter the signature name." }, 400, cors);
    if (body.agreed !== true) return json({ error: "The agreement box must be checked." }, 400, cors);
    if (!signature.startsWith("data:image/png;base64,") || signature.length < 200 || signature.length > 200000) {
      return json({ error: "Please sign in the signature box." }, 400, cors);
    }

    // Idempotency: a resubmit returns the SAME sale and a usable intent.
    // Only reuse a payment that was priced for the SAME plan. Switching
    // options after a decline used to hand back the old PaymentIntent,
    // charging the old amount while the membership and the signed
    // agreement kept the plan the buyer had moved off.
    const priorMem = await admin.from("memberships")
      .select("plan_code").eq("sale_id", saleId).limit(1).maybeSingle();
    if (priorMem.data && priorMem.data.plan_code && priorMem.data.plan_code !== chosen.code) {
      return json({
        error: "Your selection changed. Please reload the page and start again.",
        reload: true,
      }, 409, cors);
    }

    const existing = await admin.from("pos_sales")
      .select("id,view_token,status,total_cents,stripe_payment_intent").eq("id", saleId).maybeSingle();
    if (existing.data) {
      if (existing.data.status === "paid") {
        return json({ ok: true, paid: true, receipt_url: `${SITE}/invoice/?t=${existing.data.view_token}` }, 200, cors);
      }
      if (secretKey && existing.data.stripe_payment_intent) {
        const pi0 = await stripe("payment_intents/" + encodeURIComponent(existing.data.stripe_payment_intent), secretKey, undefined, "GET");
        if (pi0 && (pi0.status === "requires_payment_method" || pi0.status === "requires_confirmation" || pi0.status === "requires_action")) {
          return json({ ok: true, client_secret: pi0.client_secret, payment_intent_id: pi0.id, sale_id: saleId, total_cents: existing.data.total_cents }, 200, cors);
        }
      }
      // NOT "ok" with a receipt and no way to pay. The page reads a missing
      // client_secret as a finished sale, so this branch used to tell an
      // unpaid customer they were enrolled - which is how a family was told
      // their son had a place after three failed attempts (2026-08-26).
      //
      // An unpaid sale with no usable intent gets a FRESH one, so the retry
      // does what the customer is trying to do: pay.
      if (secretKey) {
        try {
          const rf = new URLSearchParams();
          rf.set("amount", String(existing.data.total_cents));
          rf.set("currency", "usd");
          rf.set("payment_method_types[]", "card");
          rf.set("metadata[sale_id]", saleId);
          rf.set("metadata[source]", "RETRY_SRC");
          const rpi = await stripe("payment_intents", secretKey, rf);
          const st = await admin.from("pos_sales")
            .update({ stripe_payment_intent: rpi.id }).eq("id", saleId);
          if (st.error) console.error("retry intent stamp failed", saleId, st.error);
          return json({ ok: true, client_secret: rpi.client_secret, payment_intent_id: rpi.id,
            sale_id: saleId, total_cents: existing.data.total_cents }, 200, cors);
        } catch (e) {
          console.error("retry intent failed", saleId, e);
        }
      }
      // Payments genuinely unavailable: say so plainly rather than implying
      // the enrollment went through.
      return json({ error: "We could not start the payment. Please call 903-561-2966 and we will finish this for you." }, 503, cors);
    }

    // ── price it OURSELVES with the engine the POS uses ────────────────────
    const calc = BTKDPricing.calculatePrice({
      plan: chosen, settings, person: { contact_id: null, activeMemberships: [] },
      householdMembers: [], plans: [chosen],
    });
    if (!calc.eligible) return json({ error: "That option can't be sold right now." }, 409, cors);
    const due = BTKDPricing.dueTodayCents(calc, null);   // down + first payment; PIF = the full amount
    // The uniform is a normal taxable product riding the same invoice.
    const wantUniform = body.uniform === true && !!uniform;
    if (body.uniform === true && !uniform) {
      return json({ error: "The uniform is not available right now. Uncheck it to continue." }, 409, cors);
    }
    const uniformCents = wantUniform ? uniform.price_cents : 0;

    // Shirts: a list of { name, size }. Prices come from the catalog here, so
    // the discount on the featured shirt can never be claimed for the others.
    const wantShirts: Array<{ row: { id: string; name: string; price_cents: number }; size: string; cents: number }> = [];
    const rawShirts = Array.isArray(body.shirts) ? body.shirts : [];
    for (const raw of rawShirts.slice(0, 6)) {
      const nm = str((raw as { name?: unknown }).name);
      const sz = str((raw as { size?: unknown }).size);
      const row = shirtRows.find((r: { name: string }) => r.name === nm);
      if (!row) return json({ error: "That shirt is not available. Remove it to continue." }, 409, cors);
      if (!sz) return json({ error: "Pick a size for the " + row.name + "." }, 400, cors);
      wantShirts.push({ row, size: sz, cents: shirtPrice(row) });
    }
    const shirtsCents = wantShirts.reduce((a, x) => a + x.cents, 0);

    const lines = [{ cents: due, taxable: false }];
    if (wantUniform) lines.push({ cents: uniformCents, taxable: true });
    wantShirts.forEach((x) => lines.push({ cents: x.cents, taxable: true }));
    const fee = adminFeeCents(due + uniformCents + shirtsCents, feeBps, feeFlat);   // card-only online, fee always rides
    const totals = BTKDPricing.invoiceTotals({
      lines, discountCents: 0, adminFeeCents: fee, taxRate: TAX_RATE,
    });

    const today = todayCT();
    const payDate = agreedPaymentDate(chosen.billing_frequency, today);
    const problems: string[] = [];

    // 1. The student. Email and phone are the guardian's: for a 3-year-old
    //    the guardian IS the contact channel.
    const contactIns = await admin.from("contacts").insert({
      first_name: studentFirst, last_name: studentLast,
      segment: "lead", member_role: "student",
      source: "website-cubs-checkout", entered_on: today,
      dob, address,
      // NOT email or phone: those belong to the PARENT, who is collected
      // in the guardian block below and gets them there. Putting them on
      // the child made familyCustomer read the kid as the payer and file
      // the family card on a four-year-old (Cody Mogle, 2026-08-26).
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

    // 3. The sale header FIRST (memberships carry sale_id).
    const monthlyLine = chosen.billing_frequency === "one_time"
      ? "Paid in full today. No recurring payments."
      : "After today, your " + (chosen.billing_frequency === "weekly" ? "weekly" : "monthly")
        + " payment is " + money(chosen.recurring_cents || 0) + ", due " + payDate + ".";
    const saleIns = await admin.from("pos_sales").insert({
      id: saleId, buyer_contact_id: studentId, payer_name: guardianName || null, payer_email: email || null, sale_date: today,
      staff_email: "cubs-checkout@website", brand: "btkd",
      // pending_payment, not unpaid: an abandoned checkout must not leave a
      // debt on anybody\u0027s profile (owner 2026-08-25). Payment flips it
      // paid; the sweep abandons it after 24h.
      tender_method: null, status: "pending_payment",
      subtotal_cents: totals.subtotalCents, discount_cents: 0,
      admin_fee_cents: fee, tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      customer_note:
        studentFirst + " is enrolled in Cubs.\n\n"
        + "Your plan: " + chosen.name + "\n"
        + "Today you paid " + money(totals.totalCents) + " (includes card processing).\n"
        + monthlyLine + "\n\n"
        + "Class times: barestkd.fit/schedule\n"
        + "1901 Deerbrook Dr, Tyler\n\n"
        + (wantUniform
            ? "Your Cubs uniform is paid for. We'll have it ready at the first class.\n"
            : "Wear comfortable clothes for the first class. Uniforms are available at the front desk.\n")
        + (wantShirts.length
            ? "Shirts paid for and ready at the first class: "
              + wantShirts.map((x) => x.row.name + " (" + x.size + ")").join(", ") + "\n"
            : "")
        + "\nQuestions? Call 903-561-2966 or just reply to this email.",
      notes: "Cubs online enrollment, " + chosen.name
        + (wantUniform ? ", UNIFORM PURCHASED - have one ready" : "")
        + (wantShirts.length ? ", SHIRTS: " + wantShirts.map((x) => x.row.name + " " + x.size).join(", ") : "")
        + " (" + (chosen.billing_frequency === "one_time"
            ? money(chosen.pif_cents || 0) + " paid in full"
            : money(chosen.down_cents || 0) + " down + " + money(chosen.recurring_cents || 0)
              + "/" + (chosen.billing_frequency === "weekly" ? "wk" : "mo")) + ")",
    }).select("view_token").single();
    if (saleIns.error) throw saleIns.error;
    const token = saleIns.data.view_token as string;

    // 4. The membership - frozen snapshot of the CHOSEN option.
    const snap = BTKDPricing.buildMembershipSnapshot({
      calc, contactId: studentId, program: PROGRAM,
      startedOn: today, createdBy: "cubs-checkout (website)", override: null,
    });
    (snap as Record<string, unknown>).payment_count = chosen.payment_count;
    (snap as Record<string, unknown>).sale_id = saleId;
    (snap as Record<string, unknown>).status = "pending";
    const memIns = await admin.from("memberships").insert(snap).select("id").single();
    if (memIns.error) throw memIns.error;
    const membershipId = memIns.data.id as string;

    // 5. The signed agreement, frozen with the option they picked.
    const bodyText = buildBodyText({
      participant: studentFirst + " " + studentLast, dob: fmtMDY(dob),
      guardian: guardianName, today: fmtMDY(today),
      options, chosen, payDate, initials,
      signerName, signerRelationship: signerRel,
    });
    const agrIns = await admin.from("membership_agreements").insert({
      membership_id: membershipId, contact_id: studentId, sale_id: saleId,
      template_key: CUBS_TEMPLATE.key, template_version: CUBS_TEMPLATE.version,
      document_title: CUBS_TEMPLATE.title, program: PROGRAM,
      plan_code: chosen.code,
      body_json: {
        title: CUBS_TEMPLATE.title, version: CUBS_TEMPLATE.version,
        plan: { code: chosen.code, name: chosen.name },
        due_today_cents: due,
        participant: studentFirst + " " + studentLast, dob, guardian: guardianName,
        agreed_payment_date: payDate,
      },
      body_text: bodyText,
      down_cents: calc.finalDownCents ?? 0,
      recurring_cents: chosen.billing_frequency === "one_time" ? null : (calc.finalRecurringCents ?? null),
      pif_cents: chosen.billing_frequency === "one_time" ? (chosen.pif_cents || 0) : null,
      agreed_payment_date: payDate,
      signer_name: signerName, signer_relationship: signerRel, signer_initials: initials,
      signature_png: signature, signed_with_staff: "website checkout",
      user_agent: str(req.headers.get("User-Agent")).slice(0, 300),
    });
    if (agrIns.error) problems.push("agreement: " + agrIns.error.message);

    // 6. Ledger line.
    const lineRows: Record<string, unknown>[] = [{
      sale_id: saleId, kind: "mem", label: chosen.name, qty: 1,
      unit_cents: due, discount_cents: 0, taxable: false, line_total_cents: due,
      student_contact_id: studentId, product_id: null,
      membership_row: snap, membership_id: membershipId,
    }];
    if (wantUniform) {
      lineRows.push({
        sale_id: saleId, kind: "prod", label: uniform.name, qty: 1,
        unit_cents: uniformCents, discount_cents: 0, taxable: true, line_total_cents: uniformCents,
        student_contact_id: null, product_id: uniform.id, membership_row: null, membership_id: null,
      });
    }
    // Recorded honestly: full price with the discount alongside it, so the
    // ledger shows what was given away rather than a mystery cheap shirt.
    wantShirts.forEach((x) => {
      lineRows.push({
        sale_id: saleId, kind: "prod", label: x.row.name + " (" + x.size + ")", qty: 1,
        unit_cents: x.row.price_cents, discount_cents: x.row.price_cents - x.cents, taxable: true,
        line_total_cents: x.cents,
        student_contact_id: null, product_id: x.row.id, membership_row: null, membership_id: null,
      });
    });
    const lIns = await admin.from("pos_sale_lines").insert(lineRows);
    if (lIns.error) problems.push("sale lines: " + lIns.error.message);

    // 7. Class roster.
    const eIns = await admin.from("enrollments").insert({
      student_id: studentId, program: PROGRAM, status: "pending", sale_id: saleId,
    });
    if (eIns.error) problems.push("roster: " + eIns.error.message);

    if (problems.length) console.error("[cubs-checkout] partial writes:", saleId, problems);

    // 8. The payment, on this page. The card ATTACHES TO A CUSTOMER with
    //    setup_future_usage: the buyer just signed up for recurring payments,
    //    so the card must be chargeable later without them present.
    if (!secretKey) {
      // A missing key is OUR failure, not a completed enrollment. This used
      // to answer ok with a receipt and no client_secret, which the page
      // treats as done - so a key problem would have told every family they
      // were enrolled while charging nobody (2026-08-26).
      console.error("[cubs-checkout] STRIPE_SECRET_KEY missing - refusing to imply enrollment");
      return json({ error: "Card payments are not available right now. Please call 903-561-2966 and we will finish this for you." }, 503, cors);
    }
    // Whose card it is: the family\u0027s guardian, one shared answer for all
    // five checkouts (_shared/family.ts). The old block minted a customer
    // per sale and stamped it on the KID\u0027s contact row.
    const fam = await familyCustomer(admin, stripe, secretKey,
      { email, name: guardianName, phone, studentId });

    const f = new URLSearchParams();
    f.set("amount", String(totals.totalCents));
    f.set("currency", "usd");
    f.set("payment_method_types[]", "card");
    f.set("description", "Cubs (" + chosen.name + ") - " + studentFirst + " " + studentLast);
    f.set("receipt_email", email);
    f.set("customer", fam.custId);
    f.set("setup_future_usage", "off_session");
    f.set("metadata[sale_id]", saleId);
    f.set("metadata[source]", "cubs-checkout");
    const pi = await stripe("payment_intents", secretKey, f);
    const piStamp = await admin.from("pos_sales")
      .update({ stripe_payment_intent: pi.id, stripe_customer_id: fam.custId }).eq("id", saleId);
    // Checked, because when this failed silently the retry could not
    // find the intent and told the customer they were enrolled instead.
    if (piStamp.error) console.error("payment intent stamp FAILED", saleId, piStamp.error);

    return json({
      ok: true,
      client_secret: pi.client_secret,
      payment_intent_id: pi.id,
      sale_id: saleId,
      total_cents: totals.totalCents,
    }, 200, cors);
  } catch (e) {
    console.error("[cubs-checkout] failed:", e);
    const detail = (e as { message?: string })?.message || String(e);
    return json({
      error: "Could not complete enrollment. Please try again or call us.",
      // The detail is logged above, never returned to the caller.
    }, 500, cors);
  }
});
