// ===========================================================================
// Supabase Edge Function: pricing-deck - what a membership presentation quotes
// ---------------------------------------------------------------------------
// Owner, 2026-10-10: the checkout pages show "pricing and policies" as the
// same clickable presentation the desk shows, in place of a PDF. The slides
// live in the CRM's presentation.js, which the pages load; this hands them
// the numbers: the catalog rows, the products a deck prices (uniforms, the
// gear package), the pricing settings (testing fees, the card fee), the live
// class times, and the open Little Kickers session. Nothing here is secret:
// every figure is on the pricing lists and the checkout pages already.
//
//   GET ?deck=tkd|cubs|kickboxing|jiujitsu|ampd|lk
//     -> { plans, products, settings, classes, session }
//
// PUBLIC, read-only. Deploy, from the barestkd-site repo root:
//   supabase functions deploy pricing-deck --no-verify-jwt
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://www.barestkd.fit",
  "https://barestkd.fit",
  "https://crm.barestkd.fit",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];
function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}
function json(obj: unknown, status: number, cors: Record<string, string>, cache = false) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json", ...(cache ? { "Cache-Control": "public, max-age=300" } : {}) },
  });
}

const DECKS = new Set(["tkd", "cubs", "kickboxing", "jiujitsu", "ampd", "lk"]);
// The products a deck prices, by the name the catalog gives them.
const PRODUCT_NAMES = ["Beginner uniform", "Cubs uniform", "Sparring gear package"];
// The settings a deck reads. Anything else in pricing_settings stays home.
const SETTING_KEYS = [
  "admin_fee_bps", "admin_fee_flat_cents",
  "testing_fee_standard_cents", "testing_fee_cubs_cents",
  "testing_fee_2nd_cents", "testing_fee_3rd_cents", "testing_fee_addl_cents",
];

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405, cors);

  const deck = String(new URL(req.url).searchParams.get("deck") ?? "").trim().toLowerCase();
  if (!DECKS.has(deck)) return json({ error: "Which deck?" }, 400, cors);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

    const [plans, products, settings, classes] = await Promise.all([
      admin.from("pricing_plans")
        .select("code,name,program,category,billing_frequency,recurring_cents,down_cents,pif_cents,payment_count,promo_label,family_position")
        .eq("active", true),
      admin.from("products").select("name,price_cents").in("name", PRODUCT_NAMES).eq("active", true),
      admin.from("pricing_settings").select("key,value_cents").in("key", SETTING_KEYS),
      admin.from("schedule_template").select("day,time_h,time_m,duration,program,starts_on,ends_on"),
    ]);
    for (const r of [plans, products, settings, classes]) if (r.error) throw r.error;

    const settingsObj: Record<string, number> = {};
    for (const s of (settings.data ?? []) as { key: string; value_cents: number }[]) settingsObj[s.key] = s.value_cents;

    let session: Record<string, unknown> | null = null;
    if (deck === "lk") {
      const ses = await admin.from("program_sessions").select("*")
        .eq("program", "Little Kickers").eq("status", "open").order("starts_on");
      if (ses.error) throw ses.error;
      session = ((ses.data ?? []) as Record<string, unknown>[])[0] ?? null;
    }

    return json({
      deck,
      plans: plans.data ?? [],
      products: products.data ?? [],
      settings: settingsObj,
      classes: ((classes.data ?? []) as Record<string, unknown>[])
        .filter((r) => !r.ends_on || String(r.ends_on) >= today),
      session,
    }, 200, cors, true);
  } catch (e) {
    console.error("[pricing-deck]", e);
    return json({ error: "Could not load the pricing right now." }, 500, cors);
  }
});
