/* ============================================================================
 * barestkd-site — Little Kickers checkout tests
 * ----------------------------------------------------------------------------
 * Plain Node, no framework. Run from the barestkd-site repo root:
 *
 *     node tests/lk-checkout.test.js
 *
 * What must never drift:
 *   1. The vendored agreement template === the CRM's generated one. The web
 *      page and the front desk must freeze the SAME attorney-approved text.
 *   2. The vendored pricing engine === the CRM's vendored copy, byte for
 *      byte. One engine prices every sale.
 *   3. The money math the function performs (fee on the pre-tax base, tax on
 *      the shirt only, session fee never taxed).
 *   4. The frozen body_text really is the whole document with the real
 *      amounts — the thing a parent's lawyer would be handed later.
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

/* ── the vendored copies ────────────────────────────────────────────────────*/
const vendoredSrc = fs.readFileSync(path.join(SITE, 'supabase/functions/_shared/lk_agreement.js'), 'utf8');
const vendored = JSON.parse(vendoredSrc.slice(vendoredSrc.indexOf('export default ') + 'export default '.length).replace(/;\s*$/, ''));
const A = require(path.join(CRM, 'agreements.js'));
const crmTpl = A.TEMPLATES.find((t) => t.key === 'little_kickers');

test('vendored LK template is IDENTICAL to the CRM template', () => {
  assert.ok(crmTpl, 'CRM has no little_kickers template');
  assert.deepStrictEqual(vendored, crmTpl,
    'drifted — run: node tools/vendor-lk.js && supabase functions deploy lk-checkout');
});

test('vendored pricing engine is byte-identical to the CRM copy', () => {
  const site = fs.readFileSync(path.join(SITE, 'supabase/functions/_shared/pricing_esm.js'), 'utf8');
  const crm = fs.readFileSync(path.join(CRM, 'supabase/functions/_shared/pricing_esm.js'), 'utf8');
  assert.strictEqual(site, crm,
    'drifted — run: node tools/vendor-lk.js && supabase functions deploy lk-checkout');
});

/* ── lift the function's own money + document code and run it ──────────────*/
const fnSrc = fs.readFileSync(path.join(SITE, 'supabase/functions/lk-checkout/index.ts'), 'utf8');
// Strip the TS annotations BEFORE lifting — the ctx parameter's object type
// has braces of its own, and lifting first would mistake it for the body.
const cleaned = (() => {
  let s = fnSrc;
  const a = s.indexOf('ctx: {');
  if (a !== -1) {
    const b = s.indexOf('}): string', a);
    s = s.slice(0, a) + 'ctx)' + s.slice(b + '}): string'.length);
  }
  return s
    .replace(/: typeof LK_TEMPLATE/g, '')
    .replace(/ as string\[\]/g, '')
    .replace(/ as Array<\{ h; p \}>/g, '')                    // post-strip remnant
    .replace(/ as Array<\{ h: string; p: string\[\] \}>/g, '')
    .replace(/: (number|string|boolean|unknown)(\[\])?/g, '');
})();
function lift(name) {
  const i = cleaned.indexOf('function ' + name + '(');
  assert.ok(i !== -1, 'could not lift ' + name);
  let d = 0, s = cleaned.indexOf('{', i);
  for (let j = s; j < cleaned.length; j++) {
    if (cleaned[j] === '{') d++;
    if (cleaned[j] === '}') { d--; if (!d) return cleaned.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}
const money = (c) => '$' + (c / 100).toFixed(2);
void money; // closed over by the evaled buildBodyText
const adminFeeCents = eval('(' + lift('adminFeeCents') + ')');
const buildBodyText = eval('(' + lift('buildBodyText') + ')');

const P = require(path.join(CRM, 'pricing.js'));

test('money: session only — $109 + $3.46 card fee, no tax', () => {
  const fee = adminFeeCents(10900, 290, 30);
  assert.strictEqual(fee, 346, 'fee: ' + fee);
  const t = P.invoiceTotals({ lines: [{ cents: 10900, taxable: false }], discountCents: 0, adminFeeCents: fee, taxRate: 0.0825 });
  assert.strictEqual(t.taxCents, 0, 'the session fee must never be taxed');
  assert.strictEqual(t.totalCents, 11246, 'total: ' + t.totalCents);
});

test('money: with the shirt — fee on the pre-tax base, tax on the shirt only', () => {
  const fee = adminFeeCents(10900 + 2500, 290, 30);
  assert.strictEqual(fee, 419, 'fee: ' + fee); // round(13400*.029)=389 (+30)
  const t = P.invoiceTotals({
    lines: [{ cents: 10900, taxable: false }, { cents: 2500, taxable: true }],
    discountCents: 0, adminFeeCents: fee, taxRate: 0.0825,
  });
  assert.strictEqual(t.taxCents, 206, 'tax: ' + t.taxCents); // 2500*.0825=206.25 → 206
  assert.strictEqual(t.totalCents, 10900 + 2500 + 419 + 206, 'total: ' + t.totalCents);
  // The fee itself is never in the tax base.
  const noFee = P.invoiceTotals({ lines: [{ cents: 10900, taxable: false }, { cents: 2500, taxable: true }], discountCents: 0, adminFeeCents: 0, taxRate: 0.0825 });
  assert.strictEqual(noFee.taxCents, t.taxCents, 'adding the fee changed the tax');
});

test('money: gray tee rides at half price — tax on the discounted price', () => {
  assert.ok(/GRAY_TEE_NAME = "Classic gray tee"/.test(fnSrc), 'gray tee const missing');
  assert.ok(/TEE_DISCOUNT_BPS = 5000/.test(fnSrc), 'the 50% enrollment discount is missing');
  const grayNow = Math.round(2500 * (10000 - 5000) / 10000);
  assert.strictEqual(grayNow, 1250, 'half of $25 is $12.50');
  const fee = adminFeeCents(10900 + 1250, 290, 30);
  assert.strictEqual(fee, 382, 'fee: ' + fee); // round(12150*.029)=352 (+30)
  const t = P.invoiceTotals({ lines: [{ cents: 10900, taxable: false }, { cents: 1250, taxable: true }], discountCents: 0, adminFeeCents: fee, taxRate: 0.0825 });
  assert.strictEqual(t.taxCents, 103, 'tax: ' + t.taxCents); // 1250*.0825=103.125 → 103
  assert.strictEqual(t.totalCents, 10900 + 1250 + 382 + 103, 'total: ' + t.totalCents);
});

test('money: both shirts — white full price, gray half, one tax rounding', () => {
  const fee = adminFeeCents(10900 + 2500 + 1250, 290, 30);
  assert.strictEqual(fee, 455, 'fee: ' + fee); // round(14650*.029)=425 (+30)
  const t = P.invoiceTotals({
    lines: [{ cents: 10900, taxable: false }, { cents: 2500, taxable: true }, { cents: 1250, taxable: true }],
    discountCents: 0, adminFeeCents: fee, taxRate: 0.0825,
  });
  assert.strictEqual(t.taxCents, 309, 'tax: ' + t.taxCents); // 3750*.0825=309.375 → 309
  assert.strictEqual(t.totalCents, 14650 + 455 + 309, 'total: ' + t.totalCents);
});

test('the frozen body_text is the whole executed document', () => {
  const txt = buildBodyText(vendored, {
    participant: 'Riley Test', dob: '05-04-2024', guardian: 'Pat Test',
    today: '08-16-2026', sessionStart: '09-16-2026', sessionEnd: '10-21-2026',
    priceCents: 10900, signerName: 'Pat Test', signerRelationship: 'Parent',
  });
  assert.ok(/LITTLE KICKERS MEMBERSHIP AGREEMENT/.test(txt), 'title missing');
  assert.ok(/single payment of \$109\.00/.test(txt), 'the real amount is not in the FEES text');
  assert.ok(!/\$________/.test(txt), 'an unfilled money blank survived');
  assert.ok(/Riley Test/.test(txt) && /Pat Test/.test(txt), 'names missing');
  assert.ok(/Session Start Date: 09-16-2026/.test(txt) && /Session End Date: 10-21-2026/.test(txt), 'session dates missing');
  assert.ok(/Smith County, Texas/.test(txt), 'waiver venue clause missing');
  assert.ok(/may not be cancelled/.test(txt), 'the non-cancellable term is missing');
  assert.ok(/no recurring/.test(txt), 'the no-recurring-charges sentence is missing');
  // The full LK document measures ~7.9k chars (it is the shortest of the six
  // agreements — no cancellation-fee machinery). Guard well below that.
  assert.ok(txt.length > 7000, 'document looks truncated: ' + txt.length + ' chars');
});

test('the function never trusts client HTML for the stored document', () => {
  // body_text must come from buildBodyText(LK_TEMPLATE…), not from the body.
  assert.ok(/body_text: bodyText/.test(fnSrc), 'body_text is not the server render');
  assert.ok(!/body_text:\s*str\(body/.test(fnSrc), 'body_text taken from the client');
});

test('function source: braces balanced, idempotency + fee + roster present', () => {
  let d = 0;
  for (const c of fnSrc) { if ('{(['.includes(c)) d++; if ('})]'.includes(c)) d--; }
  assert.strictEqual(d, 0, 'unbalanced brackets: ' + d);
  assert.ok(/eq\("id", saleId\)\.maybeSingle/.test(fnSrc), 'no idempotency check on sale_id');
  assert.ok(/admin_fee_cents: fee/.test(fnSrc), 'the card fee is not on the sale');
  assert.ok(/from\("enrollments"\)/.test(fnSrc), 'no roster enrollment');
  assert.ok(/--no-verify-jwt/.test(fnSrc), 'deploy note lost the --no-verify-jwt flag');
});

console.log('\n' + passed + ' passed');
