/* ============================================================================
 * program-checkout - the retry after a failed payment (audit A04)
 * ----------------------------------------------------------------------------
 * Plain Node. Run from the barestkd-site repo root:
 *     node tests/program-checkout-retry.test.js
 *
 * Same layer as tests/cubs-checkout.test.js: source assertions, no network.
 *
 * The branch under test runs when a family comes back to an unpaid sale. It
 * had two faults, and the ORDER of the guards is the whole correctness
 * property, so these assert positions rather than mere presence.
 *
 *   1. It recognised only the three "not paid yet" intent states. A SUCCEEDED
 *      intent whose sale was not yet marked paid - the ordinary webhook delay -
 *      fell through to "mint a fresh intent", showing the card field to a
 *      parent who had already paid.
 *   2. The fresh intent carried no customer and no setup_future_usage, so a
 *      family who succeeded on the retry enrolled with no card on file. Since
 *      2026-09-09 a membership charges its own pinned card or nothing, so
 *      those families would never bill at all.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SITE = path.join(__dirname, '..');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
}

const src = fs.readFileSync(path.join(SITE, 'supabase', 'functions', 'program-checkout', 'index.ts'), 'utf8');

// The block that creates a replacement intent for an unpaid sale.
const freshAt = src.indexOf('rf.set("metadata[sale_id]", saleId)');
assert.ok(freshAt > 0, 'could not locate the retry intent block - this test needs rewriting');

test('the retry can see the customer the first attempt created', () => {
  assert.ok(
    /\.select\("id,view_token,status,total_cents,stripe_payment_intent,stripe_customer_id"\)/.test(src),
    'the unpaid-sale lookup must read stripe_customer_id, or the retry has no customer to attach',
  );
});

test('a SUCCEEDED intent stops the retry before it can charge again', () => {
  const at = src.indexOf('pi0.status === "succeeded"');
  assert.ok(at > 0, 'no guard for an intent that already succeeded');
  assert.ok(at < freshAt, 'the succeeded guard must come BEFORE a fresh intent is minted');
});

test('an in-flight (processing) intent stops the retry too', () => {
  const at = src.indexOf('pi0.status === "processing"');
  assert.ok(at > 0, 'no guard for an intent still processing');
  assert.ok(at < freshAt, 'the processing guard must come BEFORE a fresh intent is minted');
});

test('the succeeded branch reports the sale paid rather than asking again', () => {
  // Bounded by the next guard, not by freshAt: the prose between them
  // mentions client_secret, and a comment is not a code path.
  const from = src.indexOf('pi0.status === "succeeded"');
  const to = src.indexOf('pi0.status === "processing"');
  assert.ok(to > from, 'expected the processing guard to follow the succeeded one');
  const seg = src.slice(from, to);
  assert.ok(/paid:\s*true/.test(seg), 'a succeeded payment must be reported as paid');
  assert.ok(/receipt_url/.test(seg), 'and must hand back the receipt');
  assert.ok(!/client_secret/.test(seg), 'it must NOT hand back anything payable');
});

test('the retry intent keeps the card on file', () => {
  const seg = src.slice(freshAt, freshAt + 1200);
  assert.ok(/rf\.set\("customer"/.test(seg),
    'the retry must attach the Stripe customer, or no card is saved');
  assert.ok(/rf\.set\("setup_future_usage", "off_session"\)/.test(seg),
    'the retry must save the card for later, like every other enrollment path');
});

test('the retry reuses the ORIGINAL customer, it does not invent one', () => {
  const seg = src.slice(freshAt, freshAt + 1200);
  assert.ok(/existing\.data\.stripe_customer_id/.test(seg),
    'the retry must land on the same customer as the attempt it is retrying');
});

test('the retry is distinguishable in Stripe from a first attempt', () => {
  const seg = src.slice(freshAt, freshAt + 1200);
  assert.ok(/program-checkout-retry/.test(seg),
    'tag the retry so a double charge can be traced back to this path');
});

test('the normal enrollment path still saves the card', () => {
  // Guards the thing the retry was missing, so the two cannot drift apart.
  assert.ok(/f\.set\("setup_future_usage", "off_session"\)/.test(src));
  assert.ok(/f\.set\("customer", fam\.custId\)/.test(src));
});

console.log('program-checkout-retry: ' + passed + ' passed, ' + failed + ' failed');
