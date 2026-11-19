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
  CUBS_TEMPLATE: loadDefault(path.join(FN, '_shared', 'cubs_agreement.js')),
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
  // members: everyone the email pays for in any program (what makes a Cub second).
  assert.deepEqual(r.body, { position: 2, found: 1, members: 1 });
  const none = await call(store(), 'juniors', 'GET', null, '&family_email=nobody%40example.com');
  assert.deepEqual(none.body, { position: 1, found: 0, members: 0 });
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
  assert.ok(/FAMILY RATE: this email already pays for 1 Taekwondo student here/.test(s.pos_sales[0].notes), s.pos_sales[0].notes);
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

// Every family page carries the controls (checkout-family.js), sends every
// student, shows the server's quote as its cart and every student's agreement.
// The two Taekwondo pages still price their own first student's family rate.
test('every family page takes a family; the pages that do not, do not', async () => {
  const FAMILY_PAGES = ['juniors-checkout', 'teens-adults-checkout', 'cubs-checkout', 'kickboxing-checkout', 'jiu-jitsu-checkout'];
  for (const dir of FAMILY_PAGES) {
    const html = fs.readFileSync(path.join(SITE, dir, 'index.html'), 'utf8');
    for (const need of ['id="cbc-fam-add"', 'id="cbc-fam-list"', '<script src="/assets/js/checkout-family.js"></script>',
      'students: studentsPayload()', 'uniforms: uniformsPayload()', 'FAMX.renderCart(', 'FAMX.docsHtml(',
      'FAMX.validate()', 'FAMX.doneHeading(', 'id="cbc-fam-consent"', 'id="cbc-r-fam"', 'body: cartBody']) {
      assert.ok(html.includes(need), dir + ' lacks ' + need);
    }
    // The page loads the family script before its own, which uses it.
    assert.ok(html.indexOf('checkout-family.js') < html.indexOf('var FAMX = null'), dir + ' uses the family script before loading it');
  }
  for (const dir of ['juniors-checkout', 'teens-adults-checkout']) {
    const html = fs.readFileSync(path.join(SITE, dir, 'index.html'), 'utf8');
    for (const need of ['&family_email=', 'billing_frequency: "monthly"', 'id="cbc-uniform-fam"', 'family_uniform_bps',
      'famLookup', 'cbc-fam-banner']) {
      assert.ok(html.includes(need), dir + ' lacks ' + need);
    }
  }
  const cubs = fs.readFileSync(path.join(SITE, 'cubs-checkout', 'index.html'), 'utf8');
  assert.ok(cubs.includes('functions/v1/program-checkout?p=cubs') && cubs.includes('cubs-pricing.pdf'), 'the Cubs page is not on the shared checkout');
  for (const dir of ['ampd-checkout', 'little-kickers-checkout', 'oneclassweekly']) {
    const html = fs.readFileSync(path.join(SITE, dir, 'index.html'), 'utf8');
    assert.ok(!html.includes('checkout-family.js'), dir + ' takes a family');
  }
});

// Owner, 2026-10-10: "Need second family member uniform at half off".
test('a family member\'s uniform is half off, on its own ledger line against that student', async () => {
  const uniform = () => [{ id: 'uni', name: 'Beginner uniform', price_cents: 8225, taxable: true, active: true }];
  const s = store({ products: uniform() });
  const r = await call(s, 'juniors', 'POST', enroll({
    students: [{ first: 'Liam', last: 'Le', dob: '2020-03-04' }, { first: 'Tammy', last: 'Le', dob: '2021-06-07' }],
    uniforms: [true, true],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const unis = s.pos_sale_lines.filter((l) => l.kind === 'prod');
  assert.deepEqual(unis.map((l) => [l.label, l.unit_cents, l.discount_cents, l.line_total_cents, l.student_contact_id]), [
    ['Beginner uniform (Liam)', 8225, 0, 8225, 'contacts-1'],
    ['Beginner uniform (Tammy, half off)', 8225, 4112, 4113, 'contacts-2'],
  ]);
  const goods = 8225 + 4113, tax = Math.floor(goods * 0.0825 + 0.5);
  assert.equal(s.pos_sales[0].total_cents, 48800 + goods + tax + fee(48800 + goods + tax));
  assert.equal(r.body.total_cents, s.pos_sales[0].total_cents);
  assert.ok(/Uniforms paid for: Liam, Tammy \(half off, family\)/.test(s.pos_sales[0].customer_note), s.pos_sales[0].customer_note);
  assert.ok(/UNIFORMS PURCHASED - have Liam and Tammy's ready \(family half off\)/.test(s.pos_sales[0].notes), s.pos_sales[0].notes);
  // Only the second wants one: no line for the first, and the old flag is ignored.
  const s1 = store({ products: uniform() });
  await call(s1, 'juniors', 'POST', enroll({
    students: [{ first: 'Liam', last: 'Le', dob: '2020-03-04' }, { first: 'Tammy', last: 'Le', dob: '2021-06-07' }],
    uniform: true, uniforms: [false, true],
  }));
  assert.deepEqual(s1.pos_sale_lines.filter((l) => l.kind === 'prod').map((l) => [l.label, l.line_total_cents]),
    [['Beginner uniform (Tammy, half off)', 4113]]);
  // A sibling of a current student is the family's second: half off on their own.
  const s2 = withSibling(); s2.products = uniform();
  const r2 = await call(s2, 'juniors', 'POST', enroll({ student_first: 'Ava', student_last: 'Root', student_dob: '2018-01-01', uniform: true }));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const u2 = s2.pos_sale_lines.find((l) => l.kind === 'prod');
  assert.deepEqual([u2.label, u2.line_total_cents, u2.student_contact_id], ['Beginner uniform (half off)', 4113, 'contacts-1'], 'a sibling pays full price');
  assert.ok(/paid for at the family rate, half off/.test(s2.pos_sales[0].customer_note), s2.pos_sales[0].customer_note);
  // A first student with no family here pays the full price, as before.
  const s3 = store({ products: uniform() });
  await call(s3, 'juniors', 'POST', enroll({ student_first: 'Ava', student_last: 'New', student_dob: '2018-01-01', uniform: true }));
  const u3 = s3.pos_sale_lines.find((l) => l.kind === 'prod');
  assert.deepEqual([u3.label, u3.unit_cents, u3.discount_cents, u3.line_total_cents], ['Beginner uniform', 8225, 0, 8225]);
  assert.equal((await call(store(), 'juniors', 'GET')).body.family_uniform_bps, 5000, 'the page is not told the discount');
});

// ── a Cub added on the Juniors checkout ──────────────────────────────────────
// Owner, 2026-11-18: "give them the option to choose cub or juniors, then how
// would the second agreement work?" A Cub behind the student ahead of them is
// the family's second: the Cubs family rate, the Cubs agreement under the same
// signature, the Cubs roster, and a family member's uniform at half off.
const CUB_PLANS = [
  plan('cubs_option_a', 'Cubs - Option A', 'Cubs', 'cubs', 'one_time', null, 0, 119900),
  plan('cubs_option_b', 'Cubs - Option B', 'Cubs', 'cubs', 'monthly', 9000, 19900, null),
  plan('cubs_option_c', 'Cubs - Option C', 'Cubs', 'cubs', 'monthly', 10500, 9900, null),
  plan('cubs_weekly', 'Cubs - Weekly', 'Cubs', 'cubs', 'weekly', 2795, 0, null),
  plan('cubs_family_second', 'Cubs - 2nd student', 'Cubs', 'cubs', 'monthly', 10900, 0, null,
    { sellable: false, family_position: 2, payment_count: null }),
];
const withCubs = (over) => store({
  pricing_plans: [...PLANS, ...CUB_PLANS].map((p) => ({ ...p })),
  products: [{ id: 'uni', name: 'Beginner uniform', price_cents: 8225, taxable: true, active: true },
    { id: 'cubuni', name: 'Cubs uniform', price_cents: 6600, taxable: true, active: true }],
  ...over,
});

test('the Juniors page is told what a Cub added there costs', async () => {
  const r = await call(withCubs(), 'juniors', 'GET');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = r.body.cub_sibling;
  assert.ok(c, 'no Cub option on the Juniors page');
  assert.deepEqual([c.code, c.down_cents, c.recurring_cents, c.due_today_cents, c.uniform_available, c.uniform_cents],
    ['cubs_family_second', 0, 10900, 10900, true, 6600]);
  assert.deepEqual(c.options.map((o) => o.code), ['cubs_option_a', 'cubs_option_b', 'cubs_option_c', 'cubs_weekly'],
    'the Cub agreement would not list what the Cubs page sells');
  assert.ok(!r.body.options.some((o) => /^cubs_/.test(o.code)), 'a Cubs plan is sold as a Juniors option');
  assert.equal((await call(withCubs(), 'ampd', 'GET')).body.cub_sibling, null, "AMP'D offers a Cub");
  assert.equal((await call(store(), 'juniors', 'GET')).body.cub_sibling, null, 'a Cub is offered with no Cubs family rate in the catalog');
});

test('a Cub on the Juniors checkout: the Cubs family rate, the Cubs agreement, the Cubs roster', async () => {
  const s = withCubs();
  const r = await call(s, 'juniors', 'POST', enroll({
    plan_code: 'juniors_option_d',
    students: [{ first: 'Lincoln', last: 'Payne', dob: '2019-09-29' },
      { first: 'June', last: 'Payne', dob: '2022-05-01', program: 'Cubs' }],
    uniforms: [true, true],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(s.memberships.map((m) => [m.contact_id, m.program, m.plan_code, m.final_down_cents, m.final_recurring_cents, m.status]), [
    ['contacts-1', 'Juniors', 'juniors_option_d', 12900, 12900, 'pending'],
    ['contacts-2', 'Cubs', 'cubs_family_second', 0, 10900, 'pending'],
  ]);
  const [a1, a2] = s.membership_agreements;
  assert.deepEqual([a1.template_key, a1.program, a2.template_key, a2.program], ['taekwondo', 'Juniors', 'cubs', 'Cubs']);
  assert.ok(a2.body_text.includes('CUBS MEMBERSHIP AGREEMENT'), a2.body_text.slice(0, 300));
  assert.ok(a2.body_text.includes('Participant (Student) Name: June Payne'));
  assert.ok(a2.body_text.includes('Cubs - Option B is a down payment of $199.00 and a monthly payment of $90.00.'),
    'the Cub agreement does not list the Cubs options');
  assert.ok(a2.body_text.includes('Cubs - 2nd student is a down payment of $0.00 and a monthly payment of $109.00.'));
  assert.ok(a2.body_text.includes('Selected option: Cubs - 2nd student'));
  assert.ok(!a2.body_text.includes('Juniors Taekwondo'), 'the Cub agreement lists Juniors options');
  assert.equal(a2.body_json.family_position, 2);
  assert.ok(s.membership_agreements.every((a) => a.signature_png === SIG && a.signer_name === 'Katie Root'), 'one signature for both');
  assert.deepEqual(s.enrollments.map((e) => [e.student_id, e.program]), [['contacts-1', 'Juniors'], ['contacts-2', 'Cubs']]);
  assert.deepEqual(s.pos_sale_lines.filter((l) => l.kind === 'mem').map((l) => [l.label, l.line_total_cents, l.student_contact_id]), [
    ['Juniors Taekwondo — Option D', 25800, 'contacts-1'], ['Cubs - 2nd student', 10900, 'contacts-2'],
  ]);
  assert.deepEqual(s.pos_sale_lines.filter((l) => l.kind === 'prod')
    .map((l) => [l.label, l.unit_cents, l.discount_cents, l.line_total_cents, l.product_id, l.student_contact_id]), [
    ['Beginner uniform (Lincoln)', 8225, 0, 8225, 'uni', 'contacts-1'],
    ['Cubs uniform (June, half off)', 6600, 3300, 3300, 'cubuni', 'contacts-2'],
  ]);
  const goods = 8225 + 3300, tax = Math.floor(goods * 0.0825 + 0.5), tuition = 25800 + 10900;
  assert.equal(s.pos_sales[0].total_cents, tuition + goods + tax + fee(tuition + goods + tax));
  assert.equal(r.body.total_cents, s.pos_sales[0].total_cents);
  const note = s.pos_sales[0].customer_note;
  assert.ok(/Lincoln is enrolled in Juniors Taekwondo, and June in Cubs\./.test(note), note);
  assert.ok(/June's monthly payment is \$109\.00/.test(note), note);
  assert.ok(/June Payne: Cubs - 2nd student/.test(s.pos_sales[0].notes), s.pos_sales[0].notes);
});

test('a Cub does not move a Juniors sibling down to the third-student rate', async () => {
  const s = withCubs();
  const r = await call(s, 'juniors', 'POST', enroll({
    students: [{ first: 'Ava', last: 'Le', dob: '2018-01-01' }, { first: 'Max', last: 'Le', dob: '2022-01-01', program: 'Cubs' },
      { first: 'Ben', last: 'Le', dob: '2019-01-01', program: 'Juniors' }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(s.memberships.map((m) => [m.program, m.plan_code, m.final_recurring_cents]),
    [['Juniors', 'juniors_option_c', 11000], ['Cubs', 'cubs_family_second', 10900], ['Juniors', 'juniors_family_second', 11900]]);
});

test('a Cub is never the first student, and no other program rides along', async () => {
  const first = await call(withCubs(), 'juniors', 'POST', enroll({
    students: [{ first: 'Max', last: 'Le', dob: '2022-01-01', program: 'Cubs' }, { first: 'Ava', last: 'Le', dob: '2018-01-01' }],
  }));
  assert.equal(first.status, 400);
  assert.ok(/first student enrolls in Juniors Taekwondo\. Add anyone in another program as a family member/.test(first.body.error), first.body.error);
  const other = await call(withCubs(), 'juniors', 'POST', enroll({
    students: [{ first: 'Ava', last: 'Le', dob: '2018-01-01' }, { first: 'Kim', last: 'Le', dob: '2000-01-01', program: 'Kickboxing' }],
  }));
  assert.equal(other.status, 400);
  assert.ok(/can't be added on this page/.test(other.body.error), other.body.error);
  const noRate = store();   // no Cubs family rate in the catalog
  const off = await call(noRate, 'juniors', 'POST', enroll({
    students: [{ first: 'Ava', last: 'Le', dob: '2018-01-01' }, { first: 'Max', last: 'Le', dob: '2022-01-01', program: 'Cubs' }],
  }));
  assert.equal(off.status, 400);
  // With no Cubs family rate in the catalog, Cubs is simply not offered.
  assert.ok(/can't be added on this page/.test(off.body.error), off.body.error);
  assert.equal(noRate.contacts.length + noRate.pos_sales.length, 0, 'records were written before the refusal');
});

test('a retry of a family checkout is not refused because the sibling row came back first', async () => {
  const s = withCubs();
  const body = enroll({
    plan_code: 'juniors_option_d',
    students: [{ first: 'Lincoln', last: 'Payne', dob: '2019-09-29' },
      { first: 'June', last: 'Payne', dob: '2022-05-01', program: 'Cubs' }],
  });
  assert.equal((await call(s, 'juniors', 'POST', body)).status, 200);
  s.memberships.reverse();   // the Cub's row first, as a database may return it
  const again = await call(s, 'juniors', 'POST', body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.ok(!again.body.reload, 'the retry was told the selection changed');
  const moved = await call(s, 'juniors', 'POST', { ...body, plan_code: 'juniors_option_c' });
  assert.equal(moved.status, 409);
  assert.ok(moved.body.reload, 'a real change of plan was not caught');
});

// ── every program, every direction ───────────────────────────────────────────
// Owner, 2026-11-18: "connect all programs via second student during checkout.
// So, for example, if an adult kickboxer wanted to sign up after a cub on the
// same checkout page ... it should run all directions." The first student is
// the page's program; each one after can be any of them, and the engine prices
// them as the till would.
const ALL_PLANS = [
  ...PLANS, ...CUB_PLANS,
  plan('adults_option_d', 'Teens and Adults Taekwondo — Option D', 'Teens/Adults', 'core_tkd', 'monthly', 12900, 12900, null),
  plan('adults_family_second', 'Teens and Adults Taekwondo — 2nd family member', 'Teens/Adults', 'core_tkd', 'monthly', 11900, 0, null,
    { sellable: false, family_position: 2 }),
  plan('specialty_kickboxing', 'Kickboxing', 'Kickboxing', 'specialty', 'monthly', 9900, 0, null,
    { supports_household_discount: true, payment_count: null }),
  plan('specialty_second_kickboxing', 'Kickboxing (second program)', 'Kickboxing', 'specialty', 'monthly', 3000, 0, null,
    { sellable: false, payment_count: null }),
  plan('specialty_jiujitsu', 'Jiu Jitsu', 'Jiu Jitsu', 'specialty', 'monthly', 9900, 0, null,
    { supports_household_discount: true, payment_count: null }),
  plan('specialty_second_jiujitsu', 'Jiu Jitsu (second program)', 'Jiu Jitsu', 'specialty', 'monthly', 3000, 0, null,
    { sellable: false, payment_count: null }),
];
const fullStore = (over) => store({
  pricing_plans: ALL_PLANS.map((p) => ({ ...p })),
  products: [{ id: 'uni', name: 'Beginner uniform', price_cents: 8225, taxable: true, active: true },
    { id: 'cubuni', name: 'Cubs uniform', price_cents: 6600, taxable: true, active: true }],
  pricing_settings: [{ key: 'admin_fee_bps', value_cents: 290 }, { key: 'admin_fee_flat_cents', value_cents: 30 },
    { key: 'household_specialty_discount_cents', value_cents: 1000 }],
  ...over,
});
const memRows = (s) => s.memberships.map((m) => [m.contact_id, m.program, m.plan_code, m.final_down_cents, m.final_recurring_cents]);

test('every family page offers every program, each with what its agreement and picker need', async () => {
  const r = await call(fullStore(), 'juniors', 'GET');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.family_choices.map((c) => [c.key, c.label, c.program, c.template_key, c.tkd]), [
    ['juniors', 'Juniors', 'Juniors', 'taekwondo', true],
    ['teens-adults', 'Teens & Adults', 'Teens/Adults', 'taekwondo', true],
    ['cubs', 'Cubs', 'Cubs', 'cubs', false],
    ['kickboxing', 'Kickboxing', 'Kickboxing', 'kickboxing', false],
    ['jiu-jitsu', 'Jiu Jitsu', 'Jiu Jitsu', 'jiujitsu', false],
    ['kickboxing-jiu-jitsu', 'Kickboxing + Jiu Jitsu', 'Kickboxing', 'kickboxing', false],
  ]);
  const c = r.body.family_choices;
  assert.deepEqual([c[2].uniform_cents, c[0].uniform_cents, c[3].uniform_available], [6600, 8225, false]);
  assert.deepEqual(c[5].add_on, { program: 'Jiu Jitsu', monthly_cents: 3000 });
  for (const p of ['teens-adults', 'cubs', 'kickboxing', 'jiu-jitsu']) {
    assert.equal((await call(fullStore(), p, 'GET')).body.family_choices.length, 6, p + ' does not take a family');
  }
  assert.deepEqual((await call(fullStore(), 'ampd', 'GET')).body.family_choices, [], "AMP'D takes a family");
});

test('a Cub, then their mom in Kickboxing: the Cubs option, and Kickboxing less the household discount', async () => {
  const s = fullStore();
  const r = await call(s, 'cubs', 'POST', enroll({
    plan_code: 'cubs_option_b',
    students: [{ first: 'June', last: 'Root', dob: '2022-05-01' },
      { first: 'Katie', last: 'Root', dob: '1990-01-01', program: 'kickboxing' }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(memRows(s), [
    ['contacts-1', 'Cubs', 'cubs_option_b', 19900, 9000],
    ['contacts-2', 'Kickboxing', 'specialty_kickboxing', 0, 8900],
  ]);
  const [a1, a2] = s.membership_agreements;
  assert.deepEqual([a1.template_key, a2.template_key, a2.program], ['cubs', 'kickboxing', 'Kickboxing']);
  assert.ok(a2.body_text.includes('Participant (Student) Name: Katie Root'));
  assert.ok(a2.body_text.includes('Parent / Guardian: \n'), 'an adult family member was given a guardian');
  assert.equal(a2.signer_relationship, 'Self', 'the mom signing for herself is not "Parent"');
  assert.equal(a1.signer_relationship, 'Parent');
  assert.deepEqual(s.contacts.map((c) => c.email), [null, 'katie@example.com'], 'the paying mom should own her email');
  assert.deepEqual(s.enrollments.map((e) => e.program), ['Cubs', 'Kickboxing']);
  assert.equal(s.pos_sales[0].total_cents, 28900 + 8900 + fee(28900 + 8900));
  assert.ok(/June is enrolled in Cubs, and Katie in Kickboxing\./.test(s.pos_sales[0].customer_note), s.pos_sales[0].customer_note);
});

test('an adult kickboxer, then a Cub: Kickboxing at its rate, the Cub at the Cubs family rate', async () => {
  const s = fullStore();
  const r = await call(s, 'kickboxing', 'POST', enroll({
    plan_code: 'specialty_kickboxing',
    students: [{ first: 'Dan', last: 'Root', dob: '1985-01-01' }, { first: 'June', last: 'Root', dob: '2022-05-01', program: 'Cubs' }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(memRows(s), [
    ['contacts-1', 'Kickboxing', 'specialty_kickboxing', 0, 9900],
    ['contacts-2', 'Cubs', 'cubs_family_second', 0, 10900],
  ]);
  assert.deepEqual(s.membership_agreements.map((a) => a.template_key), ['kickboxing', 'cubs']);
  assert.equal(s.pos_sales[0].total_cents, 9900 + 10900 + fee(20800));
});

test('a Junior behind a Cub is the family\'s first Taekwondo student: they pick a regular option', async () => {
  const kids = (pc) => enroll({ plan_code: 'cubs_option_c',
    students: [{ first: 'June', last: 'Root', dob: '2022-05-01' },
      { first: 'Max', last: 'Root', dob: '2018-03-03', program: 'Juniors', plan_code: pc }] });
  const none = await call(fullStore(), 'cubs', 'POST', kids(''));
  assert.equal(none.status, 400);
  assert.ok(/Pick a payment option for Max/.test(none.body.error), none.body.error);
  // The quote says so instead of refusing, and prices nothing until they pick.
  const q0 = await call(fullStore(), 'cubs', 'POST', { ...kids(''), action: 'quote' });
  assert.equal(q0.status, 200, JSON.stringify(q0.body));
  assert.deepEqual([q0.body.complete, q0.body.students[1].needs_option, q0.body.total_cents], [false, true, null]);
  const s = fullStore();
  const r = await call(s, 'cubs', 'POST', kids('juniors_option_d'));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(memRows(s), [
    ['contacts-1', 'Cubs', 'cubs_option_c', 9900, 10500],
    ['contacts-2', 'Juniors', 'juniors_option_d', 12900, 12900],
  ]);
  const q = await call(fullStore(), 'cubs', 'POST', { ...kids('juniors_option_d'), action: 'quote' });
  assert.equal(q.body.complete, true);
  assert.equal(q.body.total_cents, s.pos_sales[0].total_cents, 'the quote and the charge disagree');
  assert.deepEqual(q.body.students.map((x) => [x.program, x.plan.code, x.plan.due_today_cents]),
    [['Cubs', 'cubs_option_c', 20400], ['Juniors', 'juniors_option_d', 25800]]);
});

test('a quote writes nothing and matches the charge, uniforms and all', async () => {
  const body = enroll({
    plan_code: 'juniors_option_d', uniforms: [true, true, false],
    students: [{ first: 'Lincoln', last: 'Payne', dob: '2019-09-29' },
      { first: 'June', last: 'Payne', dob: '2022-05-01', program: 'cubs' },
      { first: 'Mom', last: 'Payne', dob: '1990-02-02', program: 'jiu-jitsu' }],
  });
  const qs = fullStore();
  const q = await call(qs, 'juniors', 'POST', { ...body, action: 'quote', sale_id: undefined, signature_png: '' });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(qs.contacts.length + qs.pos_sales.length + qs.memberships.length, 0, 'a quote wrote records');
  assert.deepEqual(q.body.students.map((x) => [x.plan.code, x.plan.recurring_cents, x.uniform && x.uniform.cents]), [
    ['juniors_option_d', 12900, 8225], ['cubs_family_second', 10900, 3300], ['specialty_jiujitsu', 8900, null],
  ]);
  const s = fullStore();
  const r = await call(s, 'juniors', 'POST', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(q.body.total_cents, s.pos_sales[0].total_cents);
  assert.ok(/Lincoln is enrolled in Juniors Taekwondo, June in Cubs, and Mom in Jiu Jitsu\./.test(s.pos_sales[0].customer_note),
    s.pos_sales[0].customer_note);
});

test('Kickboxing + Jiu Jitsu for a family member: Kickboxing less the household discount, Jiu Jitsu added on', async () => {
  const s = fullStore();
  const r = await call(s, 'juniors', 'POST', enroll({
    students: [{ first: 'Liam', last: 'Le', dob: '2018-01-01' },
      { first: 'Dan', last: 'Le', dob: '1985-01-01', program: 'kickboxing-jiu-jitsu' }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(memRows(s), [
    ['contacts-1', 'Juniors', 'juniors_option_c', 25900, 11000],
    ['contacts-2', 'Kickboxing', 'specialty_kickboxing', 0, 8900],
    ['contacts-2', 'Jiu Jitsu', 'specialty_second_jiujitsu', 0, 3000],
  ]);
  assert.deepEqual(s.enrollments.map((e) => [e.student_id, e.program]),
    [['contacts-1', 'Juniors'], ['contacts-2', 'Kickboxing'], ['contacts-2', 'Jiu Jitsu']]);
  const dan = s.membership_agreements.filter((a) => a.contact_id === 'contacts-2');
  assert.deepEqual(dan.map((a) => [a.template_key, a.program, a.plan_code]),
    [['kickboxing', 'Kickboxing', 'specialty_kickboxing'], ['kickboxing', 'Jiu Jitsu', 'specialty_second_jiujitsu']]);
  assert.ok(dan[0].body_text.includes('Add-on: Jiu Jitsu is $30.00 per month.'), dan[0].body_text.slice(0, 900));
  assert.equal(s.contacts[1].email, null, 'an adult who is not the payer was given the payer\'s email');
  assert.equal(s.pos_sales[0].total_cents, 36900 + 8900 + 3000 + fee(36900 + 11900));
});

test('a family that already trains here: a kickboxer gets the household discount, a Cub the Cubs family rate', async () => {
  const fam = () => { const s = withSibling(); const f = fullStore(); s.pricing_plans = f.pricing_plans; s.pricing_settings = f.pricing_settings; s.products = f.products; return s; };
  const s1 = fam();
  const r1 = await call(s1, 'kickboxing', 'POST', enroll({ plan_code: 'specialty_kickboxing',
    student_first: 'Katie', student_last: 'Root', student_dob: '1990-01-01' }));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(memRows(s1).filter((m) => m[0] !== 'samuel'), [['contacts-1', 'Kickboxing', 'specialty_kickboxing', 0, 8900]]);
  const s2 = fam();
  const r2 = await call(s2, 'cubs', 'POST', enroll({ plan_code: 'cubs_option_b',
    student_first: 'June', student_last: 'Root', student_dob: '2022-05-01' }));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.deepEqual(memRows(s2).filter((m) => m[0] !== 'samuel'), [['contacts-1', 'Cubs', 'cubs_family_second', 0, 10900]]);
});

// The family rows: a program for each member, a payment option only when the
// quote says they need one, their own uniform, and nothing priced on the page.
test('the family script asks the server for every price and signs each member to their own program', () => {
  const js = fs.readFileSync(path.join(SITE, 'assets', 'js', 'checkout-family.js'), 'utf8');
  for (const need of ['data-f="program"', 'data-f="plan"', 'data-f="uniform"', 'b.action = "quote"', 'needs_option',
    'c.template_key', 'program: m.choice ? m.choice.key', 'plan_code: m.planCode', 'Q.failSig === sig']) {
    assert.ok(js.includes(need), 'checkout-family.js lacks ' + need);
  }
  assert.ok(!/cardFeeCents|tax_rate|\* CFG\.tax/.test(js), 'the family script works out a price itself');
  assert.ok(!js.includes(String.fromCharCode(8212)), 'em dash in the family script');
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
