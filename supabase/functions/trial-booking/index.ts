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
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import { LOGO_PNG_BASE64 } from "./logo.ts";

const ALLOWED_ORIGINS = [
  "https://www.barestkd.fit",
  "https://preview.barestkd.fit",
  "https://barestkd.fit",
];

const NOTIFY_TO = "race@barestkd.fit";
// From-address MUST be on the Resend-verified domain (barestkd.fit).
const NOTIFY_FROM = "Bares TKD Website <noreply@barestkd.fit>";

// Liability Waiver and Release, verbatim; do not edit. Shown in the popup and
// included in both emails, followed by the typed signature and timestamp.
const WAIVER_TEXT = `As an inducement to cause BTF to extend services to the Participant and in consideration of those services, I, the undersigned on behalf of the Participant, my heirs, assigns, and personal representatives, and the Participant's heirs, assigns, and personal representatives the Participant understands and acknowledges that the Participant is about to engage in an activity which includes strenuous exercise and body contact which involves risks, which could result in injury, harm or death to the Participant, the Participant's property, third parties, and/or third parties' property. The Participant is aware that Tae Kwon Do is a vigorous activity involving bodily contact in a unique environment and poses risk of injury. The Participant understands that Tae Kwon Do, and related activities, always involve certain risk, including but not limited to, death, serious injuries, complete or partial paralysis, brain damage, and injury to any and all bones, joints, muscles and internal organs. The risk of harm may be limited by the proper performance of instruction under the supervision of trained instructors, but never eliminated. In full awareness of the risks, both known and unknown, associated with the activities offered by BTF, the Participant hereby expressly, knowingly, and voluntarily release BTF, it's officers, agents, employees, and instructors, from all responsibility, liability, claims, demands, charges, duties, injuries, actions, causes of action, suits, companies and promises of any nature whatsoever relating to or deriving from the Participant's or the Participant's friends' and family's presence at the BTF premises or in same's participation in any activities directly or indirectly related to the activities at BTF. The Participant voluntarily agrees to assume all risk of injury, including paralysis and death, that may occur while the Participant is in the facility of BTF or participating in any event or program hosted or sponsored by BTF. The Participant's participation in these activities is purely voluntary and the Participant knowingly and voluntarily elects to participate after full consideration of risks, and the Participant further understands that he or she will be supervised during the event time only. The Participant hereby releases all of the above-mentioned parties from any and all responsibility for the Participant during non-class or function related times. The Participant further agrees that the Participant, and the Participant's estate, heirs, or assigns will not bring any claim or suit against BTF, it's instructors, employees, staff, guests, landlord or any other party on behalf of the Participant. This release shall be effective even if the loss, damage, or injury results or has resulted from negligence, wrongful acts, omissions, breach of warranty or strict tort liability of BTF. Finally, the Participant agrees to indemnify BTF, it's instructors, staff, students, guests, and any and all additional defendants for all judgments, costs, attorney fees and other expenses incurred should there be a claim against BTF, it's instructors, staff, students, or guests as a result of this member's participation in any service, activities or special event BTF offers. The Participant understands and agrees that this waiver, and covenant-not-to-sue will continue to be as broad and as inclusive as permitted by the law, as the State of Texas and the Participant agrees that if any portion is held invalid, the remainder of the waiver, and covenant-not-to-sue will continue in full legal force and effect. The Participant agrees that the jurisdiction and venue for any legal proceedings arising out of this will be Smith County, Texas. The Participant further agree that this agreement shall be interpreted under Texas law.`;

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

const escHtml = (v: unknown) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

// UTF-8 safe base64 for email attachments.
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

type WaiverDoc = {
  who: string;
  dob: string;
  age: number | null;
  programs: string[];
  waiverName: string;
  waiverAt: string;
  waiverSignature: string; // PNG data URL, may be ""
};

const dobLine = (d: WaiverDoc) =>
  `${d.dob}${d.age != null ? ` (age ${d.age})` : ""}`;

// Signed waiver as a PDF (preferred). Long text wraps + paginates; the drawn
// signature is embedded as a PNG. Returns base64 of the PDF bytes.
async function buildWaiverPdf(d: WaiverDoc): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageW = 612, pageH = 792, margin = 54, maxW = pageW - margin * 2;
  let page = pdf.addPage([pageW, pageH]);
  let y = pageH - margin;
  const line = (text: string, f = font, s = 10, lh = 14) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    let cur = "";
    const flush = () => {
      if (y - lh < margin) { page = pdf.addPage([pageW, pageH]); y = pageH - margin; }
      page.drawText(cur, { x: margin, y, size: s, font: f });
      y -= lh;
    };
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (cur && f.widthOfTextAtSize(test, s) > maxW) { flush(); cur = w; }
      else cur = test;
    }
    if (cur) flush();
  };
  const gap = (n: number) => { y -= n; };

  let logoDrawn = false;
  try {
    const logoRaw = Uint8Array.from(atob(LOGO_PNG_BASE64), (ch) => ch.charCodeAt(0));
    const logo = await pdf.embedPng(logoRaw);
    const lw = 150, lh = logo.height * (lw / logo.width);
    page.drawImage(logo, { x: margin, y: y - lh, width: lw, height: lh });
    y -= lh + 12;
    logoDrawn = true;
  } catch (_e) { /* fall back to the text title below */ }
  if (!logoDrawn) line("Bares Taekwondo Fitness", bold, 15, 18);
  line("Liability Waiver and Release", bold, 11, 15);
  gap(6);
  line(`Participant: ${d.who}`);
  line(`Date of birth: ${dobLine(d)}`);
  line(`Programs: ${d.programs.join(", ")}`);
  gap(8);
  line(WAIVER_TEXT);
  gap(10);
  line(`Signed: ${d.waiverName}`, bold, 10, 14);
  if (d.waiverSignature.indexOf("data:image/png") === 0) {
    const b64 = d.waiverSignature.split(",")[1] || "";
    const raw = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const png = await pdf.embedPng(raw);
    const w = 200, h = png.height * (w / png.width);
    if (y - h - 6 < margin) { page = pdf.addPage([pageW, pageH]); y = pageH - margin; }
    y -= h;
    page.drawImage(png, { x: margin, y, width: w, height: h });
    gap(8);
  }
  line(`Date: ${d.waiverAt}`);
  return bytesToBase64(await pdf.save());
}

// HTML fallback if the PDF library ever fails (opens in a browser).
function buildWaiverHtml(d: WaiverDoc): string {
  const sigImg = d.waiverSignature
    ? `<div style="margin:8px 0"><img src="${d.waiverSignature}" alt="Signature" style="max-width:340px;height:auto"></div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Liability Waiver and Release</title></head>` +
    `<body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#17130f;line-height:1.5">` +
    `<img src="data:image/png;base64,${LOGO_PNG_BASE64}" alt="Bares Taekwondo Fitness" style="width:150px;height:auto;margin:0 0 8px">` +
    `<h2 style="font-size:14px;margin:0 0 16px;text-transform:uppercase;letter-spacing:.04em">Liability Waiver and Release</h2>` +
    `<p style="margin:0 0 12px"><strong>Participant:</strong> ${escHtml(d.who)}<br>` +
    `<strong>Date of birth:</strong> ${escHtml(dobLine(d))}<br>` +
    `<strong>Programs:</strong> ${escHtml(d.programs.join(", "))}</p>` +
    `<p style="margin:0 0 20px">${escHtml(WAIVER_TEXT)}</p>` +
    `<hr style="border:none;border-top:1px solid #ccc;margin:20px 0">` +
    `<p style="margin:0 0 4px"><strong>Signed:</strong> ${escHtml(d.waiverName)}</p>` +
    sigImg +
    `<p style="margin:0"><strong>Date:</strong> ${escHtml(d.waiverAt)}</p>` +
    `</body></html>`;
}

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
  // Signed-waiver document, attached to both emails. Its data is gathered in
  // the trial branch; the actual PDF is built later (best-effort) so a document
  // failure can never lose the saved booking.
  let waiverAttachments: Array<{ filename: string; content: string }> = [];
  let waiverDocData: WaiverDoc | null = null;

  // ---- 1 & 2: validate + DB insert FIRST -------------------------------
  try {
    if (type === "trial") {
      // v2 shape: one student, one or more chosen programs, one booking per
      // chosen class, a real DOB, a full address, and a signed waiver.
      const studentFirst = str(body.student_first);
      const studentLast = str(body.student_last);
      const dob = str(body.dob); // YYYY-MM-DD
      const isKids = !!body.is_kids;
      const programs = Array.isArray(body.programs)
        ? body.programs.map((p) => str(p)).filter(Boolean) : [];
      const bookings = Array.isArray(body.bookings) ? body.bookings : [];
      const waiverName = str(body.waiver_name);
      const waiverAgreed = !!body.waiver_agreed;
      const waiverSignature = str(body.waiver_signature); // PNG data URL (drawn)

      // Contact channel: parent for kids, the person themselves for 18+.
      // Adults may add an optional guardian; when present it fills booked_by
      // and (via email) a student_guardians row, same as the kids path.
      let contactEmail = "", contactPhone = "", parentEmail = "", bookedBy = "", guardianPhone = "";
      if (isKids) {
        contactPhone = str(body.parent_phone);
        contactEmail = str(body.parent_email);
        parentEmail = contactEmail;
        bookedBy = (str(body.parent_first) + " " + str(body.parent_last)).trim();
      } else {
        contactPhone = str(body.phone);
        contactEmail = str(body.email);
        const gName = (str(body.guardian_first) + " " + str(body.guardian_last)).trim();
        parentEmail = str(body.guardian_email); // optional guardian email
        guardianPhone = str(body.guardian_phone);
        bookedBy = gName || (studentFirst + " " + studentLast).trim();
      }

      const who = (studentFirst + " " + studentLast).trim();

      if (!studentFirst || !studentLast || !dob ||
          !contactPhone || !contactEmail || !programs.length || !bookings.length ||
          !waiverAgreed || !waiverName || (isKids && !bookedBy)) {
        return json({ error: "Missing required fields" }, 400, cors);
      }

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

      // Record the parent/guardian email as a guardian row (kids always; adults
      // only when they supplied an optional guardian email).
      if (parentEmail) {
        await admin.from("student_guardians").insert({
          student_id: contact.id,
          email: parentEmail,
          label: "parent",
        });
      }

      // One clean line per class: program, day, date, time once (no repeated
      // label, no em dashes). date_text already carries the weekday + date.
      const classLines = bookings.map((b) => {
        const bo = (b && typeof b === "object") ? b as Record<string, unknown> : {};
        const when = str(bo.date_text) && str(bo.time_text)
          ? `${str(bo.date_text)} at ${str(bo.time_text)}` : str(bo.class_datetime);
        return `${str(bo.program)}: ${when}`;
      });

      const guardianLine = (bookedBy && bookedBy !== who)
        ? `Parent/guardian: ${bookedBy}` +
          (guardianPhone ? `, ${guardianPhone}` : "") +
          ((!isKids && parentEmail) ? `, ${parentEmail}` : "")
        : "";

      // Gather the data for the signed-waiver document; the PDF is built later.
      waiverDocData = {
        who, dob, age: studentAge, programs,
        waiverName, waiverAt, waiverSignature,
      };

      const waiverBlock = [
        "LIABILITY WAIVER AND RELEASE",
        `Signed by ${waiverName} on ${waiverAt}.`,
        "The full signed waiver is attached to this email.",
      ];

      subject = `New free-trial booking: ${who} (${programs.join(", ")})`;
      lines = [
        "STUDENT",
        `Name: ${who}`,
        `Date of birth: ${dob}`,
        `Age: ${studentAge != null ? studentAge : "unknown"}`,
        "",
        "PROGRAMS & CLASSES",
        ...classLines,
        "",
        "CONTACT",
        `Phone: ${contactPhone}`,
        `Email: ${contactEmail}`,
        ...(guardianLine ? [guardianLine] : []),
        "",
        ...waiverBlock,
      ];

      // Confirmation email to the parent/student (sent best-effort below).
      confirmTo = contactEmail;
      confirmSubject = "Your free week at Bares Taekwondo Fitness";
      confirmLines = [
        `Hi ${isKids ? (bookedBy || "there") : (studentFirst || "there")},`,
        "",
        `Thanks for booking a free trial week${isKids ? " for " + who : ""}. Here's what you're signed up for:`,
        "",
        "YOUR CLASSES",
        ...classLines,
        "",
        "WHERE",
        "Bares Taekwondo Fitness",
        "1901 Deerbrook Dr, Tyler, TX 75703",
        "",
        "QUESTIONS?",
        "Call 903-561-2966 or reply to this email.",
        "",
        ...waiverBlock,
        "",
        "See you on the mat!",
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
  async function sendEmail(
    to: string,
    subj: string,
    text: string,
    tag: string,
    attachments?: Array<{ filename: string; content: string }>,
  ) {
    if (!key) {
      console.warn(`[trial-booking] RESEND_API_KEY not set; ${tag} skipped (record is saved).`);
      return;
    }
    try {
      const payload: Record<string, unknown> = { from: NOTIFY_FROM, to: [to], subject: subj, text };
      if (attachments && attachments.length) payload.attachments = attachments;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error(`[trial-booking] Resend ${tag} non-OK (record saved):`, res.status, await res.text());
      }
    } catch (e) {
      console.error(`[trial-booking] Resend ${tag} threw (record saved):`, e);
    }
  }

  // Build the signed-waiver PDF (HTML fallback). Best-effort; never blocks the
  // saved booking or the emails.
  // TODO(crm): also persist this signed waiver to the student's profile under
  // Documents once the CRM supports document storage, e.g. upload the PDF to a
  // Supabase Storage bucket keyed by contact_id and surface it in the CRM.
  if (waiverDocData) {
    const safeName = waiverDocData.who.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "participant";
    try {
      const content = await buildWaiverPdf(waiverDocData);
      waiverAttachments = [{ filename: `Waiver-${safeName}.pdf`, content }];
    } catch (e) {
      console.error("[trial-booking] waiver PDF failed, using HTML fallback:", e);
      try {
        waiverAttachments = [{ filename: `Waiver-${safeName}.html`, content: toBase64(buildWaiverHtml(waiverDocData)) }];
      } catch (_e) { /* send without attachment */ }
    }
  }

  // Staff notification (with the signed waiver attached, on trials).
  await sendEmail(NOTIFY_TO, subject, lines.join("\n"), "staff notify", waiverAttachments);
  // Confirmation to the parent/student (trial only).
  if (confirmTo) {
    await sendEmail(confirmTo, confirmSubject, confirmLines.join("\n"), "confirmation", waiverAttachments);
  }

  return json({ ok: true }, 200, cors);
});
