/* ==========================================================================
   Bares Taekwondo Fitness — main.js
   Nav toggle, Programs dropdown, FAQ accordion, and a single fade-up on
   section entry. Vanilla JS only. Motion is disabled under
   prefers-reduced-motion.
   ========================================================================== */
(function () {
  "use strict";

  // Signal to CSS that JS is on (so fade-up starts hidden only when JS can reveal it).
  document.documentElement.classList.add("js");

  var reduceMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  document.addEventListener("DOMContentLoaded", function () {
    setupNavToggle();
    setupDropdowns();
    setupFaqAccordion();
    setupHeroVideo();
    setupHeaderCtaReveal();
    setupMobileCtaBar();
    setupFadeUp();
  });

  /* ---- Mobile bottom bar: hide while the contact section is on screen -- */
  function setupMobileCtaBar() {
    var bar = document.querySelector("[data-mobile-cta-bar]");
    if (!bar) return;

    // Only the homepage has #contact. Elsewhere the bar simply stays visible.
    var contact = document.getElementById("contact");
    if (!contact || !("IntersectionObserver" in window)) return;

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        // Contact section on screen -> tuck the bar away so it doesn't overlap it.
        bar.classList.toggle("is-hidden", entry.isIntersecting);
      });
    }, { threshold: 0 });

    observer.observe(contact);
  }

  /* ---- Homepage header CTA: hide over hero, fade in past it ----------- */
  function setupHeaderCtaReveal() {
    var hero = document.querySelector(".hero");
    var header = document.querySelector(".site-header");
    // No hero (interior pages) => leave the header button always visible.
    if (!hero || !header) return;

    if (!("IntersectionObserver" in window)) {
      // Fail safe: without IO support, keep the button visible.
      return;
    }

    // Start hidden: the hero fills the top of the homepage on load.
    header.classList.add("hero-cta-hidden");

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        // Hero on screen -> hide the CTA; scrolled past hero -> reveal it.
        header.classList.toggle("hero-cta-hidden", entry.isIntersecting);
      });
    }, { threshold: 0 });

    observer.observe(hero);
  }

  /* ---- Hero video: respect reduced motion --------------------------- */
  function setupHeroVideo() {
    var video = document.querySelector("video.hero__media");
    if (!video) return;
    if (reduceMotion) {
      // Show the poster only — no motion.
      video.removeAttribute("autoplay");
      video.autoplay = false;
      try { video.pause(); } catch (e) {}
    }
  }

  /* ---- Mobile nav hamburger ------------------------------------------- */
  function setupNavToggle() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.getElementById("primary-nav");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // Close the menu when a real link is followed (mobile).
    nav.addEventListener("click", function (e) {
      var link = e.target.closest("a");
      if (link && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---- Programs dropdown (accessible) --------------------------------- */
  function setupDropdowns() {
    var groups = document.querySelectorAll(".has-dropdown");
    Array.prototype.forEach.call(groups, function (group) {
      var btn = group.querySelector(".dropdown-toggle");
      if (!btn) return;
      btn.addEventListener("click", function () {
        var open = group.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
      });
    });

    // Click outside closes any open dropdown (desktop).
    document.addEventListener("click", function (e) {
      Array.prototype.forEach.call(groups, function (group) {
        if (!group.contains(e.target)) {
          group.classList.remove("is-open");
          var btn = group.querySelector(".dropdown-toggle");
          if (btn) btn.setAttribute("aria-expanded", "false");
        }
      });
    });

    // Escape closes dropdowns.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        Array.prototype.forEach.call(groups, function (group) {
          group.classList.remove("is-open");
          var btn = group.querySelector(".dropdown-toggle");
          if (btn) btn.setAttribute("aria-expanded", "false");
        });
      }
    });
  }

  /* ---- FAQ accordion --------------------------------------------------- */
  function setupFaqAccordion() {
    var questions = document.querySelectorAll(".faq__q");
    Array.prototype.forEach.call(questions, function (q) {
      q.addEventListener("click", function () {
        var expanded = q.getAttribute("aria-expanded") === "true";
        q.setAttribute("aria-expanded", expanded ? "false" : "true");
        var panel = document.getElementById(q.getAttribute("aria-controls"));
        if (panel) panel.hidden = expanded;
      });
    });
  }

  /* ---- Single fade-up on section entry -------------------------------- */
  function setupFadeUp() {
    var els = document.querySelectorAll(".fade-up");
    if (!els.length) return;

    if (reduceMotion || !("IntersectionObserver" in window)) {
      // No motion: reveal everything immediately.
      Array.prototype.forEach.call(els, function (el) {
        el.classList.add("is-visible");
      });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });

    Array.prototype.forEach.call(els, function (el) {
      observer.observe(el);
    });
  }
})();
