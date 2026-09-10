// ===========================================================================
// Supabase Edge Function: shop - the public gear shop
// ---------------------------------------------------------------------------
// Students buy school gear FROM Bares Taekwondo Fitness. Race orders it from
// Century in batches and hands it over at the school. PUBLIC and with NO
// LOGIN, on purpose (owner, 2026-09-09): he does not want payment attached to
// curriculum where kids browse unsupervised, and he does not want an account
// standing between a parent and buying gear. The buyer is identified the way
// every other checkout page does it, by the name and email typed at checkout.
//
// GET  -> the catalogue: the package, the pieces sold on their own, every
//         sellable variant with its price, and the settings copy.
// POST -> contact + sale + sale lines + shop order + order lines, then a
//         PaymentIntent. The client sends variant ids and quantities, NEVER
//         an amount.
// POST {action:"finalize"} -> re-reads the intent FROM STRIPE before
//         recording the payment.
//
// HARD RULES
//   1. The browser never names a price. Every unit price is re-derived here
//      from shop_variants, and a variant that is not sellable, not in stock,
//      or belongs to an inactive product is refused outright.
//   2. THE FEE GROSSES UP ON GOODS PLUS TAX. Stripe takes its cut of the
//      whole charge, tax included. Gear is all sales tax, so getting this
//      wrong costs about 59c on every set (ledger audit 2026-09-09).
//   3. The sale is created `pending_payment`, never `unpaid`. An abandoned
//      checkout must not leave a debt, which is the owner's ruling of
//      2026-08-25, and staff_email ends in -checkout@website so the existing
//      hourly sweep abandons it after 24h like every other web checkout.
//   4. A shop_order is written at POST time, but the fulfilment queue only
//      ever lists orders whose SALE IS PAID. So an abandoned checkout can
//      never put gear on Race's Century order.
//   5. Order lines are a SNAPSHOT. A later Century rename or price move must
//      not rewrite what somebody already bought.
//
// Deploy:  supabase functions deploy shop --no-verify-jwt
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";

const SITE = "https://www.barestkd.fit";
const TAX_RATE = 0.0825;          // the same literal the POS and every other checkout uses
const SLUG = "shop";              // its row in checkout_pages, for the live switch
const MAX_ITEMS = 40;

const ALLOWED_ORIGINS = [
  "https://www.barestkd.fit",
  "https://barestkd.fit",
  "https://crm.barestkd.fit",              // the CRM registry reads this GET
  "https://curriculum.barestkd.fit",       // curriculum links here
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
function json(body: unknown, status: number, h: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...h, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clip = (v: unknown, n: number) => str(v).slice(0, n);

/** Stripe REST, form-encoded. No SDK, same as every other checkout here. */
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

/** Brand and last four, wherever Stripe hung them. Same walk as the others. */
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

/** Receipt, server to server. Never throws into the payment path: the money
 *  is already recorded and a mail failure must not undo that. */
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
  } catch (e) { console.error("receipt send threw", e); }
}

/** The card fee, grossed up on goods PLUS tax. See HARD RULE 2. */
function feeFor(lines: { cents: number; taxable: boolean }[], bps: number, flat: number) {
  const preFee = BTKDPricing.invoiceTotals({ lines, discountCents: 0, adminFeeCents: 0, taxRate: TAX_RATE });
  const fee = BTKDPricing.cardFeeCents(preFee.totalCents, bps, flat);
  return BTKDPricing.invoiceTotals({ lines, discountCents: 0, adminFeeCents: fee, taxRate: TAX_RATE });
}

const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Server not configured." }, 500, cors);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const secretKey = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

  try {
    // ── settings and the live switch ────────────────────────────────────
    const [setRes, pageRes, feeRes] = await Promise.all([
      admin.from("settings").select(
        "shop_package_name,shop_package_note,shop_cadence_text,shop_notice_text").limit(1).maybeSingle(),
      admin.from("checkout_pages").select("live").eq("slug", SLUG).maybeSingle(),
      admin.from("pricing_settings").select("key,value_cents")
        .in("key", ["admin_fee_bps", "admin_fee_flat_cents", "shop_logo_cents"]),
    ]);
    const S = (setRes.data ?? {}) as Record<string, string>;
    const fs: Record<string, number> = {};
    ((feeRes.data ?? []) as { key: string; value_cents: number }[]).forEach((r) => fs[r.key] = r.value_cents);
    const feeBps = fs.admin_fee_bps ?? 290;
    const feeFlat = fs.admin_fee_flat_cents ?? 30;
    // A MISSING row means live, the same rule the other pages follow, so
    // nothing disappears because it was not registered yet.
    const pageLive = pageRes.data ? pageRes.data.live !== false : true;

    // ── GET: the catalogue ──────────────────────────────────────────────
    if (req.method === "GET") {
      if (!pageLive) {
        return json({
          closed: true,
          error: "The gear shop is not open right now. Call 903-561-2966 and we will sort you out.",
        }, 503, cors);
      }
      const [pRes, vRes] = await Promise.all([
        admin.from("shop_products")
          .select("id,title,image_url,item_type,logo_cents,in_package,set_order,lead_time_text,stocked")
          .eq("active", true).order("set_order"),
        admin.from("shop_variants")
          .select("id,product_id,size,color,list_cents,rank_gate")
          .eq("sellable", true).eq("available", true).order("position"),
      ]);
      if (pRes.error || vRes.error) throw (pRes.error ?? vRes.error);

      const byProduct = new Map<string, Record<string, unknown>[]>();
      for (const v of (vRes.data ?? []) as Record<string, unknown>[]) {
        const k = String(v.product_id);
        if (!byProduct.has(k)) byProduct.set(k, []);
        byProduct.get(k)!.push(v);
      }
      // A product with nothing sellable is simply not offered. It is not an
      // error and it is not a zero-priced product.
      const products = ((pRes.data ?? []) as Record<string, unknown>[])
        .map((p) => {
          const vs = byProduct.get(String(p.id)) ?? [];
          return {
            id: p.id,
            title: p.title,
            image_url: p.image_url,
            // Drives which tab the shop files it under, and the type chips.
            item_type: p.item_type || "other",
            in_package: p.in_package === true,
            logo: Number(p.logo_cents) > 0,
            lead_time_text: p.stocked === true ? null : (p.lead_time_text ?? null),
            // The price the buyer sees already contains the logo charge, and
            // is never presented as a separate line (owner, 2026-09-09).
            variants: vs.map((v) => ({
              id: v.id,
              size: v.size || "",
              color: v.color || "",
              cents: Number(v.list_cents) + Number(p.logo_cents ?? 0),
              black_belt_only: v.rank_gate === "black_belt",
            })),
          };
        })
        .filter((p) => p.variants.length > 0);

      return json({
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? "",
        tax_rate: TAX_RATE,
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        package_name: S.shop_package_name || "Beginner Gear Package",
        package_note: S.shop_package_note || "",
        cadence_text: S.shop_cadence_text || "",
        notice: S.shop_notice_text || "",
        package: products.filter((p) => p.in_package),
        extras: products.filter((p) => !p.in_package),
      }, 200, cors);
    }

    if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { body = {}; }

    // ── finalize ────────────────────────────────────────────────────────
    if (str(body.action) === "finalize") {
      if (!secretKey) return json({ error: "Payments are not configured." }, 503, cors);
      const fSale = str(body.sale_id).toLowerCase();
      const piId = str(body.payment_intent_id);
      if (!UUID_RE.test(fSale) || !piId.startsWith("pi_")) return json({ error: "Bad payment reference." }, 400, cors);

      const pi = await stripe("payment_intents/" + encodeURIComponent(piId)
        + "?expand[]=latest_charge.payment_method_details", secretKey, undefined, "GET");
      if (pi.status !== "succeeded") return json({ error: "That payment did not complete." }, 409, cors);
      if (str(pi.metadata?.sale_id).toLowerCase() !== fSale) {
        return json({ error: "That payment is for a different order." }, 409, cors);
      }
      const amt = Number(pi.amount_received ?? pi.amount ?? 0);
      if (amt <= 0) return json({ error: "No amount on that payment." }, 409, cors);

      const seen = await admin.from("pos_payments")
        .select("id").eq("sale_id", fSale).eq("stripe_object_id", pi.id).maybeSingle();
      if (!seen.data) {
        const ins = await admin.from("pos_payments").insert({
          sale_id: fSale, kind: "charge", amount_cents: amt, method: "card",
          ...cardBits(pi), stripe_object_id: pi.id, note: "Card payment (gear shop)",
        });
        if (ins.error) throw ins.error;
      }
      const sale = await admin.from("pos_sales")
        .select("total_cents,status,view_token").eq("id", fSale).single();
      if (sale.error || !sale.data) return json({ error: "Order not found." }, 404, cors);
      const pays = await admin.from("pos_payments").select("amount_cents").eq("sale_id", fSale);
      const net = (pays.data ?? []).reduce((a: number, p: { amount_cents: number }) => a + p.amount_cents, 0);
      if (net >= sale.data.total_cents && sale.data.status !== "paid") {
        const upd = await admin.from("pos_sales").update({
          status: "paid", tender_method: "card",
          confirmed_at: new Date().toISOString(), stripe_payment_intent: pi.id,
        }).eq("id", fSale);
        // The order only reaches Race's queue once its sale is paid, so
        // there is nothing else to flip here.
        if (!upd.error) await sendReceipt(fSale);
      }
      return json({ ok: true, paid: true, receipt_url: `${SITE}/invoice/?t=${sale.data.view_token}` }, 200, cors);
    }

    // ── the order ───────────────────────────────────────────────────────
    if (!pageLive) return json({ error: "The gear shop is not open right now.", closed: true }, 503, cors);
    if (str(body.hp)) return json({ ok: true }, 200, cors);   // honeypot: look successful, do nothing

    const saleId = str(body.sale_id).toLowerCase();
    if (!UUID_RE.test(saleId)) return json({ error: "Bad order id. Reload the page." }, 400, cors);

    // Idempotent on the client-minted id: a double submit cannot order twice.
    const existing = await admin.from("pos_sales")
      .select("id,status,total_cents,view_token,stripe_payment_intent").eq("id", saleId).maybeSingle();
    if (existing.data) {
      if (existing.data.status === "paid") {
        return json({ ok: true, paid: true, receipt_url: `${SITE}/invoice/?t=${existing.data.view_token}` }, 200, cors);
      }
      const pid = existing.data.stripe_payment_intent;
      if (pid && secretKey) {
        try {
          const pi = await stripe("payment_intents/" + encodeURIComponent(String(pid)), secretKey, undefined, "GET");
          if (pi.status !== "canceled" && pi.client_secret) {
            return json({ ok: true, client_secret: pi.client_secret, payment_intent_id: pi.id,
              sale_id: saleId, total_cents: existing.data.total_cents }, 200, cors);
          }
        } catch (e) { console.error("reuse intent failed", saleId, e); }
      }
      return json({ error: "We could not restart that payment. Please reload and try again." }, 409, cors);
    }

    const buyerFirst = clip(body.buyer_first, 60);
    const buyerLast = clip(body.buyer_last, 60);
    const email = clip(body.email, 160).toLowerCase();
    const phone = clip(body.phone, 40);
    const studentFirst = clip(body.student_first, 60);
    const studentLast = clip(body.student_last, 60);
    const buyerNote = clip(body.note, 600);
    if (!buyerFirst || !buyerLast) return json({ error: "Tell us your name." }, 400, cors);
    if (!EMAIL_RE.test(email)) return json({ error: "That email does not look right." }, 400, cors);
    if (!studentFirst || !studentLast) return json({ error: "Tell us who the gear is for." }, 400, cors);

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) return json({ error: "Nothing in the order yet." }, 400, cors);
    if (rawItems.length > MAX_ITEMS) return json({ error: "That is too many items for one order." }, 400, cors);

    // ── price it OURSELVES, HARD RULE 1 ─────────────────────────────────
    const wanted: { id: string; qty: number; fromPackage: boolean }[] = [];
    for (const raw of rawItems) {
      const r = raw as Record<string, unknown>;
      const id = str(r.variant_id).toLowerCase();
      const qty = Math.max(1, Math.min(10, Math.round(Number(r.qty) || 1)));
      if (!UUID_RE.test(id)) return json({ error: "Something in your order is not valid. Reload the page." }, 400, cors);
      wanted.push({ id, qty, fromPackage: r.from_package === true });
    }
    const vRes = await admin.from("shop_variants")
      .select("id,product_id,variant_sku,size,color,list_cents,sellable,available")
      .in("id", wanted.map((w) => w.id));
    if (vRes.error) throw vRes.error;
    const vMap = new Map<string, Record<string, unknown>>();
    for (const v of (vRes.data ?? []) as Record<string, unknown>[]) vMap.set(String(v.id), v);

    const pRes = await admin.from("shop_products")
      .select("id,title,dealer_sku,vendor,logo_cents,active")
      .in("id", Array.from(new Set((vRes.data ?? []).map((v: Record<string, unknown>) => String(v.product_id)))));
    if (pRes.error) throw pRes.error;
    const pMap = new Map<string, Record<string, unknown>>();
    for (const p of (pRes.data ?? []) as Record<string, unknown>[]) pMap.set(String(p.id), p);

    type Priced = {
      v: Record<string, unknown>; p: Record<string, unknown>;
      qty: number; unit: number; logoCents: number; fromPackage: boolean; label: string;
    };
    const priced: Priced[] = [];
    for (const w of wanted) {
      const v = vMap.get(w.id);
      if (!v) return json({ error: "One of those items is no longer in the shop. Reload the page." }, 409, cors);
      const p = pMap.get(String(v.product_id));
      if (!p || p.active !== true) return json({ error: "One of those items is no longer for sale. Reload the page." }, 409, cors);
      if (v.sellable !== true) return json({ error: "We are not selling that colour. Reload the page." }, 409, cors);
      if (v.available !== true) return json({ error: "Century has that one out of stock. Reload the page and pick another." }, 409, cors);
      const logoCents = Number(p.logo_cents) || 0;
      const unit = Number(v.list_cents) + logoCents;
      if (!(unit > 0)) return json({ error: "That item is not priced. Please call us." }, 409, cors);
      const bits = [v.size, v.color].map((x) => str(x)).filter(Boolean).join(", ");
      priced.push({
        v, p, qty: w.qty, unit, logoCents, fromPackage: w.fromPackage,
        label: String(p.title) + (bits ? " (" + bits + ")" : ""),
      });
    }

    const lines = priced.map((x) => ({ cents: x.unit * x.qty, taxable: true }));
    const totals = feeFor(lines, feeBps, feeFlat);

    // ── who is buying ───────────────────────────────────────────────────
    // Match on email only when it is unambiguous. A loose match would file
    // one family's order onto another family's record, which is the mistake
    // testing-checkout was hardened against.
    let buyerId: string | null = null;
    const emailPattern = email.replace(/([\\%_])/g, "\\$1");
    const found = await admin.from("contacts").select("id").ilike("email", emailPattern).limit(2);
    if ((found.data ?? []).length === 1) {
      buyerId = String((found.data as { id: string }[])[0].id);
    } else if (!(found.data ?? []).length) {
      const ins = await admin.from("contacts").insert({
        first_name: buyerFirst, last_name: buyerLast, email, phone,
        segment: "lead", source: "website-shop", entered_on: todayCT(),
      }).select("id").maybeSingle();
      if (ins.data) buyerId = String(ins.data.id);
    }

    // Who it is FOR. Same discipline: an exact single name match, or nothing.
    let studentId: string | null = null;
    const sHit = await admin.from("contacts").select("id")
      .ilike("first_name", studentFirst.replace(/([\\%_])/g, "\\$1"))
      .ilike("last_name", studentLast.replace(/([\\%_])/g, "\\$1")).limit(2);
    if ((sHit.data ?? []).length === 1) studentId = String((sHit.data as { id: string }[])[0].id);

    // ── the sale, HARD RULE 3 ───────────────────────────────────────────
    const saleIns = await admin.from("pos_sales").insert({
      id: saleId,
      buyer_contact_id: buyerId,
      sale_date: todayCT(),
      staff_email: "shop-checkout@website",
      brand: "btkd",
      status: "pending_payment",
      tender_method: null,
      subtotal_cents: totals.subtotalCents,
      discount_cents: 0,
      admin_fee_cents: totals.adminFeeCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      payer_name: buyerFirst + " " + buyerLast,
      payer_email: email,
      customer_note: buyerNote || null,
      notes: "Gear order for " + studentFirst + " " + studentLast,
    }).select("id,view_token").single();
    if (saleIns.error) throw saleIns.error;

    // Gear rides one generic products row so the POS, Reports and the receipt
    // keep working; the size and colour are in the line label, and the real
    // vendor detail is on the shop order line.
    const gear = await admin.from("products").select("id").eq("sku", "shop_gear").maybeSingle();
    const gearProductId = gear.data ? gear.data.id : null;

    const saleLineIds: (string | null)[] = [];
    for (const x of priced) {
      const ins = await admin.from("pos_sale_lines").insert({
        sale_id: saleId, kind: "prod", label: x.label, qty: x.qty,
        unit_cents: x.unit, discount_cents: 0, taxable: true,
        line_total_cents: x.unit * x.qty,
        student_contact_id: studentId, product_id: gearProductId,
      }).select("id").maybeSingle();
      saleLineIds.push(ins.data ? String(ins.data.id) : null);
    }

    // ── the fulfilment order, HARD RULES 4 and 5 ────────────────────────
    const vendor = String((priced[0].p.vendor as string) || "century");
    const orderIns = await admin.from("shop_orders").insert({
      sale_id: saleId,
      buyer_contact_id: buyerId,
      buyer_name: buyerFirst + " " + buyerLast,
      buyer_email: email,
      buyer_phone: phone || null,
      student_name: studentFirst + " " + studentLast,
      student_contact_id: studentId,
      vendor,
      fulfillment_status: "requested",
      buyer_note: buyerNote || null,
    }).select("id").single();
    if (orderIns.error) throw orderIns.error;

    const orderLines = priced.map((x, i) => ({
      order_id: orderIns.data.id,
      product_id: x.p.id,
      variant_id: x.v.id,
      sale_line_id: saleLineIds[i],
      vendor: String(x.p.vendor || "century"),
      dealer_sku: x.p.dealer_sku ?? null,
      variant_sku: x.v.variant_sku ?? null,
      title: x.p.title,
      size: str(x.v.size) || null,
      color: str(x.v.color) || null,
      from_package: x.fromPackage,
      logo: x.logoCents > 0,
      qty: x.qty,
      unit_cents: x.unit,
      logo_cents: x.logoCents,
      line_total_cents: x.unit * x.qty,
    }));
    const olIns = await admin.from("shop_order_lines").insert(orderLines);
    if (olIns.error) throw olIns.error;

    // ── the payment ─────────────────────────────────────────────────────
    if (!secretKey) {
      return json({ error: "We could not start the payment. Please call 903-561-2966." }, 503, cors);
    }
    const form = new URLSearchParams();
    form.set("amount", String(totals.totalCents));
    form.set("currency", "usd");
    form.append("payment_method_types[]", "card");
    form.set("description", "Bares Taekwondo Fitness - gear for " + studentFirst + " " + studentLast);
    form.set("receipt_email", email);
    form.set("metadata[sale_id]", saleId);
    form.set("metadata[source]", "shop");
    const pi = await stripe("payment_intents", secretKey, form);
    await admin.from("pos_sales").update({ stripe_payment_intent: pi.id }).eq("id", saleId);

    return json({
      ok: true,
      client_secret: pi.client_secret,
      payment_intent_id: pi.id,
      sale_id: saleId,
      total_cents: totals.totalCents,
    }, 200, cors);
  } catch (e) {
    console.error("shop error", e);
    return json({ error: "Something went wrong on our end. Nothing was charged. Please call 903-561-2966." }, 500, cors);
  }
});
