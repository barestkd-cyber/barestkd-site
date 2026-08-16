/* ============================================================================
 * BaresTKD — household membership pricing engine
 * ----------------------------------------------------------------------------
 * PURE CALCULATOR. No database calls, no DOM, no dependencies. Every input
 * arrives as an argument so the same code runs in the browser (window.BTKDPricing)
 * and in Node (module.exports) for tests.
 *
 * ALL MONEY IS INTEGER CENTS.
 *
 * Main entry:
 *   calculatePrice({ plan, settings, person, householdMembers, plans })
 *
 *   plan             a pricing_plans row (the plan being quoted)
 *   settings         map of pricing_settings — accepts { key: cents } or
 *                    { key: { value_cents } } or an array of rows
 *   person           { contact_id, activeMemberships: [...] }
 *   householdMembers [{ contact_id, activeMemberships: [...] }] for every OTHER
 *                    contact in the household (the person is excluded)
 *   plans            OPTIONAL full pricing_plans catalog. When supplied the
 *                    engine can resolve substitutions (family-position plans,
 *                    add-on -> standalone, weekly bundles) to real rows. Without
 *                    it, canonical fallback amounts are used.
 *
 * A membership passed in looks like:
 *   { plan_code, category, status, started_on, billing_frequency? }
 * ========================================================================== */
// GENERATED from pricing.js by tools/gen-esm-pricing.js — DO NOT EDIT.
// tests/pos-flow.test.js fails if this file drifts from pricing.js.
const BTKDPricing = (function () {
  'use strict';

  // ─── constants ────────────────────────────────────────────────────────────

  // Canonical family-position amounts, used when no `plans` catalog is passed.
  var FAMILY_FALLBACK = {
    2: { code: 'tkd_family_second',     name: 'Taekwondo — 2nd family member',  recurring_cents: 11900, down_cents: 0 },
    3: { code: 'tkd_family_third_plus', name: 'Taekwondo — 3rd+ family member', recurring_cents: 7900,  down_cents: 0 }
  };

  // add-on  ->  standalone equivalent (person has no core TKD of their own)
  var ADDON_TO_STANDALONE = {
    addon_kickboxing: 'specialty_kickboxing',
    addon_jiujitsu:   'specialty_jiujitsu',
    addon_both:       'specialty_both'
  };

  // standalone -> member add-on rate (person HOLDS their own monthly core TKD).
  // The mirror of ADDON_TO_STANDALONE: "add-on" is a RATE, not a product, so
  // selling the program to an existing Taekwondo member must find this rate on
  // its own. sql/membership-programs.sql marks these rows sellable=false for
  // exactly that reason — the UI never pitches them directly.
  var STANDALONE_TO_ADDON = {
    specialty_kickboxing: 'addon_kickboxing',
    specialty_jiujitsu:   'addon_jiujitsu',
    specialty_both:       'addon_both'
  };

  // one specialty vs both -> the weekly bundle that replaces weekly TKD
  var TO_BUNDLE = {
    addon_kickboxing:     'bundle_tkd_one_specialty',
    addon_jiujitsu:       'bundle_tkd_one_specialty',
    addon_both:           'bundle_tkd_both_specialties',
    specialty_kickboxing: 'bundle_tkd_one_specialty',
    specialty_jiujitsu:   'bundle_tkd_one_specialty',
    specialty_both:       'bundle_tkd_both_specialties'
  };

  // A family-position plan is data-marked (family_position) or code-marked
  // (juniors_family_second, adults_family_third_plus, legacy tkd_family_*).
  function isFamilyPlan(p) {
    return !!p && (p.family_position != null || /_family_(second|third_plus)$/.test(p.code || ''));
  }

  /* Family rates are per program (juniors_family_second vs adults_family_second).
   * Prefer the row matching the requested plan's program; fall back to any
   * core-TKD row carrying that family_position. */
  function findFamilyPlanFor(plans, pos, program) {
    if (!plans) return null;
    var list = Array.isArray(plans) ? plans : Object.keys(plans).map(function (k) { return plans[k]; });
    var any = null;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || p.category !== 'core_tkd' || p.family_position !== pos) continue;
      if (program != null && p.program === program) return p;
      if (!any) any = p;
    }
    return any;
  }

  // ─── small helpers ────────────────────────────────────────────────────────

  function centsToDollars(c) {
    var n = (c || 0) / 100;
    return '$' + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');
  }

  function readSettings(settings) {
    var out = {};
    if (!settings) return out;
    if (Array.isArray(settings)) {
      settings.forEach(function (r) { if (r && r.key != null) out[r.key] = Number(r.value_cents) || 0; });
      return out;
    }
    Object.keys(settings).forEach(function (k) {
      var v = settings[k];
      out[k] = (v && typeof v === 'object') ? (Number(v.value_cents) || 0) : (Number(v) || 0);
    });
    return out;
  }

  /* A membership only "qualifies" (for household rank and eligibility) when its
   * status is exactly 'active'. trial / complimentary / paused / canceled /
   * ended never count.
   *
   * ASSUMPTION (flagged to the owner): the spec says "Drop-ins (one_time) never
   * count", so ALL one_time billing is excluded here — which also excludes the
   * paid-in-full plans (tkd_pif, cubs_pif). If a PIF sibling should trigger
   * family pricing, remove the one_time test below. */
  function isQualifying(m) {
    if (!m || m.status !== 'active') return false;
    if (m.billing_frequency === 'one_time') return false;
    if (m.plan_code === 'specialty_dropin') return false;
    if (m.plan_code === 'tkd_pif' || m.plan_code === 'cubs_pif') return false;
    return true;
  }

  function qualifying(list) { return (list || []).filter(isQualifying); }

  function earliestStart(list) {
    var q = qualifying(list);
    if (!q.length) return null;
    return q.map(function (m) { return m.started_on; })
            .filter(Boolean)
            .sort()[0] || null;
  }

  function findPlan(plans, code) {
    if (!plans || !code) return null;
    for (var i = 0; i < plans.length; i++) if (plans[i] && plans[i].code === code) return plans[i];
    return null;
  }

  // ─── household rank ───────────────────────────────────────────────────────

  /* Order every household contact holding >=1 qualifying membership by their
   * earliest qualifying started_on (tie-break contact_id for determinism).
   * Rank 1 is the founding member.
   *
   * Returns { rank, rankedCount, prospective } where `rank` is the person's
   * actual position if they already hold a qualifying membership, otherwise
   * their prospective rank (rankedCount + 1). */
  function householdRank(person, householdMembers) {
    // A contact is ranked only if they hold at least one qualifying membership.
    var others = (householdMembers || [])
      .filter(function (h) { return qualifying(h.activeMemberships).length > 0; })
      .map(function (h) { return { contact_id: h.contact_id, start: earliestStart(h.activeMemberships) }; });

    var personQualifies = qualifying(person && person.activeMemberships).length > 0;
    var rows = others.slice();
    if (personQualifies) {
      rows.push({ contact_id: person.contact_id, start: earliestStart(person.activeMemberships), isPerson: true });
    }

    rows.sort(function (a, b) {
      var as = a.start || '9999-12-31', bs = b.start || '9999-12-31';
      if (as !== bs) return as < bs ? -1 : 1;
      return String(a.contact_id) < String(b.contact_id) ? -1 : 1;
    });

    if (personQualifies) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].isPerson) return { rank: i + 1, rankedCount: rows.length, prospective: false };
      }
    }
    return { rank: rows.length + 1, rankedCount: rows.length, prospective: true };
  }

  // ─── core TKD family position ─────────────────────────────────────────────

  function coreTkdCount(list) {
    return qualifying(list).filter(function (m) { return m.category === 'core_tkd'; }).length;
  }

  /* Position is driven by how many OTHER household members hold active core TKD:
   * 0 others -> 1 (regular individual option), 1 other -> 2, 2+ others -> 3. */
  function familyPosition(householdMembers) {
    var others = (householdMembers || []).reduce(function (n, h) {
      return n + (coreTkdCount(h.activeMemberships) > 0 ? 1 : 0);
    }, 0);
    if (others === 0) return 1;
    if (others === 1) return 2;
    return 3;
  }

  function personHoldsCoreTkd(person) {
    return coreTkdCount(person && person.activeMemberships) > 0;
  }

  function personCoreTkdIsWeekly(person) {
    // Program-split catalog: weekly core TKD is any core_tkd row billed weekly
    // (juniors_weekly, adults_weekly, legacy tkd_weekly). Prefer the explicit
    // billing_frequency when the caller supplies it; fall back to the code.
    return qualifying(person && person.activeMemberships).some(function (m) {
      return m.category === 'core_tkd' &&
        (m.billing_frequency === 'weekly' || /(^|_)weekly$/.test(m.plan_code || ''));
    });
  }

  // ─── plan resolution (substitutions) ──────────────────────────────────────

  /* Decides which plan is actually quoted. Returns
   * { plan, substituted, substitutionNote, eligible, eligibilityReason }. */
  function resolvePlan(requested, person, householdMembers, plans) {
    var out = {
      plan: requested,
      substituted: false,
      substitutionNote: '',
      eligible: true,
      eligibilityReason: ''
    };
    if (!requested) { out.eligible = false; out.eligibilityReason = 'No plan supplied.'; return out; }

    var cat = requested.category;
    var holdsCore = personHoldsCoreTkd(person);
    var coreIsWeekly = personCoreTkdIsWeekly(person);

    // ── add-ons: require the person's OWN active core TKD ──
    if (cat === 'addon') {
      if (!holdsCore) {
        // A parent whose child has TKD does not qualify -> standalone specialty.
        var standalone = findPlan(plans, ADDON_TO_STANDALONE[requested.code]);
        if (standalone) {
          out.plan = standalone;
          out.substituted = true;
          out.substitutionNote = 'No active Taekwondo membership of their own, so standalone pricing applies.';
        } else {
          out.eligible = false;
          out.eligibilityReason = 'Add-on pricing requires the person to hold an active Taekwondo membership.';
        }
        return out;
      }
      if (coreIsWeekly) {
        // Weekly TKD: the bundle price REPLACES the weekly TKD price.
        var bundle = findPlan(plans, TO_BUNDLE[requested.code]);
        if (bundle) {
          out.plan = bundle;
          out.substituted = true;
          out.substitutionNote = 'Weekly Taekwondo member, so the weekly bundle price replaces the weekly Taekwondo price.';
        }
        return out;
      }
      return out; // monthly TKD member, add-on stands
    }

    // ── standalone specialty sold to someone who holds their own core TKD ──
    if (cat === 'specialty' && requested.billing_frequency === 'monthly' && holdsCore) {
      if (coreIsWeekly) {
        // Weekly TKD: the bundle price REPLACES the weekly TKD price.
        var b2 = findPlan(plans, TO_BUNDLE[requested.code]);
        if (b2) {
          out.plan = b2;
          out.substituted = true;
          out.substitutionNote = 'Weekly Taekwondo member, so the weekly bundle price replaces the weekly Taekwondo price.';
        }
        return out;
      }
      // Monthly TKD: the member add-on RATE applies instead of standalone.
      var mem = findPlan(plans, STANDALONE_TO_ADDON[requested.code]);
      if (mem) {
        out.plan = mem;
        out.substituted = true;
        out.substitutionNote = 'Active Taekwondo member, so the member add-on rate applies.';
      }
      return out;
    }

    // ── weekly bundles: only valid for a weekly TKD member ──
    if (cat === 'weekly_bundle') {
      if (!holdsCore || !coreIsWeekly) {
        out.eligible = false;
        out.eligibilityReason = 'Weekly bundles require an active weekly Taekwondo membership.';
      }
      return out;
    }

    // ── core TKD: apply family position ──
    if (cat === 'core_tkd') {
      // An explicitly chosen family plan is respected as-is.
      if (isFamilyPlan(requested)) return out;
      // Family positions are monthly-only in the catalog; weekly/PIF core plans
      // are left alone (ASSUMPTION, flagged).
      if (requested.billing_frequency !== 'monthly') return out;

      var pos = familyPosition(householdMembers);
      if (pos >= 2) {
        var key = pos >= 3 ? 3 : 2;
        var famPlan = findFamilyPlanFor(plans, key, requested.program) ||
                      findPlan(plans, FAMILY_FALLBACK[key].code) || FAMILY_FALLBACK[key];
        out.plan = famPlan;
        out.substituted = true;
        out.substitutionNote = (pos === 2 ? 'Second' : 'Third+') + ' Taekwondo member in the household.';
      }
      return out;
    }

    return out;
  }

  // ─── the calculation ──────────────────────────────────────────────────────

  function calculatePrice(args) {
    args = args || {};
    var requested = args.plan;
    var settings = readSettings(args.settings);
    var person = args.person || { contact_id: null, activeMemberships: [] };
    var householdMembers = args.householdMembers || [];
    var plans = args.plans || null;

    var res = resolvePlan(requested, person, householdMembers, plans);
    var plan = res.plan || {};

    var isOneTime = plan.billing_frequency === 'one_time';
    var baseCents = isOneTime ? (Number(plan.pif_cents) || 0) : (Number(plan.recurring_cents) || 0);
    var downCents = Number(plan.down_cents) || 0;
    var paymentCount = plan.payment_count != null ? plan.payment_count : null;

    var adjustments = [];

    /* Household discount. Applies only when:
     *   - the plan supports it (specialty + add-on categories in the catalog),
     *   - billing is monthly,
     *   - the person's household rank is 2 or higher (the founding member never
     *     receives it).
     * Flat, once per person. Never stacks, never scales with family size, and
     * never touches core TKD, Cubs, weekly bundles, drop-ins, or AMP'D — those
     * all carry supports_household_discount = false.
     *
     * Family-position pricing never combines with it: a substituted family plan
     * is a core_tkd row, which does not support the discount. */
    var rankInfo = householdRank(person, householdMembers);
    if (plan.supports_household_discount === true && plan.billing_frequency === 'monthly' && rankInfo.rank >= 2) {
      var amt = settings.household_specialty_discount_cents || 0;
      if (amt > 0) {
        adjustments.push({
          code: 'household_specialty_discount',
          label: 'Household discount',
          amountCents: -amt
        });
      }
    }

    // Weekly bundles use their own household setting (currently 0 = off).
    if (plan.category === 'weekly_bundle' && rankInfo.rank >= 2) {
      var wAmt = settings.weekly_household_discount_cents || 0;
      if (wAmt > 0) {
        adjustments.push({
          code: 'weekly_household_discount',
          label: 'Household discount (weekly)',
          amountCents: -wAmt
        });
      }
    }

    var adjTotal = adjustments.reduce(function (n, a) { return n + a.amountCents; }, 0);
    var finalRecurringCents = Math.max(0, baseCents + adjTotal);
    var finalDownCents = Math.max(0, downCents);

    // ── explanation sentence ──
    var freqWord = plan.billing_frequency === 'monthly' ? '/month'
                 : plan.billing_frequency === 'weekly'  ? '/week'
                 : ' one time';
    var parts = [(plan.name || plan.code || 'Plan') + ' ' + centsToDollars(baseCents) + freqWord];
    if (finalDownCents > 0) parts.push(centsToDollars(finalDownCents) + ' down');
    adjustments.forEach(function (a) {
      parts.push(a.label.toLowerCase() + ' -' + centsToDollars(Math.abs(a.amountCents)));
    });
    if (adjustments.length) parts.push('final ' + centsToDollars(finalRecurringCents) + freqWord);
    if (res.substituted && res.substitutionNote) parts.push(res.substitutionNote);
    var explanation = parts.join(', ').replace(/, ([A-Z])/g, '. $1');

    return {
      planCode: plan.code || null,
      planName: plan.name || null,
      billingFrequency: plan.billing_frequency || null,
      baseCents: baseCents,
      downCents: downCents,
      paymentCount: paymentCount,
      adjustments: adjustments,
      finalRecurringCents: finalRecurringCents,
      finalDownCents: finalDownCents,
      explanation: explanation,
      pricingVersion: (plan.effective_date || 'unversioned') + ':' + (plan.code || 'unknown'),
      // ── additive fields the UI needs (not part of the required shape) ──
      planId: plan.id || null,
      program: plan.program || null,
      category: plan.category || null,
      promoLabel: plan.promo_label || null,
      householdRank: rankInfo.rank,
      householdRankedCount: rankInfo.rankedCount,
      familyPosition: plan.category === 'core_tkd' ? familyPosition(householdMembers) : null,
      substituted: res.substituted,
      substitutionNote: res.substitutionNote,
      eligible: res.eligible,
      eligibilityReason: res.eligibilityReason
    };
  }

  /* Builds the memberships row from a calculation result. The snapshot is taken
   * ONCE at creation and never re-derived — a later price change to the
   * pricing_plans catalog must not alter an existing membership. */
  function buildMembershipSnapshot(opts) {
    opts = opts || {};
    var calc = opts.calc || {};
    var override = opts.override || null;

    var row = {
      contact_id: opts.contactId || null,
      plan_id: calc.planId || null,
      plan_code: calc.planCode || null,
      program: opts.program != null ? opts.program : (calc.program || null),
      status: opts.status || 'active',
      billing_frequency: calc.billingFrequency || null,
      started_on: opts.startedOn || null,
      base_cents: calc.baseCents,
      down_cents: calc.downCents,
      adjustments: (calc.adjustments || []).slice(),
      final_recurring_cents: calc.finalRecurringCents,
      final_down_cents: calc.finalDownCents,
      explanation: calc.explanation || null,
      pricing_version: calc.pricingVersion || null,
      recommended_cents: calc.finalRecurringCents,
      created_by: opts.createdBy || null
    };

    if (override && override.active) {
      row.final_recurring_cents = Number(override.recurringCents);
      if (override.downCents != null) row.final_down_cents = Number(override.downCents);
      row.override_reason = override.reason || null;
      row.override_by = override.by || null;
      row.override_at = override.at || null;
      // recommended_cents keeps the engine's recommendation for comparison
    }
    return row;
  }

  /* ─── invoice math ─────────────────────────────────────────────────────────
   * The POS invoice's money, in one tested place. Integer cents in, integer
   * cents out; the UI formats dollars but never does arithmetic.
   */

  // Half-up rounding on a non-negative float that is conceptually cents.
  function roundHalfUpCents(x) { return Math.floor(x + 0.5); }

  /* Split `total` integer cents across `weights` pro-rata, largest-remainder,
   * so the parts always sum to exactly `total`. Zero/empty weights → zeros.
   * Used for the invoice discount, and by the UI to show per-line tax that
   * reconciles to the stored invoice-level tax figure. */
  function allocateCents(total, weights) {
    total = Math.max(Math.round(Number(total) || 0), 0);
    var w = (weights || []).map(function (x) { return Math.max(Math.round(Number(x) || 0), 0); });
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    var out = w.map(function () { return 0; });
    if (!total || !sum) return out;
    var exact = w.map(function (x) { return total * x / sum; });
    var floors = exact.map(Math.floor);
    var used = floors.reduce(function (a, b) { return a + b; }, 0);
    var rem = total - used;
    var order = exact.map(function (e, i) { return { i: i, frac: e - floors[i] }; })
      .sort(function (a, b) { return b.frac - a.frac || a.i - b.i; });
    out = floors;
    for (var k = 0; k < rem; k++) out[order[k % order.length].i] += 1;
    return out;
  }

  /* What one membership line costs TODAY. Recurring plans owe the down payment
   * plus the first payment; a one_time plan owes its full amount PLUS any down
   * payment on the row. (No seeded one_time plan carries a down payment today,
   * but the snapshot writes final_down_cents regardless — due-today must agree
   * with the snapshot, not quietly drop the down.) An override replaces the
   * engine's numbers, not the shape. */
  function dueTodayCents(calc, override) {
    if (!calc) return 0;
    var rec  = override ? Number(override.recurringCents) : calc.finalRecurringCents;
    var down = (override && override.downCents != null) ? Number(override.downCents) : calc.finalDownCents;
    return (rec || 0) + (down || 0);
  }

  /* Totals for a whole invoice.
   *
   *   invoiceTotals({
   *     lines:         [{ cents, taxable }],   net per-line integer cents
   *     discountCents: invoice-level discount (integer cents, >= 0)
   *     adminFeeCents: integer cents, >= 0 (never taxed — flagged to the
   *                    owner's accountant; change here if that ruling changes)
   *     taxRate:       e.g. 0.0825
   *   })
   *
   * The invoice discount reduces the TAX BASE: it is allocated across all
   * lines pro-rata by amount (largest-remainder so the allocations sum exactly),
   * and taxable lines are taxed on what the customer actually paid after their
   * share of the discount. Tax rounds half-up once, on the total base.
   */
  function invoiceTotals(opts) {
    opts = opts || {};
    var lines = (opts.lines || []).map(function (l) {
      var c = Math.round(Number(l.cents) || 0);
      return { cents: c < 0 ? 0 : c, taxable: !!l.taxable };
    });
    var subtotal = lines.reduce(function (a, l) { return a + l.cents; }, 0);
    var discount = Math.min(Math.max(Math.round(Number(opts.discountCents) || 0), 0), subtotal);
    var adminFee = Math.max(Math.round(Number(opts.adminFeeCents) || 0), 0);
    var taxRate  = Number(opts.taxRate) || 0;

    var allocations = allocateCents(discount, lines.map(function (l) { return l.cents; }));

    var taxBase = 0;
    lines.forEach(function (l, i) { if (l.taxable) taxBase += l.cents - allocations[i]; });
    var tax = roundHalfUpCents(taxBase * taxRate);
    var total = subtotal - discount + adminFee + tax;

    return {
      subtotalCents: subtotal,
      discountCents: discount,
      adminFeeCents: adminFee,
      taxBaseCents: taxBase,
      taxCents: tax,
      totalCents: total,
      discountAllocationCents: allocations
    };
  }

  return {
    calculatePrice: calculatePrice,
    buildMembershipSnapshot: buildMembershipSnapshot,
    dueTodayCents: dueTodayCents,
    invoiceTotals: invoiceTotals,
    allocateCents: allocateCents,
    // exposed for the UI and for tests
    householdRank: householdRank,
    familyPosition: familyPosition,
    isQualifying: isQualifying,
    centsToDollars: centsToDollars,
    isFamilyPlan: isFamilyPlan,
    ADDON_TO_STANDALONE: ADDON_TO_STANDALONE,
    STANDALONE_TO_ADDON: STANDALONE_TO_ADDON,
    TO_BUNDLE: TO_BUNDLE
  };
})();
export default BTKDPricing;
