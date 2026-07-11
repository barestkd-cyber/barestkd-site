// ===========================================================================
// Supabase Edge Function: trial-booking
// ---------------------------------------------------------------------------
// One endpoint for two marketing-site submissions:
//   type: "trial"    -> on-site free-trial popup (program + chosen class + person)
//   type: "contact"  -> the contact form
//
// HARD RULES (do not weaken):
//   1. Validate required fields. Reject silently if the honeypot "company" is set.
//   2. INSERT INTO THE DATABASE FIRST (contacts, then trial_bookings / guardian).
//   3. THEN send a Resend notification email. A Resend failure must NEVER lose the
//      lead: catch it, log it, and STILL return success to the browser.
//   4. CORS locked to the three site origins only.
//   5. Resend API key comes from the project secret RESEND_API_KEY.
//
// Deploy (see repo README / the site's manual-steps list):
//   supabase functions deploy trial-booking --no-verify-jwt
// ===========================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://www.barestkd.fit",
  "https://preview.barestkd.fit",
  "https://barestkd.fit",
];

const NOTIFY_TO = "race@barestkd.fit";
// From-address MUST be on the Resend-verified domain (barestkd.fit).
const NOTIFY_FROM = "Bares TKD Website <noreply@barestkd.fit>";

function corsHeaders(origin: string | null) {
  const allow =
    origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const str = (v: unknown) => (v == null ? "" : String(v)).trim();

function json(obj: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Bad JSON" }, 400, cors);
  }

  // Honeypot: pretend success, do nothing.
  if (str(body.company) !== "") return json({ ok: true }, 200, cors);

  const type = body.type === "trial" ? "trial" : "contact";

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const today = new Date().toISOString().slice(0, 10);
  let subject = "";
  let lines: string[] = [];

  // ---- 1 & 2: validate + DB insert FIRST -------------------------------
  try {
    if (type === "trial") {
      const program = str(body.program);
      const classLabel = str(body.class_label);
      const classDatetime = str(body.class_datetime);
      const contactName = str(body.contact_name); // the "Your name" field (parent for kids)
      const studentName = str(body.student_name); // kids only
      const phone = str(body.phone);
      const email = str(body.email);
      const isKids = !!body.is_kids;
      const studentAge = body.student_age ? parseInt(String(body.student_age), 10) : null;

      if (!program || !classDatetime || !contactName || !phone || !email || (isKids && !studentName)) {
        return json({ error: "Missing required fields" }, 400, cors);
      }

      // The contact row is the student: their name for kids, the adult otherwise.
      const who = isKids ? studentName : contactName;
      const parts = who.split(" ");
      const firstName = parts[0] || who;
      const lastName = parts.slice(1).join(" ");

      const { data: contact, error: cErr } = await admin
        .from("contacts")
        .insert({
          first_name: firstName,
          last_name: lastName,
          segment: "trial",
          member_role: "student",
          program,
          source: "website-trial",
          entered_on: today,
          email,   // parent's email for kids; the adult's otherwise
          phone,   // parent's phone for kids; the adult's otherwise
        })
        .select("id")
        .single();
      if (cErr) throw cErr;

      const { error: bErr } = await admin.from("trial_bookings").insert({
        contact_id: contact.id,
        program,
        class_datetime: classDatetime,
        class_label: classLabel,
        student_age: studentAge,
        booked_by: contactName,
      });
      if (bErr) throw bErr;

      // Kids: record the parent's email as a guardian (matches existing pattern).
      if (isKids && email) {
        await admin.from("student_guardians").insert({
          student_id: contact.id,
          email,
          label: "parent",
        });
      }

      subject = `New free-trial booking: ${who} (${program})`;
      lines = [
        `Program: ${program}`,
        `Class: ${classLabel} — ${classDatetime}`,
        isKids ? `Student: ${studentName}${studentAge ? " (age " + studentAge + ")" : ""}` : `Name: ${contactName}`,
        isKids ? `Parent/guardian: ${contactName}` : "",
        `Phone: ${phone}`,
        `Email: ${email}`,
      ].filter(Boolean);
    } else {
      const name = str(body.name);
      const phone = str(body.phone);
      const email = str(body.email);
      const message = str(body.message);
      const program = str(body.program);
      if (!name || !phone || !email || !message) {
        return json({ error: "Missing required fields" }, 400, cors);
      }
      const parts = name.split(" ");
      const { error: cErr } = await admin.from("contacts").insert({
        first_name: parts[0] || name,
        last_name: parts.slice(1).join(" "),
        segment: "lead",
        member_role: "student",
        program: program || null,
        source: "website-contact",
        entered_on: today,
        email,
        phone,
      });
      if (cErr) throw cErr;

      subject = `New website contact: ${name}`;
      lines = [
        program ? `Interested in: ${program}` : "",
        `Name: ${name}`,
        `Phone: ${phone}`,
        `Email: ${email}`,
        "",
        `Message:`,
        message,
      ].filter((l) => l !== undefined);
    }
  } catch (e) {
    console.error("[trial-booking] DB insert failed:", e);
    return json({ error: "Could not save your request. Please try again." }, 500, cors);
  }

  // ---- 3: Resend notification (best-effort, NEVER loses the lead) -------
  try {
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) {
      console.warn("[trial-booking] RESEND_API_KEY not set; email skipped (lead is saved).");
    } else {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: NOTIFY_FROM,
          to: [NOTIFY_TO],
          subject,
          text: lines.join("\n"),
        }),
      });
      if (!res.ok) {
        console.error("[trial-booking] Resend non-OK (lead is saved):", res.status, await res.text());
      }
    }
  } catch (e) {
    console.error("[trial-booking] Resend threw (lead is saved):", e);
  }

  return json({ ok: true }, 200, cors);
});
