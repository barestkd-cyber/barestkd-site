/* ============================================================================
 * update-card - a dead card link says so before anybody types a card
 * ----------------------------------------------------------------------------
 * Plain Node. Run from the barestkd-site repo root:
 *     node tests/update-card.test.js
 *
 * Owner, 2026-10-28: a mom typed her new card into a link that had run out,
 * pressed save, and the page answered "expired" under the card box. It read
 * as her card being expired. The page now asks about the link as it opens.
 * The real page script runs in a vm against a fake card-setup and Stripe.
 * ========================================================================== */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'update-card', 'index.html'), 'utf8');
const SCRIPT = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
const TOKEN = 'ab'.repeat(16);

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

// Opens the page with one card-setup answer per call, in order.
async function open(answers) {
  const els = {};
  const node = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', disabled: false,
    on: {}, addEventListener(t, fn) { this.on[t] = fn; }, focus() {} });
  ['nm', 'em', 'hp'].forEach(node);
  const calls = [];
  let mounted = false;
  const ctx = vm.createContext({
    document: { getElementById: node },
    location: { search: '?t=' + TOKEN },
    URLSearchParams, window: { scrollTo() {} },
    fetch: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      const a = answers.shift() || {};
      return { json: async () => a };
    },
    Stripe: () => ({
      elements: () => ({ create: () => ({ mount() { mounted = true; }, on() {} }) }),
      confirmCardSetup: async () => ({ setupIntent: { id: 'seti_1', status: 'succeeded' } }),
    }),
  });
  vm.runInContext(SCRIPT, ctx);
  await settle();
  return { els, calls, mounted: () => mounted, root: els.root, err: els.err };
}

(async () => {
  await test('an expired link says the link expired, and never shows the card field', async () => {
    const p = await open([{ error: 'expired', message: 'This link has expired. Ask the studio for a new one.' }]);
    assert.equal(p.calls[0].action, 'config');
    assert.equal(p.calls[0].token, TOKEN, 'the page opened without checking its link');
    assert.ok(p.root.innerHTML.includes('This link has expired'), p.root.innerHTML);
    assert.ok(p.root.innerHTML.includes('not your card'), 'it does not say the card is not the problem');
    assert.equal(p.mounted(), false, 'the card field was shown on a dead link');
  });

  await test('a link the studio does not have says so as it opens', async () => {
    const p = await open([{ error: 'That link is not valid.', code: 'invalid' }]);
    assert.ok(p.root.innerHTML.includes('Link not valid'), p.root.innerHTML);
    assert.equal(p.mounted(), false);
  });

  await test('a live link opens the card field', async () => {
    const p = await open([{ publishable_key: 'pk_test' }]);
    assert.equal(p.mounted(), true);
    assert.equal(p.root.innerHTML, '', 'a live link was replaced');
    assert.equal(p.err.textContent, '');
  });

  await test('a link that runs out while the page is open says so in place of the form', async () => {
    const p = await open([{ publishable_key: 'pk_test' }, { error: 'expired', message: 'x' }]);
    p.els.nm.value = 'Pat Example';
    p.els.em.value = 'pat@example.com';
    p.els.go.on.click();
    await settle();
    assert.ok(p.root.innerHTML.includes('This link has expired'), p.root.innerHTML);
    assert.notEqual(p.err.textContent, 'expired', '"expired" sat under the card box again');
  });

  await test('the page copy has no em dashes', () => {
    assert.ok(!SCRIPT.includes('—'), 'an em dash in the page script');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
})();
