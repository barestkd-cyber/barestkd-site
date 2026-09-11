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
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
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
    // src as well as href. Checking only href let a missing script and a
    // missing image through (audit A16: private-lesson's site.js, and
    // the map on Home and Contact).
    const refs = [...html.matchAll(/(?:href|src)="(\/assets\/[^"?#]+)/g)].map((m) => m[1]);
    const missing = refs.filter((r) => !fs.existsSync(path.join(SITE, r.replace(/^\//, ''))));
    assert.deepStrictEqual(missing, [], 'links to files that are not in the repo: ' + missing.join(', '));
  });
}

/* ── the card fee is one number, computed the same way in fourteen places ──
 * Static checkout pages load no module, so each carries its own copy of the
 * gross-up. A copy that drifts would quote a different price from the server
 * that charges it, which the customer would see as the page lying. */
{
  const PAGES = ['ampd-checkout', 'cubs-checkout', 'jiu-jitsu-checkout', 'juniors-checkout',
    'kickboxing-checkout', 'little-kickers-checkout', 'teens-adults-checkout', 'testing-checkout',
    // The gear shop. Its SERVER side is deliberately absent from FNS below:
    // it imports BTKDPricing.cardFeeCents from the vendored engine instead of
    // carrying a copy, which is the better arrangement and is checked on its
    // own further down.
    'shop'];
  const FNS = ['cubs-checkout', 'lk-checkout', 'private-checkout', 'program-checkout', 'testing-checkout'];

  // The engine is the reference. Everything else has to match it.
  const engine = require(path.join(SITE, '..', 'BaresCRM', 'pricing.js')).cardFeeCents;
  const amounts = [];
  for (let b = 1; b <= 30000; b += 11) amounts.push(b);
  [119900, 25749, 10904, 6000, 5000, 7000, 50].forEach((b) => amounts.push(b));

  let helperSrc = null;
  PAGES.forEach((dir) => {
    const html = fs.readFileSync(path.join(SITE, dir, 'index.html'), 'utf8');
    const m = /function cardFeeCents\(baseCents, bps, flatCents\)\s*\{[\s\S]*?\n  \}/.exec(html);
    test(dir + ': carries the grossed-up card fee', () => {
      assert.ok(m, 'no cardFeeCents helper on the page');
      assert.ok(!/Math\.round\(base \* CFG\.admin_fee_bps/.test(html),
        'the old subtotal formula is still here');
    });
    if (!m) return;
    // Byte-identical, not merely equivalent: one canonical text is the only
    // way eight hand-edited copies stay the same over time.
    test(dir + ': its copy of the fee helper is byte-identical to the others', () => {
      if (helperSrc === null) helperSrc = m[0];
      assert.strictEqual(m[0], helperSrc, 'this copy has drifted from the others');
    });
    test(dir + ': and computes what the pricing engine computes', () => {
      const f = new Function('return (' + m[0].replace('function cardFeeCents', 'function') + ')')();
      const wrong = amounts.filter((b) => f(b, 290, 30) !== engine(b, 290, 30));
      assert.strictEqual(wrong.length, 0,
        'disagrees with BTKDPricing.cardFeeCents on ' + wrong.length + ' amounts, e.g. ' + wrong[0]);
    });
  });

  // The shop function is the one that does it properly: it imports the engine
  // rather than keeping a fifteenth hand-maintained copy of the gross-up.
  // Pin that, so nobody "fixes" it later by pasting the helper back in.
  {
    const ts = fs.readFileSync(path.join(SITE, 'supabase', 'functions', 'shop', 'index.ts'), 'utf8');
    test('fn shop: uses the pricing engine rather than its own copy of the fee', () => {
      assert.ok(/import BTKDPricing from "\.\.\/_shared\/pricing_esm\.js"/.test(ts),
        'the shop function should import the engine');
      assert.ok(/BTKDPricing\.cardFeeCents\(/.test(ts), 'it does not call the engine fee');
      assert.ok(!/function cardFeeCents\(/.test(ts), 'a local copy of the fee helper has crept in');
    });
    test('fn shop: grosses the fee up on goods PLUS tax', () => {
      // The whole point of feeFor(): price once with a zero fee, then gross up
      // on that total, because Stripe takes its cut of the tax as well.
      assert.ok(/adminFeeCents:\s*0/.test(ts), 'no zero-fee pass to get the tax from');
      assert.ok(/cardFeeCents\(\s*preFee\.totalCents/.test(ts),
        'the fee base must be the pre-fee TOTAL, not the subtotal');
    });
    test('fn shop: never lets the browser name a price', () => {
      assert.ok(!/body\.(unit_cents|amount|price|total)/.test(ts),
        'the client must send variant ids and quantities only');
      assert.ok(/shopUnitCents\(v\.list_cents, p\)/.test(ts),
        'prices must be re-derived from shop_variants through the engine rule');
    });
    // Owner, 2026-09-10: "don't let someone buy an out of stock product." The
    // stored stock flag is only as fresh as the weekly refresh, so the order
    // is re-checked live with Century, and it has to happen BEFORE anything is
    // written, or a sold-out order would leave a sale and a contact behind.
    test('fn shop: re-checks stock live with Century before writing anything', () => {
      assert.ok(/async function centuryOutOfStock\(/.test(ts), 'no live stock check');
      const check = ts.indexOf('await centuryOutOfStock(handles)');
      assert.ok(check > 0, 'the live check is never called');
      assert.ok(check < ts.indexOf('from("contacts").insert'), 'a contact is written before stock is checked');
      assert.ok(check < ts.indexOf('from("pos_sales").insert'), 'the sale is written before stock is checked');
      assert.ok(/\.eq\("available", true\)/.test(ts), 'the catalogue must never offer an out-of-stock variant');
    });
    test('fn shop: an abandoned checkout leaves no debt', () => {
      assert.ok(/status:\s*"pending_payment"/.test(ts), 'the sale must start pending_payment, never unpaid');
      assert.ok(/shop-checkout@website/.test(ts),
        'staff_email must end in -checkout@website so the hourly sweep abandons it');
    });

    // Owner, 2026-09-11: "a t shirt tab with all the t shirts that I offer on
    // the checkout pages". Pin every half of that: each shirt a checkout
    // function sells is on the shop's list, in the same sizes, priced from the
    // same catalogue, and never filed under Century.
    test('fn shop: sells every shirt the checkout pages sell', () => {
      const block = /const SHIRTS: Shirt\[\] = \[([\s\S]*?)\n\];/.exec(ts);
      assert.ok(block, 'could not read the shop shirt list');
      const listed = new Set((block[1].match(/name: "([^"]+)"/g) || []).map((x) => x.slice(7, -1)));
      const sold = new Set();
      ['cubs-checkout', 'program-checkout', 'lk-checkout'].forEach((fn) => {
        const src = fs.readFileSync(path.join(SITE, 'supabase', 'functions', fn, 'index.ts'), 'utf8');
        (src.match(/(?:SHIRT_NAMES = |shirts: )\[[^\]]*\]/g) || [])
          .forEach((l) => (l.match(/"([^"]+)"/g) || []).forEach((q) => sold.add(q.slice(1, -1))));
        (src.match(/(?:TSHIRT_NAME|TEE_NAME) = "[^"]+"/g) || [])
          .forEach((d) => sold.add(/"([^"]+)"/.exec(d)[1]));
      });
      assert.ok(sold.size >= 5, 'found only ' + sold.size + ' shirts on the checkout pages; the scan is broken');
      const missing = Array.from(sold).filter((n) => !listed.has(n));
      assert.deepStrictEqual(missing, [], 'the checkout pages sell shirts the shop does not');
    });
    // Owner, 2026-09-11: the custom uniform is priced from what the school
    // pays for each patch. That cost is his; the public page only ever gets
    // the words. The function never even names the cost field: the engine
    // reads it.
    test('fn shop: what the school pays for art never reaches the public page', () => {
      assert.ok(!/cost_cents/.test(ts), 'the shop function handles art costs directly');
      assert.ok(/art_labels: artLabels\(p\)/.test(ts), 'the page should get art labels, and only labels');
    });
    test('fn shop: sizes each shirt the way its checkout page does', () => {
      const shopSizes = /const TEE_SIZES = (\[[^\]]*\])/.exec(ts);
      const cubs = fs.readFileSync(path.join(SITE, 'supabase', 'functions', 'cubs-checkout', 'index.ts'), 'utf8');
      const cubsSizes = /tee_sizes: (\[[^\]]*\])/.exec(cubs);
      assert.ok(shopSizes && cubsSizes, 'could not read the tee size lists');
      assert.deepStrictEqual(JSON.parse(shopSizes[1]), JSON.parse(cubsSizes[1]), 'tee sizes differ from the checkout pages');
      const lkPage = fs.readFileSync(path.join(SITE, 'little-kickers-checkout', 'index.html'), 'utf8');
      const sel = /<select id="lkc-size"[\s\S]*?<\/select>/.exec(lkPage);
      const lkSizes = sel ? (sel[0].match(/<option>[^<]+<\/option>/g) || []).map((o) => o.replace(/<\/?option>/g, '')) : [];
      const shopLk = /sizes: (\["2T"[^\]]*\])/.exec(ts);
      assert.ok(lkSizes.length && shopLk, 'could not read the Little Kickers sizes');
      assert.deepStrictEqual(JSON.parse(shopLk[1]), lkSizes, 'Little Kickers shirt sizes differ from its checkout page');
    });
    test('fn shop: prices a shirt from the CRM catalogue and files it under the school', () => {
      assert.ok(/from\("products"\)\.select\("id,name,price_cents,active"\)/.test(ts),
        'a shirt must be re-priced from products at checkout');
      assert.ok(/const unit = Number\(row\.price_cents\)/.test(ts), 'the shirt price must come from the catalogue row');
      assert.ok(/orderFor\("school"\)/.test(ts), 'shirts must go on their own school order, never Century');
      const page = fs.readFileSync(path.join(SITE, 'shop', 'index.html'), 'utf8');
      assert.ok(/\["shirts", "T-Shirts"\]/.test(page), 'the page has no T-Shirts tab');
    });
  }

  FNS.forEach((name) => {
    const p = path.join(SITE, 'supabase', 'functions', name, 'index.ts');
    const ts = fs.readFileSync(p, 'utf8');
    test('fn ' + name + ': charges the grossed-up fee', () => {
      assert.ok(!/Math\.round\(baseCents \* bps \/ 10000\) \+ flat/.test(ts),
        'the old subtotal formula is still here');
      assert.ok(/while \(nets\(total\) < baseCents\) total\+\+;/.test(ts),
        'the gross-up is missing');
    });
    test('fn ' + name + ': and its arithmetic matches the engine', () => {
      const m = /const nets = \(t: number\)[\s\S]*?return total - baseCents;/.exec(ts);
      assert.ok(m, 'could not read the fee body');
      const f = new Function(
        'function f(baseCents,bps,flat){ if(baseCents<=0)return 0; if(!bps&&!flat)return 0;'
        + ' if(bps>=10000)return 0; ' + m[0].replace('(t: number)', '(t)') + ' } return f;')();
      const wrong = amounts.filter((b) => f(b, 290, 30) !== engine(b, 290, 30));
      assert.strictEqual(wrong.length, 0,
        'server would charge a different fee from the page on ' + wrong.length + ' amounts');
    });
    // The two tests above only prove the fee HELPER is right. Both passed
    // happily for weeks while every caller handed it a pre-tax base, so
    // Stripe's cut landed on the sales tax too and the studio came up about
    // 2.9% of the tax short on every taxed sale. Found in the live ledger
    // 2026-09-09. The base has to be goods PLUS tax, which is exactly what
    // invoiceTotals returns as totalCents when the fee is zero.
    test('fn ' + name + ': the fee base includes sales tax', () => {
      const calls = Array.from(ts.matchAll(/(?:^|[^\w.])adminFeeCents\(\s*([^,]+),/g))
        .map((m) => m[1].trim())
        .filter((a) => !/^baseCents/.test(a));   // skip the declaration itself
      assert.ok(calls.length, 'no adminFeeCents call found at all');
      const bad = calls.filter((a) => !/\.totalCents$/.test(a));
      assert.strictEqual(bad.length, 0,
        'fee grossed up on a pre-tax base: ' + bad.join(' | '));
    });
  });
}

// A count of passes alone reads green whatever happened, and exiting 0
// means a CI check or a skimmed last line never sees a failure. Two suites
// sat red for weeks behind exactly that (2026-09-07).
console.log('\n' + passed + ' passed' + (failed ? ', ' + failed + ' FAILED' : ''));
