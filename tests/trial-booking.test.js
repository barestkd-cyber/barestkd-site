/* ============================================================================
 * trial-booking - the website trial form books real classes, for the right age
 * ----------------------------------------------------------------------------
 * Plain Node. Run from the barestkd-site repo root:
 *     node tests/trial-booking.test.js
 *
 * Audits A13 and A17. Real handler code in a vm, a fixed clock, and a fixture
 * that is the actual September 2026 changeover found live on 2026-09-10:
 * Teens/Adults Monday 6:45 ends on the 13th, and new classes start on the 16th.
 * On that day the page offered the Monday class for the 14th - the day after
 * it stopped existing - and hid the new classes until they began.
 * ========================================================================== */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripTypeScriptTypes } = require('module');

const SITE = path.join(__dirname, '..');
const SRC = path.join(SITE, 'supabase', 'functions', 'trial-booking', 'index.ts');
const source = fs.readFileSync(SRC, 'utf8');
const code = stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, ''));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok   ' + name); passed++; }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e && e.message)); failed++; process.exitCode = 1; }
}

// Thursday 2026-09-10, 1pm in Texas.
const FIXED = Date.UTC(2026, 8, 10, 18, 0, 0);
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
}

// day: 0 = Monday (the page shows dow = day + 1, JS getDay()).
const ROWS = [
  { day: 0, time_h: 18, time_m: 45, label: 'Teens / Adults', prog_css: 'prog-teen', belt: '', trial_open: true, duration: 60, starts_on: null, ends_on: '2026-09-13' },
  { day: 1, time_h: 19, time_m: 15, label: 'Teens / Adults', prog_css: 'prog-teen', belt: '', trial_open: true, duration: 60, starts_on: null, ends_on: null },
  { day: 2, time_h: 17, time_m: 0,  label: 'Juniors',        prog_css: 'prog-juniors', belt: '', trial_open: true, duration: 45, starts_on: '2026-09-16', ends_on: null },
  { day: 3, time_h: 18, time_m: 0,  label: 'Kickboxing',     prog_css: 'prog-kick', belt: '', trial_open: true, duration: 60, starts_on: null, ends_on: '2026-09-01' },
  { day: 5, time_h: 11, time_m: 0,  label: 'Cubs',           prog_css: 'prog-cubs', belt: '', trial_open: false, duration: 30, starts_on: null, ends_on: null },
];

function load(rows = ROWS) {
  const reader = { from() { return { select() { return this; }, eq() { return this; }, gte() { return this; },
    in() { return this; }, limit() { return this; }, maybeSingle() { return this; },
    then(r, j) { return Promise.resolve({ data: rows, error: null }).then(r, j); } }; } };
  const blank = { from() { return { select() { return this; }, eq() { return this; }, gte() { return this; },
    then(r, j) { return Promise.resolve({ data: [], error: null }).then(r, j); } }; } };
  let n = 0;
  const ctx = vm.createContext({
    Deno: { serve() {}, env: { get: () => 'x' } },
    createClient: () => (n++ % 2 === 0 ? reader : blank),
    findOrCreateGuardian: async () => null, PDFDocument: {}, StandardFonts: {}, LOGO_PNG_BASE64: '',
    URL, URLSearchParams, Response, Request, Intl, console: { log() {}, error() {} },
    Date: FixedDate,
  });
  vm.runInContext(code, ctx);
  return { ctx, reader };
}

// An instant for h:m in Texas on a date (CDT in September: UTC-5).
const at = (ymd, h, m) => {
  const [y, mo, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h + 5, m)).toISOString();
};

(async () => {
  // ── A13: the age that decides whether a parent signs ──────────────────
  await test('age is read from `dob`, the field the page actually sends', () => {
    assert.ok(/ageFromDob\(dob\)/.test(source), 'must compute age from the parsed dob');
    assert.ok(!/ageFromDob\(body\.student_dob\)/.test(source),
      'body.student_dob is never sent, so reading it made the age always null');
  });

  await test('a 13-year-old is a minor by date of birth, whatever the program flag says', () => {
    const { ctx } = load();
    assert.strictEqual(ctx.ageFromDob('2013-03-01'), 13);
    assert.strictEqual(ctx.ageFromDob(undefined), null, 'the old field name read as null - the bug');
  });

  // ── A13: only real, open, running, future classes ──────────────────────
  const v = async (program, ymd, h, m) => {
    const { ctx, reader } = load();
    return ctx.validateBookings(reader, [{ program, class_datetime: at(ymd, h, m) }]);
  };

  await test('the class that ends on the 13th cannot be booked for the 14th', async () => {
    const out = await v('Teens/Adults Taekwondo', '2026-09-14', 18, 45);
    assert.ok(out.refused, 'this is the booking a family could make on 2026-09-10 into a class that no longer existed');
  });

  await test('a running class books normally', async () => {
    const out = await v('Teens/Adults Taekwondo', '2026-09-15', 19, 15);
    assert.ok(!out.refused && !out.error, JSON.stringify(out));
  });

  await test('a class starting on the 16th can be booked for the 16th and after', async () => {
    assert.ok(!(await v('Juniors', '2026-09-16', 17, 0)).refused);
    assert.ok(!(await v('Juniors', '2026-09-23', 17, 0)).refused);
  });

  await test('an ended class is refused', async () => {
    assert.ok((await v('Kickboxing', '2026-09-17', 18, 0)).refused);
  });

  await test('a class not open for trials is refused', async () => {
    assert.ok((await v('Cubs', '2026-09-12', 11, 0)).refused);
  });

  await test('a real time booked under the wrong program is refused', async () => {
    assert.ok((await v('Cubs', '2026-09-15', 19, 15)).refused, 'Tuesday 7:15 is Teens/Adults, not Cubs');
  });

  await test('an unknown program still books on a genuine slot', async () => {
    // A program added to the page before this list must not turn every family away.
    assert.ok(!(await v('Some New Program', '2026-09-15', 19, 15)).refused);
  });

  await test('an invented time is refused', async () => {
    assert.ok((await v('Teens/Adults Taekwondo', '2026-09-15', 3, 17)).refused);
  });

  await test('a time in the past is refused', async () => {
    assert.ok((await v('Teens/Adults Taekwondo', '2026-09-08', 19, 15)).refused);
  });

  // ── A17: the endpoint says when each class runs ────────────────────────
  await test('the schedule endpoint carries start and end dates', async () => {
    const { ctx } = load();
    const res = await ctx.handleSchedule({}, new Request('https://x.invalid/trial-booking'));
    const all = (await res.json()).programs.flatMap(p => p.classes);
    const mon = all.find(c => c.dow === 1 && c.h === 18);
    assert.strictEqual(mon.endsOn, '2026-09-13');
    assert.strictEqual(mon.trialOpen, true, 'still running today, so still eligible - for dates up to the 13th');
  });

  await test('a class that has not started is eligible, for dates from its start', async () => {
    const { ctx } = load();
    const res = await ctx.handleSchedule({}, new Request('https://x.invalid/trial-booking'));
    const wed = (await res.json()).programs.flatMap(p => p.classes).find(c => c.dow === 3);
    assert.strictEqual(wed.trialOpen, true, 'it used to be false until its first day, so nobody could book ahead');
    assert.strictEqual(wed.startsOn, '2026-09-16');
  });

  await test('an ended class is not eligible at all, even to a stale page', async () => {
    const { ctx } = load();
    const res = await ctx.handleSchedule({}, new Request('https://x.invalid/trial-booking'));
    const kb = (await res.json()).programs.flatMap(p => p.classes).find(c => c.dow === 4);
    assert.strictEqual(kb.trialOpen, false);
  });

  // ── A17: the pages respect the window ──────────────────────────────────
  const trialJs = fs.readFileSync(path.join(SITE, 'assets', 'js', 'trial.js'), 'utf8');
  const schedJs = fs.readFileSync(path.join(SITE, 'assets', 'js', 'schedule.js'), 'utf8');

  await test('the booking page offers no date before a class starts or after it ends', () => {
    assert.ok(/cls\.startsOn && ymd < String\(cls\.startsOn\)/.test(trialJs));
    assert.ok(/cls\.endsOn && ymd > String\(cls\.endsOn\)/.test(trialJs));
  });

  await test('the public schedule drops a class once it has ended', () => {
    assert.ok(/c\.endsOn && String\(c\.endsOn\) < studioToday\(\)\) return;/.test(schedJs));
  });

  await test('"starts" is printed only while the start is still ahead', () => {
    assert.ok(/c\.startsOn && String\(c\.startsOn\) > today/.test(schedJs),
      'it used to print "starts Sept 16" forever, including after the 16th');
  });

  // ── A13: a retry is recognised, not duplicated ─────────────────────────
  await test('the page sends one key per submission, reused on retry', () => {
    assert.ok(/intake_key: intakeKey\(\)/.test(trialJs));
    assert.ok(/if \(state\.intakeKey\) return state\.intakeKey;/.test(trialJs));
  });

  await test('a failed booking insert undoes the contact it just made', () => {
    const i = source.indexOf('await admin.from("trial_bookings").insert(rows)');
    assert.ok(/admin\.from\("contacts"\)\.delete\(\)\.eq\("id", contact\.id\)/.test(source.slice(i, i + 900)));
  });

  await test('the guardian becomes a real person through the shared helper', () => {
    assert.ok(/findOrCreateGuardian\(admin,/.test(source));
    assert.ok(!/await admin\.from\("student_guardians"\)\.insert\(\{\s*student_id: contact\.id,\s*email: parentEmail \|\| null/.test(source),
      'the legacy link-row-only insert must be gone');
  });

  console.log('trial-booking: ' + passed + ' passed, ' + failed + ' failed');
})();
