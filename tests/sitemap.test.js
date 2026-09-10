/* ============================================================================
 * sitemap - every URL is the one its page says it is (audit A18)
 * ----------------------------------------------------------------------------
 * Plain Node. Run from the barestkd-site repo root:  node tests/sitemap.test.js
 *
 * 26 of 27 sitemap URLs omitted the trailing slash while every page declared
 * its canonical with one. GitHub Pages answers /about with a 301 to /about/,
 * so the sitemap was sending search engines to 26 redirects. Each URL here
 * must now equal the canonical its own page declares.
 * ========================================================================== */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..');
const HOST = 'https://www.barestkd.fit';
const locs = [...fs.readFileSync(path.join(SITE, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
}

test('the sitemap was read', () => assert.ok(locs.length > 10, 'only ' + locs.length + ' URLs'));

test('every sitemap URL is a page that exists', () => {
  const missing = locs.filter((u) => !fs.existsSync(path.join(SITE, u.slice(HOST.length), 'index.html')));
  assert.deepStrictEqual(missing, []);
});

test('every sitemap URL equals the canonical its page declares', () => {
  const bad = [];
  for (const u of locs) {
    const file = path.join(SITE, u.slice(HOST.length), 'index.html');
    if (!fs.existsSync(file)) continue;
    const m = /<link rel="canonical" href="([^"]+)"/.exec(fs.readFileSync(file, 'utf8'));
    if (!m) bad.push(u + ' (page declares no canonical)');
    else if (m[1] !== u) bad.push(u + '  but the page says  ' + m[1]);
  }
  assert.deepStrictEqual(bad, [], 'sitemap disagrees with the page:\n    ' + bad.join('\n    '));
});

console.log('sitemap: ' + passed + ' passed, ' + failed + ' failed');
