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

  /* ---- Mobile bottom bar: visible on load, hides on scroll-down, returns
     on scroll-up, and stays hidden while the contact section is on screen.
     State is computed from live geometry every scroll (no IntersectionObserver
     combine that could get stuck hidden). ------------------------------- */
  function setupMobileCtaBar() {
    var bar = document.querySelector("[data-mobile-cta-bar]");
    if (!bar) return;

    var contact = document.getElementById("contact"); // homepage only; null elsewhere
    var lastY = window.pageYOffset || 0;
    var hidden = false;
    var ticking = false;
    var DELTA = 6; // ignore tiny scroll jitters

    function contactOnScreen() {
      if (!contact) return false;
      var r = contact.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      return r.top < vh && r.bottom > 0;
    }

    function update() {
      var y = window.pageYOffset || 0;
      var dy = y - lastY;
      var next;
      if (contactOnScreen()) {
        next = true;            // tucked away while the contact section shows
      } else if (y <= 40) {
        next = false;           // always visible at/near the top
      } else if (Math.abs(dy) > DELTA) {
        next = dy > 0;          // scrolling down hides, scrolling up shows
      } else {
        next = hidden;          // tiny move: keep current state
      }
      if (Math.abs(dy) > DELTA) lastY = y;
      if (next !== hidden) {
        hidden = next;
        bar.classList.toggle("is-hidden", hidden);
      }
    }

    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { update(); ticking = false; });
    }, { passive: true });

    // Establish the correct state on load (visible unless contact is already shown).
    update();
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

  /* ---- hero highlight reel --------------------------------------------
     The poster photo shows instantly on top. The muted looping reel sits behind
     it; once the reel plays we fade the POSTER out to reveal it (fading the img
     avoids opacity-transition quirks on <video>). We only load/play the reel
     when motion is welcome and the connection allows. Under prefers-reduced-
     motion, data-saver, or blocked autoplay, the poster simply stays. */
  var hv = document.querySelector("[data-hero-video]");
  var poster = document.querySelector(".hero__poster");
  if (hv && poster) {
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var conn = navigator.connection || {};
    var src = hv.getAttribute("data-src");
    if (src && !reduce && !conn.saveData) {
      var source = document.createElement("source");
      source.src = src;
      source.type = "video/mp4";
      hv.appendChild(source);
      // Reveal (fade poster out) on whichever fires first: playing or play() resolving.
      var revealed = false;
      var reveal = function () {
        if (revealed) return;
        revealed = true;
        poster.classList.add("is-hidden");
      };
      hv.addEventListener("playing", reveal, { once: true });
      try { hv.load(); } catch (e) { /* ignore */ }
      var playPromise = hv.play();
      if (playPromise && playPromise.then) {
        playPromise.then(reveal).catch(function () { /* autoplay blocked: poster stays */ });
      }
    }
  }
})();
