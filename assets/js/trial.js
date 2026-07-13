/* ==========================================================================
   Bares Taekwondo Fitness — trial.js  (v2)
   The on-site "Try 1 Week Free" popup. Every [data-trial-open] button opens a
   multi-step modal and submits to the Supabase Edge Function.

   Flow:
     1. Age gate      (Under 3 / 3-4 / 5-12 / 13 & Up)
     2. Program       (13 & Up = MULTI-select TKD/Kickboxing/Jiu Jitsu;
                        kids buckets skip this, program is implied)
     3. Scheduler     (one screen per chosen program, "Class X of N",
                        live classes from the GET, explicit first-class pick)
     4. Intake        (student first/last, DOB, address; kids collect a
                        parent/guardian; 18+ give their own phone/email + an
                        optional guardian)
     5. Waiver        (inline placeholder text + typed signature + agree box)
     6. Submit        (one contact per student, tags = chosen programs, one
                        trial_bookings row per class) then success + the option
                        to book another family member (parent/address kept).

   The program list + class times are LIVE: on open we GET the trial-booking
   function, which reads schedule_template (trial_open=true) and groups rows
   into marketing programs with a kids flag. No hardcoded schedule here.

   No-JS fallback: buttons keep href="/contact-form". If the live fetch fails,
   the modal shows a call number + contact link (never an empty step).
   ========================================================================== */
(function () {
  "use strict";

  var ENDPOINT = "https://akdncbzxiwvihfcyijvm.supabase.co/functions/v1/trial-booking";
  var SB_KEY = "sb_publishable_uSGIk4_Tt1_BOmPBoC_U5A_Kp2032f5"; // publishable (public) key — safe to ship

  var CONSENT = "By providing your number you consent to receive marketing/promotional/notification messages from Bares Taekwondo Fitness, to opt-out, reply STOP at any moment. Msg & Data rates may apply";
  var PHONE = "903-561-2966";
  var DAYS_AHEAD = 14;
  var DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // One-line program descriptors (reused from the homepage program cards).
  var TEASER = {
    "Taekwondo": "Traditional forms, sparring, board breaking, and high-level kick development.",
    "Kickboxing": "High-energy striking and conditioning built on Muay Thai, Taekwondo, and boxing fundamentals.",
    "Jiu Jitsu": "Grappling for teens and adults, all experience levels welcome."
  };

  // Marketing programs served by the GET. Each: {program, ageLabel, kids,
  // classes:[{dow (1=Mon..6=Sat), h, m, label}]}. Loaded on open.
  var PROGRAMS = null;

  var state = freshState();
  var modal, dialog, lastFocused;

  function freshState() {
    return {
      bucket: null,        // 'u3' | '3-4' | '5-12' | '13+'
      kids: false,         // true for the 3-4 and 5-12 buckets
      programs: [],        // chosen program objects (single for kids, 1..3 for 13+)
      bookings: [],        // aligned to programs: [{program, slot}]
      schedIdx: 0,         // current program index in the scheduler loop
      waiverName: "",
      waiverAgreed: false,
      keep: null           // preserved parent/guardian + address for the family loop
    };
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.addEventListener("click", function (e) {
      var trigger = e.target.closest("[data-trial-open]");
      if (!trigger) return;
      e.preventDefault();
      openModal(trigger);
    });
  });

  /* ---- helpers -------------------------------------------------------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function bookablePrograms() {
    return (PROGRAMS || []).filter(function (p) { return p.classes && p.classes.length; });
  }

  function programByName(name) {
    return bookablePrograms().filter(function (p) { return p.program === name; })[0] || null;
  }

  // A Taekwondo program view whose classes are filtered by age bucket, matching
  // how the GET labels them: 5-12 = Juniors + Forms, 13+ = Teens/Adults + Forms.
  function taekwondoFor(bucket) {
    var tkd = programByName("Taekwondo");
    if (!tkd) return null;
    var re = bucket === "5-12" ? /juniors|forms/i : /teens|adult|forms/i;
    var classes = tkd.classes.filter(function (c) { return re.test(c.label || ""); });
    if (!classes.length) return null;
    return { program: "Taekwondo", ageLabel: tkd.ageLabel, kids: tkd.kids, classes: classes };
  }

  // The 13 & Up multi-select menu, in a stable order, only bookable ones.
  function adultPrograms() {
    var out = [];
    var tkd = taekwondoFor("13+"); if (tkd) out.push(tkd);
    var kb = programByName("Kickboxing"); if (kb) out.push(kb);
    var jj = programByName("Jiu Jitsu"); if (jj) out.push(jj);
    return out;
  }

  function fmtTime(h, m) {
    var ap = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    var mm = (m < 10 ? "0" : "") + m;
    return h12 + ":" + mm + " " + ap;
  }

  // Next DAYS_AHEAD days of a program's weekly classes, soonest first.
  function upcomingSlots(program) {
    var out = [], now = new Date();
    for (var i = 0; i < DAYS_AHEAD; i++) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
      for (var c = 0; c < program.classes.length; c++) {
        var cls = program.classes[c];
        if (cls.dow !== d.getDay()) continue;
        var when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), cls.h, cls.m);
        if (when.getTime() <= now.getTime()) continue; // skip already-past times today
        out.push({
          iso: when.toISOString(),
          label: cls.label,
          dateText: DOW[when.getDay()] + ", " + MON[when.getMonth()] + " " + when.getDate(),
          timeText: fmtTime(cls.h, cls.m)
        });
      }
    }
    out.sort(function (a, b) { return a.iso < b.iso ? -1 : 1; });
    return out;
  }

  /* ---- modal shell ---------------------------------------------------- */
  function buildModal() {
    modal = document.createElement("div");
    modal.className = "trial-modal";
    modal.setAttribute("hidden", "");
    modal.innerHTML =
      '<div class="trial-backdrop" data-trial-close></div>' +
      '<div class="trial-dialog" role="dialog" aria-modal="true" aria-labelledby="trial-title">' +
        '<button class="trial-close" type="button" aria-label="Close" data-trial-close>&times;</button>' +
        '<div class="trial-body" id="trial-body"></div>' +
      '</div>';
    document.body.appendChild(modal);
    dialog = modal.querySelector(".trial-dialog");

    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-trial-close]")) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (modal.hasAttribute("hidden")) return;
      if (e.key === "Escape") closeModal();
      if (e.key === "Tab") trapFocus(e);
    });
  }

  function trapFocus(e) {
    var f = dialog.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openModal(trigger) {
    if (!modal) buildModal();
    lastFocused = trigger || document.activeElement;
    state = freshState();
    renderLoading();
    modal.removeAttribute("hidden");
    document.documentElement.classList.add("trial-open");
    dialog.querySelector(".trial-close").focus();
    loadSchedule();
  }

  function closeModal() {
    if (!modal) return;
    modal.setAttribute("hidden", "");
    document.documentElement.classList.remove("trial-open");
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function setBody(html) { document.getElementById("trial-body").innerHTML = html; }

  function focusFirst() {
    var el = dialog.querySelector(".trial-body input, .trial-body button, .trial-body a[href]");
    if (el) el.focus();
  }

  function head(title, hint) {
    return '<p class="trial-eyebrow">Free Week' + (hint ? ' &middot; ' + esc(hint) : '') + '</p>' +
           '<h2 id="trial-title" class="trial-h">' + esc(title) + '</h2>';
  }

  /* ---- load the live schedule ---------------------------------------- */
  function renderLoading() {
    setBody(head("Choose your program") + '<p class="trial-note">Loading class times&hellip;</p>');
  }

  function loadSchedule() {
    fetch(ENDPOINT, { method: "GET", headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY } })
      .then(function (r) { if (!r.ok) throw new Error("bad " + r.status); return r.json(); })
      .then(function (data) {
        PROGRAMS = (data && data.programs) || [];
        if (!bookablePrograms().length) { renderFallback(); return; }
        renderAgeGate();
      })
      .catch(function (err) {
        console.error("Schedule load failed:", err);
        renderFallback();
      });
  }

  // Never an empty step: offer a call + contact link.
  function renderFallback() {
    setBody(
      '<h2 id="trial-title" class="trial-h">Let\'s get you booked</h2>' +
      '<p class="trial-note">We couldn\'t load class times right now. Give us a call and we\'ll set up your free week:</p>' +
      '<p class="trial-confirm"><a href="tel:' + PHONE + '">' + PHONE + '</a></p>' +
      '<p class="trial-note">Or <a href="/contact-form">send us a message</a> and we\'ll reach out.</p>' +
      '<div class="trial-actions"><button class="btn btn--primary" type="button" data-trial-close>Close</button></div>'
    );
    focusFirst();
  }

  /* ---- step 1: age gate ---------------------------------------------- */
  var AGE_OPTIONS = [
    { key: "u3",   name: "Under 3",  sub: "Our Little Kickers parent-and-me class for ages 2 to 3, launching soon." },
    { key: "3-4",  name: "3 to 4",   sub: "Cubs, our preschool program. Age 3 and ready to train without a parent? Cubs it is. Age 2 to 3 and not quite ready? Little Kickers may fit." },
    { key: "5-12", name: "5 to 12",  sub: "Juniors Taekwondo plus Forms. Just turned 5 and still building focus? Cubs may be the better start." },
    { key: "13+",  name: "13 & Up",  sub: "Teens and adults, Taekwondo, Kickboxing, and Jiu Jitsu, try any or all." }
  ];

  function renderAgeGate() {
    var html = head("How old is the student?") + '<div class="trial-options">';
    AGE_OPTIONS.forEach(function (o) {
      html += '<button class="trial-option" type="button" data-age="' + o.key + '">' +
                '<span class="trial-option__name">' + esc(o.name) + '</span>' +
                '<span class="trial-option__sub">' + esc(o.sub) + '</span>' +
              '</button>';
    });
    html += '</div>';
    setBody(html);
    dialog.querySelectorAll("[data-age]").forEach(function (b) {
      b.addEventListener("click", function () { chooseAge(b.getAttribute("data-age")); });
    });
    focusFirst();
  }

  function chooseAge(bucket) {
    state.bucket = bucket;
    state.programs = [];
    state.bookings = [];
    state.schedIdx = 0;

    if (bucket === "u3") { renderLittleKickers(); return; }

    if (bucket === "3-4") {
      state.kids = true;
      var cubs = programByName("Cubs");
      if (!cubs) { renderNoProgram("Cubs"); return; }
      state.programs = [cubs];
      startScheduler();
      return;
    }

    if (bucket === "5-12") {
      state.kids = true;
      var tkd = taekwondoFor("5-12");
      if (!tkd) { renderNoProgram("Taekwondo"); return; }
      state.programs = [tkd];
      startScheduler();
      return;
    }

    // 13+
    state.kids = false;
    renderProgramMulti();
  }

  function renderLittleKickers() {
    setBody(
      head("Little Kickers is coming soon") +
      '<p class="trial-note">Our parent-and-me class for ages 2 to 3 is launching soon. Join the interest list and we\'ll tell you the moment it opens.</p>' +
      '<div class="trial-actions">' +
        '<button class="btn btn--secondary trial-back" type="button">Back</button>' +
        '<a class="btn btn--primary" href="/contact-form?program=little-kickers">Join the interest list</a>' +
      '</div>'
    );
    dialog.querySelector(".trial-back").addEventListener("click", renderAgeGate);
    focusFirst();
  }

  function renderNoProgram(name) {
    setBody(
      head("No open classes right now") +
      '<p class="trial-note">We don\'t have ' + esc(name) + ' trial times open this week. Call <a href="tel:' + PHONE + '">' + PHONE + '</a> or <a href="/contact-form">contact us</a> and we\'ll find a spot.</p>' +
      '<div class="trial-actions"><button class="btn btn--secondary trial-back" type="button">Back</button></div>'
    );
    dialog.querySelector(".trial-back").addEventListener("click", renderAgeGate);
    focusFirst();
  }

  /* ---- step 2: program (13 & Up multi-select) ------------------------ */
  function renderProgramMulti() {
    var progs = adultPrograms();
    if (!progs.length) { renderNoProgram("13 & Up"); return; }

    // Preserve any prior selection by program name when coming Back.
    var chosen = {};
    state.programs.forEach(function (p) { chosen[p.program] = true; });

    var html = head("Which programs?", "Step 2");
    html += '<p class="trial-note">Pick one or more, you can try them all.</p>';
    html += '<div class="trial-options">';
    progs.forEach(function (p, i) {
      var on = !!chosen[p.program];
      html += '<button class="trial-option trial-toggle" type="button" role="checkbox" aria-checked="' + (on ? "true" : "false") + '" data-idx="' + i + '">' +
                '<span class="trial-toggle__box" aria-hidden="true"></span>' +
                '<span class="trial-toggle__text">' +
                  '<span class="trial-option__name">' + esc(p.program) + '</span>' +
                  '<span class="trial-option__sub">' + esc(TEASER[p.program] || p.ageLabel) + '</span>' +
                '</span>' +
              '</button>';
    });
    html += '</div>';
    html += '<div class="trial-actions">' +
              '<button class="btn btn--secondary trial-back" type="button">Back</button>' +
              '<button class="btn btn--primary trial-next" type="button" disabled>Continue</button>' +
            '</div>';
    setBody(html);

    var next = dialog.querySelector(".trial-next");
    function sync() {
      var any = dialog.querySelectorAll('.trial-toggle[aria-checked="true"]').length > 0;
      next.disabled = !any;
    }
    dialog.querySelectorAll(".trial-toggle").forEach(function (b) {
      b.addEventListener("click", function () {
        var on = b.getAttribute("aria-checked") === "true";
        b.setAttribute("aria-checked", on ? "false" : "true");
        sync();
      });
    });
    dialog.querySelector(".trial-back").addEventListener("click", renderAgeGate);
    next.addEventListener("click", function () {
      state.programs = [];
      dialog.querySelectorAll('.trial-toggle[aria-checked="true"]').forEach(function (b) {
        state.programs.push(progs[parseInt(b.getAttribute("data-idx"), 10)]);
      });
      if (!state.programs.length) return;
      startScheduler();
    });
    sync();
    focusFirst();
  }

  /* ---- step 3: scheduler (loops once per chosen program) ------------- */
  function startScheduler() {
    state.schedIdx = 0;
    state.bookings = [];
    renderScheduler();
  }

  function renderScheduler() {
    var n = state.programs.length;
    var i = state.schedIdx;
    var program = state.programs[i];
    var slots = upcomingSlots(program);

    var html = head("Pick your first class", n > 1 ? ("Class " + (i + 1) + " of " + n) : null);
    html += '<p class="trial-sub">' + esc(program.program) + ' &middot; ' + esc(program.ageLabel) + '</p>';
    if (!slots.length) {
      html += '<p class="trial-note">No upcoming ' + esc(program.program) + ' times in the next two weeks. ' +
              'Call <a href="tel:' + PHONE + '">' + PHONE + '</a> or ' +
              '<a href="/contact-form">contact us</a> to find a time.</p>';
    } else {
      html += '<div class="trial-options trial-slots">';
      slots.forEach(function (s, si) {
        html += '<button class="trial-option" type="button" data-slot="' + si + '">' +
                  '<span class="trial-option__name">' + esc(s.dateText) + '</span>' +
                  '<span class="trial-option__sub">' + esc(s.timeText) + ' &middot; ' + esc(s.label) + '</span>' +
                '</button>';
      });
      html += '</div>';
    }
    html += '<div class="trial-actions"><button class="btn btn--secondary trial-back" type="button">Back</button></div>';
    setBody(html);

    dialog.querySelector(".trial-back").addEventListener("click", function () {
      if (i > 0) { state.schedIdx = i - 1; state.bookings.pop(); renderScheduler(); }
      else if (state.kids) { renderAgeGate(); }
      else { renderProgramMulti(); }
    });
    dialog.querySelectorAll("[data-slot]").forEach(function (b) {
      b.addEventListener("click", function () {
        var slot = slots[parseInt(b.getAttribute("data-slot"), 10)];
        state.bookings[i] = { program: program.program, slot: slot };
        if (i + 1 < n) { state.schedIdx = i + 1; renderScheduler(); }
        else { renderIntake(); }
      });
    });
    focusFirst();
  }

  /* ---- step 4: intake ------------------------------------------------ */
  function field(id, label, name, type, extra) {
    var k = state.keep || {};
    var val = k[name] != null ? k[name] : "";
    return '<div class="form-field"><label for="' + id + '">' + esc(label) + '</label>' +
           '<input id="' + id + '" name="' + name + '" type="' + type + '"' +
           (extra || "") + ' value="' + esc(val) + '"></div>';
  }

  function renderIntake() {
    var kids = state.kids;
    var todayISO = new Date().toISOString().slice(0, 10);
    var html = head("A little about the student", "Your info");
    html += '<form class="trial-form" novalidate>';

    // Student (never prefilled from the family loop — each member is their own).
    html += '<div class="trial-grid trial-grid--2">' +
              '<div class="form-field"><label for="tf-sfirst">Student first name</label>' +
              '<input id="tf-sfirst" name="student_first" type="text" autocomplete="given-name" required></div>' +
              '<div class="form-field"><label for="tf-slast">Student last name</label>' +
              '<input id="tf-slast" name="student_last" type="text" autocomplete="family-name" required></div>' +
            '</div>';
    html += '<div class="form-field"><label for="tf-dob">Student date of birth</label>' +
            '<input id="tf-dob" name="dob" type="date" max="' + todayISO + '" required></div>';

    // Address (single line + city/state/zip; kept for the family loop).
    html += field("tf-street", "Street address", "street", "text", ' autocomplete="address-line1" required');
    html += '<div class="trial-grid trial-grid--3">' +
              field("tf-city", "City", "city", "text", ' autocomplete="address-level2" required') +
              field("tf-state", "State", "state", "text", ' autocomplete="address-level1" maxlength="20" required') +
              field("tf-zip", "ZIP", "zip", "text", ' autocomplete="postal-code" inputmode="numeric" maxlength="10" required') +
            '</div>';

    if (kids) {
      html += '<p class="trial-legend">Parent / guardian</p>';
      html += '<div class="trial-grid trial-grid--2">' +
                field("tf-pfirst", "First name", "parent_first", "text", ' autocomplete="given-name" required') +
                field("tf-plast", "Last name", "parent_last", "text", ' autocomplete="family-name" required') +
              '</div>';
      html += field("tf-pphone", "Phone", "parent_phone", "tel", ' autocomplete="tel" required');
      html += field("tf-pemail", "Email", "parent_email", "email", ' autocomplete="email" required');
    } else {
      html += field("tf-phone", "Your phone", "phone", "tel", ' autocomplete="tel" required');
      html += field("tf-email", "Your email", "email", "email", ' autocomplete="email" required');
      html += field("tf-guardian", "Parent / guardian (optional)", "guardian", "text", '');
    }

    // Honeypot.
    html += '<div class="hp-field" aria-hidden="true"><label for="tf-company">Company</label>' +
            '<input id="tf-company" name="company" type="text" tabindex="-1" autocomplete="off"></div>';

    html += '<div class="trial-actions">' +
              '<button class="btn btn--secondary trial-back" type="button">Back</button>' +
              '<button class="btn btn--primary" type="submit">Continue</button>' +
            '</div>';
    html += '<p class="form-consent">' + esc(CONSENT) + '</p>';
    html += '<p class="form-status" role="status" aria-live="polite"></p>';
    html += '</form>';
    setBody(html);

    dialog.querySelector(".trial-back").addEventListener("click", function () {
      state.schedIdx = state.programs.length - 1;
      renderScheduler();
    });
    dialog.querySelector(".trial-form").addEventListener("submit", function (e) {
      e.preventDefault();
      onIntakeSubmit(e.target, kids);
    });
    focusFirst();
  }

  function onIntakeSubmit(form, kids) {
    var status = form.querySelector(".form-status");
    var get = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value.trim() : ""; };

    // Honeypot -> silently pretend success (no record).
    if (get("company") !== "") { renderSuccess(); return; }

    var d = {
      student_first: get("student_first"),
      student_last: get("student_last"),
      dob: get("dob"),
      street: get("street"),
      city: get("city"),
      state: get("state"),
      zip: get("zip")
    };
    var required = [d.student_first, d.student_last, d.dob, d.street, d.city, d.state, d.zip];
    if (kids) {
      d.parent_first = get("parent_first");
      d.parent_last = get("parent_last");
      d.parent_phone = get("parent_phone");
      d.parent_email = get("parent_email");
      required = required.concat([d.parent_first, d.parent_last, d.parent_phone, d.parent_email]);
    } else {
      d.phone = get("phone");
      d.email = get("email");
      d.guardian = get("guardian");
      required = required.concat([d.phone, d.email]);
    }
    if (required.some(function (v) { return !v; })) {
      setStatus(status, "error", "Please fill in all the required fields.");
      return;
    }

    state.intake = d;
    renderWaiver();
  }

  /* ---- step 5: waiver ------------------------------------------------ */
  function renderWaiver() {
    var lorem =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
      "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. " +
      "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. " +
      "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. " +
      "Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.";

    var html = head("Sign the waiver", "Almost done");
    html += '<div class="trial-waiver" tabindex="0" aria-label="Waiver text">' +
              '<p class="trial-waiver__flag">[WAIVER TEXT PLACEHOLDER, Race to provide real language]</p>' +
              '<p>' + esc(lorem) + '</p>' +
              '<p>' + esc(lorem) + '</p>' +
            '</div>';
    html += '<form class="trial-form" novalidate>';
    html += '<div class="form-field"><label for="tf-sig">Type your full legal name to sign</label>' +
            '<input id="tf-sig" name="waiver_name" type="text" autocomplete="off" required></div>';
    html += '<label class="trial-agree"><input id="tf-agree" name="waiver_agreed" type="checkbox">' +
            '<span>I have read and agree to the waiver above.</span></label>';
    html += '<div class="trial-actions">' +
              '<button class="btn btn--secondary trial-back" type="button">Back</button>' +
              '<button class="btn btn--primary trial-submit" type="submit" disabled>Book my free week</button>' +
            '</div>';
    html += '<p class="form-status" role="status" aria-live="polite"></p>';
    html += '</form>';
    setBody(html);

    var sig = dialog.querySelector("#tf-sig");
    var agree = dialog.querySelector("#tf-agree");
    var submit = dialog.querySelector(".trial-submit");
    function sync() { submit.disabled = !(agree.checked && sig.value.trim()); }
    sig.addEventListener("input", sync);
    agree.addEventListener("change", sync);

    dialog.querySelector(".trial-back").addEventListener("click", renderIntake);
    dialog.querySelector(".trial-form").addEventListener("submit", function (e) {
      e.preventDefault();
      state.waiverName = sig.value.trim();
      state.waiverAgreed = !!agree.checked;
      if (!state.waiverAgreed || !state.waiverName) return;
      submitBooking(e.target);
    });
    sync();
    focusFirst();
  }

  /* ---- step 6: submit ------------------------------------------------ */
  function submitBooking(form) {
    var status = form.querySelector(".form-status");
    var button = form.querySelector('button[type="submit"]');
    var d = state.intake;

    var payload = {
      type: "trial",
      is_kids: state.kids,
      student_first: d.student_first,
      student_last: d.student_last,
      dob: d.dob,
      address: { street: d.street, city: d.city, state: d.state, zip: d.zip },
      programs: state.programs.map(function (p) { return p.program; }),
      bookings: state.bookings.map(function (b) {
        return {
          program: b.program,
          class_datetime: b.slot.iso,
          class_label: b.slot.label,
          date_text: b.slot.dateText,
          time_text: b.slot.timeText
        };
      }),
      waiver_name: state.waiverName,
      waiver_agreed: true,
      company: ""
    };
    if (state.kids) {
      payload.parent_first = d.parent_first;
      payload.parent_last = d.parent_last;
      payload.parent_phone = d.parent_phone;
      payload.parent_email = d.parent_email;
    } else {
      payload.phone = d.phone;
      payload.email = d.email;
      payload.guardian = d.guardian || "";
    }

    button.disabled = true;
    setStatus(status, "", "Booking…");

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY },
      body: JSON.stringify(payload)
    })
      .then(function (r) { if (!r.ok) throw new Error("bad " + r.status); return r; })
      .then(function () { renderSuccess(); })
      .catch(function (err) {
        console.error("Trial booking failed:", err);
        setStatus(status, "error", "Oops, there was an error booking. Please try again later.");
        button.disabled = false;
      });
  }

  /* ---- confirmation + family loop ------------------------------------ */
  function renderSuccess() {
    var d = state.intake || {};
    var email = state.kids ? (d.parent_email || "") : (d.email || "");
    var recap = state.bookings.map(function (b) {
      return '<li>' + esc(b.program) + ' &middot; ' + esc(b.slot.dateText) + ' at ' + esc(b.slot.timeText) + '</li>';
    }).join("");

    setBody(
      '<div class="trial-success">' +
        '<div class="trial-check" aria-hidden="true">&#10003;</div>' +
        '<h2 id="trial-title" class="trial-h">You\'re booked!</h2>' +
        '<p class="trial-sub">Thanks' + (d.student_first ? ", " + esc(d.student_first) : "") + '! See you in class.</p>' +
        (recap ? '<ul class="trial-recap">' + recap + '</ul>' : '') +
        (email ? '<p class="trial-note">We\'ve emailed a confirmation to ' + esc(email) + '.</p>' : '') +
        '<div class="trial-actions">' +
          '<button class="btn btn--secondary trial-again" type="button">Book another family member?</button>' +
          '<button class="btn btn--primary" type="button" data-trial-close>Done</button>' +
        '</div>' +
      '</div>'
    );
    var again = dialog.querySelector(".trial-again");
    if (again) again.addEventListener("click", bookAnother);
    focusFirst();
  }

  // Loop back to the age gate for a new student, keeping the parent/guardian
  // contact + address so the same family isn't re-typed. Each member still
  // becomes its own contact + bookings + waiver.
  function bookAnother() {
    var d = state.intake || {};
    var keep = {
      street: d.street, city: d.city, state: d.state, zip: d.zip
    };
    if (state.kids) {
      keep.parent_first = d.parent_first;
      keep.parent_last = d.parent_last;
      keep.parent_phone = d.parent_phone;
      keep.parent_email = d.parent_email;
    } else {
      keep.phone = d.phone;
      keep.email = d.email;
      keep.guardian = d.guardian;
    }
    state = freshState();
    state.keep = keep;
    renderAgeGate();
  }

  function setStatus(status, state2, msg) {
    if (!status) return;
    status.textContent = msg;
    if (state2) status.setAttribute("data-state", state2); else status.removeAttribute("data-state");
  }
})();
