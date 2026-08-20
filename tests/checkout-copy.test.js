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
 * Every checkout page is generated from an existing one. This test makes that
 * specific mistake impossible to ship.
 *
 * THREE THINGS A PAGE DECLARES, and why each is separate:
 *
 *   program        what this page sells. It may name no OTHER program.
 *   agreementName  the document the buyer actually signs, which is NOT always
 *                  the program name: Juniors and Teens & Adults both sign one
 *                  "Taekwondo Membership Agreement". Writing "Juniors
 *                  Membership Agreement" on that checkbox would name a
 *                  document that does not exist.
 *   term           what the buyer is committing to. Taekwondo and Cubs are
 *                  twelve months and auto-renew; Kickboxing and Jiu Jitsu run
 *                  month to month with no minimum term; Little Kickers is a
 *                  single session paid in full. Claiming the wrong one on the
 *                  consent line is the most expensive copy error available.
 *
 * KINDS: 'enrollment' sells one program's membership. 'event' sells a seat at
 * a dated event (belt testing), is for several programs at once on purpose,
 * and carries no membership agreement because those people already signed one.
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

const TERMS = {
  'paid-in-full':   { must: /paid in full/i,        mustNot: /12-month|twelve|month to month/i },
  'twelve-month':   { must: /12-month|twelve/i,     mustNot: /paid in full|month to month/i },
  'month-to-month': { must: /month to month/i,      mustNot: /12-month|twelve|paid in full/i },
};

/* Add a row when a new checkout page ships. */
const PAGES = [
  { dir: 'little-kickers-checkout', kind: 'enrollment', program: 'Little Kickers',
    templateKey: 'little_kickers', term: 'paid-in-full' },

  // forbidPhrases: CONCEPTS belonging to another program, not just names. Cubs
  // shipped twice with parent-and-me wording because the name lint could not
  // see it.
  { dir: 'cubs-checkout', kind: 'enrollment', program: 'Cubs',
    templateKey: 'cubs', term: 'twelve-month',
    forbidPhrases: ['training with you', 'on the mat too', 'grown-up', 'Grown-Up',
      'parent and me', 'Parent & Me', 'parent-and-me', 'six-week', '6-week session',
      'not a drop-off'] },

  { dir: 'juniors-checkout', kind: 'enrollment', program: 'Juniors',
    agreementName: 'Taekwondo', templateKey: 'taekwondo', term: 'twelve-month',
    forbidPhrases: ['Ages 3-4', 'preschool', 'Preschool'] },

  { dir: 'teens-adults-checkout', kind: 'enrollment', program: 'Teens & Adults',
    agreementName: 'Taekwondo', templateKey: 'taekwondo', term: 'twelve-month',
    forbidPhrases: ['Ages 3-4', 'preschool', 'Preschool'] },

  { dir: 'kickboxing-checkout', kind: 'enrollment', program: 'Kickboxing',
    templateKey: 'kickboxing', term: 'month-to-month',
    forbidPhrases: ['12-month', 'twelve (12) month', 'preschool'] },

  { dir: 'jiu-jitsu-checkout', kind: 'enrollment', program: 'Jiu Jitsu',
    templateKey: 'jiujitsu', term: 'month-to-month',
    forbidPhrases: ['12-month', 'twelve (12) month', 'preschool'] },

  { dir: "ampd-checkout", kind: "enrollment", program: "AMP'D",
    templateKey: "ampd", term: "month-to-month",
    forbidPhrases: ["12-month", "twelve (12) month", "preschool"] },

  // An event page names every program on purpose, because every program tests.
  { dir: 'testing-checkout', kind: 'event', program: 'Belt Testing',
    forbidPhrases: ['Membership Agreement', 'membership agreement', 'auto-renew',
      'automatically renews', '12-month', 'twelve (12) month', 'down payment',
      'paid in full at enrollment', 'cancellation notice'] },

  // A private lesson is a service someone buys once, not a membership. It
  // must not inherit a single word of enrollment language, and it must not
  // borrow the trial page's free-week promise either.
  { dir: 'private-lesson', kind: 'event', program: 'Private Lessons',
    forbidPhrases: ['Membership Agreement', 'membership agreement', 'auto-renew',
      'automatically renews', '12-month', 'twelve (12) month', 'down payment',
      'cancellation notice', 'free week', 'free trial', 'Your Cub', 'this session',
      'six-week', 'enrollment'] },
];

/* Phrases each page OWNS. The program-name check missed all of these:
 * every generated page shipped with the heading "Your Cub", because Cub
 * singular is not a program name, and with "the agreement for this session"
 * which is Little Kickers language for a six-week block, on pages selling a
 * twelve-month membership. Names are the obvious leak; the wording around
 * them is the one that actually reaches a buyer. */
const CROSSOVER = [
  { phrase: 'Your Cub',            owner: ['cubs-checkout'] },
  { phrase: 'Your Little Kicker',  owner: ['little-kickers-checkout'] },
  { phrase: 'Ages 3-4',            owner: ['cubs-checkout'] },
  { phrase: 'Ages 2-3',            owner: ['little-kickers-checkout'] },
  { phrase: 'for this session',    owner: ['little-kickers-checkout'] },
  { phrase: 'little attention spans', owner: ['cubs-checkout'] },
];

const OTHER_PROGRAMS = ['Little Kickers', 'Cubs', 'Juniors', 'Teens & Adults',
  'Kickboxing', 'Jiu Jitsu', "AMP'D"];

/* Strip anything that legitimately mentions another program: asset paths, the
 * shared navigation, and the footer. What is left is this page's own copy. */
function ownCopy(html) {
  let h = html;
  h = h.replace(/<header[\s\S]*?<\/header>/gi, '');
  h = h.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
  h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
  h = h.replace(/(src|href)="[^"]*"/gi, '');
  return h;
}

for (const page of PAGES) {
  const file = path.join(SITE, page.dir, 'index.html');
  if (!fs.existsSync(file)) { test(page.dir + ' exists', () => assert.fail('missing ' + file)); continue; }
  const html = fs.readFileSync(file, 'utf8');
  const body = ownCopy(html);

  if (page.kind !== 'event') {
    test(page.dir + ': names no other program in its own copy', () => {
      const strays = OTHER_PROGRAMS
        .filter((p) => p !== page.program)
        .filter((p) => body.includes(p));
      assert.deepStrictEqual(strays, [],
        'found another program named in the page copy: ' + strays.join(', '));
    });

    test(page.dir + ': the consent line names the document actually signed', () => {
      const m = /I have read and agree to the ([^,.]+?) Membership Agreement/.exec(body);
      assert.ok(m, 'no agreement consent sentence found');
      assert.strictEqual(m[1].trim(), page.agreementName || page.program,
        'consent names "' + m[1].trim() + '" on the ' + page.program + ' page');
    });

    test(page.dir + ': renders the right agreement template', () => {
      assert.ok(html.includes('"' + page.templateKey + '"'),
        'page does not select template key ' + page.templateKey);
      const otherKeys = [...new Set(PAGES.map((p) => p.templateKey))]
        .filter((k) => k && k !== page.templateKey);
      otherKeys.forEach((k) => {
        assert.ok(!html.includes('=== "' + k + '"'),
          'page also selects the ' + k + ' template');
      });
    });

    test(page.dir + ': the consent states the right commitment', () => {
      const consent = /I have read and agree to the[\s\S]{0,400}?<\/span>/.exec(body);
      assert.ok(consent, 'no consent block found');
      const txt = consent[0];
      const rule = TERMS[page.term];
      assert.ok(rule, 'unknown term "' + page.term + '"');
      assert.ok(rule.must.test(txt), 'consent does not state a ' + page.term + ' commitment');
      assert.ok(!rule.mustNot.test(txt), 'consent claims a commitment this program does not have');
    });
  }

  if (page.kind === 'event') {
    test(page.dir + ': carries no membership agreement machinery', () => {
      assert.ok(!/Membership Agreement/i.test(body),
        'an event page is asking the buyer to agree to a membership agreement');
      assert.ok(!/signature/i.test(body), 'an event page is collecting a signature');
    });
    test(page.dir + ': tells the buyer when to show up', () => {
      assert.ok(/tst-sched|schedule|group/i.test(body),
        'no schedule or group information on an event signup page');
    });
  }

  test(page.dir + ': no wording owned by another page', () => {
    const strays = CROSSOVER
      .filter((c) => !c.owner.includes(page.dir))
      .filter((c) => body.includes(c.phrase))
      .map((c) => c.phrase);
    assert.deepStrictEqual(strays, [],
      'wording that belongs to another page: ' + strays.join(' | '));
  });

  test(page.dir + ': no borrowed concepts from another program', () => {
    const strays = (page.forbidPhrases || []).filter((ph) => body.includes(ph));
    assert.deepStrictEqual(strays, [], 'phrases from another program: ' + strays.join(' | '));
  });

  test(page.dir + ': no em dashes in the page', () => {
    assert.ok(!html.includes(String.fromCharCode(8212)), 'em dash found');
  });

  test(page.dir + ': is noindex, since these are link-only pages', () => {
    assert.ok(/<meta\s+name="robots"\s+content="noindex"/i.test(html),
      'checkout pages are handed out by link and must not be indexed');
  });

  test(page.dir + ': links no file that does not exist', () => {
    // A dead "View all policies" link is the exact thing a buyer clicks before
    // signing. Only Cubs has a policy PDF.
    const refs = [...html.matchAll(/href="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
    const missing = refs.filter((r) => !fs.existsSync(path.join(SITE, r.replace(/^\//, ''))));
    assert.deepStrictEqual(missing, [], 'links to files that are not in the repo: ' + missing.join(', '));
  });
}

console.log('\n' + passed + ' passed');
