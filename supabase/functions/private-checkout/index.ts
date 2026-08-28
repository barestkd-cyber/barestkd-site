// ===========================================================================
// private-checkout - book and pay for a private lesson
// ---------------------------------------------------------------------------
// Owner, 2026-08-20: "a private lesson calendar link or a checkout page ...
// that should have my availability which is our open hours before the start
// time of our classes ... my Monday at four is already filled and my Thursday
// at four is already filled."
//
// Availability is DERIVED, never typed twice: slots run backwards from the
// first class of each day in the live schedule_template, so when he moves a
// class the private slots move with it. That is also why his own 4:00 PM
// lessons fit exactly, both days start class at 4:30.
//
// Pricing: $35 for 30 minutes, or seven for the price of six. The rule lives
// in the shared engine (privateLessonCents) so the page cannot disagree with
// the CRM about what a pack costs.
//
// A pack is a BALANCE. Buying seven books ONE lesson now and leaves six owed,
// which Race books from the CRM. Picking seven times up front would be a
// worse promise to make and a worse thing to reschedule.
//
// GET  -> { page_live, rate_cents, pack_size, pack_cents, days:[...], publishable_key }
// POST -> creates the sale + booking, returns a Stripe client_secret
// POST { action: "finalize" } -> verifies with Stripe, records the money
//
// Deploy: supabase functions deploy private-checkout --no-verify-jwt
// ===========================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";
import { familyCustomer } from "../_shared/family.ts";

const SITE = "https://www.barestkd.fit";
const TAX_RATE = 0.0825;
const LESSON_TAXABLE = false; // instruction is a service, not tangible goods
const DURATION_MIN = 30;
const WEEKS_OUT = 6; // how far ahead the page will offer

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

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

/** "Monday, September 14" from a yyyy-mm-dd, without new Date(str), which
 *  parses as UTC and reads a day early in Central. */
function prettyDay(ymd: string): string {
  const p = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return DAYS[d.getUTCDay()] + ", " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
}
/** 915 -> "3:15 PM" */
function prettyTime(mins: number): string {
  let h = Math.floor(mins / 60), m = mins % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
/** 915 -> "1515", for the Google Calendar link. */
function hhmm(mins: number): string {
  return String(Math.floor(mins / 60)).padStart(2, "0") + String(mins % 60).padStart(2, "0");
}
/** yyyy-mm-dd + minutes, in STUDIO time, as a real instant. Central is UTC-5
 *  or UTC-6 depending on the date, so this asks the runtime rather than
 *  assuming an offset. */
function studioInstant(ymd: string, mins: number): Date {
  const p = ymd.split("-").map(Number);
  const guess = Date.UTC(p[0], p[1] - 1, p[2], Math.floor(mins / 60), mins % 60);
  // What wall-clock does that instant show in Central? Shift by the gap.
  const shown = new Date(guess).toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false });
  const local = new Date(shown + "Z").getTime();
  return new Date(guess + (guess - local));
}
function addDaysYmd(ymd: string, n: number): string {
  const p = ymd.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.toISOString().slice(0, 10);
}
function googleCalUrl(o: { ymd: string; mins: number; minutes: number; title: string; details: string }): string {
  const d = o.ymd.replace(/-/g, "");
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: o.title,
    dates: d + "T" + hhmm(o.mins) + "00/" + d + "T" + hhmm(o.mins + o.minutes) + "00",
    ctz: "America/Chicago",
    location: "1901 Deerbrook Dr, Tyler, TX 75703",
    details: o.details,
  });
  return "https://calendar.google.com/calendar/render?" + q.toString();
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
/** Fire-and-forget: by the time this runs the money is already taken, so a
 *  failed email must never fail the booking. */
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
 * this object. Missing is normal (cash, ACH) and returns nulls rather than
 * guessing. Same walk the stripe-webhook uses. */
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

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  let reqBody: Record<string, unknown> = {};
  try {
    const setRow = await admin.from("settings")
      .select("private_page_live, private_rate_cents, private_pack_size, private_pack_pay_for, private_open_weekday, private_open_saturday, private_blocked_slots, private_open_hours")
      .limit(1).maybeSingle();
    const S = setRow.data ?? {};
    const pageLive = S.private_page_live === true;
    const rateCents = BTKDPricing.privateLessonCents({ count: 1, settings: S });
    const packSize = Math.max(2, Math.round(Number(S.private_pack_size)) || 7);
    const packCents = BTKDPricing.privateLessonCents({ count: packSize, settings: S });

    // ── availability ────────────────────────────────────────────────────
    // Derived from the live class schedule: slots end where class begins.
    const today = todayCT();
    // Give back slots held by checkouts that were abandoned or declined.
    // Without this every dead attempt destroyed a lesson slot forever, and
    // a script could have held the whole six-week window for free.
    const holdMin = Math.max(5, Math.round(Number(S.private_hold_minutes)) || 20);
    const expired = await admin.from("private_lessons")
      .update({ status: "canceled", notes: "hold expired before payment" })
      .eq("status", "pending")
      .lt("created_at", new Date(Date.now() - holdMin * 60000).toISOString())
      .select("starts_at");
    // Clear any calendar row those holds left behind, so a dead checkout
    // can never keep a slot shut.
    for (const row of (expired.data ?? []) as Record<string, unknown>[]) {
      const at = new Date(String(row.starts_at));
      const eymd = at.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
      const ehm = at.toLocaleTimeString("en-GB", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false });
      await admin.from("calendar_events").delete()
        .eq("created_by", "private-checkout@website").eq("event_date", eymd)
        .eq("event_time", prettyTime(Number(ehm.slice(0, 2)) * 60 + Number(ehm.slice(3, 5))));
    }
    const schedRes = await admin.from("schedule_template")
      .select("day, time_h, time_m, starts_on, ends_on");
    // Which classes are running ON A GIVEN DATE, not merely today. A term
    // that starts inside the six-week horizon used to be ignored entirely,
    // and the page would have sold lessons straight through those classes.
    // schedule_template.day is 0=Monday; JS getDay is 0=Sunday.
    const schedRows = (schedRes.data ?? []) as Record<string, unknown>[];
    const firstClassOn = (ymd: string, dow: number): number | undefined => {
      let best: number | undefined;
      schedRows.forEach((r) => {
        if ((Number(r.day) + 1) % 7 !== dow) return;
        if (r.starts_on && String(r.starts_on) > ymd) return;
        if (r.ends_on && String(r.ends_on) < ymd) return;
        const mins = Number(r.time_h) * 60 + Number(r.time_m);
        if (best === undefined || mins < best) best = mins;
      });
      return best;
    };

    // Standing weekly lessons Race already teaches. A recurring rule, not
    // fake bookings: those would expire and need topping up forever.
    // Format: "Mon 4:00 PM, Thu 4:00 PM".
    // "Mon 4:00 PM, Thu 4:00 PM" -> { dowNumber: minutes }. Anything it
    // cannot read is skipped rather than guessed at.
    const parseDayTimes = (raw: unknown): Record<number, number> => {
      const out: Record<number, number> = {};
      String(raw ?? "").split(",").forEach((piece) => {
        const m = /^\s*([A-Za-z]{3})[a-z]*\s+(.+?)\s*$/.exec(piece);
        if (!m) return;
        const dow = DAYS.findIndex((d) => d.slice(0, 3).toLowerCase() === m[1].toLowerCase());
        const mins = BTKDPricing.minutesFromClock(m[2]);
        if (dow >= 0 && mins !== null) out[dow] = mins;
      });
      return out;
    };
    const openByDow = parseDayTimes(S.private_open_hours);

    const blocked = new Set<string>();
    String(S.private_blocked_slots ?? "").split(",").forEach((piece: string) => {
      const m = /^\s*([A-Za-z]{3})[a-z]*\s+(.+?)\s*$/.exec(piece);
      if (!m) return;
      const dow = DAYS.findIndex((d) => d.slice(0, 3).toLowerCase() === m[1].toLowerCase());
      const mins = BTKDPricing.minutesFromClock(m[2]);
      if (dow >= 0 && mins !== null) blocked.add(dow + ":" + mins);
    });

    const openWeekday = BTKDPricing.minutesFromClock(S.private_open_weekday ?? "15:00");
    const openSaturday = BTKDPricing.minutesFromClock(S.private_open_saturday ?? "08:30");

    const horizon = addDaysYmd(today, WEEKS_OUT * 7);
    // Closures that block private lessons, and everything already booked.
    const [boRes, staffRes, bookedRes] = await Promise.all([
      admin.from("calendar_events").select("event_date")
        .eq("type", "blackout").eq("blocks_privates", true).gte("event_date", today),
      // Privates Race books himself in the CRM are calendar rows, not
      // private_lessons rows. They were invisible here, so the page could
      // sell a slot he had already promised to somebody.
      admin.from("calendar_events").select("event_date,event_time")
        .eq("type", "private").gte("event_date", today),
      admin.from("private_lessons").select("starts_at")
        .in("status", ["pending", "booked", "completed"]).gte("starts_at", today + "T00:00:00Z"),
    ]);
    const closed = new Set(((boRes.data ?? []) as Record<string, unknown>[]).map((r) => String(r.event_date)));
    const takenIso = new Set(((bookedRes.data ?? []) as Record<string, unknown>[])
      .map((r) => new Date(String(r.starts_at)).toISOString()));
    // "3:00 PM" on a date -> the same key the generated slots use.
    const staffTaken = new Set<string>();
    ((staffRes.data ?? []) as Record<string, unknown>[]).forEach((r) => {
      const mins = BTKDPricing.minutesFromClock(String(r.event_time ?? ""));
      if (mins !== null) staffTaken.add(String(r.event_date) + ":" + mins);
    });

    const days: Array<{ ymd: string; label: string; slots: Array<{ mins: number; label: string; iso: string }> }> = [];
    const nowMs = Date.now();
    for (let i = 0; i < WEEKS_OUT * 7; i++) {
      const ymd = addDaysYmd(today, i);
      if (closed.has(ymd)) continue;
      const p = ymd.split("-").map(Number);
      const dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
      const first = firstClassOn(ymd, dow);
      if (first === undefined) continue; // no classes that day, so no "before class"
      // Per-day opening time when he has set one, otherwise the old
      // weekday/Saturday default so a missing day still works.
      const open = openByDow[dow] !== undefined
        ? openByDow[dow]
        : (dow === 6 ? openSaturday : openWeekday);
      if (open === null) continue; // unreadable setting closes the day rather than opening it wrongly
      // Taken slots are RETURNED, marked, not hidden. A day with everything
      // sold used to vanish, which reads as "we don't teach then" rather than
      // "that filled up". Showing them greyed keeps the weekly shape visible.
      // Past slots are still dropped: nobody can book yesterday.
      const slots = BTKDPricing.privateSlotsForDay({
        openMinutes: open, firstClassMinutes: first, durationMin: DURATION_MIN,
      }).map((mins: number) => {
        const at = studioInstant(ymd, mins);
        return { mins, label: prettyTime(mins), iso: at.toISOString(), ms: at.getTime() };
      }).filter((s: { ms: number }) => s.ms > nowMs)
        .map((s: { mins: number; label: string; iso: string }) => ({
          mins: s.mins, label: s.label, iso: s.iso,
          taken: takenIso.has(s.iso)
            || blocked.has(dow + ":" + s.mins)
            || staffTaken.has(ymd + ":" + s.mins),
        }));
      if (slots.length) days.push({ ymd, label: prettyDay(ymd), slots });
    }

    if (req.method === "GET") {
      // The price with the card fee already in it, worked out by the same
      // code that builds the invoice. The page displays these verbatim.
      const feeRow = await admin.from("pricing_settings").select("key,value_cents")
        .in("key", ["admin_fee_bps", "admin_fee_flat_cents"]);
      const fs2: Record<string, number> = {};
      ((feeRow.data ?? []) as { key: string; value_cents: number }[]).forEach((r) => fs2[r.key] = r.value_cents);
      const withFee = (cents: number) => BTKDPricing.invoiceTotals({
        lines: [{ cents, taxable: LESSON_TAXABLE }],
        discountCents: 0,
        adminFeeCents: adminFeeCents(cents, fs2.admin_fee_bps ?? 290, fs2.admin_fee_flat_cents ?? 30),
        taxRate: TAX_RATE,
      }).totalCents;
      return json({
        page_live: pageLive,
        rate_cents: rateCents,
        pack_size: packSize,
        pack_cents: packCents,
        single_total_cents: withFee(rateCents),
        pack_total_cents: withFee(packCents),
        duration_min: DURATION_MIN,
        days,
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? "",
      }, 200, cors);
    }
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    reqBody = body;
    if (str(body.hp)) return json({ ok: true }, 200, cors); // honeypot

    const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

    // ── finalize: the card cleared in the browser, record it ─────────────
    // Deliberately NOT gated on page_live: a card already charged must still
    // be recordable after the owner takes the page down.
    if (str(body.action) === "finalize") {
      const fSale = str(body.sale_id).toLowerCase();
      const piId = str(body.payment_intent_id);
      if (!UUID_RE.test(fSale) || !piId.startsWith("pi_")) return json({ error: "Bad request" }, 400, cors);
      if (!secretKey) return json({ error: "Payments are not configured." }, 503, cors);

      const pi = await stripe("payment_intents/" + encodeURIComponent(piId), secretKey, undefined, "GET");
      if (pi.status !== "succeeded") return json({ error: "That payment did not complete." }, 409, cors);
      if (str(pi.metadata?.sale_id).toLowerCase() !== fSale) {
        return json({ error: "That payment is for a different booking." }, 409, cors);
      }
      const amt = Number(pi.amount_received ?? pi.amount ?? 0);
      if (amt <= 0) return json({ error: "No amount on that payment." }, 409, cors);

      const dupe = await admin.from("pos_payments").select("id")
        .eq("sale_id", fSale).eq("stripe_object_id", pi.id).limit(1);
      if (!dupe.data || !dupe.data.length) {
        await admin.from("pos_payments").insert({
          sale_id: fSale, kind: "charge", amount_cents: amt, method: "card",
          ...cardBits(pi),
          stripe_object_id: pi.id, note: "Card payment (private lesson booking)",
        });
      }
      const sale = await admin.from("pos_sales").select("total_cents,status").eq("id", fSale).maybeSingle();
      const pays = await admin.from("pos_payments").select("amount_cents,kind").eq("sale_id", fSale);
      const net = ((pays.data ?? []) as Record<string, unknown>[])
        .reduce((a, p) => a + (p.kind === "refund" ? -Number(p.amount_cents) : Number(p.amount_cents)), 0);
      if (sale.data && net >= Number(sale.data.total_cents) && sale.data.status !== "paid") {
        await admin.from("pos_sales").update({ status: "paid", tender_method: "card", confirmed_at: new Date().toISOString() }).eq("id", fSale);
        const lesson = await admin.from("private_lessons")
          .update({ status: "booked" }).eq("sale_id", fSale)
          .select("starts_at,student_name").maybeSingle();
        // Now it is real, so now it goes on the wall calendar.
        if (lesson.data) {
          const at = new Date(String(lesson.data.starts_at));
          const lymd = at.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
          const hm = at.toLocaleTimeString("en-GB", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false });
          const lmins = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
          const cal = await admin.from("calendar_events").insert({
            type: "private", title: "Private · " + (lesson.data.student_name || "Private lesson"),
            event_date: lymd, event_time: prettyTime(lmins),
            created_by: "private-checkout@website",
          });
          if (cal.error) console.error("[private-checkout] calendar row failed:", fSale, cal.error);
        }
        await sendReceipt(fSale);
      }
      return json({ ok: true, paid: true }, 200, cors);
    }

    // ── a new booking ───────────────────────────────────────────────────
    if (!pageLive) return json({ error: "Private lesson booking is not open right now." }, 503, cors);

    const saleId = str(body.sale_id).toLowerCase();
    if (!UUID_RE.test(saleId)) return json({ error: "Bad request" }, 400, cors);
    const first = str(body.first_name).slice(0, 80);
    const last = str(body.last_name).slice(0, 80);
    const student = str(body.student_name).slice(0, 120) || (first + " " + last).trim();
    const email = str(body.email).toLowerCase().slice(0, 200);
    const phone = str(body.phone).slice(0, 40);
    const notes = str(body.notes).slice(0, 2000);
    const slotIso = str(body.slot_iso);
    const wantPack = body.pack === true;
    const count = wantPack ? packSize : 1;

    if (!first || !last || !EMAIL_RE.test(email) || !phone || !slotIso) {
      return json({ error: "Missing required fields" }, 400, cors);
    }
    const slotAt = new Date(slotIso);
    if (isNaN(slotAt.getTime())) return json({ error: "Pick a lesson time." }, 400, cors);

    // The slot must still be one we actually offer. Trusting the posted time
    // would let a stale page book into a class, a closure, or the past.
    // What this shopper is already holding, if anything. Their own pending
    // hold must not make their own slot look taken, or a declined card
    // could never be retried.
    const mine = await admin.from("private_lessons")
      .select("starts_at,pack_id,status").eq("sale_id", saleId).maybeSingle();
    const myHeldIso = mine.data && mine.data.status === "pending"
      ? new Date(String(mine.data.starts_at)).toISOString() : null;
    // Taken slots now appear in `days` so the page can grey them, which means
    // "is it in the list" is no longer the same question as "can it be
    // booked". It must be present AND free, or already held by this shopper.
    const offered = days.some((d) => d.slots.some((s) => s.iso === slotAt.toISOString() && !s.taken))
      || myHeldIso === slotAt.toISOString();
    if (!offered) {
      return json({ error: "That time is no longer available. Please pick another." }, 409, cors);
    }

    // Idempotency: a refreshed page must not create a second booking.
    const existing = await admin.from("pos_sales")
      .select("id,status,total_cents,view_token,stripe_payment_intent").eq("id", saleId).maybeSingle();
    if (existing.data) {
      // Only reuse this sale if it is still for the SAME lesson. A shopper
      // who changes their time or picks the pack after a decline must not
      // be handed the old payment: that charged the old amount for the old
      // slot while the page showed the new one.
      const sameSlot = mine.data
        && new Date(String(mine.data.starts_at)).toISOString() === slotAt.toISOString();
      const samePack = mine.data ? (!!mine.data.pack_id === wantPack) : false;
      if (existing.data.status !== "paid" && (!sameSlot || !samePack)) {
        return json({
          error: "Your selection changed. Please reload the page and book again.",
          reload: true,
        }, 409, cors);
      }
      const token = existing.data.view_token as string;
      if (existing.data.status === "paid") {
        return json({ ok: true, paid: true, receipt_url: SITE + "/invoice/?t=" + token }, 200, cors);
      }
      if (existing.data.stripe_payment_intent && secretKey) {
        const pi = await stripe("payment_intents/" + encodeURIComponent(String(existing.data.stripe_payment_intent)),
          secretKey, undefined, "GET");
        if (pi?.client_secret) {
          return json({
            ok: true, client_secret: pi.client_secret, payment_intent_id: pi.id,
            sale_id: saleId, total_cents: existing.data.total_cents,
            receipt_url: SITE + "/invoice/?t=" + token,
          }, 200, cors);
        }
      }
      // NOT "ok" with a receipt and no way to pay: the page treats a missing
      // client_secret as a finished sale and would tell an unpaid customer
      // they were done (2026-08-26, cubs-checkout, a family told their son
      // was enrolled after three failed attempts). Make a fresh intent so
      // the retry does what they came to do.
      if (secretKey) {
        try {
          const rf = new URLSearchParams();
          rf.set("amount", String(existing.data.total_cents));
          rf.set("currency", "usd");
          rf.set("payment_method_types[]", "card");
          rf.set("metadata[sale_id]", saleId);
          rf.set("metadata[source]", "private-checkout");
          const rpi = await stripe("payment_intents", secretKey, rf);
          const st = await admin.from("pos_sales")
            .update({ stripe_payment_intent: rpi.id }).eq("id", saleId);
          if (st.error) console.error("retry intent stamp failed", saleId, st.error);
          return json({ ok: true, client_secret: rpi.client_secret, payment_intent_id: rpi.id,
            sale_id: saleId, total_cents: existing.data.total_cents,
            receipt_url: SITE + "/invoice/?t=" + token }, 200, cors);
        } catch (e) {
          console.error("retry intent failed", saleId, e);
        }
      }
      return json({ error: "We could not start the payment. Please call 903-561-2966 and we will finish this for you." }, 503, cors);
    }

    // Money, from the engine. The page never sends an amount.
    const feeRes = await admin.from("pricing_settings").select("key,value_cents")
      .in("key", ["admin_fee_bps", "admin_fee_flat_cents"]);
    const ps: Record<string, number> = {};
    ((feeRes.data ?? []) as { key: string; value_cents: number }[]).forEach((r) => ps[r.key] = r.value_cents);
    const lessonsCents = BTKDPricing.privateLessonCents({ count, settings: S });
    // How many of the pack are the free ones, said plainly on the invoice.
    const payFor = Math.max(1, Math.round(Number(S.private_pack_pay_for)) || packSize - 1);
    const freeCount = Math.max(0, packSize - payFor);
    const fee = adminFeeCents(lessonsCents, ps.admin_fee_bps ?? 290, ps.admin_fee_flat_cents ?? 30);
    const totals = BTKDPricing.invoiceTotals({
      lines: [{ cents: lessonsCents, taxable: LESSON_TAXABLE }],
      discountCents: 0, adminFeeCents: fee, taxRate: TAX_RATE,
    });

    // One contact per buyer, matched on email. Unlike the testing page these
    // may be brand new people, so a miss creates the contact rather than
    // dropping the booking on the floor.
    let buyerId: string | null = null;
    // Escaped: an address is a literal, not a LIKE pattern. Unescaped, a
    // crafted "a_b@x.com" matched somebody else and filed the booking onto
    // their record.
    const emailPattern = email.replace(/([\\%_])/g, "\\$1");
    const found = await admin.from("contacts").select("id,stripe_customer_id")
      .ilike("email", emailPattern).limit(2);
    let buyerHadCustomer = false;
    if (found.data && found.data.length === 1) {
      buyerId = found.data[0].id as string;
      buyerHadCustomer = !!found.data[0].stripe_customer_id;
    }
    if (!buyerId) {
      const made = await admin.from("contacts").insert({
        first_name: first, last_name: last, email, phone, brand: "btkd",
        tags: ["private lesson"],
      }).select("id").single();
      if (made.error) throw made.error;
      buyerId = made.data.id as string;
    }

    const ymd = slotAt.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const mins = (() => {
      const hm = slotAt.toLocaleTimeString("en-GB", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false });
      return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
    })();
    const when = prettyDay(ymd) + " at " + prettyTime(mins);
    const calUrl = googleCalUrl({
      ymd, mins, minutes: DURATION_MIN,
      title: "Private lesson - Bares Taekwondo Fitness",
      details: "Private lesson for " + student + ", " + DURATION_MIN + " minutes with Mr. Race Bares.",
    });

    const saleIns = await admin.from("pos_sales").insert({
      id: saleId, buyer_contact_id: buyerId, payer_name: ((first + " " + last).trim()) || null, sale_date: today,
      staff_email: "private-checkout@website", brand: "btkd",
      // pending_payment, not unpaid: an abandoned checkout must not leave a
      // debt on anybody\u0027s profile (owner 2026-08-25). Payment flips it
      // paid; the sweep abandons it after 24h.
      tender_method: null, status: "pending_payment",
      subtotal_cents: totals.subtotalCents, discount_cents: 0,
      admin_fee_cents: fee, tax_cents: totals.taxCents, total_cents: totals.totalCents,
      payer_email: email, calendar_url: calUrl,
      customer_note: wantPack
        ? ("Private lessons for " + student + ". First lesson " + when + ". "
          + packSize + " lessons prepaid, " + (packSize - 1) + " left to schedule - "
          + "call or text " + "903-561-2966 to set the rest.")
        : ("Private lesson for " + student + ", " + when + "."),
      notes: wantPack
        ? ("Private lesson pack from the website, " + packSize + " lessons, first on " + ymd)
        : ("Private lesson from the website, " + ymd),
    }).select("view_token").single();
    if (saleIns.error) throw saleIns.error;
    const token = saleIns.data.view_token as string;

    const problems: string[] = [];
    const lineIns = await admin.from("pos_sale_lines").insert({
      sale_id: saleId, kind: "event",
      label: wantPack
        ? ("Private lessons - " + student + " (" + packSize + " lessons, " + freeCount + " free)")
        : ("Private lesson - " + student + " (" + DURATION_MIN + " min, " + when + ")"),
      qty: 1, unit_cents: lessonsCents, discount_cents: 0,
      taxable: LESSON_TAXABLE, line_total_cents: lessonsCents,
      student_contact_id: buyerId, product_id: null, membership_row: null, membership_id: null,
    });
    if (lineIns.error) problems.push("line: " + lineIns.error.message);

    let packId: string | null = null;
    if (wantPack) {
      const packIns = await admin.from("private_lesson_packs").insert({
        contact_id: buyerId, sale_id: saleId,
        lessons_total: packSize, lessons_used: 1, amount_cents: lessonsCents,
      }).select("id").single();
      if (packIns.error) problems.push("pack: " + packIns.error.message);
      else packId = packIns.data.id as string;
    }

    // The unique index on starts_at is what actually stops a double booking:
    // two people can pass the availability check milliseconds apart.
    const lessonIns = await admin.from("private_lessons").insert({
      contact_id: buyerId, pack_id: packId, sale_id: saleId,
      starts_at: slotAt.toISOString(), duration_min: DURATION_MIN,
      status: "pending", student_name: student,
      contact_name: (first + " " + last).trim(), phone, email, notes,
    });
    if (lessonIns.error) {
      // Someone took the slot first. Unwind rather than charge for a lesson
      // that has no time attached to it.
      await admin.from("private_lessons").delete().eq("sale_id", saleId);
      if (packId) await admin.from("private_lesson_packs").delete().eq("id", packId);
      await admin.from("pos_sale_lines").delete().eq("sale_id", saleId);
      await admin.from("pos_sales").delete().eq("id", saleId);
      return json({ error: "Someone just booked that time. Please pick another." }, 409, cors);
    }

    // The wall calendar row is NOT written here: nothing is real until the
    // card clears. It is written on the paid transition instead, so an
    // abandoned checkout never leaves a lesson on his calendar.
    if (problems.length) console.error("[private-checkout] partial writes:", saleId, problems);

    if (!secretKey) {
      // A missing key is OUR failure, not a completed booking. Answering ok
      // with a receipt and no client_secret reads to the page as done, so a
      // key problem would have told every customer they were booked while
      // charging nobody (2026-08-26).
      console.error("[private-checkout] STRIPE_SECRET_KEY missing - refusing to imply a booking");
      return json({ error: "Card payments are not available right now. Please call 903-561-2966 and we will finish this for you." }, 503, cors);
    }

    // Whose card it is: one shared answer (_shared/family.ts). An adult
    // paying for themselves keeps their own customer (case 1, adopt-only,
    // never overwriting); a parent lands on their guardian person.
    const fam = await familyCustomer(admin, stripe, secretKey,
      { email, name: (first + " " + last).trim(), phone, studentId: buyerId });
    await admin.from("pos_sales").update({ stripe_customer_id: fam.custId }).eq("id", saleId);

    const f = new URLSearchParams();
    f.set("amount", String(totals.totalCents));
    f.set("currency", "usd");
    f.set("payment_method_types[]", "card");
    f.set("description", wantPack
      ? ("Private lesson pack (" + packSize + ") - " + student)
      : ("Private lesson - " + student + ", " + when));
    f.set("receipt_email", email);
    f.set("customer", fam.custId);
    f.set("setup_future_usage", "off_session");
    f.set("metadata[sale_id]", saleId);
    f.set("metadata[source]", "private-checkout");
    const pi = await stripe("payment_intents", secretKey, f);
    const piStamp = await admin.from("pos_sales")
      .update({ stripe_payment_intent: pi.id }).eq("id", saleId);
    // Checked: a silent failure here is what let the retry claim success.
    if (piStamp.error) console.error("payment intent stamp FAILED", saleId, piStamp.error);

    return json({
      ok: true, client_secret: pi.client_secret, payment_intent_id: pi.id,
      sale_id: saleId, total_cents: totals.totalCents,
      receipt_url: SITE + "/invoice/?t=" + token,
    }, 200, cors);
  } catch (e) {
    console.error("[private-checkout] failed:", e);
    const detail = (e as { message?: string })?.message || String(e);
    // The detail goes to the logs, never to the caller: this endpoint is
    // public and anyone could have asked for it with debug:true.
    console.error("[private-checkout] detail:", detail);
    return json({
      error: "Could not complete the booking. Please try again or call us.",
    }, 500, cors);
  }
});
