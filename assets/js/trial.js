/* ==========================================================================
   Bares Taekwondo Fitness — trial.js
   The on-site "Try 1 Week Free" popup. Every [data-trial-open] button opens a
   3-step modal (choose program -> pick a class -> your info) and submits to the
   Supabase Edge Function.

   The program list + class times are LIVE: on modal open we GET the
   trial-booking function, which reads schedule_template (trial_open=true rows
   only) and groups them into marketing programs with a kids flag. There is no
   hardcoded schedule here — edit classes in Class Plan / schedule_template.

   No-JS fallback: the buttons keep href="/contact-form", so without JS they
   simply navigate there. If the live fetch fails, the modal shows a call
   number + contact link (never an empty step).
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

  // Marketing programs served by the GET. Each: {program, ageLabel, kids,
  // classes:[{dow (1=Mon..6=Sat), h, m, label}]}. Loaded on open.
  var PROGRAMS = null;
  var state = { program: null, slot: null };
  var modal, dialog, lastFocused;

  document.addEventListener("DOMContentLoaded", function () {
    document.addEventListener("click", function (e) {
      var trigger = e.target.closest("[data-trial-open]");
      if (!trigger) return;
      e.preventDefault();
      openModal(trigger);
    });
  });

  /* ---- helpers -------------------------------------------------------- */
  function bookablePrograms() {
    return (PROGRAMS || []).filter(function (p) { return p.classes && p.classes.length; });
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
    state = { program: null, slot: null };
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

  function stepHead(n, title) {
    return '<p class="trial-eyebrow">Free Week &middot; Step ' + n + ' of 3</p>' +
           '<h2 id="trial-title" class="trial-h">' + title + '</h2>';
  }

  /* ---- load the live schedule ---------------------------------------- */
  function renderLoading() {
    setBody(stepHead(1, "Choose your program") + '<p class="trial-note">Loading class times&hellip;</p>');
  }

  function loadSchedule() {
    fetch(ENDPOINT, { method: "GET", headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY } })
      .then(function (r) { if (!r.ok) throw new Error("bad " + r.status); return r.json(); })
      .then(function (data) {
        PROGRAMS = (data && data.programs) || [];
        if (!bookablePrograms().length) { renderFallback(); return; }
        renderStepProgram();
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
    var b = dialog.querySelector("[data-trial-close]");
    if (b) b.focus();
  }

  /* ---- step 1: program ------------------------------------------------ */
  function renderStepProgram() {
    var progs = bookablePrograms();
    var html = stepHead(1, "Choose your program") + '<div class="trial-options">';
    progs.forEach(function (p, i) {
      html += '<button class="trial-option" type="button" data-idx="' + i + '">' +
                '<span class="trial-option__name">' + p.program + '</span>' +
                '<span class="trial-option__sub">' + p.ageLabel + '</span>' +
              '</button>';
    });
    html += '</div>';
    setBody(html);
    dialog.querySelectorAll("[data-idx]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.program = progs[parseInt(b.getAttribute("data-idx"), 10)];
        renderStepClass();
      });
    });
  }

  /* ---- step 2: class -------------------------------------------------- */
  function renderStepClass() {
    var slots = upcomingSlots(state.program);
    var html = stepHead(2, "Pick your first class");
    html += '<p class="trial-sub">' + state.program.program + ' &middot; ' + state.program.ageLabel + '</p>';
    if (!slots.length) {
      html += '<p class="trial-note">No upcoming class times in the next two weeks. ' +
              'Call <a href="tel:' + PHONE + '">' + PHONE + '</a> or ' +
              '<a href="/contact-form">contact us</a> to find a time.</p>';
    } else {
      html += '<div class="trial-options trial-slots">';
      slots.forEach(function (s, i) {
        html += '<button class="trial-option" type="button" data-slot="' + i + '">' +
                  '<span class="trial-option__name">' + s.dateText + '</span>' +
                  '<span class="trial-option__sub">' + s.timeText + ' &middot; ' + s.label + '</span>' +
                '</button>';
      });
      html += '</div>';
    }
    html += '<div class="trial-actions"><button class="btn btn--secondary trial-back" type="button">Back</button></div>';
    setBody(html);
    dialog.querySelector(".trial-back").addEventListener("click", renderStepProgram);
    dialog.querySelectorAll("[data-slot]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.slot = slots[parseInt(b.getAttribute("data-slot"), 10)];
        renderStepDetails();
      });
    });
  }

  /* ---- step 3: details ------------------------------------------------ */
  function renderStepDetails() {
    var kids = !!state.program.kids;
    var html = stepHead(3, "Your info");
    html += '<p class="trial-sub">' + state.program.program + ' &middot; ' + state.slot.dateText + ' at ' + state.slot.timeText + '</p>';
    html += '<form class="trial-form" novalidate>';
    if (kids) {
      html +=
        '<div class="form-field"><label for="tf-student">Student name</label>' +
        '<input id="tf-student" name="student_name" type="text" required></div>' +
        '<div class="form-field"><label for="tf-age">Student age</label>' +
        '<input id="tf-age" name="student_age" type="number" min="1" max="99" inputmode="numeric" required></div>';
    }
    html +=
      '<div class="form-field"><label for="tf-name">' + (kids ? "Parent/guardian name" : "Your name") + '</label>' +
      '<input id="tf-name" name="contact_name" type="text" autocomplete="name" required></div>' +
      '<div class="form-field"><label for="tf-phone">Phone</label>' +
      '<input id="tf-phone" name="phone" type="tel" autocomplete="tel" required></div>' +
      '<div class="form-field"><label for="tf-email">Email</label>' +
      '<input id="tf-email" name="email" type="email" autocomplete="email" required></div>' +
      '<div class="hp-field" aria-hidden="true"><label for="tf-company">Company</label>' +
      '<input id="tf-company" name="company" type="text" tabindex="-1" autocomplete="off"></div>' +
      '<div class="trial-actions">' +
        '<button class="btn btn--secondary trial-back" type="button">Back</button>' +
        '<button class="btn btn--primary" type="submit">Book my free class</button>' +
      '</div>' +
      '<p class="form-consent">' + CONSENT + '</p>' +
      '<p class="form-status" role="status" aria-live="polite"></p>' +
    '</form>';
    setBody(html);

    dialog.querySelector(".trial-back").addEventListener("click", renderStepClass);
    dialog.querySelector(".trial-form").addEventListener("submit", function (e) {
      e.preventDefault();
      submit(e.target, kids);
    });
  }

  function submit(form, kids) {
    var status = form.querySelector(".form-status");
    var button = form.querySelector('button[type="submit"]');
    var get = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? el.value.trim() : ""; };

    // Honeypot -> silently pretend success.
    if (get("company") !== "") { showSuccess(); return; }

    var payload = {
      type: "trial",
      program: state.program.program,
      class_label: state.slot.label,
      class_datetime: state.slot.iso,
      contact_name: get("contact_name"),
      phone: get("phone"),
      email: get("email"),
      is_kids: kids,
      student_name: kids ? get("student_name") : "",
      student_age: kids ? get("student_age") : "",
      company: ""
    };

    if (!payload.contact_name || !payload.phone || !payload.email || (kids && (!payload.student_name || !payload.student_age))) {
      setStatus(status, "error", "Please fill in all the fields.");
      return;
    }

    button.disabled = true;
    setStatus(status, "", "Booking…");

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY },
      body: JSON.stringify(payload)
    })
      .then(function (r) { if (!r.ok) throw new Error("bad " + r.status); return r; })
      .then(function () { showSuccess(); })
      .catch(function (err) {
        console.error("Trial booking failed:", err);
        setStatus(status, "error", "Oops, there was an error booking your class. Please try again later.");
        button.disabled = false;
      });
  }

  function showSuccess() {
    setBody(
      '<div class="trial-success">' +
        '<div class="trial-check" aria-hidden="true">&#10003;</div>' +
        '<h2 id="trial-title" class="trial-h">You\'re booked!</h2>' +
        '<p class="trial-sub">' + state.program.program + '</p>' +
        '<p class="trial-confirm">' + state.slot.dateText + '<br>' + state.slot.timeText + '</p>' +
        '<p class="trial-note">We\'ll reach out to confirm. See you in class!</p>' +
        '<div class="trial-actions"><button class="btn btn--primary" type="button" data-trial-close>Done</button></div>' +
      '</div>'
    );
    var done = dialog.querySelector("[data-trial-close]");
    if (done) done.focus();
  }

  function setStatus(status, state2, msg) {
    if (!status) return;
    status.textContent = msg;
    if (state2) status.setAttribute("data-state", state2); else status.removeAttribute("data-state");
  }
})();
