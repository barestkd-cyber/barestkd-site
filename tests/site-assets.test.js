/* ============================================================================
 * site-assets - no page on the site references a file that does not exist
 * ----------------------------------------------------------------------------
 * Plain Node. Run from the barestkd-site repo root:
 *     node tests/site-assets.test.js
 *
 * Audit A16 found two live 404s: /assets/img/map.jpg on Home and Contact, and
 * /assets/js/site.js on private-lesson. The checkout test only looked at
 * checkout pages, and only at href, never src. This looks at EVERY page and
 * both attributes.
 * ========================================================================== */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'supabase', 'tests', 'tools']);

function pages(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) pages(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const found = pages(SITE);
const broken = [];
for (const file of found) {
  const html = fs.readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');                  // a commented-out reference is not a request
  for (const m of html.matchAll(/(?:href|src)="(\/assets\/[^"?#]+)/g)) {
    if (!fs.existsSync(path.join(SITE, m[1].replace(/^\//, '')))) {
      broken.push(path.relative(SITE, file).split(path.sep).join('/') + ' -> ' + m[1]);
    }
  }
}

let failed = 0;
try {
  assert.ok(found.length > 20, 'expected to scan the whole site, found only ' + found.length + ' pages');
  assert.deepStrictEqual(broken, [], 'missing files:\n    ' + broken.join('\n    '));
  console.log('  ok   every /assets/ reference on ' + found.length + ' pages exists');
} catch (e) {
  console.error('  FAIL ' + e.message); failed++; process.exitCode = 1;
}
console.log('site-assets: ' + (failed ? 0 : 1) + ' passed, ' + failed + ' failed');
