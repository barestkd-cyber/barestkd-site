/* ==========================================================================
   Bares Taekwondo Fitness — schedule.js
   Renders the live weekly class schedule on the Schedule page. Reads the SAME
   schedule_template the classplan/curriculum apps use, via the trial-booking
   Edge Function's GET endpoint, so it always matches what staff set in-app.
   Vanilla JS. If the fetch fails, the static fallback message stays visible.
   ========================================================================== */
(function () {
  "use strict";

  var ENDPOINT = "https://akdncbzxiwvihfcyijvm.supabase.co/functions/v1/trial-booking";
  var SB_KEY = "sb_publishable_uSGIk4_Tt1_BOmPBoC_U5A_Kp2032f5"; // publishable (public) key
  var DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]; // dow 1..6

  document.addEventListener("DOMContentLoaded", function () {
    var mount = document.querySelector("[data-schedule-mount]");
    if (!mount) return;
    var fallback = document.querySelector(".schedule-fallback");

    fetch(ENDPOINT, { method: "GET", headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        var classes = flatten(data && data.programs);
        if (!classes.length) throw new Error("no classes");
        render(mount, classes);
        if (fallback) fallback.hidden = true;
      })
      .catch(function (err) {
        console.error("[schedule] load failed (fallback shown):", err);
      });
  });

  function flatten(programs) {
    var out = [];
    (programs || []).forEach(function (p) {
      (p.classes || []).forEach(function (c) {
        out.push({ dow: c.dow, h: c.h, m: c.m, label: c.label || p.program, program: p.program });
      });
    });
    return out;
  }

  function fmtTime(h, m) {
    var ap = h < 12 ? "AM" : "PM";
    var hh = h % 12; if (hh === 0) hh = 12;
    return hh + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }

  function render(mount, classes) {
    var byDay = {};
    classes.forEach(function (c) { (byDay[c.dow] = byDay[c.dow] || []).push(c); });
    var days = Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; });

    var grid = document.createElement("div");
    grid.className = "schedule";

    days.forEach(function (dow) {
      var list = byDay[dow].sort(function (a, b) { return (a.h * 60 + a.m) - (b.h * 60 + b.m); });

      var col = document.createElement("div");
      col.className = "schedule-day";

      var head = document.createElement("h3");
      head.className = "schedule-day__name";
      head.textContent = DAYS[dow] || ("Day " + dow);
      col.appendChild(head);

      var ul = document.createElement("ul");
      ul.className = "schedule-day__list";
      list.forEach(function (c) {
        var li = document.createElement("li");
        li.className = "schedule-class";

        var t = document.createElement("span");
        t.className = "schedule-class__time";
        t.textContent = fmtTime(c.h, c.m);

        var n = document.createElement("span");
        n.className = "schedule-class__name";
        n.textContent = c.label;

        li.appendChild(t);
        li.appendChild(n);

        // Show the marketing program as a colored tag when it adds information
        // beyond the class label (e.g. Taekwondo's Juniors / Teens / Forms).
        if (c.program && c.label.toLowerCase().indexOf(c.program.toLowerCase()) === -1) {
          var pg = document.createElement("span");
          pg.className = "schedule-class__prog";
          pg.setAttribute("data-p", c.program);
          pg.textContent = c.program;
          li.appendChild(pg);
        }

        ul.appendChild(li);
      });
      col.appendChild(ul);
      grid.appendChild(col);
    });

    mount.textContent = "";
    mount.appendChild(grid);
  }
})();
