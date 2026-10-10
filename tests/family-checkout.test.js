/* ============================================================================
 * program-checkout - a family on one checkout
 * ----------------------------------------------------------------------------
 *     node tests/family-checkout.test.js
 *
 * The REAL handler against a fake database and a fake Stripe. Never contacts
 * a network.
 *
 * Owner, 2026-10-10: "add a second family member option to the checkout
 * pages" and "if you wanted to register 2 in one go that should be doable".
 * The till has priced a family's second Taekwondo student at $119 and a
 * third at $79 since the catalog was split; the page quoted every student
 * the first-student rate.
 * ========================================================================== */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');

const SITE = path.join(__dirname, '..');
const FN = path.join(SITE, 'supabase', 'functions');
const SRC = stripTypeScriptTypes(
  fs.readFileSync(path.join(FN, 'program-checkout', 'index.ts'), 'utf8').replace(/^import .*;\r?\n/gm, ''));

function loadDefault(file) {
  const ctx = vm.createContext({});
  vm.runInContext('var __out;' + fs.readFileSync(file, 'utf8').replace(/export default/, '__out ='), ctx);
  return ctx.__out;
}
const BTKDPricing = loadDefault(path.join(FN, '_shared', 'pricing_esm.js'));
const TEMPLATES = {
  TAEKWONDO_TEMPLATE: loadDefault(path.join(FN, '_shared', 'taekwondo_agreement.js')),
  KICKBOXING_TEMPLATE: loadDefault(path.join(FN, '_shared', 'kickboxing_agreement.js')),
  JIUJITSU_TEMPLATE: loadDefault(path.join(FN, '_shared', 'jiujitsu_agreement.js')),
  AMPD_TEMPLATE: loadDefault(path.join(FN, '_shared', 'ampd_agreement.js')),
};

// ── the catalog, as the live one reads for Juniors and AMP'D ─────────────────
const plan = (code, name, program, category, freq, rec, down, pif, extra) => ({
  id: 'plan-' + code, code, name, program, category, billing_frequency: freq,
  recurring_cents: rec, down_cents: down, pif_cents: pif, payment_count: freq === 'monthly' ? 12 : null,
  promo_label: null, sellable: true, active: true, display_order: 1, family_position: null,
  supports_household_discount: false, ...extra,
});
const PLANS = [
  plan('juniors_pif', 'Juniors Taekwondo — Paid in Full', 'Juniors', 'core_tkd', 'one_time', null, 0, 140000),
  plan('juniors_option_c', 'Juniors Taekwondo — Option C', 'Juniors', 'core_tkd', 'monthly', 11000, 25900, null),
  plan('juniors_option_d', 'Juniors Taekwondo — Option D', 'Juniors', 'core_tkd', 'monthly', 12900, 12900, null),
  plan('juniors_weekly', 'Juniors Taekwondo — Weekly', 'Juniors', 'core_tkd', 'weekly', 3395, 0, null),
  plan('juniors_family_second', 'Juniors Taekwondo — 2nd family member', 'Juniors', 'core_tkd', 'monthly', 11900, 0, null,
    { sellable: false, family_position: 2 }),
  plan('juniors_family_third_plus', 'Juniors Taekwondo — 3rd+ family member', 'Juniors', 'core_tkd', 'monthly', 7900, 0, null,
    { sellable: false, family_position: 3 }),
  plan('juniors_oneclass', 'One class a week, first student', 'Juniors', 'core_tkd', 'monthly', 10900, 0, null),
  plan('ampd_member', "AMP'D", "AMP'D", 'specialty', 'monthly', 5000, 0, null),
];

function store(over) {
  return {
    pricing_plans: PLANS.map((p) => ({ ...p })),
    checkout_pages: [], products: [], schedule_template: [],
    pricing_settings: [{ key: 'admin_fee_bps', value_cents: 290 }, { key: 'admin_fee_flat_cents', value_cents: 30 }],
    contacts: [], guardians: [], guardian_emails: [], student_guardians: [], student_contacts: [],
    memberships: [], membership_agreements: [], enrollments: [], pos_sales: [], pos_sale_lines: [], pos_payments: [],
    ...over,
  };
}

// Just enough of supabase-js for the calls the handler makes.
function db(s) {
  let seq = 0;
  return {
    from(table) {
      const eqs = {}, ins = {}, likes = {}, isNull = {}; let insert, update, single = false;
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; }, not() { return q; }, or() { return q; },
        eq(k, v) { eqs[k] = v; return q; }, in(k, v) { ins[k] = v; return q; },
        ilike(k, v) { likes[k] = String(v).toLowerCase(); return q; },
        is(k, v) { isNull[k] = v; return q; },
        maybeSingle() { single = true; return q; }, single() { single = true; return q; },
        insert(v) { insert = v; return q; }, update(v) { update = v; return q; },
        then(resolve, reject) {
          const rows = s[table] || (s[table] = []);
          if (insert) {
            const add = (Array.isArray(insert) ? insert : [insert]).map((r) => ({
              id: table + '-' + (++seq), view_token: table === 'pos_sales' ? 'tok-' + seq : undefined, ...r }));
            rows.push(...add);
            return Promise.resolve({ data: single ? add[0] : add, error: null }).then(resolve, reject);
          }
          const match = (r) => Object.entries(eqs).every(([k, v]) => r[k] === v)
            && Object.entries(ins).every(([k, v]) => v.includes(r[k]))
            && Object.entries(likes).every(([k, v]) => String(r[k] ?? '').toLowerCase() === v)
            && Object.entries(isNull).every(([k, v]) => (r[k] ?? null) === v);
          const hit = rows.filter(match);
          if (update) { hit.forEach((r) => Object.assign(r, update)); return Promise.resolve({ data: hit, error: null }).then(resolve, reject); }
          const data = single ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r }));
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const STRIPE_CALLS = [];
async function call(s, slug, method, body, query) {
  let handler;
  STRIPE_CALLS.length = 0;
  const ctx = vm.createContext({
    createClient: () => db(s),
    BTKDPricing, ...TEMPLATES,
    // _shared/family.ts, as far as this handler uses it.
    findOrCreateGuardian: async (admin, a) => {
      s.student_guardians.push({ id: 'sg-' + s.student_guardians.length, student_id: a.studentId, guardian_id: 'g-' + a.email, email: a.email, label: a.label });
      return 'g-' + a.email;
    },
    familyCustomer: async () => ({ custId: 'cus_test', ownerKind: 'guardian', guardianId: 'g-test' }),
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes('api.stripe.com')) {
        STRIPE_CALLS.push({ url: u, body: String(init && init.body || '') });
        return { ok: true, json: async () => ({ id: 'pi_test', client_secret: 'cs_test', status: 'requires_payment_method' }) };
      }
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' };
    },
    Deno: { serve: (fn) => { handler = fn; }, env: { get: (k) => ({
      SUPABASE_URL: 'https://t.invalid', SUPABASE_SERVICE_ROLE_KEY: 'svc',
      STRIPE_SECRET_KEY: 'sk_test', STRIPE_PUBLISHABLE_KEY: 'pk_test' })[k] } },
    URL, URLSearchParams, Response, Request, console: { log() {}, error() {} },
    crypto: nodeCrypto.webcrypto, Date, Math, JSON, Object, Array, String, Number, Set, Map, isFinite, Promise,
  });
  vm.runInContext(SRC, ctx);
  const res = await handler(new Request('https://t.invalid/program-checkout?p=' + slug + (query || ''), {
    method, headers: { 'Content-Type': 'application/json', Origin: 'https://www.barestkd.fit' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}

const SALE = '11111111-1111-4111-8111-111111111111';
const SIG = 'data:image/png;base64,' + 'A'.repeat(300);
const parent = {
  parent_first: 'Katie', parent_last: 'Root', email: 'katie@example.com', phone: '903-555-0100',
  address: '1 Main St, Tyler, TX 75703', initials: 'KR', signer_name: 'Katie Root', signer_relationship: 'Parent',
  signature_png: SIG, agreed: true, hp: '',
};
const enroll = (over) => ({ sale_id: SALE, plan_code: 'juniors_option_c', ...parent, ...over });
const fee = (c) => BTKDPricing.cardFeeCents(c, 290, 30);

// A family that already pays for one Taekwondo student, paid in full.
function withSibling() {
  return store({
    contacts: [{ id: 'samuel', first_name: 'Samuel', last_name: 'Root', email: null }],
    guardian_emails: [{ guardian_id: 'g-mom', email: 'katie@example.com' }],
    student_guardians: [{ id: 'sg-0', student_id: 'samuel', guardian_id: 'g-mom', email: 'katie@example.com', label: 'parent' }],
    memberships: [{ id: 'm-samuel', contact_id: 'samuel', plan_code: 'juniors_pif', program: 'Juniors',
      billing_frequency: 'one_time', status: 'active', started_on: '2026-05-13' }],
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the page is told the family rates, and they are not sold as options', async () => {
  const r = await call(store(), 'juniors', 'GET');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.family_rates.map((f) => [f.position, f.code, f.recurring_cents, f.down_cents, f.due_today_cents]),
    [[2, 'juniors_family_second', 11900, 0, 11900], [3, 'juniors_family_third_plus', 7900, 0, 7900]]);
  assert.ok(!r.body.options.some((o) => /family/.test(o.code)), 'a family rate is pickable as an option');
  assert.deepEqual((await call(store(), 'ampd', 'GET')).body.family_rates, [], "AMP'D has no family rate");
});

test('an email that already pays for a Taekwondo student is told where a new one lands', async () => {
  const r = await call(withSibling(), 'juniors', 'GET', null, '&family_email=Katie%40Example.com');
  assert.deepEqual(r.body, { position: 2, found: 1 });
  const none = await call(store(), 'juniors', 'GET', null, '&family_email=nobody%40example.com');
  assert.deepEqual(none.body, { position: 1, found: 0 });
});

test('two students on one checkout: the first at their option, the second at the family rate', async () => {
  const s = store();
  const r = await call(s, 'juniors', 'POST', enroll({
    students: [{ first: 'Liam', last: 'Le', dob: '2020-03-04' }, { first: 'Tammy', last: 'Le', dob: '2021-06-07' }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(s.contacts.length, 2);
  assert.deepEqual(s.memberships.map((m) => [m.contact_id, m.plan_code, m.final_down_cents, m.final_recurring_cents, m.status]),
    [['contacts-1', 'juniors_option_c', 25900, 11000, 'pending'], ['contacts-2', 'juniors_family_second', 0, 11900, 'pending']]);
  // One agreement per student, each naming its own student and its own rate.
  assert.equal(s.membership_agreements.length, 2);
  const [a1, a2] = s.membership_agreements;
  assert.ok(a1.body_text.includes('Participant (Student) Name: Liam Le') && a1.body_text.includes('Selected option: Juniors Taekwondo — Option C'));
  assert.ok(a2.body_text.includes('Participant (Student) Name: Tammy Le'), 'the second agreement names the first student');
  assert.ok(a2.body_text.includes('Juniors Taekwondo — 2nd family member is a down payment of $0.00 and a monthly payment of $119.00.'),
    'the second agreement does not price the family rate');
  assert.ok(a2.body_text.includes('Selected option: Juniors Taekwondo — 2nd family member'));
  assert.equal(a2.body_json.family_position, 2);
  assert.ok(s.membership_agreements.every((a) => a.signature_png === SIG && a.signer_name === 'Katie Root'));
  // One invoice, a line per student, one charge for the lot.
  const lines = s.pos_sale_lines.filter((l) => l.kind === 'mem');
  assert.deepEqual(lines.map((l) => [l.label, l.line_total_cents, l.student_contact_id]),
    [['Juniors Taekwondo — Option C', 36900, 'contacts-1'], ['Juniors Taekwondo — 2nd family member', 11900, 'contacts-2']]);
  const sale = s.pos_sales[0];
  assert.equal(sale.total_cents, 48800 + fee(48800));
  assert.equal(r.body.total_cents, sale.total_cents);
  assert.ok(/Liam and Tammy are enrolled/.test(sale.customer_note), sale.customer_note);
  assert.ok(/Tammy's monthly payment is \$119\.00/.test(sale.customer_note), sale.customer_note);
  assert.ok(/Tammy Le: Juniors Taekwondo — 2nd family member/.test(sale.notes), sale.notes);
  assert.equal(s.enrollments.length, 2, 'a roster place per student');
  assert.equal(s.student_guardians.filter((g) => g.email === 'katie@example.com').length, 2, 'the parent is linked to both');
  assert.ok(STRIPE_CALLS[0].body.includes(encodeURIComponent('Liam Le, Tammy Le').replace(/%20/g, '+')) || /Liam\+Le/.test(STRIPE_CALLS[0].body),
    'the charge does not name both students: ' + STRIPE_CALLS[0].body);
});

test('a sibling of a current student is priced as the second family member on their own', async () => {
  const s = withSibling();
  const r = await call(s, 'juniors', 'POST', enroll({
    plan_code: 'juniors_option_d',
    student_first: 'Katie', student_last: 'Root', student_dob: '1990-01-01',
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const m = s.memberships.find((x) => x.plan_code !== 'juniors_pif');
  assert.equal(m.plan_code, 'juniors_family_second', 'the sibling was charged the first-student rate');
  assert.equal(m.final_recurring_cents, 11900);
  assert.equal(m.final_down_cents, 0);
  assert.equal(s.pos_sales[0].total_cents, 11900 + fee(11900));
  const a = s.membership_agreements[0];
  assert.ok(a.body_text.includes('Selected option: Juniors Taekwondo — 2nd family member'), a.body_text.slice(0, 600));
});

test('a third student lands on the third-and-beyond rate', async () => {
  const s = withSibling();
  const r = await call(s, 'juniors', 'POST', enroll({
    plan_code: 'juniors_pif',
    students: [{ first: 'Ava', last: 'Root', dob: '2018-01-01' }, { first: 'Ben', last: 'Root', dob: '2019-01-01' }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const codes = s.memberships.filter((x) => x.contact_id !== 'samuel').map((x) => [x.plan_code, x.final_recurring_cents]);
  // Paid in full is left alone (the engine never swaps a one-time plan); the
  // next student is the household's third Taekwondo student.
  // A paid-in-full plan carries its one payment as its recurring figure.
  assert.deepEqual(codes, [['juniors_pif', 140000], ['juniors_family_third_plus', 7900]], JSON.stringify(codes));
  assert.equal(s.pos_sales[0].total_cents, 140000 + 7900 + fee(147900));
});

test('a program with no family rate takes one student at a time', async () => {
  const r = await call(store(), 'ampd', 'POST', enroll({
    plan_code: 'ampd_member',
    students: [{ first: 'A', last: 'B', dob: '2000-01-01' }, { first: 'C', last: 'D', dob: '2001-01-01' }],
  }));
  assert.equal(r.status, 400);
  assert.ok(/no family rate online/.test(r.body.error), r.body.error);
});

test('every student needs a name and a date of birth, and nothing is written until they do', async () => {
  const s = store();
  const r = await call(s, 'juniors', 'POST', enroll({
    students: [{ first: 'Liam', last: 'Le', dob: '2020-03-04' }, { first: 'Tammy', last: '', dob: '' }],
  }));
  assert.equal(r.status, 400);
  assert.ok(/every student's name/.test(r.body.error), r.body.error);
  assert.equal(s.contacts.length + s.pos_sales.length, 0);
});

test('the old one-student request still enrolls one student exactly as before', async () => {
  const s = store();
  const r = await call(s, 'juniors', 'POST', enroll({ student_first: 'Jace', student_last: 'Smith', student_dob: '2022-02-02' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(s.memberships.length, 1);
  assert.equal(s.memberships[0].plan_code, 'juniors_option_c');
  assert.equal(s.pos_sales[0].total_cents, 36900 + fee(36900));
  assert.ok(/Jace is enrolled in Juniors Taekwondo/.test(s.pos_sales[0].customer_note));
  assert.ok(/Your plan: Juniors Taekwondo — Option C/.test(s.pos_sales[0].customer_note));
});

// The two Taekwondo pages carry the controls, send every student, and price
// a family rate as a monthly plan.
test('the Juniors and Teens/Adults pages take a family, and Cubs is untouched', async () => {
  for (const dir of ['juniors-checkout', 'teens-adults-checkout']) {
    const html = fs.readFileSync(path.join(SITE, dir, 'index.html'), 'utf8');
    for (const need of ['id="cbc-fam-add"', 'students: studentsPayload()', '&family_email=', 'billing_frequency: "monthly"',
      'Agreement ', '-first', 'famLookup', 'cbc-fam-banner']) {
      assert.ok(html.includes(need), dir + ' lacks ' + need);
    }
  }
  const cubs = fs.readFileSync(path.join(SITE, 'cubs-checkout', 'index.html'), 'utf8');
  assert.ok(!cubs.includes('cbc-fam-add') && cubs.includes('cubs-pricing.pdf'), 'the Cubs page changed');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e && e.stack || e).split('\n').slice(0, 3).join('\n       ')); }
  }
  console.log(failed ? '\n' + failed + ' FAILED' : '\nall ' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
