/* ==========================================================================
   Bares Taekwondo Fitness — form.js
   Contact form handler. Posts JSON to a Supabase Edge Function.
   Vanilla JS only.
   ========================================================================== */
(function () {
  "use strict";

  // TODO: replace with the deployed Supabase Edge Function URL.
  var ENDPOINT = "PASTE_SUPABASE_EDGE_FUNCTION_URL_HERE";

  var SUCCESS_MSG = "Thank you for contacting us. We will get back to you as soon as possible.";
  var ERROR_MSG = "Oops, there was an error sending your message. Please try again later.";

  document.addEventListener("DOMContentLoaded", function () {
    var forms = document.querySelectorAll("form[data-contact-form]");
    Array.prototype.forEach.call(forms, initForm);
  });

  function initForm(form) {
    var status = form.querySelector(".form-status");
    var button = form.querySelector("button[type='submit'], input[type='submit']");

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      // Honeypot: if the hidden "company" field is filled, silently abort.
      var honey = form.querySelector('input[name="company"]');
      if (honey && honey.value.trim() !== "") {
        return;
      }

      var data = {
        program: getVal(form, "program"),
        name: getVal(form, "name"),
        phone: getVal(form, "phone"),
        email: getVal(form, "email"),
        message: getVal(form, "message"),
        source_page: location.pathname
      };

      // Required field validation.
      if (!data.program || !data.name || !data.phone || !data.email || !data.message) {
        setStatus(status, "error", "Please choose a program and fill in your name, phone, email, and message.");
        return;
      }

      // Endpoint not configured yet.
      if (ENDPOINT.indexOf("PASTE_") !== -1) {
        console.warn("Contact form endpoint is not configured yet (ENDPOINT still contains PASTE_).");
        setStatus(status, "error", ERROR_MSG);
        return;
      }

      setBusy(button, true);
      setStatus(status, "", "Sending…");

      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
