/* ============================================================================
 * One class a week - the unlisted daytime page
 * ----------------------------------------------------------------------------
 *     node tests/oneclass-weekly.test.js
 *
 * Owner, 2026-09-19: a checkout for the Wednesday 10:15 daytime class that is
 * "not basically findable unless I show it to somebody", sold at $109 a month
 * on the twelve-month Taekwondo agreement, where the benefit of the term is
 * that non-renewal needs no notice.
 *
 * Two things this guards. First, hidden means hidden: no link from any page,
 * no sitemap entry, noindex. Second, and the one that costs money, the $109
 * rate belongs to this page ALONE - it is sellable at the front desk, so
 * nothing but the code filter keeps it off the public Juniors and Teens
 * pages, where it would undercut every evening member.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SITE = path.join(__dirname, '..');
const PAGE = path.join(SITE, 'oneclassweekly', 'index.html');
const FN = path.join(SITE, 'supabase', 'functions', 'program-checkout', 'index.ts');
const html = fs.readFileSync(PAGE, 'utf8');
const fn = fs.readFileSync(FN, 'utf8');
const sitemap = fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn2) {
  try { fn2(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
}

test('the page is handed out, never found: noindex, no sitemap entry, no link anywhere', () => {
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.ok(!sitemap.includes('oneclassweekly'), 'the sitemap advertises it');
  const linkers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'oneclassweekly' || e.name === 'tests') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|xml|txt)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('oneclassweekly')) {
        linkers.push(path.relative(SITE, p));
      }
    }
  };
  walk(SITE);
  assert.deepStrictEqual(linkers, [], 'these files point at the page: ' + linkers.join(', '));
  // robots.txt would publish the path to anyone who reads it, so it must not
  // name the page either.
  assert.ok(!fs.readFileSync(path.join(SITE, 'robots.txt'), 'utf8').includes('oneclassweekly'));
});

test('it declares its own canonical', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.barestkd\.fit\/oneclassweekly\/">/);
});

test('the rate is claimed by this page and filtered off every other one', () => {
  assert.match(fn, /"oneclass-juniors":[\s\S]{0,400}codes: \["juniors_oneclass"\]/);
  assert.match(fn, /"oneclass-teens-adults":[\s\S]{0,400}codes: \["adults_oneclass"\]/);
  // The catalog a page may sell: its own codes, or everything no page claims.
  assert.match(fn, /const claimed = new Set\(Object\.values\(PROGRAMS\)\.flatMap\(\(p\) => p\.codes \?\? \[\]\)\)/);
  assert.match(fn, /cfg\.codes[\s\S]{0,120}rows\.filter\(\(p\) => !claimed\.has\(p\.code\)\)/);
  // That same list is what a POST is checked against, so a page cannot be
  // talked into selling a rate it does not offer.
  assert.match(fn, /const chosen = options\.find\(\(p\) => p\.code === str\(body\.plan_code\)\)/);
});

test('both age groups reach their own program, from one page', () => {
  assert.match(fn, /"oneclass-juniors":\s*\{\s*\n\s*program: "Juniors"/);
  assert.match(fn, /"oneclass-teens-adults":\s*\{\s*\n\s*program: "Teens\/Adults"/);
  assert.match(html, /data-who="oneclass-juniors"[\s\S]{0,120}Ages 5 to 12/);
  assert.match(html, /data-who="oneclass-teens-adults"[\s\S]{0,120}Ages 13 and up/);
  assert.match(html, /var FN_BASE = "https:\/\/akdncbzxiwvihfcyijvm\.supabase\.co\/functions\/v1\/program-checkout\?p=";/);
  assert.ok(!/\?p=juniors"/.test(html), 'the page still points at the public Juniors slug');
});

test('nobody can pay before saying who it is for', () => {
  assert.match(html, /if \(!WHO\) \{ status\("error", "Pick who this is for first\."\)/);
  // A price in flight for the age they just left must not land on the page.
  assert.match(html, /if \(WHO !== slug\) return;/);
});

test('it sells the one class, at one rate, with no evening add-ons', () => {
  const cfgBlock = /"oneclass-juniors":[\s\S]*?\},\s*"oneclass-teens-adults":[\s\S]*?\},/.exec(fn)[0];
  assert.ok(!/addOns/.test(cfgBlock), 'the daytime page is offering add-on programs');
  assert.ok(!/bothCode/.test(cfgBlock));
  assert.match(html, /The class is Wednesdays, 10:15 to 11:00 AM\./);
});

test('the terms on the page are the terms in the document they sign', () => {
  // Twelve months, renews by itself, and the part that sells it: walking away
  // at the end needs no notice period. Straight from the CANCELLATION section.
  assert.match(html, /12-month membership that renews on its own/);
  assert.match(html, /Tell us in writing before the term ends and it simply does not renew: no notice period, no fee\./);
  assert.match(html, /Leaving during the term takes 30 days written notice\./);
  assert.match(html, /I have read and agree to the Taekwondo Membership Agreement above/);
  assert.match(html, /A\.TEMPLATES\[i\]\.key === "taekwondo"/);
  assert.ok(!/month to month/i.test(html), 'the page promises month to month terms it does not have');
});

test('it never names the programs it quietly enrolls people into', () => {
  const body = html
    .replace(/<header[\s\S]*?<\/header>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/(src|href)="[^"]*"/gi, '');
  ['Juniors', 'Teens & Adults', 'Cubs', 'Little Kickers', 'Kickboxing', 'Jiu Jitsu', "AMP'D"]
    .forEach((p) => assert.ok(!body.includes(p), 'page copy names ' + p));
});

console.log('one class a week: ' + passed + ' passed, ' + failed + ' failed');
