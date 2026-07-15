/* ==========================================================================
   Bares Taekwondo Fitness — schedule.js
   Renders live class times from the SAME schedule_template the classplan /
   curriculum apps use, via the trial-booking GET endpoint. Two mount modes:

   - Full weekly grid (Schedule page):
       <div data-schedule-mount></div>
   - Per-program list (a program page, that program's classes only):
       <div data-schedule-mount data-schedule-program="Taekwondo"
            data-schedule-labels="juniors,forms"></div>

   Shows every class, trial-bookable or not. If the fetch fails, the sibling
   .schedule-fallback message stays visible. Vanilla JS.
   ========================================================================== */
(function () {
  "use strict";

  var ENDPOINT = "https://akdncbzxiwvihfcyijvm.supabase.co/functions/v1/trial-booking";
  var SB_KEY = "sb_publishable_uSGIk4_Tt1_BOmPBoC_U5A_Kp2032f5"; // publishable (public) key
  var DAYS = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Display name + age/detail per class, keyed by the schedule_template label.
  // Purely presentational; edit here to retitle a class or fix an age range.
  var CLASS_META = {
    "Cubs":            { name: "Cubs",           detail: "Ages 3-4" },
    "Juniors":         { name: "Juniors",        detail: "" },
    "Teens / Adults":  { name: "Teens / Adults", detail: "Ages 13+" },
    "Forms":           { name: "Forms",          detail: "Juniors, Teens & Adults" },
    "Leadership":      { name: "Leadership",     detail: "By invitation" },
    "Sparring":        { name: "Sparring",       detail: "" },
    "Kickboxing":      { name: "Kickboxing",     detail: "Ages 13+" },
    "Jiu-Jitsu (BJJ)": { name: "Jiu Jitsu",      detail: "No-Gi BJJ · 13+" },
    "AMP'D":           { name: "AMP'D",          detail: "By invitation" }
  };

  // Belt-rank abbreviations -> full names. Only hyphenated belt ranges (and
  // "All Ranks") render as a rank; other belt values (Pre-K, 13+, All, blank)
  // are age/all-levels notes and show no rank delineator.
  var BELT = { WHI: "White", YEL: "Yellow", ORG: "Orange", GR: "Green", GRN: "Green", BLU: "Blue", PUR: "Purple", RED: "Red", BR: "Brown", BRN: "Brown", BLK: "Black" };
  function beltLabel(b) {
    b = (b || "").trim();
    if (!b) return "";
    if (/^all ranks$/i.test(b)) return "All Ranks";
    if (b.indexOf("-") === -1) return "";
    var parts = b.split("-").map(function (p) { return p.toUpperCase().trim(); });
    if (!parts.every(function (p) { return BELT[p]; })) return ""; // e.g. "Pre-K" is not a belt range
    return parts.map(function (p) { return BELT[p]; }).join("–");
  }

  document.addEventListener("DOMContentLoaded", function () {
    var mounts = [].slice.call(document.querySelectorAll("[data-schedule-mount]"));
    if (!mounts.length) return;

    fetch(ENDPOINT, { method: "GET", headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        var all = flatten(data && data.programs);
        if (!all.length) throw new Error("no classes");
        mounts.forEach(function (mount) { fill(mount, all); });
      })
      .catch(function (err) {
        console.error("[schedule] load failed (fallback shown):", err);
      });
  });

  function flatten(programs) {
    var out = [];
    (programs || []).forEach(function (p) {
      (p.classes || []).forEach(function (c) {
        var lab = c.label || p.program;
        var meta = CLASS_META[lab] || { name: lab, detail: "" };
        out.push({ dow: c.dow, h: c.h, m: c.m, label: lab, name: meta.name, detail: meta.detail, belt: beltLabel(c.belt), program: p.program, trialOpen: c.trialOpen !== false });
      });
    });
    return out;
  }

  function fill(mount, all) {
    var prog = mount.getAttribute("data-schedule-program");
    var labels = mount.getAttribute("data-schedule-labels");
    var classes = all;
    if (prog) classes = classes.filter(function (c) { return c.program === prog; });
    if (labels) {
      var re = new RegExp(labels.split(",").map(function (s) { return s.trim(); }).filter(Boolean).join("|"), "i");
      classes = classes.filter(function (c) { return re.test(c.label); });
    }
    if (!classes.length) return; // leave the static fallback message

    if (prog) { renderList(mount, classes); } else { renderGrid(mount, classes); }

    var fb = mount.parentNode && mount.parentNode.querySelector(".schedule-fallback");
    if (fb) fb.hidden = true;
  }

  function fmtTime(h, m) {
    var ap = h < 12 ? "AM" : "PM";
    var hh = h % 12; if (hh === 0) hh = 12;
    return hh + ":" + (m < 10 ? "0" : "") + m + " " + ap;
  }

  function slot(c) { return c.dow * 1440 + c.h * 60 + c.m; }

  /* Full weekly grid, one column per day (Schedule page). */
  function renderGrid(mount, classes) {
    var byDay = {};
    classes.forEach(function (c) { (byDay[c.dow] = byDay[c.dow] || []).push(c); });
    var days = Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; });

    var grid = document.createElement("div");
    grid.className = "schedule";
    days.forEach(function (dow) {
      var list = byDay[dow].sort(function (a, b) { return (a.h * 60 + a.m) - (b.h * 60 + b.m); });
      var col = document.createElement("div");
      col.className = "schedule-day";
      col.appendChild(el("h3", "schedule-day__name", DAYS[dow] || ("Day " + dow)));
      var ul = document.createElement("ul");
      ul.className = "schedule-day__list";
      list.forEach(function (c) {
        var li = document.createElement("li");
        li.className = "schedule-class";
        if (c.program) li.setAttribute("data-p", c.program);
        li.appendChild(el("span", "schedule-class__time", fmtTime(c.h, c.m)));
        li.appendChild(el("span", "schedule-class__name", c.name));
        if (c.belt) li.appendChild(el("span", "schedule-class__rank", c.belt));
        if (c.detail) li.appendChild(el("span", "schedule-class__detail", c.detail));
        ul.appendChild(li);
      });
      col.appendChild(ul);
      grid.appendChild(col);
    });
    mount.textContent = "";
    mount.appendChild(grid);
  }

  /* Per-program list: group by class (label), each with its day/time list. */
  function renderList(mount, classes) {
    var byName = {};
    classes.forEach(function (c) { (byName[c.name] = byName[c.name] || []).push(c); });
    var names = Object.keys(byName).sort(function (a, b) {
      return Math.min.apply(null, byName[a].map(slot)) - Math.min.apply(null, byName[b].map(slot));
    });

    var wrap = document.createElement("div");
    wrap.className = "schedule-classes";
    names.forEach(function (nm) {
      var group = byName[nm];
      var times = group.sort(function (a, b) { return slot(a) - slot(b); });
      var row = document.createElement("div");
      row.className = "schedule-class-row";
      row.appendChild(el("h3", "schedule-class-row__name", nm));
      if (group[0].detail) row.appendChild(el("p", "schedule-class-row__age", group[0].detail));
      var ul = document.createElement("ul");
      ul.className = "schedule-class-row__times";
      times.forEach(function (c) { ul.appendChild(el("li", "", SHORT[c.dow] + " " + fmtTime(c.h, c.m) + (c.belt ? " · " + c.belt : ""))); });
      row.appendChild(ul);
      wrap.appendChild(row);
    });
    mount.textContent = "";
    mount.appendChild(wrap);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
})();
