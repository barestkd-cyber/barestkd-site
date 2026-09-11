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
//         sellable variant with its price, the school's own shirts, and the
//         settings copy.
// POST -> contact + sale + sale lines + shop order + order lines, then a
//         PaymentIntent. The client sends variant ids and quantities, NEVER
//         an amount.
// POST {action:"finalize"} -> re-reads the intent FROM STRIPE before
//         recording the payment.
//
// HARD RULES
//   1. The browser never names a price. Every unit price is re-derived here
//      from shop_variants through BTKDPricing.shopUnitCents, the rule the CRM
//      shows too: Century's list + the logo + TWICE what the school pays for
//      each piece of art, or the flat price while an art cost is unknown
//      (owner, 2026-09-11). A variant that is not sellable, not in stock, or
//      belongs to an inactive product is refused outright. What the school
//      pays for art NEVER leaves the server: the page gets the labels only.
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
//   6. NOBODY BUYS OUT-OF-STOCK GEAR. The stored flag is only as fresh as the
//      weekly refresh, so stock is re-checked LIVE with Century at the moment
//      of paying, before a single row is written or a cent moves. A definite
//      "out of stock" refuses the order and marks the variant so the page
//      stops offering it. If Century cannot be reached at all, the stored
//      flag, already checked, stands, rather than refusing every sale on a
//      Century hiccup (owner, 2026-09-10).
//   7. SHIRTS ARE THE SCHOOL'S OWN (owner, 2026-09-11). The T-Shirts tab sells
//      every shirt the checkout pages sell, priced from `products`, the CRM
//      catalogue the POS and those pages already use, so one price change in
//      the CRM reaches all of them. A shirt is never Century gear: it skips
//      the Century stock check, and it goes on its own shop order with vendor
//      'school', so it can never land in the text Race pastes to Century.
//
// Deploy:  supabase functions deploy shop --no-verify-jwt
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import BTKDPricing from "../_shared/pricing_esm.js";

const SITE = "https://www.barestkd.fit";
const TAX_RATE = 0.0825;          // the same literal the POS and every other checkout uses
const SLUG = "shop";              // its row in checkout_pages, for the live switch
const MAX_ITEMS = 40;

// ── the school's own shirts, HARD RULE 7 ────────────────────────────────
// The NAME is the key into `products`. Artwork, colour and sizes are the
// checkout pages' own (cubs-checkout, program-checkout, lk-checkout), and
// tests/checkout-copy.test.js fails if a checkout page sells a shirt that is
// missing here. A shirt the catalogue marks inactive is simply not offered.
const TEE_SIZES = ["Youth XS", "Youth S", "Youth M", "Youth L", "Adult S", "Adult M", "Adult L", "Adult XL", "Adult 2XL"];
// `swatch` is the colour painted behind the artwork, and it must be the
// artwork's OWN edge colour, sampled from the image, or the picture shows as
// a box of a slightly different colour (owner, 2026-09-11). `fill` is for a
// photo that runs to its edges with no flat background: it fills the tile.
type Shirt = {
  name: string; colour: string; swatch: string; sizes: string[]; fill?: boolean;
  designs?: string[]; images: { src: string; label: string }[];
};
const SHIRTS: Shirt[] = [
  { name: "Classic gray tee", colour: "Gray", swatch: "#B4B6B9", sizes: TEE_SIZES,
    images: [{ src: "/assets/img/logo.png", label: "Front" },
             { src: "/assets/img/shirts/art-bear-patch.png", label: "Back" }] },
  // A photo of the print on blue fabric, textured to its edges: no flat colour
  // can match it, so it fills the whole tile instead.
  { name: "Lego tee", colour: "Blue", swatch: "#00458C", sizes: TEE_SIZES, fill: true,
    images: [{ src: "/assets/img/shirts/art-lego.jpg", label: "Front" }] },
  { name: "Alternate design tee", colour: "Black", swatch: "#000000", sizes: TEE_SIZES,
    images: [{ src: "/assets/img/shirts/art-bares-bar.jpg", label: "Front" }] },
  { name: "Team Grizzly Kickboxing tee", colour: "Black", swatch: "#030103", sizes: TEE_SIZES,
    images: [{ src: "/assets/img/shirts/art-grizzly-kickboxing.jpg", label: "Front" }] },
  // White, and the artwork is the choice, exactly as on the Little Kickers page.
  { name: "Little Kickers T-Shirt", colour: "White", swatch: "#FEFEFE",
    sizes: ["2T", "3T", "4T", "Youth XS", "Youth S"], designs: ["Girl", "Boy"],
    images: [{ src: "/assets/img/lk-logo-girl.png", label: "Girl design" },
             { src: "/assets/img/lk-logo-boy.png", label: "Boy design" }] },
];
// A shirt's variant id is built, never stored: tee|<products.id>|<size>|<colour
// or design>. Every part is re-checked on the way back in, and the price never
// comes from the id.
const TEE_PREFIX = "tee|";
const teeVariantId = (productId: string, size: string, second: string) =>
  TEE_PREFIX + productId + "|" + size + "|" + second;
/** The invoice label, word for word what the checkout pages write. */
const teeLabel = (sh: Shirt, size: string, second: string) =>
  sh.designs ? sh.name + " (" + second + ", " + size + ", white)" : sh.name + " (" + size + ")";

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

/** Live stock at Century, HARD RULE 6. Returns the Century variant ids that
 *  Century reports as OUT of stock, for the products it could reach. A
 *  product it could not reach contributes nothing: the stored flag has
 *  already been checked for it, and a slow storefront must not block sales. */
const CENTURY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
async function centuryOutOfStock(handles: string[]): Promise<Set<number>> {
  const out = new Set<number>();
  await Promise.all(handles.map(async (h) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch("https://www.centurymartialarts.com/products/" + encodeURIComponent(h) + ".js", {
        headers: { "User-Agent": CENTURY_UA, "Accept": "application/json,text/javascript,*/*" },
        signal: ctl.signal,
      });
      if (!r.ok) return;
      // The .js endpoint answers text/javascript; parse on content.
      const p = JSON.parse(await r.text());
      for (const v of (p?.variants ?? [])) if (v && v.available === false) out.add(Number(v.id));
    } catch (e) {
      console.error("live stock check failed for", h, e);
    } finally {
      clearTimeout(timer);
    }
  }));
  return out;
}

/** The card fee, grossed up on goods PLUS tax. See HARD RULE 2. */
function feeFor(lines: { cents: number; taxable: boolean }[], bps: number, flat: number) {
  const preFee = BTKDPricing.invoiceTotals({ lines, discountCents: 0, adminFeeCents: 0, taxRate: TAX_RATE });
  const fee = BTKDPricing.cardFeeCents(preFee.totalCents, bps, flat);
  return BTKDPricing.invoiceTotals({ lines, discountCents: 0, adminFeeCents: fee, taxRate: TAX_RATE });
}

const todayCT = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/** The art on an item as the words a buyer reads, never what it costs: the
 *  school's cost per piece is Race's, and stays in the CRM. */
const artLabels = (p: Record<string, unknown>): string[] =>
  (Array.isArray(p.art) ? (p.art as Record<string, unknown>[]) : [])
    .map((a) => str(a ? a.label : "")).filter(Boolean);

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
      const [pRes, vRes, tRes] = await Promise.all([
        admin.from("shop_products")
          .select("id,title,display_title,image_url,item_type,category,logo_cents,art,flat_price_cents,package_role,set_order,lead_time_text,stocked")
          .eq("active", true).order("set_order"),
        admin.from("shop_variants")
          .select("id,product_id,size,color,list_cents,rank_gate")
          .eq("sellable", true).eq("available", true).order("position"),
        admin.from("products").select("id,name,price_cents")
          .in("name", SHIRTS.map((sh) => sh.name)).eq("active", true),
      ]);
      if (pRes.error || vRes.error || tRes.error) throw (pRes.error ?? vRes.error ?? tRes.error);

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
            // Our own name when there is one: Century's title is rewritten
            // by every weekly refresh, the display title never is.
            title: (p.display_title as string | null) || p.title,
            image_url: p.image_url,
            // Drives which tab the shop files it under, and the type chips.
            item_type: p.item_type || "other",
            // The Category dropdown within a tab. Null means "use the type".
            category: (p.category as string | null) || null,
            // Its part in the package: required, boys (required only for a
            // boy), optional, or null for sold-on-its-own only.
            role: (p.package_role as string | null) ?? null,
            in_package: p.package_role === "required",
            logo: Number(p.logo_cents) > 0,
            art_labels: artLabels(p),
            lead_time_text: p.stocked === true ? null : (p.lead_time_text ?? null),
            // The price the buyer sees already contains the logo charge, and
            // is never presented as a separate line (owner, 2026-09-09).
            // An item the rule cannot price (art costs unknown and no flat
            // price) offers nothing, rather than a guessed or zero price.
            variants: vs.map((v) => ({
              id: v.id,
              size: v.size || "",
              color: v.color || "",
              cents: BTKDPricing.shopUnitCents(v.list_cents, p),
              black_belt_only: v.rank_gate === "black_belt",
            })).filter((v) => typeof v.cents === "number" && v.cents > 0),
          };
        })
        .filter((p) => p.variants.length > 0);

      // The shirts, HARD RULE 7, in the order the checkout pages list them.
      const teeRows = new Map<string, Record<string, unknown>>();
      for (const r of (tRes.data ?? []) as Record<string, unknown>[]) teeRows.set(String(r.name), r);
      const shirts: Record<string, unknown>[] = SHIRTS.flatMap((sh) => {
        const r = teeRows.get(sh.name);
        const cents = r ? Number(r.price_cents) : 0;
        if (!r || !(cents > 0)) return [];
        const pairs: string[][] = sh.designs
          ? sh.sizes.flatMap((size) => sh.designs!.map((d) => [size, d]))
          : sh.sizes.map((size) => [size, sh.colour]);
        return [{
          id: "tee-" + String(r.id),
          title: sh.name,
          image_url: sh.images[0].src,
          images: sh.images,
          swatch: sh.swatch,
          fill: sh.fill === true,
          item_type: "shirt",
          category: "T-shirts",
          role: null,
          in_package: false,
          logo: false,
          lead_time_text: null,
          // On the Little Kickers shirt the second choice is the artwork.
          color_label: sh.designs ? "Design" : null,
          variants: pairs.map(([size, second]) => ({
            id: teeVariantId(String(r.id), size, second),
            size, color: second, cents, black_belt_only: false,
          })),
        }];
      });
      const extras: Record<string, unknown>[] = [...products.filter((p) => p.role !== "required"), ...shirts];

      return json({
        publishable_key: Deno.env.get("STRIPE_PUBLISHABLE_KEY") ?? "",
        tax_rate: TAX_RATE,
        admin_fee_bps: feeBps,
        admin_fee_flat_cents: feeFlat,
        package_name: S.shop_package_name || "Beginner Gear Package",
        package_note: S.shop_package_note || "",
        cadence_text: S.shop_cadence_text || "",
        notice: S.shop_notice_text || "",
        // `package` and `extras` keep their OLD meaning, the required pieces
        // and everything else, so a phone still holding yesterday's page keeps
        // working. The current page reads `role` off each product instead.
        package: products.filter((p) => p.role === "required"),
        extras,
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
    const wantedTees: { productId: string; size: string; second: string; qty: number }[] = [];
    for (const raw of rawItems) {
      const r = raw as Record<string, unknown>;
      const rawId = str(r.variant_id);
      const qty = Math.max(1, Math.min(10, Math.round(Number(r.qty) || 1)));
      if (rawId.startsWith(TEE_PREFIX)) {
        const parts = rawId.split("|");
        if (parts.length !== 4 || !UUID_RE.test(parts[1])) {
          return json({ error: "Something in your order is not valid. Reload the page." }, 400, cors);
        }
        wantedTees.push({ productId: parts[1].toLowerCase(), size: parts[2], second: parts[3], qty });
        continue;
      }
      const id = rawId.toLowerCase();
      if (!UUID_RE.test(id)) return json({ error: "Something in your order is not valid. Reload the page." }, 400, cors);
      wanted.push({ id, qty, fromPackage: r.from_package === true });
    }
    const vRes = wanted.length
      ? await admin.from("shop_variants")
        .select("id,product_id,vendor_variant_id,variant_sku,size,color,list_cents,sellable,available")
        .in("id", wanted.map((w) => w.id))
      : { data: [] as Record<string, unknown>[], error: null };
    if (vRes.error) throw vRes.error;
    const vMap = new Map<string, Record<string, unknown>>();
    for (const v of (vRes.data ?? []) as Record<string, unknown>[]) vMap.set(String(v.id), v);

    const gearIds = Array.from(new Set((vRes.data ?? []).map((v: Record<string, unknown>) => String(v.product_id))));
    const pRes = gearIds.length
      ? await admin.from("shop_products")
        .select("id,title,display_title,dealer_sku,vendor,handle,logo_cents,art,flat_price_cents,active")
        .in("id", gearIds)
      : { data: [] as Record<string, unknown>[], error: null };
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
      const unit = BTKDPricing.shopUnitCents(v.list_cents, p);
      if (!(typeof unit === "number" && unit > 0)) {
        return json({ error: "That item is not priced. Please call us." }, 409, cors);
      }
      const bits = [v.size, v.color].map((x) => str(x)).filter(Boolean).join(", ");
      priced.push({
        v, p, qty: w.qty, unit, logoCents, fromPackage: w.fromPackage,
        label: String(p.display_title || p.title) + (bits ? " (" + bits + ")" : ""),
      });
    }

    // ── the shirts, HARD RULE 7: priced from the CRM catalogue ─────────
    type Tee = { sh: Shirt; row: Record<string, unknown>; size: string; second: string;
                 qty: number; unit: number; label: string };
    const tees: Tee[] = [];
    if (wantedTees.length) {
      const tRes = await admin.from("products").select("id,name,price_cents,active")
        .in("id", Array.from(new Set(wantedTees.map((w) => w.productId))));
      if (tRes.error) throw tRes.error;
      const tMap = new Map<string, Record<string, unknown>>();
      for (const r of (tRes.data ?? []) as Record<string, unknown>[]) tMap.set(String(r.id), r);
      for (const w of wantedTees) {
        const row = tMap.get(w.productId);
        const sh = row ? SHIRTS.find((x) => x.name === row.name) : undefined;
        if (!row || !sh || row.active !== true) {
          return json({ error: "One of those shirts is no longer for sale. Reload the page." }, 409, cors);
        }
        if (!sh.sizes.includes(w.size)) return json({ error: "Pick a size for the " + sh.name + "." }, 400, cors);
        const okSecond = sh.designs ? sh.designs.includes(w.second) : w.second === sh.colour;
        if (!okSecond) {
          return json({ error: (sh.designs ? "Pick the girl or boy design for the " : "That colour is not offered for the ")
            + sh.name + ".", }, 400, cors);
        }
        const unit = Number(row.price_cents);
        if (!(unit > 0)) return json({ error: "That shirt is not priced. Please call us." }, 409, cors);
        tees.push({ sh, row, size: w.size, second: w.second, qty: w.qty, unit, label: teeLabel(sh, w.size, w.second) });
      }
    }

    // ── live stock, HARD RULE 6 ────────────────────────────────────────
    const handles = Array.from(new Set(priced.map((x) => str(x.p.handle)).filter(Boolean)));
    const gone = await centuryOutOfStock(handles);
    const soldOut = priced.filter((x) => gone.has(Number(x.v.vendor_variant_id)));
    if (soldOut.length) {
      // Record it now, so the page stops offering it straight away instead of
      // waiting for the weekly refresh to notice.
      await admin.from("shop_variants").update({ available: false })
        .in("id", soldOut.map((x) => String(x.v.id)));
      return json({
        error: "Century has just sold out of " + soldOut.map((x) => x.label).join(", ")
          + ". Remove it and pick another size or colour. Nothing has been charged.",
        sold_out: soldOut.map((x) => String(x.v.id)),
      }, 409, cors);
    }

    const lines = priced.map((x) => ({ cents: x.unit * x.qty, taxable: true }))
      .concat(tees.map((t) => ({ cents: t.unit * t.qty, taxable: true })));
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
    // A shirt's line points at its own catalogue product, exactly as the
    // checkout pages record it, so Reports count a shirt as that shirt.
    const teeLineIds: (string | null)[] = [];
    for (const t of tees) {
      const ins = await admin.from("pos_sale_lines").insert({
        sale_id: saleId, kind: "prod", label: t.label, qty: t.qty,
        unit_cents: t.unit, discount_cents: 0, taxable: true,
        line_total_cents: t.unit * t.qty,
        student_contact_id: studentId, product_id: t.row.id,
      }).select("id").maybeSingle();
      teeLineIds.push(ins.data ? String(ins.data.id) : null);
    }

    // ── the fulfilment orders, HARD RULES 4, 5 and 7 ────────────────────
    // One order per vendor, so each vendor's Copy order in the queue holds
    // only what that vendor sells, and the school's shirts are their own.
    const orderFor = async (vendor: string): Promise<string> => {
      const ins = await admin.from("shop_orders").insert({
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
      if (ins.error) throw ins.error;
      return String(ins.data.id);
    };

    const byVendor = new Map<string, number[]>();
    priced.forEach((x, i) => {
      const v = String(x.p.vendor || "century");
      if (!byVendor.has(v)) byVendor.set(v, []);
      byVendor.get(v)!.push(i);
    });
    for (const [vendor, idx] of byVendor) {
      const orderId = await orderFor(vendor);
      const olIns = await admin.from("shop_order_lines").insert(idx.map((i) => {
        const x = priced[i];
        return {
          order_id: orderId,
          product_id: x.p.id,
          variant_id: x.v.id,
          sale_line_id: saleLineIds[i],
          vendor,
          dealer_sku: x.p.dealer_sku ?? null,
          variant_sku: x.v.variant_sku ?? null,
          title: x.p.display_title || x.p.title,
          // What goes on it, so the queue and the Century order text say so.
          art_text: artLabels(x.p).join("; ") || null,
          size: str(x.v.size) || null,
          color: str(x.v.color) || null,
          from_package: x.fromPackage,
          logo: x.logoCents > 0,
          qty: x.qty,
          unit_cents: x.unit,
          logo_cents: x.logoCents,
          line_total_cents: x.unit * x.qty,
        };
      }));
      if (olIns.error) throw olIns.error;
    }

    if (tees.length) {
      const orderId = await orderFor("school");
      const olIns = await admin.from("shop_order_lines").insert(tees.map((t, i) => ({
        order_id: orderId,
        product_id: null,
        variant_id: null,
        sale_line_id: teeLineIds[i],
        vendor: "school",
        dealer_sku: null,
        variant_sku: null,
        title: t.sh.name,
        size: t.size,
        color: t.sh.designs ? t.second + " design, white" : t.sh.colour,
        from_package: false,
        logo: false,
        qty: t.qty,
        unit_cents: t.unit,
        logo_cents: 0,
        line_total_cents: t.unit * t.qty,
      })));
      if (olIns.error) throw olIns.error;
    }

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
