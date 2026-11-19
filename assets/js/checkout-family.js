/* Family members on a checkout page.
 *
 * Owner, 2026-11-18: "connect all programs via second student during checkout.
 * So, for example, if an adult kickboxer wanted to sign up after a cub on the
 * same checkout page ... it should run all directions. So we need the checkout
 * page to be specific for the first student, but then you can add any type of
 * second student and the engine will run the price correctly."
 *
 * The first student is the page's own program and stays the page's business.
 * This file owns everyone added after them: the rows (program, name, date of
 * birth, a payment option when they need one, their uniform), what is posted
 * for them, their agreements, and their lines in the cart.
 *
 * Nothing here prices anything. Every price comes from the server's quote
 * (program-checkout, action "quote"), which runs the same engine as the charge,
 * so the cart a family reads is the cart they pay.
 *
 *   var fam = BTKDFamily.create({ cfg, fn, key, root, list, addBtn, note,
 *     defaultKey, money, moneyS, esc, body, changed });
 *
 * body()    the page's part of the cart, as the POST sends it: plan_code,
 *           email, uniform, addons, shirts, and the first student.
 * changed() re-render the page (cart, agreements, who-signs rules).
 */
(function () {
  "use strict";

  function create(o) {
    var cfg = o.cfg, choices = cfg.family_choices || [];
    var rows = [], seq = 0;
    var Q = { sig: "", data: null, pending: false, error: "", timer: null, n: 0 };

    var choiceOf = function (key) {
      for (var i = 0; i < choices.length; i++) if (choices[i].key === key) return choices[i];
      return choices[0] || null;
    };
    var val = function (row, f) { var el = row.el.querySelector('[data-f="' + f + '"]'); return el ? String(el.value || "").trim() : ""; };
    var halfOf = function (c) { return Math.round(c * (10000 - (cfg.family_uniform_bps || 0)) / 10000); };
    // Whole years on a yyyy-mm-dd, in the parent's own time zone.
    function ageOn(dob) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dob || ""));
      if (!m) return null;
      var d = new Date(), age = d.getFullYear() - +m[1];
      if (d.getMonth() + 1 < +m[2] || (d.getMonth() + 1 === +m[2] && d.getDate() < +m[3])) age--;
      return age;
    }
    function fmtMDY(ymd) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || "")); return m ? (m[2] + "-" + m[3] + "-" + m[1]) : ""; }
    function ordinal(n) { var s = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"; return n + s; }

    function members() {
      return rows.map(function (r) {
        var cb = r.el.querySelector('[data-f="uniform"]');
        var choice = choiceOf(val(r, "program"));
        return {
          row: r, choice: choice, first: val(r, "first"), last: val(r, "last"), dob: val(r, "dob"),
          planCode: val(r, "plan"), uniform: !!(cb && cb.checked && choice && choice.uniform_available),
        };
      });
    }
    function name(m, i) { return ((m.first + " " + m.last).trim()) || ("Family member " + (i + 2)); }

    /* What is posted for them, in order after the first student. */
    function payload() {
      return members().map(function (m) {
        return { first: m.first, last: m.last, dob: m.dob, program: m.choice ? m.choice.key : "", plan_code: m.planCode };
      });
    }
    function uniforms() { return members().map(function (m) { return m.uniform; }); }

    /* ── the quote ─────────────────────────────────────────────────────── */
    function fullBody() {
      var b = o.body();
      var first = b.students && b.students[0] ? b.students[0] : { first: "", last: "", dob: "" };
      b.students = [first].concat(payload());
      b.uniforms = [b.uniform === true].concat(uniforms());
      return b;
    }
    // Only what changes a price goes into the signature, so typing a name
    // or a birthday does not cost a round trip.
    function sigOf(b) {
      return JSON.stringify([b.plan_code, b.email, b.uniforms, b.addons, b.shirts,
        (b.students || []).map(function (s) { return [s.program || "", s.plan_code || ""]; })]);
    }
    function fresh() { var b = fullBody(); return Q.data && Q.sig === sigOf(b) ? Q.data : null; }
    function requestQuote() {
      if (!o.body().plan_code) return;
      clearTimeout(Q.timer);
      Q.timer = setTimeout(sendQuote, 250);
    }
    function sendQuote() {
      var b = fullBody();
      var sig = sigOf(b);
      if (Q.data && Q.sig === sig && !Q.error) return;
      // A cart that just failed is not asked again until something in it
      // changes, so a refusal cannot turn into a loop of requests.
      if (Q.failSig === sig) return;
      var n = ++Q.n;
      Q.pending = true; Q.error = "";
      b.action = "quote";
      fetch(o.fn, {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": o.key, "Authorization": "Bearer " + o.key },
        body: JSON.stringify(b)
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (n !== Q.n) return;
          Q.pending = false;
          if (!res.ok || !res.j || !res.j.ok) {
            Q.error = (res.j && res.j.error) || "The price is not loading. Try again, or call 903-561-2966.";
            Q.data = null; Q.failSig = sig;
          } else { Q.data = res.j; Q.sig = sig; Q.failSig = ""; }
          syncRows(); o.changed();
        })
        .catch(function () {
          if (n !== Q.n) return;
          Q.pending = false; Q.error = "The price is not loading. Check your connection and try again.";
          Q.data = null; Q.failSig = sig;
          o.changed();
        });
      o.changed();
    }

    /* ── the rows ──────────────────────────────────────────────────────── */
    function add() {
      if (rows.length >= 3 || !choices.length) return;
      var id = "cbc-fam-" + (++seq);
      var el = document.createElement("div");
      el.className = "cbc-fam-student";
      var opts = choices.map(function (c) {
        return '<option value="' + o.esc(c.key) + '"' + (c.key === o.defaultKey ? " selected" : "") + ">" + o.esc(c.label) + "</option>";
      }).join("");
      el.innerHTML = '<p class="lkc-pick" style="margin:0 0 8px">Family member</p>'
        + '<div class="form-field"><label for="' + id + '-prog">Program</label><select id="' + id + '-prog" data-f="program">' + opts + '</select></div>'
        + '<div class="form-field"><label for="' + id + '-first">Their first name</label><input id="' + id + '-first" type="text" data-f="first" autocomplete="off"></div>'
        + '<div class="form-field"><label for="' + id + '-last">Their last name</label><input id="' + id + '-last" type="text" data-f="last" autocomplete="off"></div>'
        + '<div class="form-field"><label for="' + id + '-dob">Their date of birth</label><input id="' + id + '-dob" type="date" data-f="dob"></div>'
        + '<div class="form-field" data-f="planwrap" style="display:none"><label for="' + id + '-plan">Their payment option</label>'
        + '<select id="' + id + '-plan" data-f="plan"></select>'
        + '<small class="cbc-fam-why" style="display:block;color:#5b6570;margin-top:4px">The family\'s first Taekwondo student picks a regular option.</small></div>'
        + '<label class="lkc-shirt-q" style="margin:0 0 10px" data-f="unilabel"><input type="checkbox" data-f="uniform">'
        + '<span class="grow"><span data-f="uniname">Uniform</span> for this student. <b data-f="uniprice"></b> + tax'
        + '<small class="cbc-uni-fam">Half off for a family member</small></span></label>'
        + '<p class="tst-seatnote" data-f="price" style="font-size:.85rem;color:#5b6570;margin:0 0 8px"></p>'
        + '<button type="button" class="cbc-fam-x">Remove this student</button>';
      var r = { el: el };
      rows.push(r);
      el.querySelector(".cbc-fam-x").addEventListener("click", function () {
        rows.splice(rows.indexOf(r), 1);
        el.remove();
        relabel(); requestQuote(); o.changed();
      });
      el.querySelector('[data-f="program"]').addEventListener("change", function () {
        el.querySelector('[data-f="plan"]').value = "";
        el.querySelector('[data-f="planwrap"]').style.display = "none";
        syncRows(); requestQuote(); o.changed();
      });
      el.querySelector('[data-f="plan"]').addEventListener("change", function () { requestQuote(); o.changed(); });
      el.querySelector('[data-f="uniform"]').addEventListener("change", function () { requestQuote(); o.changed(); });
      el.querySelectorAll("input").forEach(function (i) {
        i.addEventListener("input", function () { o.changed(); });
      });
      o.list.appendChild(el);
      relabel(); syncRows(); requestQuote(); o.changed();
      el.querySelector('[data-f="first"]').focus();
    }
    function relabel() {
      rows.forEach(function (r, i) { r.el.querySelector(".lkc-pick").textContent = "Family member " + (i + 2); });
      o.addBtn.hidden = rows.length >= 3;
      o.addBtn.textContent = rows.length ? "+ Add another family member" : "+ Add a second family member";
    }
    /* Each row follows its program: its uniform, a payment option where the
       quote says they need one, and the price the quote gave them. */
    function syncRows() {
      var q = fresh();
      members().forEach(function (m, i) {
        var el = m.row.el, c = m.choice;
        var qs = q && q.students ? q.students[i + 1] : null;
        var lab = el.querySelector('[data-f="unilabel"]');
        var avail = !!(c && c.uniform_available);
        lab.style.display = avail ? "" : "none";
        if (!avail) el.querySelector('[data-f="uniform"]').checked = false;
        el.querySelector('[data-f="uniname"]').textContent = c && c.template_key === "cubs" ? "Cubs uniform" : "Beginner uniform";
        if (avail) {
          var full = c.uniform_cents, cents = qs && qs.uniform ? qs.uniform.cents : (qs && qs.position < 2 ? full : halfOf(full));
          el.querySelector('[data-f="uniprice"]').textContent = o.moneyS(cents);
          el.querySelector(".cbc-uni-fam").style.display = cents < full ? "" : "none";
        }
        // A Taekwondo student who is the family's first picks a regular option.
        var wrap = el.querySelector('[data-f="planwrap"]'), sel = el.querySelector('[data-f="plan"]');
        var needs = !!(qs && (qs.needs_option || (c && c.tkd && qs.position === 1)));
        if (needs) {
          var cur = sel.value;
          sel.innerHTML = '<option value="">Pick an option</option>' + (c.options || []).map(function (p) {
            return '<option value="' + o.esc(p.code) + '">' + o.esc(p.name) + ", " + o.moneyS(p.due_today_cents) + " today</option>";
          }).join("");
          sel.value = cur;
          wrap.style.display = "";
        } else if (qs) {
          wrap.style.display = "none";
          sel.value = "";
        }
        // Their price, in a line, where they were entered.
        var line = "";
        if (qs && qs.plan) {
          var p = qs.plan;
          var plus = qs.add_on ? " plus " + o.moneyS(qs.add_on.monthly_cents) + " for " + qs.add_on.program : "";
          line = p.billing_frequency === "one_time" ? o.moneyS(p.pif_cents) + " paid in full" + plus
            : (p.down_cents ? o.moneyS(p.down_cents) + " down, then " : "") + o.moneyS(p.recurring_cents)
              + (p.billing_frequency === "weekly" ? " a week" : " a month") + plus + (p.down_cents ? "" : ", nothing down");
          line = c.label + ": " + line + ".";
        } else if (qs && qs.needs_option) line = "Pick their payment option.";
        el.querySelector('[data-f="price"]').textContent = line;
      });
    }

    /* ── what the page asks of it ──────────────────────────────────────── */
    function validate() {
      var ms = members();
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i], el = m.row.el;
        if (!m.first || !m.last) { el.querySelector('[data-f="first"]').focus(); return "Please enter family member " + (i + 2) + "'s name."; }
        if (!m.dob) { el.querySelector('[data-f="dob"]').focus(); return "Please enter family member " + (i + 2) + "'s date of birth."; }
        var qs = Q.data && Q.data.students ? Q.data.students[i + 1] : null;
        if (qs && qs.needs_option && !m.planCode) { el.querySelector('[data-f="plan"]').focus(); return "Please pick a payment option for " + (m.first || "family member " + (i + 2)) + "."; }
      }
      return "";
    }

    /* The cart's lines for everyone added, from the quote. */
    function cartHtml() {
      var q = fresh();
      if (!q || !q.students) return "";
      var ms = members(), h = "";
      ms.forEach(function (m, i) {
        var qs = q.students[i + 1]; if (!qs) return;
        var nm = o.esc(name(m, i));
        if (qs.plan) {
          var p = qs.plan;
          h += '<div class="lkc-line"><span>' + nm + ": " + o.esc(p.name)
            + (p.billing_frequency === "one_time" ? ", paid in full" : (p.down_cents ? ", down payment + first month" : ", first month"))
            + '</span><span class="amt">' + o.money(p.due_today_cents) + "</span></div>";
        } else {
          h += '<div class="lkc-line"><span>' + nm + ": pick a payment option</span><span class=\"amt\">-</span></div>";
        }
        if (qs.add_on) {
          h += '<div class="lkc-line"><span>' + nm + ": " + o.esc(qs.add_on.program) + " added on, first month</span>"
            + '<span class="amt">' + o.money(qs.add_on.monthly_cents) + "</span></div>";
        }
        if (qs.uniform) {
          h += '<div class="lkc-line"><span>' + o.esc(qs.uniform.name) + " (" + nm + (qs.uniform.cents < qs.uniform.full_cents ? ", half off" : "") + ")</span>"
            + '<span class="amt">' + o.money(qs.uniform.cents) + "</span></div>";
        }
      });
      return h;
    }

    /* Everyone's agreements after the first: their own program's document,
       its fee table, their rate marked selected. ctx: { A, guardian, today,
       initials, count } (count: every agreement on the page, theirs included). */
    function docsHtml(ctx) {
      var q = fresh(), h = "";
      members().forEach(function (m, i) {
        var c = m.choice; if (!c) return;
        var tpl = null;
        for (var t = 0; t < ctx.A.TEMPLATES.length; t++) if (ctx.A.TEMPLATES[t].key === c.template_key) tpl = ctx.A.TEMPLATES[t];
        if (!tpl) { h += "<p>The agreement for " + o.esc(c.label) + " could not load. Call us at 903-561-2966.</p>"; return; }
        var qs = q && q.students ? q.students[i + 1] : null;
        var mine = qs && qs.plan ? qs.plan : null;
        if (!mine && m.planCode) for (var k = 0; k < c.options.length; k++) if (c.options[k].code === m.planCode) mine = c.options[k];
        var student = (m.first + " " + m.last).trim() || "____________________";
        var age = ageOn(m.dob);
        var guardian = age !== null && age >= 18 ? "" : ctx.guardian;
        h += '<p class="ttl" style="margin-top:28px">Agreement ' + (i + 2) + " of " + ctx.count + ": " + o.esc(student) + "</p>"
          + '<p class="ent">Grizzly Martial Arts &amp; Fitness LLC<br>doing business as Bares Taekwondo Fitness</p>'
          + '<p class="ttl">' + o.esc(tpl.title).toUpperCase() + "</p>"
          + "<p>Participant (Student) Name: <b>" + o.esc(student) + "</b><br>"
          + "Date of Birth: <b>" + o.esc(fmtMDY(m.dob) || "____________") + "</b><br>"
          + "Parent / Guardian: <b>" + o.esc(guardian) + "</b><br>"
          + "Today's Date: <b>" + o.esc(ctx.today) + "</b><br>"
          + "Membership Start Date: <b>" + o.esc(ctx.today) + "</b></p>"
          + "<h4>FEES</h4>";
        var listed = (c.options || []).slice();
        if (mine && !listed.some(function (x) { return x.code === mine.code; })) listed.push(mine);
        listed.forEach(function (x) {
          var line = x.billing_frequency === "one_time"
            ? o.esc(x.name) + " is a single payment of <b>" + o.money(x.pif_cents) + "</b> for the full twelve (12) month term."
            : o.esc(x.name) + " is a down payment of <b>" + o.money(x.down_cents) + "</b> and a "
              + (x.billing_frequency === "weekly" ? "weekly" : "monthly") + " payment of <b>" + o.money(x.recurring_cents) + "</b>.";
          var sel = mine && mine.code === x.code;
          h += "<p" + (sel ? ' style="background:#FFF6D9;border-radius:6px;padding:4px 6px"' : "") + ">" + line + (sel ? " <b>&larr; selected</b>" : "") + "</p>";
        });
        var add = qs && qs.add_on ? qs.add_on : (c.add_on || null);
        if (add) h += "<p>Add-on: " + o.esc(add.program) + " is " + o.money(add.monthly_cents) + " per month.</p>";
        var payDate = "";
        if (mine) {
          if (mine.billing_frequency === "monthly") payDate = "the " + ordinal(new Date().getDate()) + " of each month";
          else if (mine.billing_frequency === "weekly") payDate = "each " + ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()];
          else payDate = "none (paid in full)";
        }
        h += "<p>Selected option: <b>" + (mine ? o.esc(mine.name) : "____________") + "</b>"
          + "&nbsp;&nbsp;Initials: <b>" + o.esc(ctx.initials) + "</b>"
          + "&nbsp;&nbsp;Payment date: <b>" + (payDate || "____________") + "</b></p>";
        if (add) {
          h += "<p>I am also enrolling in <b>" + o.esc(add.program) + "</b> for <b>" + o.money(add.monthly_cents) + "</b> per month, billed on the agreed"
            + " payment date above under the same payment authorization, and cancellable on the same notice.&nbsp;&nbsp;Initials: <b>"
            + o.esc(ctx.initials) + "</b></p>";
        }
        for (var f = 0; f < tpl.feesTail.length; f++) h += "<p>" + o.esc(tpl.feesTail[f]) + "</p>";
        for (var s = 0; s < tpl.sections.length; s++) {
          h += "<h4>" + o.esc(tpl.sections[s].h) + "</h4>";
          for (var p2 = 0; p2 < tpl.sections[s].p.length; p2++) h += "<p>" + o.esc(tpl.sections[s].p[p2]) + "</p>";
        }
        h += "<p><i>" + o.esc(tpl.signNote) + "</i></p>";
      });
      return h;
    }

    /* The box they tick names every other document they are signing. */
    function consentText(pageTemplateKey, A) {
      var parts = [];
      members().forEach(function (m) {
        var c = m.choice; if (!c || c.template_key === pageTemplateKey) return;
        var title = c.label + " Membership Agreement";
        if (A) for (var t = 0; t < A.TEMPLATES.length; t++) if (A.TEMPLATES[t].key === c.template_key) title = A.TEMPLATES[t].title;
        parts.push("the " + title + " for " + (m.first || "your family member"));
      });
      if (!parts.length) return "";
      return " That includes " + (parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0]) + ", above.";
    }

    /* "Lincoln is enrolled in Juniors, and June in Cubs". */
    function doneHeading(firstName, pageLabel) {
      var groups = [{ label: pageLabel, names: [firstName] }];
      members().forEach(function (m) {
        var label = m.choice ? m.choice.label : pageLabel, nm = m.first || "Your student";
        var g = null;
        for (var k = 0; k < groups.length; k++) if (groups[k].label === label) g = groups[k];
        if (g) g.names.push(nm); else groups.push({ label: label, names: [nm] });
      });
      var list = function (a) { return a.length > 1 ? a.slice(0, -1).join(", ") + " and " + a[a.length - 1] : a[0]; };
      var parts = groups.map(function (g, i) {
        return i === 0 ? list(g.names) + (g.names.length > 1 ? " are" : " is") + " enrolled in " + g.label : list(g.names) + " in " + g.label;
      });
      return parts.length > 1 ? parts.slice(0, -1).join(", ") + ", and " + parts[parts.length - 1] : parts[0];
    }

    function anyMinor() {
      return members().some(function (m) { var a = ageOn(m.dob); return a === null || a < 18; });
    }

    /* What comes out after today, from the quote: everyone's recurring rate
       and every add-on. */
    function afterText() {
      var q = fresh(); if (!q || !q.students) return "";
      var monthly = 0, weekly = 0;
      q.students.forEach(function (s) {
        if (s.plan && s.plan.billing_frequency === "monthly") monthly += s.plan.recurring_cents;
        if (s.plan && s.plan.billing_frequency === "weekly") weekly += s.plan.recurring_cents;
        if (s.add_on) monthly += s.add_on.monthly_cents;
      });
      (q.add_ons || []).forEach(function (a) { monthly += a.monthly_cents; });
      if (!monthly && !weekly) return "Nothing more to pay";
      return "Then " + [monthly ? o.money(monthly) + " monthly" : "", weekly ? o.money(weekly) + " weekly" : ""].filter(Boolean).join(" and ");
    }

    /* The whole cart from the quote, in the page's own rows (every checkout
       page shares their ids). Returns false when there is nothing of ours to
       show yet, so the page draws its single-student cart itself.
         p: { chosen, firstName, shirts: [{ i }] } */
    function renderCart(p) {
      var $ = function (id) { return document.getElementById(id); };
      var show = function (id, on) { var e = $(id); if (e) e.hidden = !on; };
      var set = function (id, t) { var e = $(id); if (e) e.textContent = t; };
      if (!p.chosen) return false;
      var q = fresh();
      if (!q && !rows.length) return false;
      if (!q) {
        // Still asking, or the asking failed: say which, and quote no total.
        show("cbc-r-pick", false);
        if ($("cbc-r-fam")) $("cbc-r-fam").innerHTML = "";
        set("lkc-p-fee", "-");
        set("lkc-p-total", Q.error ? "-" : "…");
        set("cbc-after", Q.error || "Working out your family's price");
        return true;
      }
      var s0 = q.students[0], p1 = s0 && s0.plan;
      if (!p1) return false;
      show("cbc-r-pick", false); show("cbc-r-down", true); show("cbc-r-rec", true);
      var pif = p1.billing_frequency === "one_time";
      var who = rows.length ? ((p.firstName || "First student") + ": ") : "";
      set("cbc-p-down", o.money(pif ? p1.pif_cents : p1.down_cents));
      set("cbc-l-rec", who + (p1.billing_frequency === "weekly" ? "Weekly payment" : "Monthly payment")
        + (p1.code !== p.chosen.code ? " (family rate)" : ""));
      set("cbc-p-rec", o.money(pif ? 0 : p1.recurring_cents));
      var u0 = s0.uniform;
      show("cbc-r-uni", !!u0);
      if (u0 && $("cbc-r-uni")) {
        $("cbc-r-uni").querySelector("span").textContent = u0.name + (u0.cents < u0.full_cents ? " (half off, family)" : "");
        set("cbc-p-uni", o.money(u0.cents));
      }
      if ($("cbc-r-addons")) $("cbc-r-addons").innerHTML = (q.add_ons || []).map(function (a) {
        return '<div class="lkc-line"><span>' + o.esc(a.program) + " (first month)</span>"
          + '<span class="amt">' + o.money(a.monthly_cents) + "</span></div>";
      }).join("");
      if ($("cbc-r-fam")) $("cbc-r-fam").innerHTML = cartHtml();
      (cfg.shirts || []).forEach(function (sh, i) {
        var on = (p.shirts || []).some(function (x) { return String(x.i) === String(i); });
        var row = document.querySelector('[data-row="' + i + '"]');
        if (row) row.hidden = !on;
        var amt = document.querySelector('[data-amt="' + i + '"]');
        if (on && amt) amt.textContent = o.money(sh.cents);
      });
      if (!q.complete) {
        show("cbc-r-tax", false);
        set("lkc-p-fee", "-"); set("lkc-p-total", "-");
        set("cbc-after", "Pick a payment option for each family member");
        return true;
      }
      show("cbc-r-tax", q.tax_cents > 0);
      if (q.tax_cents > 0) set("cbc-p-tax", o.money(q.tax_cents));
      set("lkc-p-fee", o.money(q.fee_cents));
      set("lkc-p-total", o.money(q.total_cents));
      set("cbc-after", afterText());
      return true;
    }

    o.addBtn.addEventListener("click", add);
    o.root.hidden = !choices.length;
    relabel();

    return {
      count: function () { return rows.length; },
      payload: payload, uniforms: uniforms, validate: validate,
      requestQuote: requestQuote, quote: fresh,
      state: function () { return { pending: Q.pending, error: Q.error }; },
      cartHtml: cartHtml, renderCart: renderCart, docsHtml: docsHtml, consentText: consentText,
      doneHeading: doneHeading, anyMinor: anyMinor, afterText: afterText,
      names: function () { return members().map(function (m, i) { return name(m, i); }); },
    };
  }

  window.BTKDFamily = { create: create };
})();
