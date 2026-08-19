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
 * This test makes that specific mistake impossible to ship.
 *
 * TWO KINDS OF PAGE (added 2026-08-19 with the belt-testing page):
 *
 *   kind: 'enrollment'  sells ONE program's membership. It must name only its
 *                       own program and its consent line must match it.
 *   kind: 'event'       sells a seat at a dated event. A belt testing is for
 *                       Cubs, Juniors, Teens and Adults on the same page, so
 *                       naming several programs is CORRECT, not a leak. These
 *                       pages carry no membership agreement: the people
 *                       signing up are already members who signed one.
 *
 * The checks that survive on every page regardless of kind are the ones about
 * house style, because those never depend on what is being sold.
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

/* Each checkout page, what it sells, and the phrases that belong to OTHER
 * programs. Add a row when a new checkout page ships. */
const PAGES = [
  { dir: 'little-kickers-checkout', kind: 'enrollment', program: 'Little Kickers', templateKey: 'little_kickers' },
  // forbidPhrases: CONCEPTS that belong to another program, not just names.
  // Cubs shipped twice with parent-and-me wording ("Who's training with
  // you", "You're on the mat too") because the name lint could not see it.
  { dir: 'cubs-checkout', kind: 'enrollment', program: 'Cubs', templateKey: 'cubs',
    forbidPhrases: ['training with you', 'on the mat too', 'grown-up', 'Grown-Up',
      'parent and me', 'Parent & Me', 'parent-and-me', 'six-week', '6-week session',
      'not a drop-off'] },
  // The testing page is an EVENT page: it names every program on purpose,
  // because every program tests. What it must never do is grow enrollment
  // wording, which would mean somebody cloned it from the wrong page.
  { dir: 'testing-checkout', kind: 'event', program: 'Belt Testing',
    forbidPhrases: ['Membership Agreement', 'membership agreement', 'auto-renew',
      'automatically renews', '12-month', 'twelve (12) month', 'down payment',
      'paid in full at enrollment', 'cancellation notice'] },
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

  /* ── enrollment-only: one program, one agreement ────────────────────────*/
  if (page.kind !== 'event') {
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
      const otherKeys = PAGES.map((p) => p.templateKey).filter((k) => k && k !== page.templateKey);
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
  }

  /* ── event-only: no membership machinery may creep in ───────────────────*/
  if (page.kind === 'event') {
    test(page.dir + ': carries no membership agreement machinery', () => {
      // These pages take a fee for a dated event. If a signature pad or a
      // consent-to-an-agreement line shows up here, somebody cloned an
      // enrollment page and the buyer is being asked to sign something that
      // does not exist.
      assert.ok(!/Membership Agreement/i.test(body),
        'an event page is asking the buyer to agree to a membership agreement');
      assert.ok(!/signature/i.test(body),
        'an event page is collecting a signature');
    });

    test(page.dir + ': tells the buyer when to show up', () => {
      // The single most important thing this page does after taking money.
      assert.ok(/tst-sched|schedule|group/i.test(body),
        'no schedule or group information on an event signup page');
    });
  }

  /* ── every page, regardless of kind ─────────────────────────────────────*/
  test(page.dir + ': no borrowed concepts from another program', () => {
    const strays = (page.forbidPhrases || []).filter((ph) => body.includes(ph));
    assert.deepStrictEqual(strays, [],
      'phrases from another program: ' + strays.join(' | '));
  });

  test(page.dir + ': no em dashes in the page', () => {
    assert.ok(!html.includes(String.fromCharCode(8212)), 'em dash found');
  });

  test(page.dir + ': is noindex, since these are link-only pages', () => {
    assert.ok(/<meta\s+name="robots"\s+content="noindex"/i.test(html),
      'checkout pages are handed out by link and must not be indexed');
  });
}

console.log('\n' + passed + ' passed');
