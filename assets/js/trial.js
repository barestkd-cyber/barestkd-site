/* ==========================================================================
   Bares Taekwondo Fitness — trial.js  (v3)
   The on-site "Try 1 Week Free" popup. Every [data-trial-open] button opens a
   multi-step modal and submits to the Supabase Edge Function.

   Flow:
     1. Program select  (six programs; the three 13+ programs multi-select,
                         Little Kickers/Cubs/Juniors each solo. Little Kickers
                         is coming-soon and routes to the interest list.)
     2. Scheduler       (a one-week calendar strip per chosen program, pageable
                         up to six weeks out, "Class X of N", live classes from
                         the GET; days with no class show empty.)
     3. Intake          (student first/last, DOB, address; parent/guardian is
                         required when the DOB is under 18, optional at 18+;
                         adults also give their own phone/email.)
     4. Waiver          (inline placeholder text + typed signature + agree box.)
     5. Submit          (one contact per student, tags = chosen programs, one
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
  // Liability Waiver and Release, verbatim; do not edit. Must match the copy in the Edge Function.
  var WAIVER_TEXT = "As an inducement to cause BTF to extend services to the Participant and in consideration of those services, I, the undersigned on behalf of the Participant, my heirs, assigns, and personal representatives, and the Participant's heirs, assigns, and personal representatives the Participant understands and acknowledges that the Participant is about to engage in an activity which includes strenuous exercise and body contact which involves risks, which could result in injury, harm or death to the Participant, the Participant's property, third parties, and/or third parties' property. The Participant is aware that Tae Kwon Do is a vigorous activity involving bodily contact in a unique environment and poses risk of injury. The Participant understands that Tae Kwon Do, and related activities, always involve certain risk, including but not limited to, death, serious injuries, complete or partial paralysis, brain damage, and injury to any and all bones, joints, muscles and internal organs. The risk of harm may be limited by the proper performance of instruction under the supervision of trained instructors, but never eliminated. In full awareness of the risks, both known and unknown, associated with the activities offered by BTF, the Participant hereby expressly, knowingly, and voluntarily release BTF, it's officers, agents, employees, and instructors, from all responsibility, liability, claims, demands, charges, duties, injuries, actions, causes of action, suits, companies and promises of any nature whatsoever relating to or deriving from the Participant's or the Participant's friends' and family's presence at the BTF premises or in same's participation in any activities directly or indirectly related to the activities at BTF. The Participant voluntarily agrees to assume all risk of injury, including paralysis and death, that may occur while the Participant is in the facility of BTF or participating in any event or program hosted or sponsored by BTF. The Participant's participation in these activities is purely voluntary and the Participant knowingly and voluntarily elects to participate after full consideration of risks, and the Participant further understands that he or she will be supervised during the event time only. The Participant hereby releases all of the above-mentioned parties from any and all responsibility for the Participant during non-class or function related times. The Participant further agrees that the Participant, and the Participant's estate, heirs, or assigns will not bring any claim or suit against BTF, it's instructors, employees, staff, guests, landlord or any other party on behalf of the Participant. This release shall be effective even if the loss, damage, or injury results or has resulted from negligence, wrongful acts, omissions, breach of warranty or strict tort liability of BTF. Finally, the Participant agrees to indemnify BTF, it's instructors, staff, students, guests, and any and all additional defendants for all judgments, costs, attorney fees and other expenses incurred should there be a claim against BTF, it's instructors, staff, students, or guests as a result of this member's participation in any service, activities or special event BTF offers. The Participant understands and agrees that this waiver, and covenant-not-to-sue will continue to be as broad and as inclusive as permitted by the law, as the State of Texas and the Participant agrees that if any portion is held invalid, the remainder of the waiver, and covenant-not-to-sue will continue in full legal force and effect. The Participant agrees that the jurisdiction and venue for any legal proceedings arising out of this will be Smith County, Texas. The Participant further agree that this agreement shall be interpreted under Texas law.";
  var PHONE = "903-561-2966";
  var WEEKS_OUT = 6;   // how many weeks the calendar can page forward
  var DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // The six program buttons. `get` + `re` map each to the live GET program and
  // an optional class-label filter. `tag` is the stored program name (tags +
  // trial_bookings.program). solo programs clear all other selections.
  var PROGRAM_MENU = [
    { key: "lk",      label: "Little Kickers",         desc: "Ages 2-3 · Parent & Me · Coming Soon", solo: true,  comingSoon: true },
    { key: "cubs",    label: "Cubs",                   desc: "Ages 3-4",  solo: true,  tag: "Cubs",         get: "Cubs",      re: null },
    { key: "juniors", label: "Juniors",                desc: "Ages 5-12", solo: true,  tag: "Juniors",      get: "Taekwondo", re: /juniors|forms/i },
    { key: "tkd",     label: "Teens/Adults Taekwondo", desc: "Ages 13+",  solo: false, tag: "Teens/Adults Taekwondo", get: "Taekwondo", re: /teens|adult|forms/i },
    { key: "kb",      label: "Kickboxing",             desc: "Ages 13+",  solo: false, tag: "Kickboxing",   get: "Kickboxing", re: null },
    { key: "jj",      label: "Jiu Jitsu",              desc: "Ages 13+",  solo: false, tag: "Jiu Jitsu",    get: "Jiu Jitsu",  re: null }
  ];

  // Marketing programs served by the GET. Each: {program, ageLabel, kids,
  // classes:[{dow (1=Mon..6=Sat), h, m, label}]}. Loaded on open.
  var PROGRAMS = null;

  var state = freshState();
  var modal, dialog, lastFocused;

  function freshState() {
    return {
      picked: [],          // selected menu keys on screen 1
      selected: [],        // bookable menu items to schedule (excludes Little Kickers)
      bookings: [],        // aligned to selected: [{tag, label, slot}]
      schedIdx: 0,         // current program index in the scheduler loop
      weekOffset: 0,       // current calendar week page (0..WEEKS_OUT-1)
      waiverName: "",
      waiverAgreed: false,
      waiverSignature: "",
      intake: null,
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

  function menuByKey(key) {
    return PROGRAM_MENU.filter(function (m) { return m.key === key; })[0] || null;
  }

  // Classes for a menu item, filtered by its label regex (Cubs=all,
  // Juniors=Juniors+Forms, Teens/Adults=Teens/Adults+Forms, etc.).
  function classesFor(item) {
    var p = item.get ? programByName(item.get) : null;
    if (!p) return [];
    if (!item.re) return p.classes;
    return p.classes.filter(function (c) { return item.re.test(c.label || ""); });
  }

  function fmtTime(h, m) {
    var ap = h >= 12 ? "PM" : "AM";
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    var mm = (m < 10 ? "0" : "") + m;
    return h12 + ":" + mm + " " + ap;
  }

  function midnight(dt) { return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); }

  // Bookable classes for a program on a specific date, future only, soonest first.
  function slotsOnDate(item, d) {
    var now = new Date();
    var classes = classesFor(item);
    var out = [];
    for (var c = 0; c < classes.length; c++) {
      var cls = classes[c];
      if (cls.dow !== d.getDay()) continue;
      var when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), cls.h, cls.m);
      if (when.getTime() <= now.getTime()) continue;
      out.push({
        iso: when.toISOString(),
        label: cls.label,
        dateText: DOW[when.getDay()] + ", " + MON[when.getMonth()] + " " + when.getDate(),
        timeText: fmtTime(cls.h, cls.m),
        mins: cls.h * 60 + cls.m
      });
    }
    out.sort(function (a, b) { return a.mins - b.mins; });
    return out;
  }

  // Does a program have any bookable slot within the paging window?
  function anyUpcoming(item) {
    var base = midnight(new Date());
    for (var i = 0; i < WEEKS_OUT * 7; i++) {
      var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      if (slotsOnDate(item, d).length) return true;
    }
    return false;
  }

  // Parse a typed date of birth (MM/DD/YYYY, also accepts - or . separators).
  // Returns { iso: "YYYY-MM-DD", age } or null if incomplete/invalid/future.
  function parseDOB(raw) {
    var m = (raw || "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) return null;
    var mo = parseInt(m[1], 10), da = parseInt(m[2], 10), y = parseInt(m[3], 10);
    var b = new Date(y, mo - 1, da);
    if (b.getFullYear() !== y || b.getMonth() !== mo - 1 || b.getDate() !== da) return null;
    var t = new Date();
    if (b.getTime() > t.getTime()) return null;
    var a = t.getFullYear() - y, mm = t.getMonth() - (mo - 1);
    if (mm < 0 || (mm === 0 && t.getDate() < da)) a--;
    if (a < 0 || a >= 120) return null;
    var iso = y + "-" + (mo < 10 ? "0" : "") + mo + "-" + (da < 10 ? "0" : "") + da;
    return { iso: iso, age: a };
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
        renderPrograms();
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

  /* ---- step 1: program select ---------------------------------------- */
  function renderPrograms() {
    var html = head("Choose your program");
    html += '<p class="trial-note">Teens and adults can select more than one.</p>';
    html += '<div class="trial-options">';
    PROGRAM_MENU.forEach(function (m) {
      var on = state.picked.indexOf(m.key) >= 0;
      html += '<button class="trial-option trial-toggle" type="button" role="checkbox" aria-checked="' + (on ? "true" : "false") + '" data-key="' + m.key + '">' +
                '<span class="trial-toggle__box" aria-hidden="true"></span>' +
                '<span class="trial-toggle__text">' +
                  '<span class="trial-option__name">' + esc(m.label) + '</span>' +
                  '<span class="trial-option__sub">' + esc(m.desc) + '</span>' +
                '</span>' +
              '</button>';
    });
    html += '</div>';
    html += '<div class="trial-actions"><button class="btn btn--primary trial-next" type="button" disabled>Continue</button></div>';
    setBody(html);

    function refresh() {
      dialog.querySelectorAll(".trial-toggle").forEach(function (b) {
        b.setAttribute("aria-checked", state.picked.indexOf(b.getAttribute("data-key")) >= 0 ? "true" : "false");
      });
      dialog.querySelector(".trial-next").disabled = state.picked.length === 0;
    }
    dialog.querySelectorAll(".trial-toggle").forEach(function (b) {
      b.addEventListener("click", function () { toggleKey(b.getAttribute("data-key")); refresh(); });
    });
    dialog.querySelector(".trial-next").addEventListener("click", proceedFromPrograms);
    refresh();
    focusFirst();
  }

  // Solo programs clear everything else; multi programs clear any solo pick.
  function toggleKey(key) {
    var m = menuByKey(key);
    var idx = state.picked.indexOf(key);
    if (idx >= 0) { state.picked.splice(idx, 1); return; }
    if (m.solo) { state.picked = [key]; return; }
    state.picked = state.picked.filter(function (k) { return !menuByKey(k).solo; });
    state.picked.push(key);
  }

  function proceedFromPrograms() {
    var picks = state.picked.map(menuByKey);
    if (!picks.length) return;
    // Little Kickers is solo + coming soon.
    if (picks.length === 1 && picks[0].comingSoon) { renderLittleKickers(); return; }
    state.selected = picks.filter(function (m) { return !m.comingSoon; });
    if (!state.selected.length) { renderLittleKickers(); return; }
    startScheduler();
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
    dialog.querySelector(".trial-back").addEventListener("click", renderPrograms);
    focusFirst();
  }

  function renderNoProgram(name) {
    setBody(
      head("No open classes right now") +
      '<p class="trial-note">We don\'t have ' + esc(name) + ' trial times open in the next few weeks. Call <a href="tel:' + PHONE + '">' + PHONE + '</a> or <a href="/contact-form">contact us</a> and we\'ll find a spot.</p>' +
      '<div class="trial-actions"><button class="btn btn--secondary trial-back" type="button">Back</button></div>'
    );
    dialog.querySelector(".trial-back").addEventListener("click", renderPrograms);
    focusFirst();
  }

  /* ---- step 2: calendar scheduler (one week at a time) --------------- */
  function startScheduler() {
    state.schedIdx = 0;
    state.weekOffset = 0;
    state.bookings = [];
    renderScheduler();
  }

  function weekRange(start, end) {
    return MON[start.getMonth()] + " " + start.getDate() + " - " + MON[end.getMonth()] + " " + end.getDate();
  }

  function renderScheduler() {
    var n = state.selected.length;
    var i = state.schedIdx;
    var item = state.selected[i];
    if (!anyUpcoming(item)) { renderNoProgram(item.label); return; }

    var base = midnight(new Date());
    var w = state.weekOffset;
    var start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + w * 7);
    var end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);

    var html = head(item.label, n > 1 ? ("Class " + (i + 1) + " of " + n) : null);
    html += '<p class="trial-sub">Schedule your <strong>first</strong> class</p>';
    html += '<p class="trial-note trial-firstnote">Just your first class. Your free week covers every class you want to attend that week, so there\'s no need to book each one.</p>';
    html += '<p class="trial-weeklabel">' + esc(weekRange(start, end)) + '</p>';
    html += '<div class="trial-cal">';
    for (var dn = 0; dn < 7; dn++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dn);
      if (d.getDay() === 0) continue; // never show Sunday
      var slots = slotsOnDate(item, d);
      html += '<div class="trial-day">' +
                '<div class="trial-day__label">' + esc(DOW[d.getDay()].slice(0, 3) + ", " + MON[d.getMonth()] + " " + d.getDate()) + '</div>' +
                '<div class="trial-day__slots">';
      if (!slots.length) {
        html += '<span class="trial-day__empty">No class</span>';
      } else {
        slots.forEach(function (s) {
          html += '<button class="trial-slot" type="button" data-iso="' + esc(s.iso) + '" data-label="' + esc(s.label) + '" data-date="' + esc(s.dateText) + '" data-time="' + esc(s.timeText) + '">' +
                    esc(s.timeText) + ' &middot; ' + esc(s.label) +
                  '</button>';
        });
      }
      html += '</div></div>';
    }
    html += '</div>';
    html += '<div class="trial-actions">' +
              '<button class="btn btn--secondary trial-back" type="button">Back</button>' +
              '<button class="btn btn--secondary trial-nextweek" type="button"' + (w >= WEEKS_OUT - 1 ? " disabled" : "") + '>Next week</button>' +
            '</div>';
    setBody(html);

    var nw = dialog.querySelector(".trial-nextweek");
    if (nw) nw.addEventListener("click", function () {
      if (state.weekOffset < WEEKS_OUT - 1) { state.weekOffset++; renderScheduler(); }
    });
    dialog.querySelector(".trial-back").addEventListener("click", function () {
      if (state.weekOffset > 0) { state.weekOffset--; renderScheduler(); }
      else if (i > 0) { state.schedIdx = i - 1; state.weekOffset = 0; state.bookings.pop(); renderScheduler(); }
      else { renderPrograms(); }
    });
    dialog.querySelectorAll(".trial-slot").forEach(function (b) {
      b.addEventListener("click", function () {
        var slot = {
          iso: b.getAttribute("data-iso"),
          label: b.getAttribute("data-label"),
          dateText: b.getAttribute("data-date"),
          timeText: b.getAttribute("data-time")
        };
        state.bookings[i] = { tag: item.tag, label: item.label, slot: slot };
        if (i + 1 < n) { state.schedIdx = i + 1; state.weekOffset = 0; renderScheduler(); }
        else { renderIntake(); }
      });
    });
    focusFirst();
  }

  /* ---- step 3: intake (DOB drives parent/guardian requirement) ------- */
  function keepVal(name) { return (state.keep && state.keep[name] != null) ? state.keep[name] : ""; }

  function addrField(id, label, name, extra) {
    return '<div class="form-field"><label for="' + id + '">' + esc(label) + '</label>' +
           '<input id="' + id + '" name="' + name + '" type="text"' + (extra || "") + ' value="' + esc(keepVal(name)) + '"></div>';
  }

  function renderIntake() {
    var html = head("A little about the student", "Your info");
    html += '<form class="trial-form" novalidate>';
    html += '<div class="trial-grid trial-grid--2">' +
              '<div class="form-field"><label for="tf-sfirst">Student first name</label>' +
              '<input id="tf-sfirst" name="student_first" type="text" autocomplete="given-name" required></div>' +
              '<div class="form-field"><label for="tf-slast">Student last name</label>' +
              '<input id="tf-slast" name="student_last" type="text" autocomplete="family-name" required></div>' +
            '</div>';
    html += '<div class="form-field"><label for="tf-dob">Student date of birth</label>' +
            '<input id="tf-dob" name="dob" type="text" inputmode="numeric" autocomplete="bday" placeholder="MM/DD/YYYY" required></div>';
    html += addrField("tf-street", "Street address", "street", ' autocomplete="address-line1" required');
    html += '<div class="trial-grid trial-grid--3">' +
              addrField("tf-city", "City", "city", ' autocomplete="address-level2" required') +
              addrField("tf-state", "State", "state", ' autocomplete="address-level1" maxlength="20" required') +
              addrField("tf-zip", "ZIP", "zip", ' autocomplete="postal-code" inputmode="numeric" maxlength="10" required') +
            '</div>';
    html += '<div id="tf-contact"></div>';
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

    var dob = dialog.querySelector("#tf-dob");
    dob.addEventListener("input", renderContact);
    dob.addEventListener("change", renderContact);
    renderContact();

    dialog.querySelector(".trial-back").addEventListener("click", function () {
      state.schedIdx = state.selected.length - 1;
      state.weekOffset = 0;
      renderScheduler();
    });
    dialog.querySelector(".trial-form").addEventListener("submit", function (e) {
      e.preventDefault();
      onIntakeSubmit(e.target);
    });
    focusFirst();
  }

  // Contact fields depend on the entered DOB: parent required under 18, the
  // student's own phone/email plus an optional guardian at 18+.
  function renderContact() {
    var host = dialog.querySelector("#tf-contact");
    if (!host) return;
    // Preserve anything already typed across the re-render.
    var cur = {};
    host.querySelectorAll("input").forEach(function (el) { cur[el.name] = el.value; });
    var val = function (n) { return cur[n] != null && cur[n] !== "" ? cur[n] : keepVal(n); };

    var parsed = parseDOB((dialog.querySelector("#tf-dob") || {}).value || "");
    var age = parsed ? parsed.age : null;
    var cf = function (id, label, name, type, req) {
      return '<div class="form-field"><label for="' + id + '">' + esc(label) + '</label>' +
             '<input id="' + id + '" name="' + name + '" type="' + type + '"' + (req ? " data-req" : "") + ' value="' + esc(val(name)) + '"></div>';
    };
    var parentBlock = function (req) {
      return '<div class="trial-grid trial-grid--2">' +
               cf("tf-pfirst", "First name", "parent_first", "text", req) +
               cf("tf-plast", "Last name", "parent_last", "text", req) +
             '</div>' +
             cf("tf-pphone", "Phone", "parent_phone", "tel", req) +
             cf("tf-pemail", "Email", "parent_email", "email", req);
    };

    var html;
    if (age === null) {
      html = '<p class="trial-note">Enter the date of birth above to continue.</p>';
    } else if (age < 18) {
      html = '<p class="trial-legend">Parent / guardian</p>' + parentBlock(true);
    } else {
      html = '<p class="trial-legend">Your contact</p>' +
             cf("tf-phone", "Phone", "phone", "tel", true) +
             cf("tf-email", "Email", "email", "email", true) +
             '<p class="trial-legend">Parent / guardian (optional)</p>' + parentBlock(false);
    }
    host.innerHTML = html;
  }

  function onIntakeSubmit(form) {
    var status = form.querySelector(".form-status");
    var get = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value.trim() : ""; };

    // Honeypot -> silently pretend success (no record).
    if (get("company") !== "") { renderSuccess(); return; }

    var parsed = parseDOB(get("dob"));
    if (!parsed) { setStatus(status, "error", "Please enter the date of birth as MM/DD/YYYY."); return; }
    var age = parsed.age;

    var d = {
      student_first: get("student_first"),
      student_last: get("student_last"),
      dob: parsed.iso,
      street: get("street"),
      city: get("city"),
      state: get("state"),
      zip: get("zip"),
      isKids: age < 18
    };
    var required = [d.student_first, d.student_last, d.street, d.city, d.state, d.zip];

    if (d.isKids) {
      d.parent_first = get("parent_first");
      d.parent_last = get("parent_last");
      d.parent_phone = get("parent_phone");
      d.parent_email = get("parent_email");
      required = required.concat([d.parent_first, d.parent_last, d.parent_phone, d.parent_email]);
    } else {
      d.phone = get("phone");
      d.email = get("email");
      // Optional guardian for adults.
      d.guardian_first = get("parent_first");
      d.guardian_last = get("parent_last");
      d.guardian_phone = get("parent_phone");
      d.guardian_email = get("parent_email");
      required = required.concat([d.phone, d.email]);
    }
    if (required.some(function (v) { return !v; })) {
      setStatus(status, "error", "Please fill in all the required fields.");
      return;
    }

    state.intake = d;
    renderWaiver();
  }

  /* ---- step 4: waiver ------------------------------------------------ */
  function renderWaiver() {
    var html = head("Sign the waiver", "Almost done");
    html += '<div class="trial-waiver" tabindex="0" aria-label="Liability Waiver and Release">' +
              '<p class="trial-waiver__title">Liability Waiver and Release</p>' +
              '<p>' + esc(WAIVER_TEXT) + '</p>' +
            '</div>';
    html += '<form class="trial-form" novalidate>';
    html += '<div class="form-field"><label for="tf-signer">Full legal name of the person signing</label>' +
            '<input id="tf-signer" name="waiver_name" type="text" autocomplete="name" required></div>';
    html += '<div class="form-field"><label>Signature</label>' +
              '<div class="trial-sigwrap">' +
                '<canvas class="trial-sigpad" id="tf-sigpad" width="600" height="180" aria-label="Sign with your finger or mouse"></canvas>' +
                '<button class="trial-sigclear" type="button">Clear</button>' +
              '</div></div>';
    html += '<label class="trial-agree"><input id="tf-agree" name="waiver_agreed" type="checkbox">' +
            '<span>I have read and agree to the waiver above.</span></label>';
    html += '<div class="trial-actions">' +
              '<button class="btn btn--secondary trial-back" type="button">Back</button>' +
              '<button class="btn btn--primary trial-submit" type="submit" disabled>Book my free week</button>' +
            '</div>';
    html += '<p class="form-status" role="status" aria-live="polite"></p>';
    html += '</form>';
    setBody(html);

    var signer = dialog.querySelector("#tf-signer");
    var agree = dialog.querySelector("#tf-agree");
    var submit = dialog.querySelector(".trial-submit");
    var canvas = dialog.querySelector("#tf-sigpad");
    var ctx = canvas.getContext("2d");
    var drawing = false, hasSig = false, lastX = 0, lastY = 0;

    function sync() { submit.disabled = !(agree.checked && signer.value.trim() && hasSig); }
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var t = (e.touches && e.touches[0]) ? e.touches[0] : e;
      return { x: (t.clientX - r.left) * (canvas.width / r.width), y: (t.clientY - r.top) * (canvas.height / r.height) };
    }
    function start(e) { e.preventDefault(); drawing = true; var p = pos(e); lastX = p.x; lastY = p.y; }
    function move(e) {
      if (!drawing) return; e.preventDefault();
      var p = pos(e);
      ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.strokeStyle = "#17130f";
      ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastX = p.x; lastY = p.y; hasSig = true; sync();
    }
    function end() { drawing = false; }
    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("mouseup", end);
    canvas.addEventListener("mouseleave", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end);
    dialog.querySelector(".trial-sigclear").addEventListener("click", function () {
      ctx.clearRect(0, 0, canvas.width, canvas.height); hasSig = false; sync();
    });
    signer.addEventListener("input", sync);
    agree.addEventListener("change", sync);

    dialog.querySelector(".trial-back").addEventListener("click", renderIntake);
    dialog.querySelector(".trial-form").addEventListener("submit", function (e) {
      e.preventDefault();
      state.waiverName = signer.value.trim();
      state.waiverAgreed = !!agree.checked;
      state.waiverSignature = hasSig ? canvas.toDataURL("image/png") : "";
      if (!state.waiverAgreed || !state.waiverName || !state.waiverSignature) return;
      submitBooking(e.target);
    });
    sync();
    focusFirst();
  }

  /* ---- step 5: submit ------------------------------------------------ */
  function submitBooking(form) {
    var status = form.querySelector(".form-status");
    var button = form.querySelector('button[type="submit"]');
    var d = state.intake;

    var payload = {
      type: "trial",
      is_kids: d.isKids,
      student_first: d.student_first,
      student_last: d.student_last,
      dob: d.dob,
      address: { street: d.street, city: d.city, state: d.state, zip: d.zip },
      programs: state.selected.map(function (m) { return m.tag; }),
      bookings: state.bookings.map(function (b) {
        return {
          program: b.tag,
          class_datetime: b.slot.iso,
          class_label: b.slot.label,
          date_text: b.slot.dateText,
          time_text: b.slot.timeText
        };
      }),
      waiver_name: state.waiverName,
      waiver_agreed: true,
      waiver_signature: state.waiverSignature,
      company: ""
    };
    if (d.isKids) {
      payload.parent_first = d.parent_first;
      payload.parent_last = d.parent_last;
      payload.parent_phone = d.parent_phone;
      payload.parent_email = d.parent_email;
    } else {
      payload.phone = d.phone;
      payload.email = d.email;
      payload.guardian_first = d.guardian_first || "";
      payload.guardian_last = d.guardian_last || "";
      payload.guardian_phone = d.guardian_phone || "";
      payload.guardian_email = d.guardian_email || "";
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
    var email = d.isKids ? (d.parent_email || "") : (d.email || "");
    var recap = state.bookings.map(function (b) {
      return '<li>' + esc(b.label) + ' &middot; ' + esc(b.slot.dateText) + ' at ' + esc(b.slot.timeText) + '</li>';
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

  // Loop back to program select for a new student, keeping the parent/guardian
  // contact + address so the same family isn't re-typed. Each member still
  // becomes its own contact + bookings + waiver.
  function bookAnother() {
    var d = state.intake || {};
    var keep = { street: d.street, city: d.city, state: d.state, zip: d.zip };
    keep.parent_first = d.parent_first || d.guardian_first || "";
    keep.parent_last = d.parent_last || d.guardian_last || "";
    keep.parent_phone = d.parent_phone || d.guardian_phone || "";
    keep.parent_email = d.parent_email || d.guardian_email || "";
    state = freshState();
    state.keep = keep;
    renderPrograms();
  }

  function setStatus(status, state2, msg) {
    if (!status) return;
    status.textContent = msg;
    if (state2) status.setAttribute("data-state", state2); else status.removeAttribute("data-state");
  }
})();
