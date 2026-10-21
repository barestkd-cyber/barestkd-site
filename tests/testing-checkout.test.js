/* ============================================================================
 * testing-checkout - each testing is its own page
 * ----------------------------------------------------------------------------
 *     node tests/testing-checkout.test.js
 *
 * The REAL handler against a fake database and a fake Stripe, plus the page
 * that calls it. Never contacts a network.
 *
 * Owner, 2026-09-09: "separate my testings into separate testing pages or
 * checkout pages". The function learned ?t= that day; the page never passed
 * it on, so every link showed the same open pile. Owner, 2026-10-20: "how far
 * are we on testing pages being individuals", then "fix testing".
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
  fs.readFileSync(path.join(FN, 'testing-checkout', 'index.ts'), 'utf8').replace(/^import .*;\r?\n/gm, ''));
const PAGE = fs.readFileSync(path.join(SITE, 'testing-checkout', 'index.html'), 'utf8');

function loadDefault(file) {
  const ctx = vm.createContext({});
  vm.runInContext('var __out;' + fs.readFileSync(file, 'utf8').replace(/export default/, '__out ='), ctx);
  return ctx.__out;
}
const BTKDPricing = loadDefault(path.join(FN, '_shared', 'pricing_esm.js'));

// The live dates as they stood on 2026-10-20: August still open for late
// payers, November set up but not open yet.
const date = (id, cycle, ymd, label, program, open) => ({ id, cycle_ref: cycle, test_date: ymd, start_time: '5:30 PM',
  label, program, signups_open: open, signup_by: null, fee_cents: null, fee_addl_cents: null, sort_order: 1, applies_to: null });
function store(augOpen, novOpen) {
  return {
    settings: [{ testing_page_live: true }],
    testing_dates: [
      date('a1', 'aug-2026', '2026-08-28', 'Cubs', 'Cubs', augOpen),
      date('a2', 'aug-2026', '2026-08-29', 'Juniors, White through Orange Belt', 'TKD', augOpen),
      date('n1', 'nov-2026', '2026-11-13', 'Cubs', 'Cubs', novOpen),
      date('n2', 'nov-2026', '2026-11-14', 'Juniors, White through Orange Belt', 'TKD', novOpen),
    ],
    pricing_settings: [{ key: 'admin_fee_bps', value_cents: 290 }, { key: 'admin_fee_flat_cents', value_cents: 30 }],
    contacts: [], guardian_emails: [], student_guardians: [],
    pos_sales: [], pos_sale_lines: [], pos_payments: [], testing_signups: [],
  };
}

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

async function call(s, method, query, body) {
  let handler;
  const ctx = vm.createContext({
    createClient: () => db(s), BTKDPricing,
    familyCustomer: async () => ({ custId: 'cus_test' }),
    fetch: async () => ({ ok: true, json: async () => ({ id: 'pi_test', client_secret: 'cs_test', status: 'requires_payment_method' }), text: async () => '' }),
    Deno: { serve: (fn) => { handler = fn; }, env: { get: (k) => ({
      SUPABASE_URL: 'https://t.invalid', SUPABASE_SERVICE_ROLE_KEY: 'svc',
      STRIPE_SECRET_KEY: 'sk_test', STRIPE_PUBLISHABLE_KEY: 'pk_test' })[k] } },
    URL, URLSearchParams, Response, Request, console: { log() {}, error() {} },
    crypto: nodeCrypto.webcrypto, Date, Math, JSON, Object, Array, String, Number, Set, Map, isFinite, Promise,
  });
  vm.runInContext(SRC, ctx);
  const res = await handler(new Request('https://t.invalid/testing-checkout' + (query || ''), {
    method, headers: { 'Content-Type': 'application/json', Origin: 'https://www.barestkd.fit' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}

const signup = (groupId, rank) => ({
  sale_id: '11111111-2222-4333-8444-555555555555', parent_first: 'Pat', parent_last: 'Stone',
  email: 'pat@example.com', phone: '903-555-0100',
  students: [{ first: 'Ava', last: 'Stone', group_id: groupId, rank, position: 1 }],
});

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
}

(async () => {
  await test('the plain link shows one testing: the newest still open', async () => {
    const r = await call(store(true, true), 'GET');
    assert.equal(r.body.testing, 'nov-2026');
    assert.deepEqual(r.body.groups.map((g) => g.id), ['n1', 'n2']);
    assert.ok(r.body.groups.every((g) => g.cycle_ref === 'nov-2026'));
    assert.equal(r.body.selling, true);
  });

  await test('with only August open, the plain link is August', async () => {
    const r = await call(store(true, false), 'GET');
    assert.equal(r.body.testing, 'aug-2026');
    assert.deepEqual(r.body.groups.map((g) => g.id), ['a1', 'a2']);
  });

  await test("a testing's own link opens it, finished or not, as a record", async () => {
    const r = await call(store(false, true), 'GET', '?t=aug-2026');
    assert.equal(r.body.testing, 'aug-2026');
    assert.deepEqual(r.body.groups.map((g) => g.id), ['a1', 'a2']);
    assert.equal(r.body.selling, false);
  });

  await test("a closed testing's own link takes no money", async () => {
    const s = store(true, false);
    const r = await call(s, 'POST', '?t=nov-2026', signup('n2', 'White Belt'));
    assert.equal(r.status, 409);
    assert.equal(s.pos_sales.length, 0);
  });

  await test('late payers still pay on an open past testing through its own link', async () => {
    const s = store(true, true);
    const r = await call(s, 'POST', '?t=aug-2026', signup('a2', 'White Belt'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(s.testing_signups[0].testing_date_id, 'a2');
  });

  await test('the plain link will not sell a seat in a testing it is not showing', async () => {
    const s = store(true, true);
    const r = await call(s, 'POST', '', signup('a2', 'White Belt'));
    assert.equal(r.status, 400);
    assert.equal(s.pos_sales.length, 0);
  });

  await test('the page passes its testing on every call to the server', () => {
    assert.match(PAGE, /new URLSearchParams\(location\.search\)\.get\("t"\)/);
    const calls = PAGE.match(/fetch\(FN[_A-Z]*,/g) || [];
    assert.equal(calls.length, 3, 'expected the load, the signup and the finalize');
    assert.ok(calls.every((c) => c === 'fetch(FN_T,'), 'a call goes to the plain link: ' + calls.join(' '));
  });

  await test('a finished testing renders as a record, never the form', () => {
    assert.match(PAGE, /id="tst-finished"/);
    assert.match(PAGE, /if \(cfg\.selling === false\) \{ renderFinished\(\); return; \}/);
  });

  await test('a testing still to come never reads as finished', () => {
    const fn = /function renderFinished\(\) \{[\s\S]*?\n  \}/.exec(PAGE)[0];
    assert.match(fn, /String\(g\.test_date\) >= today/);
    assert.match(fn, /Registration is not open yet/);
  });

  await test('each testing has its own week, and only that one shows', () => {
    const blocks = PAGE.match(/data-cycle="[a-z]{3}-\d{4}" hidden/g) || [];
    assert.deepEqual(blocks.map((b) => b.slice(12, 20)), ['nov-2026', 'aug-2026']);
    assert.match(PAGE, /showWeek\(cfg\.testing\)/);
  });

  console.log('\n' + passed + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
})();
