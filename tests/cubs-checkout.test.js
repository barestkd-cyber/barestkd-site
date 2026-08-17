/* ============================================================================
 * cubs-checkout - source assertions for the Cubs self-serve enrollment
 * ----------------------------------------------------------------------------
 * Plain Node. Run from the barestkd-site repo root:
 *     node tests/cubs-checkout.test.js
 *
 * Same layer as tests/lk-checkout.test.js: no network, no Deno. It proves the
 * vendored agreement can't drift from the CRM's, the function only trusts the
 * catalog, and the page sends choices rather than amounts.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SITE = path.join(__dirname, '..');
const CRM = path.join(SITE, '..', 'BaresCRM');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); process.exitCode = 1; }
}

const fnSrc = fs.readFileSync(path.join(SITE, 'supabase', 'functions', 'cubs-checkout', 'index.ts'), 'utf8');
const page = fs.readFileSync(path.join(SITE, 'cubs-checkout', 'index.html'), 'utf8');

test('vendored cubs agreement is byte-identical to the CRM template', () => {
  const vend = fs.readFileSync(path.join(SITE, 'supabase', 'functions', '_shared', 'cubs_agreement.js'), 'utf8');
  const tplVendored = JSON.parse(vend.slice(vend.indexOf('export default ') + 15).replace(/;\s*$/, ''));
  const A = require(path.join(CRM, 'agreements.js'));
  const tplCrm = A.TEMPLATES.find((t) => t.key === 'cubs');
  assert.ok(tplCrm, 'CRM has no cubs template');
  assert.deepStrictEqual(tplVendored, tplCrm,
    'vendored copy drifted - run node tools/vendor-lk.js and redeploy cubs-checkout');
});

test('the agreement the buyer signs still authorizes ACH and names the entity', () => {
  const vend = fs.readFileSync(path.join(SITE, 'supabase', 'functions', '_shared', 'cubs_agreement.js'), 'utf8');
  const tpl = JSON.parse(vend.slice(vend.indexOf('export default ') + 15).replace(/;\s*$/, ''));
  const tail = tpl.feesTail.join(' ');
  assert.ok(/electronic debit \(ACH\)/.test(tail), 'ACH authorization missing');
  assert.ok(/Grizzly Martial Arts & Fitness LLC/.test(tail), 'legal entity missing');
  assert.strictEqual(tpl.term, 'twelve_month', 'cubs is a twelve-month agreement');
});

test('the function prices from the catalog, never from the client', () => {
  assert.ok(/from\("pricing_plans"\)/.test(fnSrc), 'does not read pricing_plans');
  assert.ok(/eq\("program", PROGRAM\).eq\("sellable", true\).eq\("active", true\)/.test(fnSrc),
    'catalog read is not restricted to sellable active Cubs rows');
  assert.ok(/options\.find\(\(p\) => p\.code === str\(body\.plan_code\)\)/.test(fnSrc),
    'chosen plan is not validated against the catalog');
  assert.ok(!/body\.(amount|price|total|due)/.test(fnSrc), 'reads an amount from the client');
  assert.ok(/dueTodayCents/.test(fnSrc), 'due today must come from the engine (down + first payment)');
});

test('the card is saved for the recurring payments the buyer just signed up for', () => {
  assert.ok(/setup_future_usage/.test(fnSrc), 'card not saved for off-session use');
  assert.ok(/stripe\("customers", secretKey/.test(fnSrc), 'no Stripe customer created');
  assert.ok(/stripe_customer_id/.test(fnSrc), 'customer id not stored');
});

test('guardian, initials, signature, and agreement box are all hard requirements', () => {
  assert.ok(/Enter the parent or guardian's name/.test(fnSrc), 'guardian not required (Cubs is ages 3-4)');
  assert.ok(/signer_initials: initials/.test(fnSrc), 'initials not stored on the agreement');
  assert.ok(/body\.agreed !== true/.test(fnSrc), 'agreement checkbox not enforced');
  assert.ok(/signature\.startsWith\("data:image\/png;base64,"\)/.test(fnSrc), 'signature not validated');
});

test('the frozen document records every option plus the selected one', () => {
  assert.ok(/for \(const p of ctx\.options\) out\.push\(optionLine\(p\)\)/.test(fnSrc),
    'the stored agreement does not list all options like the paper form');
  assert.ok(/Selected option: /.test(fnSrc), 'selected option not recorded');
  assert.ok(/Payment date: /.test(fnSrc), 'agreed payment date not recorded');
});

test('sale before membership (the FK order that failed the first LK launch)', () => {
  const saleAt = fnSrc.indexOf('from("pos_sales").insert');
  const memAt = fnSrc.indexOf('from("memberships").insert');
  assert.ok(saleAt !== -1 && memAt !== -1 && saleAt < memAt, 'membership inserted before its sale');
});

test('the page sends a plan code and never an amount', () => {
  const m = /<script>([\s\S]*)<\/script>/.exec(page);
  const js = m[1];
  assert.ok(/plan_code: CHOSEN\.code/.test(js), 'plan code not sent');
  assert.ok(!/amount|total_cents:/.test(js.split('body: JSON.stringify({')[1].split('})')[0]),
    'the enrollment payload carries an amount');
  assert.ok(/cbc-initials/.test(page), 'initials field missing');
  assert.ok(!/tshirt|shirtDesign/.test(js), 'LK shirt logic leaked into the Cubs page');
  assert.ok(/functions\/v1\/cubs-checkout/.test(js), 'page posts to the wrong function');
});

test('no em dashes anywhere a customer reads', () => {
  const EM = String.fromCharCode(8212);
  assert.strictEqual((page.match(new RegExp(EM, 'g')) || []).length, 0, 'em dash in the page');
  assert.strictEqual((fnSrc.match(new RegExp(EM, 'g')) || []).length, 0, 'em dash in the function');
});

test('function source: braces balanced', () => {
  let d = 0;
  for (const c of fnSrc) { if ('{(['.includes(c)) d++; if ('})]'.includes(c)) d--; }
  assert.strictEqual(d, 0);
});

console.log('\n' + passed + ' passed');
