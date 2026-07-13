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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function adminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/* ---------------------------------------------------------------------------
   GET /trial-booking — the popup's live schedule.
   Reads schedule_template (service role) for trial_open=true rows, groups them
   into marketing programs (grouping only; trial_open is what gates bookability),
   and returns them with each program's kids flag. Cached a few minutes.

   Grouping mapping (schedule_template.day is 0=Mon … 5=Sat):
     Taekwondo  = prog-juniors, prog-teen, prog-forms   (Forms serves Jr + Teens/Adults)
     Cubs       = prog-cubs
     Kickboxing = prog-kick with a "kickbox" label
     Jiu Jitsu  = prog-kick with a "jiu"/"bjj" label
   --------------------------------------------------------------------------- */
const MARKETING = [
  { program: "Taekwondo", ageLabel: "Ages 5 to Adult", kids: true,
    match: (r: any) => ["prog-juniors", "prog-teen", "prog-forms"].includes(r.prog_css) },
  { program: "Cubs", ageLabel: "Ages 3-4", kids: true,
    match: (r: any) => r.prog_css === "prog-cubs" },
  { program: "Kickboxing", ageLabel: "Ages 13+", kids: false,
    match: (r: any) => r.prog_css === "prog-kick" && /kickbox/i.test(r.label || "") },
  { program: "Jiu Jitsu", ageLabel: "Ages 13+", kids: false,
    match: (r: any) => r.prog_css === "prog-kick" && /(jiu|bjj)/i.test(r.label || "") },
];

const CACHE_MS = 5 * 60 * 1000;
let scheduleCache: { at: number; data: unknown } | null = null;

async function handleSchedule(cors: Record<string, string>) {
  const cacheHeaders = { ...cors, "Cache-Control": "public, max-age=300" };
  const now = Date.now();
  if (scheduleCache && now - scheduleCache.at < CACHE_MS) {
    return json(scheduleCache.data, 200, cacheHeaders);
  }
  try {
    const { data: rows, error } = await adminClient()
      .from("schedule_template")
      .select("day, time_h, time_m, label, prog_css")
      .eq("trial_open", true);
    if (error) throw error;

    const programs = MARKETING.map(function (mkt) {
      var classes = (rows || []).filter(mkt.match).map(function (r: any) {
        return {
          dow: r.day + 1,            // schedule 0=Mon -> JS weekday 1=Mon … 5=Sat -> 6
          h: r.time_h,               // 24-hour clock source
          m: r.time_m,
          label: r.label || mkt.program,
        };
      });
      return { program: mkt.program, ageLabel: mkt.ageLabel, kids: mkt.kids, classes: classes };
    }).filter(function (p) { return p.classes.length > 0; });

    const payload = { programs: programs };
    scheduleCache = { at: now, data: payload };
    return json(payload, 200, cacheHeaders);
  } catch (e) {
    console.error("[trial-booking] schedule read failed:", e);
    return json({ error: "schedule unavailable" }, 500, cors);
  }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("origin"));

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") return await handleSchedule(cors);
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

  const admin = adminClient();

  const today = new Date().toISOString().slice(0, 10);
  let subject = "";
  let lines: string[] = [];

  // A second, best-effort confirmation email to the parent/student. Populated
  // by the trial branch; left empty for contacts (no confirmation there).
  let confirmTo = "";
  let confirmSubject = "";
  let confirmLines: string[] = [];

  // ---- 1 & 2: validate + DB insert FIRST -------------------------------
  try {
    if (type === "trial") {
      // v2 shape: one student, one or more chosen programs, one booking per
      // chosen class, a real DOB, a full address, and a signed waiver.
      const studentFirst = str(body.student_first);
      const studentLast = str(body.student_last);
      const dob = str(body.dob); // YYYY-MM-DD
      const addr = (body.address && typeof body.address === "object")
        ? body.address as Record<string, unknown> : {};
      const street = str(addr.street), city = str(addr.city);
      const region = str(addr.state), zip = str(addr.zip);
      const isKids = !!body.is_kids;
      const programs = Array.isArray(body.programs)
        ? body.programs.map((p) => str(p)).filter(Boolean) : [];
      const bookings = Array.isArray(body.bookings) ? body.bookings : [];
      const waiverName = str(body.waiver_name);
      const waiverAgreed = !!body.waiver_agreed;

      // Contact channel: parent for kids, the person themselves for 13+.
      let contactEmail = "", contactPhone = "", parentEmail = "", bookedBy = "";
      if (isKids) {
        contactPhone = str(body.parent_phone);
        contactEmail = str(body.parent_email);
        parentEmail = contactEmail;
        bookedBy = (str(body.parent_first) + " " + str(body.parent_last)).trim();
      } else {
        contactPhone = str(body.phone);
        contactEmail = str(body.email);
        bookedBy = str(body.guardian) || (studentFirst + " " + studentLast).trim();
      }

      const who = (studentFirst + " " + studentLast).trim();

      if (!studentFirst || !studentLast || !dob || !street || !city || !region || !zip ||
          !contactPhone || !contactEmail || !programs.length || !bookings.length ||
          !waiverAgreed || !waiverName || (isKids && !bookedBy)) {
        return json({ error: "Missing required fields" }, 400, cors);
      }

      const addressText = [street, city, [region, zip].filter(Boolean).join(" ")]
        .filter(Boolean).join(", ");

      // Real age from DOB (kept for CRM compatibility; DOB is the source of truth).
      let studentAge: number | null = null;
      const dobDate = new Date(dob);
      if (!isNaN(dobDate.getTime())) {
        const t = new Date();
        let a = t.getFullYear() - dobDate.getFullYear();
        const mo = t.getMonth() - dobDate.getMonth();
        if (mo < 0 || (mo === 0 && t.getDate() < dobDate.getDate())) a--;
        studentAge = a >= 0 && a < 120 ? a : null;
      }

      // ONE contact per student. program stays NULL; trial-interest programs
      // live in tags (text[]) and on the booking rows.
      const { data: contact, error: cErr } = await admin
        .from("contacts")
        .insert({
          first_name: studentFirst,
          last_name: studentLast,
          segment: "trial",
          member_role: "student",
          program: null,
          source: "website-trial",
          entered_on: today,
          email: contactEmail,   // parent's for kids; the adult's otherwise
          phone: contactPhone,
          dob,
          address: addressText,
          tags: programs,        // e.g. ["Taekwondo","Jiu Jitsu"]
        })
        .select("id")
        .single();
      if (cErr) throw cErr;

      const waiverAt = new Date().toISOString();
      const rows = bookings
        .map((b) => {
          const bo = (b && typeof b === "object") ? b as Record<string, unknown> : {};
          return {
            contact_id: contact.id,
            program: str(bo.program),
            class_datetime: str(bo.class_datetime),
            class_label: str(bo.class_label),
            student_age: studentAge,
            booked_by: bookedBy,
            dob,
            waiver_name: waiverName,
            waiver_signed_at: waiverAt,
            waiver_agreed: true,
          };
        })
        .filter((r) => r.program && r.class_datetime);
      if (!rows.length) return json({ error: "Missing required fields" }, 400, cors);

      const { error: bErr } = await admin.from("trial_bookings").insert(rows);
      if (bErr) throw bErr;

      // Kids: record the parent's email as a guardian (matches existing pattern).
      if (isKids && parentEmail) {
        await admin.from("student_guardians").insert({
          student_id: contact.id,
          email: parentEmail,
          label: "parent",
        });
      }

      // Readable per-class lines (front-end passes friendly date/time text).
      const classText = bookings.map((b) => {
        const bo = (b && typeof b === "object") ? b as Record<string, unknown> : {};
        const when = str(bo.date_text) && str(bo.time_text)
          ? `${str(bo.date_text)} at ${str(bo.time_text)}` : str(bo.class_datetime);
        return `${str(bo.program)} — ${str(bo.class_label)} — ${when}`;
      });

      subject = `New free-trial booking: ${who} (${programs.join(", ")})`;
      lines = [
        `Student: ${who}`,
        `DOB: ${dob}`,
        `Programs: ${programs.join(", ")}`,
        ...classText.map((c) => `Class: ${c}`),
        (bookedBy && bookedBy !== who) ? `Parent/guardian: ${bookedBy}` : "",
        `Phone: ${contactPhone}`,
        `Email: ${contactEmail}`,
        `Address: ${addressText}`,
        `Waiver signed: yes (${waiverName} at ${waiverAt})`,
      ].filter(Boolean);

      // Confirmation email to the parent/student (sent best-effort below).
      confirmTo = contactEmail;
      confirmSubject = "Your free week at Bares Taekwondo Fitness";
      confirmLines = [
        `Hi ${isKids ? (bookedBy || "there") : (studentFirst || "there")},`,
        ``,
        `Thanks for booking a free trial week${isKids ? " for " + who : ""}. Here's what you're signed up for:`,
        ``,
        ...classText.map((c) => `• ${c}`),
        ``,
        `Where: Bares Taekwondo Fitness, 1901 Deerbrook Dr, Tyler, TX 75703`,
        `Questions? Call 903-561-2966 or reply to this email.`,
        ``,
        `See you on the mat!`,
      ];
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
        program: null, // never store the marketing label on contacts; it lives only in the email
        source: "website-contact",
        entered_on: today,
        email,
        phone,
      });
      if (cErr) throw cErr;

      subject = `New website contact: ${name}`;
      lines = [
        `Program interest: ${program || "(not specified)"}`,
        `Name: ${name}`,
        `Phone: ${phone}`,
        `Email: ${email}`,
        "",
        `Message:`,
        message,
      ];
    }
  } catch (e) {
    console.error("[trial-booking] DB insert failed:", e);
    return json({ error: "Could not save your request. Please try again." }, 500, cors);
  }

  // ---- 3: Resend emails (best-effort, NEVER lose the saved record) -----
  const key = Deno.env.get("RESEND_API_KEY");
  async function sendEmail(to: string, subj: string, text: string, tag: string) {
    if (!key) {
      console.warn(`[trial-booking] RESEND_API_KEY not set; ${tag} skipped (record is saved).`);
      return;
    }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: NOTIFY_FROM, to: [to], subject: subj, text }),
      });
      if (!res.ok) {
        console.error(`[trial-booking] Resend ${tag} non-OK (record saved):`, res.status, await res.text());
      }
    } catch (e) {
      console.error(`[trial-booking] Resend ${tag} threw (record saved):`, e);
    }
  }

  // Staff notification.
  await sendEmail(NOTIFY_TO, subject, lines.join("\n"), "staff notify");
  // Confirmation to the parent/student (trial only).
  if (confirmTo) {
    await sendEmail(confirmTo, confirmSubject, confirmLines.join("\n"), "confirmation");
  }

  return json({ ok: true }, 200, cors);
});
