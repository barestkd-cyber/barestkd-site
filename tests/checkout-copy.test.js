/* ============================================================================
 * Checkout page copy lint
 * ----------------------------------------------------------------------------
 *     node tests/checkout-copy.test.js
 *
 * WHY THIS EXISTS: the Cubs page was built by copying the Little Kickers page,
 * and two strings came along unnoticed. The student heading said "Your Little
 * Kicker", and worse, the consent line beside the signature checkbox read "I
 * have read and agree to the Little Kickers Membership Agreement ... the
 * session is paid in full today" on a page selling a twelve-month Cubs
 * membership. The AGREEMENT itself was always correct (it renders from the
 * cubs template and the server freezes the same one), but a buyer would have
 * ticked a box naming the wrong program under the wrong payment terms.
 *
 * Every checkout page after this one gets cloned from an existing page too.
 * This test makes that specific mistake impossible to ship: a page may only
 * name its OWN program.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SITE = path.join(__dirname, '..');
let passed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); process.exitCode = 1; }
}

/* Each checkout page, the program it sells, and the phrases that belong to
 * OTHER programs. Add a row when a new checkout page ships. */
const PAGES = [
  { dir: 'little-kickers-checkout', program: 'Little Kickers', templateKey: 'little_kickers' },
  // forbidPhrases: CONCEPTS that belong to another program, not just names.
  // Cubs shipped twice with parent-and-me wording ("Who's training with
  // you", "You're on the mat too") because the name lint could not see it.
  { dir: 'cubs-checkout', program: 'Cubs', templateKey: 'cubs',
    forbidPhrases: ['training with you', 'on the mat too', 'grown-up', 'Grown-Up',
      'parent and me', 'Parent & Me', 'parent-and-me', 'six-week', '6-week session',
      'not a drop-off'] },
];

const OTHER_PROGRAMS = ['Little Kickers', 'Cubs', 'Juniors', 'Teens & Adults', 'Kickboxing', 'Jiu Jitsu', "AMP'D"];

/* Strip anything that legitimately mentions another program: asset paths, the
 * shared site navigation, and the footer. What is left is this page's own
 * copy. */
function ownCopy(html) {
  let h = html;
  h = h.replace(/<header[\s\S]*?<\/header>/gi, '');
  h = h.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');   // template data + logic
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/(src|href)="[^"]*"/gi, '');
  return h;
}

for (const page of PAGES) {
  const file = path.join(SITE, page.dir, 'index.html');
  if (!fs.existsSync(file)) { test(page.dir + ' exists', () => assert.fail('missing ' + file)); continue; }
  const html = fs.readFileSync(file, 'utf8');
  const body = ownCopy(html);

  test(page.dir + ': names no other program in its own copy', () => {
    const strays = OTHER_PROGRAMS
      .filter((p) => p !== page.program)
      .filter((p) => body.includes(p));
    assert.deepStrictEqual(strays, [],
      'found another program named in the page copy: ' + strays.join(', '));
  });

  test(page.dir + ': the consent line names ITS OWN agreement', () => {
    const m = /I have read and agree to the ([^,.]+?) Membership Agreement/.exec(body);
    assert.ok(m, 'no agreement consent sentence found');
    assert.strictEqual(m[1].trim(), page.program,
      'consent names "' + m[1].trim() + '" on the ' + page.program + ' page');
  });

  test(page.dir + ': renders the right agreement template', () => {
    // The document itself comes from agreements.js by key. A page pointing at
    // the wrong key would show the wrong contract entirely.
    assert.ok(html.includes('"' + page.templateKey + '"'),
      'page does not select template key ' + page.templateKey);
    const otherKeys = PAGES.map((p) => p.templateKey).filter((k) => k !== page.templateKey);
    otherKeys.forEach((k) => {
      assert.ok(!html.includes('=== "' + k + '"'),
        'page also selects the ' + k + ' template');
    });
  });

  test(page.dir + ': payment terms in the consent match the program', () => {
    const consent = /I have read and agree to the[\s\S]{0,400}?<\/span>/.exec(body);
    assert.ok(consent, 'no consent block found');
    const txt = consent[0];
    if (page.program === 'Little Kickers') {
      assert.ok(/paid in full/.test(txt), 'session program should say paid in full');
      assert.ok(!/12-month|twelve/i.test(txt), 'session program must not claim a 12-month term');
    } else {
      assert.ok(/12-month|twelve/i.test(txt), 'membership program should state its term');
      assert.ok(!/the session is paid in full/i.test(txt), 'membership must not use session wording');
    }
  });

  test(page.dir + ': no borrowed concepts from another program', () => {
    const strays = (page.forbidPhrases || []).filter((ph) => body.includes(ph));
    assert.deepStrictEqual(strays, [],
      'phrases from another program: ' + strays.join(' | '));
  });

  test(page.dir + ': no em dashes in the page', () => {
    assert.ok(!html.includes(String.fromCharCode(8212)), 'em dash found');
  });
}

console.log('\n' + passed + ' passed');
