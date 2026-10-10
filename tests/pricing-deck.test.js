/* ============================================================================
 * pricing-deck - the numbers a checkout page's presentation quotes
 * ----------------------------------------------------------------------------
 *     node tests/pricing-deck.test.js
 *
 * The real handler against a fake database, plus the six pages that carry
 * the "View pricing and policies" button. Never contacts a network.
 *
 * Owner, 2026-10-10: "the pricing and policies as a clickable presentation
 * where the pdf would be". The slides are the CRM's presentation.js; this
 * function hands them the catalog, and the Cubs page stays as it was.
 * ========================================================================== */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');

const SITE = path.join(__dirname, '..');
const SRC = stripTypeScriptTypes(
  fs.readFileSync(path.join(SITE, 'supabase', 'functions', 'pricing-deck', 'index.ts'), 'utf8').replace(/^import .*;\r?\n/gm, ''));

function db(s) {
  return {
    from(table) {
      const eqs = {}, ins = {}; let single = false;
      const q = {
        select() { return q; }, order() { return q; },
        eq(k, v) { eqs[k] = v; return q; }, in(k, v) { ins[k] = v; return q; },
        maybeSingle() { single = true; return q; },
        then(resolve, reject) {
          const rows = (s[table] || []).filter((r) => Object.entries(eqs).every(([k, v]) => r[k] === v)
            && Object.entries(ins).every(([k, v]) => v.includes(r[k])));
          return Promise.resolve({ data: single ? (rows[0] || null) : rows, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}
async function call(s, query) {
  let handler;
  const ctx = vm.createContext({
    createClient: () => db(s),
    Deno: { serve: (fn) => { handler = fn; }, env: { get: () => 'x' } },
    URL, Response, Request, Promise, Set, Date, String, JSON, Object, Array, console: { error() {} },
  });
  vm.runInContext(SRC, ctx);
  const res = await handler(new Request('https://t.invalid/pricing-deck' + query, { headers: { Origin: 'https://www.barestkd.fit' } }));
  return { status: res.status, body: await res.json(), cache: res.headers.get('Cache-Control') };
}
const store = () => ({
  pricing_plans: [
    { code: 'juniors_pif', active: true, pif_cents: 140000, billing_frequency: 'one_time' },
    { code: 'juniors_option_c', active: true, down_cents: 25900, recurring_cents: 11000, billing_frequency: 'monthly' },
    { code: 'old_plan', active: false, recurring_cents: 1 },
  ],
  products: [
    { name: 'Beginner uniform', price_cents: 8225, active: true },
    { name: 'Classic gray tee', price_cents: 2500, active: true },
    { name: 'Sparring gear package', price_cents: 24250, active: true },
  ],
  pricing_settings: [
    { key: 'admin_fee_bps', value_cents: 290 }, { key: 'testing_fee_standard_cents', value_cents: 6000 },
    { key: 'household_specialty_discount_cents', value_cents: 1000 },
  ],
  schedule_template: [
    { day: 0, time_h: 17, time_m: 45, duration: 60, program: 'Kickboxing', ends_on: null },
    { day: 2, time_h: 9, time_m: 0, duration: 45, program: 'Kickboxing', ends_on: '2025-01-01' },
  ],
  program_sessions: [{ id: 's1', program: 'Little Kickers', status: 'open', starts_on: '2026-10-21', weeks: 6 }],
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a deck gets the live catalog, the products it prices, its settings and the live class times', async () => {
  const r = await call(store(), '?deck=kickboxing');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.plans.map((p) => p.code), ['juniors_pif', 'juniors_option_c'], 'an inactive plan went out');
  assert.deepEqual(r.body.products.map((p) => p.name), ['Beginner uniform', 'Sparring gear package'], 'a shirt is not a deck price');
  assert.deepEqual(r.body.settings, { admin_fee_bps: 290, testing_fee_standard_cents: 6000 }, 'a setting a deck never reads went out');
  assert.equal(r.body.classes.length, 1, 'an ended class went out');
  assert.equal(r.body.session, null, 'only Little Kickers reads a session');
  assert.ok(/max-age/.test(r.cache || ''), 'the numbers should cache for a few minutes');
});

test('Little Kickers gets its open session; an unknown deck is refused', async () => {
  const r = await call(store(), '?deck=lk');
  assert.equal(r.body.session.id, 's1');
  assert.equal((await call(store(), '?deck=nope')).status, 400);
  assert.equal((await call(store(), '')).status, 400);
});

test('six pages carry the button and load the shared deck; Cubs keeps its PDF link', () => {
  for (const dir of ['juniors-checkout', 'teens-adults-checkout', 'kickboxing-checkout', 'jiu-jitsu-checkout', 'ampd-checkout', 'little-kickers-checkout']) {
    const html = fs.readFileSync(path.join(SITE, dir, 'index.html'), 'utf8');
    assert.ok(html.includes('id="cbc-deck">View pricing and policies'), dir + ' has no button');
    assert.ok(html.includes('https://crm.barestkd.fit/presentation.js'), dir + ' does not load the shared deck');
    assert.ok(html.includes('functions/v1/pricing-deck?deck='), dir + ' does not fetch the numbers');
    assert.ok(/var DECK = "(tkd|kickboxing|jiujitsu|ampd|lk)"/.test(html), dir + ' names no deck');
  }
  const cubs = fs.readFileSync(path.join(SITE, 'cubs-checkout', 'index.html'), 'utf8');
  assert.ok(!cubs.includes('cbc-deck') && cubs.includes('cubs-pricing.pdf'), 'the Cubs page changed');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok   ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e && e.message).split('\n')[0]); }
  }
  console.log(failed ? '\n' + failed + ' FAILED' : '\nall ' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
