/* ============================================================================
 * tournament-checkout - the 2026 Texas Showdown signup
 * ----------------------------------------------------------------------------
 *     node tests/tournament-checkout.test.js
 *
 * The REAL handler against a fake database and a fake Stripe. Never contacts
 * a network.
 *
 * Owner, 2026-10-20: "look at this tournament and make me a checkout page with
 * the same details". The host's prices ($55 Cubs, $90 everyone else, $35
 * board breaking, $25 shirt), the card fee on top, tax on the shirts only,
 * and a registration that only counts once it is paid.
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
  fs.readFileSync(path.join(FN, 'tournament-checkout', 'index.ts'), 'utf8').replace(/^import .*;\r?\n/gm, ''));

function loadDefault(file) {
  const ctx = vm.createContext({});
  vm.runInContext('var __out;' + fs.readFileSync(file, 'utf8').replace(/export default/, '__out ='), ctx);
  return ctx.__out;
}
const BTKDPricing = loadDefault(path.join(FN, '_shared', 'pricing_esm.js'));
const engineFee = require(path.join(SITE, '..', 'BaresCRM', 'pricing.js')).cardFeeCents;

const EVENT_ID = '607a51a9-45aa-40e5-b2c2-39d4d6493e3e';
const SALE = '11111111-2222-4333-8444-555555555555';

function store(over) {
  return {
    events: [{ id: EVENT_ID, label: '2026 Texas Showdown Regional Tournament', public_open: true, archived: false }],
    pricing_settings: [{ key: 'admin_fee_bps', value_cents: 290 }, { key: 'admin_fee_flat_cents', value_cents: 30 }],
    contacts: [], guardians: [], guardian_emails: [], student_guardians: [],
    pos_sales: [], pos_sale_lines: [], pos_payments: [], event_registrations: [],
    ...over,
  };
}

// Just enough of supabase-js for the calls the handler makes.
function db(s) {
  let seq = 0;
  return {
    from(table) {
      const eqs = {}, ins = {}, likes = {}; let insert, update, single = false;
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { eqs[k] = v; return q; }, in(k, v) { ins[k] = v; return q; },
        ilike(k, v) { likes[k] = String(v).toLowerCase(); return q; },
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
            && Object.entries(likes).every(([k, v]) => String(r[k] ?? '').toLowerCase() === v);
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
let PI_ON_GET = null;    // what Stripe says when the handler reads an intent back
async function call(s, method, body) {
  let handler;
  STRIPE_CALLS.length = 0;
  const ctx = vm.createContext({
    createClient: () => db(s),
    BTKDPricing,
    familyCustomer: async () => ({ custId: 'cus_test', ownerKind: 'guardian', guardianId: 'g-test' }),
    fetch: async (url, init) => {
      const u = String(url);
      if (u.includes('api.stripe.com')) {
        const m = (init && init.method) || 'POST';
        STRIPE_CALLS.push({ url: u, method: m, body: String(init && init.body || '') });
        if (m === 'GET') return { ok: true, json: async () => PI_ON_GET };
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
  const res = await handler(new Request('https://t.invalid/tournament-checkout', {
    method, headers: { 'Content-Type': 'application/json', Origin: 'https://www.barestkd.fit' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}

const kid = (over) => ({ first: 'Ava', last: 'Stone', dob: '2016-03-02', gender: 'Female', height_in: 50,
  division: 'jta', rank: 'Orange Belt', board: false, shirt: '', ...over });
const signup = (students, over) => ({
  sale_id: SALE, parent_first: 'Pat', parent_last: 'Stone', email: 'pat@example.com', phone: '903-555-0100',
  students, ...over,
});

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
}

(async () => {
  await test('GET: open, with the host prices and the host shirt sizes', async () => {
    const r = await call(store(), 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.body.page_live, true);
    assert.deepEqual(r.body.divisions.map((d) => [d.key, d.cents]), [['cubs', 5500], ['jta', 9000]]);
    assert.equal(r.body.board_cents, 3500);
    assert.equal(r.body.shirt_cents, 2500);
    assert.deepEqual(r.body.shirt_sizes, ['Child S', 'Child M', 'Child L', 'Adult S', 'Adult M',
      'Adult L', 'Adult XL', 'Adult XXL', 'Adult XXXL']);
    assert.equal(r.body.heights.length, 49);
    assert.equal(r.body.heights[12].label, '48" (4\')');
    assert.equal(r.body.tournament.date, '2026-11-14');
    assert.equal(r.body.tournament.pretty_day, 'Saturday, November 14');
  });

  await test('GET: the CRM event is the only switch', async () => {
    assert.equal((await call(store({ events: [{ id: EVENT_ID, public_open: false, archived: false }] }), 'GET')).body.page_live, false);
    assert.equal((await call(store({ events: [{ id: EVENT_ID, public_open: true, archived: true }] }), 'GET')).body.page_live, false);
    assert.equal((await call(store({ events: [] }), 'GET')).body.page_live, false);
  });

  await test('POST on a closed page writes nothing', async () => {
    const s = store({ events: [{ id: EVENT_ID, public_open: false, archived: false }] });
    const r = await call(s, 'POST', signup([kid()]));
    assert.equal(r.status, 503);
    assert.equal(s.pos_sales.length, 0);
    assert.equal(s.event_registrations.length, 0);
  });

  await test('a family: entries untaxed, shirts taxed, the fee grossed up on all of it', async () => {
    const s = store();
    const r = await call(s, 'POST', signup([
      kid({ first: 'June', dob: '2021-06-01', height_in: 40, division: 'cubs', rank: 'Cub Yellow Belt' }),
      kid({ first: 'Leo', dob: '2014-11-15', gender: 'Male', height_in: 54, rank: 'Green Belt', board: true, shirt: 'Adult M' }),
    ], { family_shirts: ['Adult L'] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sub = 5500 + 9000 + 3500 + 2500 + 2500;
    const tax = Math.floor(5000 * 0.0825 + 0.5);
    const fee = engineFee(sub + tax, 290, 30);
    const sale = s.pos_sales[0];
    assert.equal(sale.subtotal_cents, sub);
    assert.equal(sale.tax_cents, tax);
    assert.equal(sale.admin_fee_cents, fee);
    assert.equal(sale.total_cents, sub + tax + fee);
    assert.equal(r.body.total_cents, sub + tax + fee);
    assert.equal(sale.status, 'pending_payment');
    assert.equal(sale.staff_email, 'tournament-checkout@website');
    assert.match(sale.customer_note, /Saturday, November 14, 2026/);
    assert.match(sale.customer_note, /7901 Indian Springs Rd, Watauga, TX 76148/);
    const pi = STRIPE_CALLS.find((c) => c.method === 'POST');
    assert.match(pi.body, new RegExp('amount=' + (sub + tax + fee) + '&'));
    assert.match(pi.body, /metadata%5Bsource%5D=tournament-checkout/);
  });

  await test('the lines carry what Race needs to enter each competitor', async () => {
    const s = store();
    await call(s, 'POST', signup([
      kid({ first: 'Leo', dob: '2014-11-15', gender: 'Male', height_in: 54, rank: 'Green Belt', board: true, shirt: 'Adult M' }),
    ]));
    const [entry, board, shirt] = s.pos_sale_lines;
    assert.equal(entry.kind, 'event');
    assert.equal(entry.event_id, EVENT_ID);
    assert.equal(entry.unit_cents, 9000);
    assert.equal(entry.taxable, false);
    assert.equal(entry.label, 'Texas Showdown Juniors, Teens & Adults entry - Leo Stone');
    // Born 11/15/2014: the day before his birthday, so 11, not 12.
    assert.equal(entry.note, 'Green Belt · Age 11 on tournament day · 4\' 6" · Male · Born 11/15/2014');
    assert.equal(board.unit_cents, 3500);
    assert.equal(board.taxable, false);
    assert.equal(shirt.kind, 'prod');
    assert.equal(shirt.taxable, true);
    assert.equal(shirt.event_id, null);
    assert.match(shirt.label, /T-shirt \(Adult M\) - Leo Stone/);
  });

  await test('registrations are written pending, with the details, matched only when certain', async () => {
    const s = store({ contacts: [{ id: 'c-ava', first_name: 'Ava', last_name: 'Stone' }] });
    await call(s, 'POST', signup([kid(), kid({ first: 'Nobody', last: 'Known', shirt: 'Child M' })]));
    const [a, b] = s.event_registrations;
    assert.equal(a.status, 'pending');
    assert.equal(a.contact_id, 'c-ava');
    assert.equal(a.student_name, 'Ava Stone');
    assert.equal(a.source, 'website');
    assert.equal(a.details.age_on_day, 10);
    assert.equal(a.details.division, 'jta');
    assert.equal(b.contact_id, null);
    assert.equal(b.student_name, 'Nobody Known');
    assert.equal(b.details.shirt, 'Child M');
    assert.equal(s.pos_sale_lines[0].student_contact_id, 'c-ava');
  });

  await test('the browser cannot name a price', async () => {
    const s = store();
    await call(s, 'POST', signup([kid({ cents: 1, unit_cents: 1 })], { total_cents: 100, amount: 100 }));
    assert.equal(s.pos_sales[0].subtotal_cents, 9000);
  });

  for (const [why, over, extra] of [
    ['a Cubs entry with a Taekwondo belt', { division: 'cubs', rank: 'Green Belt' }],
    ['a birthday in the future', { dob: '2030-01-01' }],
    ['a date that does not exist', { dob: '2015-02-30' }],
    ['no gender', { gender: '' }],
    ['a height off the list', { height_in: 20 }],
    ['a shirt size the host does not print', { shirt: 'Youth M' }],
    ['no division', { division: '' }],
    ['a family shirt in a size the host does not print', {}, { family_shirts: ['Huge'] }],
  ]) {
    await test('refused: ' + why, async () => {
      const s = store();
      const r = await call(s, 'POST', signup([kid(over)], extra || {}));
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(s.pos_sales.length, 0);
    });
  }

  await test('refused: more than eight competitors', async () => {
    const r = await call(store(), 'POST', signup(Array.from({ length: 9 }, (_, i) => kid({ first: 'K' + i }))));
    assert.equal(r.status, 400);
  });

  await test('a student already registered is not charged twice', async () => {
    const s = store({
      contacts: [{ id: 'c-ava', first_name: 'Ava', last_name: 'Stone' }],
      event_registrations: [{ id: 'r1', event_id: EVENT_ID, contact_id: 'c-ava', status: 'registered' }],
    });
    const r = await call(s, 'POST', signup([kid()]));
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Ava Stone is already registered/);
    assert.equal(s.pos_sales.length, 0);
  });

  await test('an abandoned checkout does not block trying again', async () => {
    const s = store({
      contacts: [{ id: 'c-ava', first_name: 'Ava', last_name: 'Stone' }],
      event_registrations: [{ id: 'r0', event_id: EVENT_ID, contact_id: 'c-ava', status: 'pending' }],
    });
    const r = await call(s, 'POST', signup([kid()]));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  await test('a resubmit returns the same intent and writes nothing new', async () => {
    const s = store();
    await call(s, 'POST', signup([kid()]));
    s.pos_sales[0].stripe_payment_intent = 'pi_test';
    PI_ON_GET = { id: 'pi_test', status: 'requires_payment_method', client_secret: 'cs_again' };
    const r = await call(s, 'POST', signup([kid()]));
    assert.equal(r.body.client_secret, 'cs_again');
    assert.equal(s.pos_sale_lines.length, 1);
    assert.equal(s.event_registrations.length, 1);
  });

  await test('finalize: paid means registered, and the receipt goes out', async () => {
    const s = store();
    await call(s, 'POST', signup([kid(), kid({ first: 'Leo' })]));
    PI_ON_GET = { id: 'pi_test', status: 'succeeded', metadata: { sale_id: SALE }, amount_received: s.pos_sales[0].total_cents };
    const r = await call(s, 'POST', { action: 'finalize', sale_id: SALE, payment_intent_id: 'pi_test' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.pos_sales[0].status, 'paid');
    assert.deepEqual(s.event_registrations.map((x) => x.status), ['registered', 'registered']);
    assert.equal(s.pos_payments.length, 1);
    assert.equal(s.pos_payments[0].note, 'Card payment (tournament signup)');
  });

  await test('finalize after the webhook already marked it paid still registers them', async () => {
    const s = store();
    await call(s, 'POST', signup([kid()]));
    s.pos_sales[0].status = 'paid';
    PI_ON_GET = { id: 'pi_test', status: 'succeeded', metadata: { sale_id: SALE }, amount_received: s.pos_sales[0].total_cents };
    await call(s, 'POST', { action: 'finalize', sale_id: SALE, payment_intent_id: 'pi_test' });
    assert.equal(s.event_registrations[0].status, 'registered');
  });

  await test('a part payment leaves the registration pending', async () => {
    const s = store();
    await call(s, 'POST', signup([kid()]));
    PI_ON_GET = { id: 'pi_test', status: 'succeeded', metadata: { sale_id: SALE }, amount_received: 100 };
    await call(s, 'POST', { action: 'finalize', sale_id: SALE, payment_intent_id: 'pi_test' });
    assert.equal(s.pos_sales[0].status, 'pending_payment');
    assert.equal(s.event_registrations[0].status, 'pending');
  });

  await test('finalize refuses a payment that belongs to another sale', async () => {
    const s = store();
    await call(s, 'POST', signup([kid()]));
    PI_ON_GET = { id: 'pi_test', status: 'succeeded', metadata: { sale_id: 'someone-else' }, amount_received: 99999 };
    const r = await call(s, 'POST', { action: 'finalize', sale_id: SALE, payment_intent_id: 'pi_test' });
    assert.equal(r.status, 409);
    assert.equal(s.event_registrations[0].status, 'pending');
  });

  console.log('\n' + passed + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
})();
