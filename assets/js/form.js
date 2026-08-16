/* ==========================================================================
   Bares Taekwondo Fitness - form.js
   Contact form handler. Posts JSON to a Supabase Edge Function.
   Vanilla JS only.
   ========================================================================== */
(function () {
  "use strict";

  // Same Supabase Edge Function the trial popup uses (type:"contact").
  var ENDPOINT = "https://akdncbzxiwvihfcyijvm.supabase.co/functions/v1/trial-booking";
  var SB_KEY = "sb_publishable_uSGIk4_Tt1_BOmPBoC_U5A_Kp2032f5"; // publishable (public) key - safe to ship

  var SUCCESS_MSG = "Thank you for contacting us. We will get back to you as soon as possible.";
  var ERROR_MSG = "Oops, there was an error sending your message. Please try again later.";

  document.addEventListener("DOMContentLoaded", function () {
    var forms = document.querySelectorAll("form[data-contact-form]");
    Array.prototype.forEach.call(forms, initForm);
  });

  /* The typed age as a whole number, or null when it is not usable. */
  function ageVal(form) {
    var raw = getVal(form, "student_age");
    if (!/^\d{1,3}$/.test(raw)) return null;
    var age = parseInt(raw, 10);
    return (age >= 2 && age < 120) ? age : null;
  }

  /* A student under 18 must have a parent named. Over 18 the field stays
     visible but optional - an adult can still list someone, and seeing it
     empty tells them plainly that it is not required of them. */
  function syncGuardian(form) {
    var block = form.querySelector("[data-guardian-block]");
    var hint = form.querySelector("[data-guardian-hint]");
    if (!block) return null;
    var age = ageVal(form);
    var minor = age !== null && age < 18;
    block.hidden = age === null;           // nothing to say until an age is entered
    if (hint) hint.textContent = minor
      ? "Required. The student is under 18."
      : "Optional for an adult student.";
    return minor;
  }

  function initForm(form) {
    var status = form.querySelector(".form-status");
    var button = form.querySelector("button[type='submit'], input[type='submit']");

    // Age drives one thing only: whether the guardian field is required.
    // The Juniors / Teens & Adults choice belongs to the visitor - the
    // dropdown labels carry the age ranges.
    var ageEl = form.querySelector("[name='student_age']");
    if (ageEl) {
      ageEl.addEventListener("input", function () { syncGuardian(form); });
      ageEl.addEventListener("change", function () { syncGuardian(form); });
      syncGuardian(form);
    }

    // Preselect the program dropdown from a ?program= query param
    // (e.g. /contact-form?program=little-kickers). Matches against the
    // existing option text, so no option values need adding.
    preselectProgram(form);

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      // Honeypot: if the hidden "hp" field is filled, silently abort.
      // (Must NOT be named "company"/"organization" etc. - browsers autofill
      //  those, which would silently kill every real submission.)
      var honey = form.querySelector('input[name="hp"]');
      if (honey && honey.value.trim() !== "") {
        return;
      }

      var minor = syncGuardian(form);
      var age = ageVal(form);
      var data = {
        type: "contact",
        program: getVal(form, "program"),
        name: getVal(form, "name"),
        student_age: age,
        guardian_name: getVal(form, "guardian_name"),
        phone: getVal(form, "phone"),
        email: getVal(form, "email"),
        message: getVal(form, "message"),
        source_page: location.pathname
      };

      // Required field validation.
      if (!data.program || !data.name || !data.phone || !data.email || !data.message) {
        setStatus(status, "error", "Please choose a program and fill in the student's name, phone, email, and message.");
        return;
      }
      if (age === null) {
        setStatus(status, "error", "Please enter the student's age.");
        return;
      }
      // The server enforces this too - this check only gives a faster answer.
      if (minor && !data.guardian_name) {
        setStatus(status, "error", "Please enter a parent or guardian name for a student under 18.");
        return;
      }

      setBusy(button, true);
      setStatus(status, "", "Sending…");

      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY },
        body: JSON.stringify(data)
      })
        .then(function (res) {
          if (!res.ok) throw new Error("Bad response: " + res.status);
          return res;
        })
        .then(function () {
          form.reset();
          setStatus(status, "success", SUCCESS_MSG);
        })
        .catch(function (err) {
          console.error("Contact form submit failed:", err);
          setStatus(status, "error", ERROR_MSG);
        })
        .then(function () {
          setBusy(button, false);
        });
    });
  }

  function getVal(form, name) {
    var el = form.querySelector('[name="' + name + '"]');
    return el ? el.value.trim() : "";
  }

  function setBusy(button, busy) {
    if (!button) return;
    button.disabled = busy;
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }

  // Preselect the program <select> from ?program=<slug>. Normalizes both sides
  // to letters+digits and matches on the existing option text, so slugs like
  // "little-kickers" or "homeschool" select the right existing option.
  function preselectProgram(form) {
    var want = (new URLSearchParams(location.search).get("program") || "")
      .toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!want) return;
    var sel = form.querySelector('select[name="program"]');
    if (!sel) return;
    for (var i = 0; i < sel.options.length; i++) {
      var norm = sel.options[i].text.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm && norm.indexOf(want) !== -1) { sel.selectedIndex = i; break; }
    }
  }

  function setStatus(status, state, msg) {
    if (!status) return;
    status.textContent = msg;
    if (state) {
      status.setAttribute("data-state", state);
    } else {
      status.removeAttribute("data-state");
    }
  }
})();
