// ===========================================================================
// Supabase Edge Function: program-checkout - public membership enrollment
// ---------------------------------------------------------------------------
// One implementation for every program that sells a membership self-serve.
// Grown from cubs-checkout, which stays on its own proven copy: replacing a
// function that is live and taking money buys nothing today. Folding Cubs in
// here is a clean follow-up once these pages have run.
//
// WHY NOT FOUR CLONES: the copy lint exists because cloning leaked Little
// Kickers wording into the Cubs page twice. Four hand-maintained copies of
// 600 lines is that same failure waiting to repeat, and every fix would need
// applying four times. Each program still gets its own URL and its own page
// copy; only the server logic is shared.
//
// The program is chosen by slug: ?p=juniors on GET, "p" in the POST body.
// Everything program-specific lives in PROGRAMS below and nowhere else.
//
// GET  -> that programs live catalog options, gear, and fee settings.
// POST -> contact + guardians + sale + frozen membership + SIGNED agreement
//         + lines + roster, then a PaymentIntent. Prices are re-derived here
//         every time; the client sends a plan code, never an amount.
// POST {action:"finalize"} -> re-reads the intent FROM STRIPE before
//         recording the payment.
//
// Deploy:  supabase functions deploy program-checkout --no-verify-jwt
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";
import TAEKWONDO_TEMPLATE from "../_shared/taekwondo_agreement.js";
import KICKBOXING_TEMPLATE from "../_shared/kickboxing_agreement.js";
import JIUJITSU_TEMPLATE from "../_shared/jiujitsu_agreement.js";
import AMPD_TEMPLATE from "../_shared/ampd_agreement.js";

type Tpl = typeof TAEKWONDO_TEMPLATE;
type ProgramCfg = {
  program: string;            // matches pricing_plans.program and enrollments.program
  label: string;              // how the program is named back to a buyer
  tpl: Tpl;                   // the attorney-approved document this program signs
  uniform: string | null;     // a products row name, or null where none is sold
  shirts: string[];           // shirts offered at enrollment, at catalog price
  featuredTee: string | null; // half-price enrollment special, or null
  guardianAlways: boolean;    // true where every student is a child
  // Programs this page can add to the primary membership. Each add-on is a
  // real membership of its own, but rides the PRIMARY agreement as a priced
  // line with its own initial, under the waiver, payment authorization and
  // cancellation terms already in that document.
  addOns?: { program: string; code: string }[];
  // Where every add-on is taken at once and the pair is priced as one rate.
  bothCode?: string;
};

/* The ONLY place a program differs. Adding one is a row here, a page, and a
 * copy-lint entry, never another copy of this file.
 *
 * Two programs are deliberately absent:
 *   AMPD                   - its only plan is the member add-on rate, which
 *                            assumes the buyer already holds their own
 *                            Taekwondo membership. A public page cannot know
 *                            that, so it would undercharge strangers. Needs a
 *                            standalone price before it can have a page.
 *   Kickboxing + Jiu Jitsu - no agreement document exists for the bundle. The
 *                            CRM already refuses to sell it under contract.
 *
 * featuredTee is null everywhere on purpose. The half-price gray tee is a
 * Cubs enrollment special, and extending a discount to other programs is the
 * owners call, not an implementation detail. */
const PROGRAMS: Record<string, ProgramCfg> = {
  "juniors": {
    program: "Juniors", label: "Juniors Taekwondo", tpl: TAEKWONDO_TEMPLATE,
    uniform: "Beginner uniform",
    shirts: ["Classic gray tee", "Lego tee", "Alternate design tee"],
    featuredTee: null, guardianAlways: true,
    addOns: [
      { program: "Kickboxing", code: "addon_kickboxing" },
      { program: "Jiu Jitsu", code: "addon_jiujitsu" },
    ],
    bothCode: "addon_both",
  },
  "teens-adults": {
    program: "Teens/Adults", label: "Teens and Adults Taekwondo", tpl: TAEKWONDO_TEMPLATE,
    uniform: "Beginner uniform",
    shirts: ["Classic gray tee", "Lego tee", "Alternate design tee"],
    featuredTee: null, guardianAlways: false,
    addOns: [
      { program: "Kickboxing", code: "addon_kickboxing" },
      { program: "Jiu Jitsu", code: "addon_jiujitsu" },
    ],
    bothCode: "addon_both",
  },
  "kickboxing": {
    program: "Kickboxing", label: "Kickboxing", tpl: KICKBOXING_TEMPLATE,
    uniform: null,
    shirts: ["Team Grizzly Kickboxing tee", "Classic gray tee"],
    featuredTee: null, guardianAlways: false,
    addOns: [{ program: "Jiu Jitsu", code: "specialty_second_jiujitsu" }],
  },
  // $50 a month for everyone: there is no member-versus-stranger rate here,
  // which is exactly why AMP'D can have a public page at all.
  "ampd": {
    program: "AMP'D", label: "AMP'D", tpl: AMPD_TEMPLATE,
    uniform: null,
    shirts: ["Classic gray tee"],
    featuredTee: null, guardianAlways: false,
  },
  "jiu-jitsu": {
    program: "Jiu Jitsu", label: "Jiu Jitsu", tpl: JIUJITSU_TEMPLATE,
    uniform: null,
    shirts: ["Classic gray tee"],
    featuredTee: null, guardianAlways: false,
    addOns: [{ program: "Kickboxing", code: "specialty_second_kickboxing" }],
  },
};

const SHIRT_ART: Record<string, { front: string; back: string | null }> = {
  "Classic gray tee": { front: "/assets/img/logo.png", back: "/assets/img/shirts/art-bear-patch.png" },
  "Lego tee":         { front: "/assets/img/shirts/art-lego.jpg", back: null },
  "Alternate design tee": { front: "/assets/img/shirts/art-bares-bar.jpg", back: null },
  "Team Grizzly Kickboxing tee": { front: "/assets/img/shirts/art-grizzly-kickboxing.jpg", back: null },
};
const SHIRT_COLOR: Record<string, string> = {
  "Classic gray tee": "#B4B6B9", "Lego tee": "#1F51A8",
  "Alternate design tee": "#141414", "Team Grizzly Kickboxing tee": "#141414",
};

/* Age in whole years on a yyyy-mm-dd, without new Date(str), which parses as
 * UTC and reads a day early in Central. Used to decide whether a buyer is an
 * adult enrolling themselves or an adult enrolling a child. */
function ageFrom(dob: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || ""));
  if (!m) return null;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const t = today.split("-").map(Number);
  let age = t[0] - Number(m[1]);
  if (t[1] < Number(m[2]) || (t[1] === Number(m[2]) && t[2] < Number(m[3]))) age--;
  return age;
}

const TAX_RATE = 0.0825;          // memberships are untaxed; kept for shape
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
function optionLine(p: PlanRow, tpl: Tpl): string {
  if (p.billing_frequency === "one_time") {
    return p.name + " is a " + String(tpl.fees.pifText).replace("{{pif}}", money(p.pif_cents || 0)).toLowerCase();
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
  options: PlanRow[]; chosen: PlanRow; payDate: string | null; tpl: Tpl;
  addOns?: { program: string; monthlyCents: number }[];
  initials: string; signerName: string; signerRelationship: string;
}): string {
  const tpl = ctx.tpl;
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
  for (const p of ctx.options) out.push(optionLine(p, ctx.tpl));
  out.push("");
  // Add-on programs are priced lines on THIS agreement, not separate
  // contracts. The waiver already covers martial arts generally, the
  // payment authorization already covers whatever the fee table shows, and
  // the cancellation section already applies, so an add-on needs a price
  // and an initial and nothing else.
  const adds = (ctx.addOns ?? []).filter((a) => a && a.program);
  for (const a of adds) {
    out.push("Add-on: " + a.program + " is " + money(a.monthlyCents) + " per month.");
  }
  out.push("");
  out.push("Selected option: " + ctx.chosen.name
    + "   Initials: " + ctx.initials
    + "   Payment date: " + (ctx.payDate ?? "none (paid in full)"));
  if (adds.length) {
    const names = adds.map((a) => a.program).join(" and ");
    const total = adds.reduce((t, a) => t + a.monthlyCents, 0);
    out.push("");
    out.push("I am also enrolling in " + names + " for " + money(total)
      + " per month, billed on the agreed payment date above under the same"
      + " payment authorization, and cancellable on the same notice."
      + "    Initials: " + ctx.initials);
  }
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

  // ── which program is being sold ─────────────────────────────────────────
  // Read once, here, and everything downstream follows from cfg. An unknown
  // slug is refused outright rather than falling back to some default: a
  // typo must never quietly sell the wrong programs contract.
  const reqUrl = new URL(req.url);
  let bodyJson: Record<string, unknown> = {};
  if (req.method === "POST") bodyJson = await req.json().catch(() => ({}));
  const slug = String(
    reqUrl.searchParams.get("p") ?? bodyJson.p ?? ""
  ).trim().toLowerCase();
  const cfg = PROGRAMS[slug];
  if (!cfg) {
    return json({ error: "Unknown program." }, 404, cors);
  }

  // ── the live catalog: both verbs price from the same rows ────────────────
  const plansRes = await admin.from("pricing_plans")
    .select("id,code,name,billing_frequency,recurring_cents,down_cents,pif_cents,payment_count,promo_label,sellable,active,display_order")
    .eq("program", cfg.program).eq("sellable", true).eq("active", true)
    .order("display_order");
  const options = (plansRes.data ?? []) as (PlanRow & { sellable: boolean; active: boolean; display_order: number })[];
  if (!options.length) {
    return json({ error: cfg.label + " enrollment isn't open right now. Call 903-561-2966." }, 503, cors);
  }

  const teeRes = await admin.from("products")
    .select("id,name,price_cents,taxable,active")
    .in("name", cfg.shirts).eq("active", true);
  const shirtRows = teeRes.data ?? [];
  // A featured tee is half price; with none configured every shirt is simply
  // catalog price, which is the case for every program except Cubs.
  const shirtPrice = (r: { name: string; price_cents: number }) =>
    (cfg.featuredTee && r.name === cfg.featuredTee)
      ? Math.round(r.price_cents * (10000 - TEE_DISCOUNT_BPS) / 10000)
      : r.price_cents;
  const tee = cfg.featuredTee
    ? (shirtRows.find((r: { name: string }) => r.name === cfg.featuredTee) ?? null)
    : null;
  const teeFull = tee ? tee.price_cents : 0;
  const teeNow = tee ? shirtPrice(tee) : 0;

  const uniRes = await admin.from("products")
    .select("id,name,price_cents,taxable,active")
    .eq("name", cfg.uniform ?? "\u0000none").eq("active", true).maybeSingle();
  const uniform = uniRes.data ?? null;

  // Add-on rates, priced from the catalog like everything else. The pair
  // rate is a row of its own rather than the sum of two, because the owner
  // discounts taking both (a TKD member pays $40 for one and $60 for both,
  // not $80).
  const addOnCfg = cfg.addOns ?? [];
  const addOnCodes = addOnCfg.map((a) => a.code).concat(cfg.bothCode ? [cfg.bothCode] : []);
  const addOnPlanRes = addOnCodes.length
    ? await admin.from("pricing_plans")
        .select("id,code,name,program,billing_frequency,recurring_cents,down_cents,pif_cents,payment_count")
        .in("code", addOnCodes).eq("active", true)
    : { data: [] as PlanRow[] };
  const addOnPlans = (addOnPlanRes.data ?? []) as PlanRow[];
  const planByCode = (c: string) => addOnPlans.find((p) => p.code === c) ?? null;

  /* What each chosen add-on costs per month. Selecting every offered add-on
   * uses the pair rate where one exists; otherwise each is its own price. */
  function priceAddOns(chosenPrograms: string[]) {
    const picked = addOnCfg.filter((a) => chosenPrograms.includes(a.program));
    if (!picked.length) return [] as { program: string; code: string; monthlyCents: number }[];
    if (cfg.bothCode && picked.length === addOnCfg.length && addOnCfg.length > 1) {
      const both = planByCode(cfg.bothCode);
      const each = Math.floor((both?.recurring_cents || 0) / picked.length);
      // Split the pair rate across the programs so each membership carries a
      // real price, and give the remainder to the first so they sum exactly.
      const rem = (both?.recurring_cents || 0) - each * picked.length;
      return picked.map((a, i) => ({
        program: a.program, code: cfg.bothCode as string,
        monthlyCents: each + (i === 0 ? rem : 0),
      }));
    }
    return picked.map((a) => ({
      program: a.program, code: a.code,
      monthlyCents: planByCode(a.code)?.recurring_cents || 0,
    }));
  }

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
      return json({
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? null,
        program: cfg.program,
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
          featured: !!cfg.featuredTee && r.name === cfg.featuredTee,
          front: SHIRT_ART[r.name] ? SHIRT_ART[r.name].front : null,
          back: SHIRT_ART[r.name] ? SHIRT_ART[r.name].back : null,
          color: SHIRT_COLOR[r.name] || "#B4B6B9",
        })).sort((a: { featured: boolean }, b: { featured: boolean }) => (a.featured ? -1 : 0) - (b.featured ? -1 : 0)),
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        tax_rate: TAX_RATE,
        add_ons: addOnCfg.map((a) => ({
          program: a.program,
          monthly_cents: planByCode(a.code)?.recurring_cents || 0,
        })),
        add_ons_both_cents: cfg.bothCode ? (planByCode(cfg.bothCode)?.recurring_cents || 0) : null,
        agreement_version: cfg.tpl.version,
      }, 200, cors);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    const body = bodyJson;   // already read above to resolve the program
    reqBody = body;
    if (str(body.hp)) return json({ ok: true }, 200, cors); // honeypot
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
        if (!upd.error) await sendReceipt(fSale);
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
    // Who signs. Where every student is a child the guardian is the
    // contracting adult and is always required. Where a program takes adults,
    // an adult enrolling themselves should not have to invent a guardian, so
    // the requirement follows the student's actual age. A teenager still
    // needs one: a minor's contract with a blank guardian line is precisely
    // the document that fails when it matters.
    const studentAge = ageFrom(dob);
    const needsGuardian = cfg.guardianAlways || studentAge === null || studentAge < 18;
    if (needsGuardian && (!parentFirst || !parentLast)) {
      return json({ error: "Enter the parent or guardian's name." }, 400, cors);
    }
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
      return json({ ok: true, receipt_url: `${SITE}/invoice/?t=${existing.data.view_token}`, total_cents: existing.data.total_cents }, 200, cors);
    }

    // ── price it OURSELVES with the engine the POS uses ────────────────────
    const calc = BTKDPricing.calculatePrice({
      plan: chosen, settings, person: { contact_id: null, activeMemberships: [] },
      householdMembers: [], plans: [chosen],
    });
    if (!calc.eligible) return json({ error: "That option can't be sold right now." }, 409, cors);
    const due = BTKDPricing.dueTodayCents(calc, null);   // down + first payment; PIF = the full amount

    // Add-on programs. Each is a real membership with its own roster row, but
    // rides the PRIMARY agreement as a priced line, so the buyer signs once.
    // The first month is due today, exactly like the primary plan’s first
    // period, otherwise they would train a month before paying for it.
    const wantAddOns = Array.isArray(body.addons)
      ? [...new Set(body.addons.map((x: unknown) => str(x)).filter(Boolean))]
      : [];
    for (const p of wantAddOns) {
      if (!addOnCfg.some((a) => a.program === p)) {
        return json({ error: "That add-on is not available here. Reload the page." }, 400, cors);
      }
    }
    const pricedAddOns = priceAddOns(wantAddOns);
    const addOnCents = pricedAddOns.reduce((t, a) => t + a.monthlyCents, 0);
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
    pricedAddOns.forEach((a) => lines.push({ cents: a.monthlyCents, taxable: false }));
    if (wantUniform) lines.push({ cents: uniformCents, taxable: true });
    wantShirts.forEach((x) => lines.push({ cents: x.cents, taxable: true }));
    const fee = adminFeeCents(due + addOnCents + uniformCents + shirtsCents, feeBps, feeFlat);   // card-only online, fee always rides
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
      segment: "active", member_role: "student",
      source: "website-" + slug + "-checkout", entered_on: today,
      dob, email, phone, address,
    }).select("id").single();
    if (contactIns.error) throw contactIns.error;
    const studentId = contactIns.data.id as string;

    // 2. The guardian, name and all.
    const guardianName = (parentFirst + " " + parentLast).trim();
    const gIns = await admin.from("student_guardians").insert({
      student_id: studentId, email, name: guardianName, label: "parent",
    });
    if (gIns.error) problems.push("guardian row: " + gIns.error.message);

    if (guardian2 && (guardian2.name || guardian2.email || guardian2.phone)) {
      const g2Ins = await admin.from("student_guardians").insert({
        student_id: studentId, label: "guardian",
        name: guardian2.name || null, email: guardian2.email || null,
        phone: guardian2.phone || null, address: guardian2.address || null,
      });
      if (g2Ins.error) problems.push("second guardian: " + g2Ins.error.message);
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
      id: saleId, buyer_contact_id: studentId, sale_date: today,
      staff_email: "program-checkout@website", brand: "btkd",
      tender_method: null, status: "unpaid",
      subtotal_cents: totals.subtotalCents, discount_cents: 0,
      admin_fee_cents: fee, tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      customer_note:
        studentFirst + " is enrolled in " + cfg.label + ".\n\n"
        + "Your plan: " + chosen.name + "\n"
        + "Today you paid " + money(totals.totalCents) + " (includes card processing).\n"
        + monthlyLine + "\n"
        + (pricedAddOns.length
            ? "Also enrolled: " + pricedAddOns.map((a) => a.program + " at "
                + money(a.monthlyCents) + "/month").join(", ") + "\n"
            : "")
        + "\n"
        + "Class times: barestkd.fit/schedule\n"
        + "1901 Deerbrook Dr, Tyler\n\n"
        + (wantUniform
            ? "Your uniform is paid for. We'll have it ready at the first class.\n"
            : "Wear comfortable clothes for the first class. Uniforms are available at the front desk.\n")
        + (wantShirts.length
            ? "Shirts paid for and ready at the first class: "
              + wantShirts.map((x) => x.row.name + " (" + x.size + ")").join(", ") + "\n"
            : "")
        + "\nQuestions? Call 903-561-2966 or just reply to this email.",
      notes: cfg.label + " online enrollment, " + chosen.name
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
      calc, contactId: studentId, program: cfg.program,
      startedOn: today, createdBy: "program-checkout (website)", override: null,
    });
    (snap as Record<string, unknown>).payment_count = chosen.payment_count;
    (snap as Record<string, unknown>).sale_id = saleId;
    const memIns = await admin.from("memberships").insert(snap).select("id").single();
    if (memIns.error) throw memIns.error;
    const membershipId = memIns.data.id as string;

    // 5. The signed agreement, frozen with the option they picked.
    const bodyText = buildBodyText({
      tpl: cfg.tpl,
      participant: studentFirst + " " + studentLast, dob: fmtMDY(dob),
      guardian: guardianName, today: fmtMDY(today),
      options, chosen, payDate, initials,
      addOns: pricedAddOns.map((a) => ({ program: a.program, monthlyCents: a.monthlyCents })),
      signerName, signerRelationship: signerRel,
    });
    const agrIns = await admin.from("membership_agreements").insert({
      membership_id: membershipId, contact_id: studentId, sale_id: saleId,
      template_key: cfg.tpl.key, template_version: cfg.tpl.version,
      document_title: cfg.tpl.title, program: cfg.program,
      plan_code: chosen.code,
      body_json: {
        title: cfg.tpl.title, version: cfg.tpl.version,
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
    // Each add-on becomes its own membership and roster row: check-in is
    // gated per program, and billing has to know what each one costs. Only
    // the CONTRACT is shared, which is the whole point.
    for (const a of pricedAddOns) {
      const aPlan = addOnPlans.find((p) => p.code === a.code);
      if (!aPlan) { problems.push("add-on plan missing: " + a.code); continue; }
      const aCalc = BTKDPricing.calculatePrice({
        plan: { ...aPlan, recurring_cents: a.monthlyCents },
        settings, person: { contact_id: studentId, activeMemberships: [] },
        householdMembers: [], plans: [aPlan],
      });
      const aSnap = BTKDPricing.buildMembershipSnapshot({
        calc: aCalc, contactId: studentId, program: a.program,
        startedOn: today, createdBy: "program-checkout add-on (website)", override: null,
      });
      (aSnap as Record<string, unknown>).sale_id = saleId;
      const aMem = await admin.from("memberships").insert(aSnap).select("id").single();
      if (aMem.error) { problems.push("add-on membership " + a.program + ": " + aMem.error.message); continue; }
      lineRows.push({
        sale_id: saleId, kind: "mem",
        label: a.program + " (added to " + cfg.label + ")",
        qty: 1, unit_cents: a.monthlyCents, discount_cents: 0, taxable: false,
        line_total_cents: a.monthlyCents, student_contact_id: studentId,
        product_id: null, membership_row: aSnap, membership_id: aMem.data.id,
      });
      const aEnr = await admin.from("enrollments").insert({
        student_id: studentId, program: a.program, status: "active", sale_id: saleId,
      });
      if (aEnr.error) problems.push("add-on roster " + a.program + ": " + aEnr.error.message);
    }

    const lIns = await admin.from("pos_sale_lines").insert(lineRows);
    if (lIns.error) problems.push("sale lines: " + lIns.error.message);

    // 7. Class roster.
    const eIns = await admin.from("enrollments").insert({
      student_id: studentId, program: cfg.program, status: "active", sale_id: saleId,
    });
    if (eIns.error) problems.push("roster: " + eIns.error.message);

    if (problems.length) console.error("[program-checkout] partial writes:", saleId, problems);

    // 8. The payment, on this page. The card ATTACHES TO A CUSTOMER with
    //    setup_future_usage: the buyer just signed up for recurring payments,
    //    so the card must be chargeable later without them present.
    if (!secretKey) {
      return json({ ok: true, receipt_url: `${SITE}/invoice/?t=${token}`, total_cents: totals.totalCents }, 200, cors);
    }
    const cf = new URLSearchParams();
    cf.set("name", guardianName);
    cf.set("email", email);
    if (phone) cf.set("phone", phone);
    cf.set("metadata[contact_id]", studentId);
    const cust = await stripe("customers", secretKey, cf);
    await admin.from("contacts").update({ stripe_customer_id: cust.id }).eq("id", studentId);

    const f = new URLSearchParams();
    f.set("amount", String(totals.totalCents));
    f.set("currency", "usd");
    f.set("payment_method_types[]", "card");
    f.set("description", cfg.label + " (" + chosen.name + ") - " + studentFirst + " " + studentLast);
    f.set("receipt_email", email);
    f.set("customer", cust.id);
    f.set("setup_future_usage", "off_session");
    f.set("metadata[sale_id]", saleId);
    f.set("metadata[source]", "program-checkout");
    const pi = await stripe("payment_intents", secretKey, f);
    await admin.from("pos_sales").update({ stripe_payment_intent: pi.id, stripe_customer_id: cust.id }).eq("id", saleId);

    return json({
      ok: true,
      client_secret: pi.client_secret,
      payment_intent_id: pi.id,
      sale_id: saleId,
      total_cents: totals.totalCents,
    }, 200, cors);
  } catch (e) {
    console.error("[program-checkout] failed:", e);
    const detail = (e as { message?: string })?.message || String(e);
    const debug = reqBody.debug === true;
    return json({
      error: "Could not complete enrollment. Please try again or call us.",
      ...(debug ? { detail } : {}),
    }, 500, cors);
  }
});
