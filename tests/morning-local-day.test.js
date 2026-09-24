// morning-local-day.test.js -- wave-1 todo 5: local-calendar yesterday derivation.
//
// miss/credit/cron must derive "yesterday" from the LOCAL calendar (via the
// pure helper localDayDateAtOffset, adjacent to dayStamp in app.js), not from
// raw 24-hour subtraction (Date.now() - 86400000), which lands on the wrong
// calendar day across a DST transition (a 23h day shifts the wall clock).
//
// Extraction is anchor-based via tests/_extract.js (no hardcoded line
// numbers), matching the convention of the other app.js-extracting tests.
//
// Run: node tests/morning-local-day.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');
const X = require('./_extract.js');

const APP = X.readSource(path.join(__dirname, '..', 'app.js'));

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// =========================================================================
// B0: baseline characterization of dayStamp (must pass before AND after).
// dayStamp is LOCAL calendar day (getFullYear/getMonth/getDate, not UTC).
// =========================================================================
const dayStampSrc = X.extractFunction(APP, /^function dayStamp\(/, 'dayStamp');
const box = {};
vm.createContext(box);
vm.runInContext(dayStampSrc + '\nthis.dayStamp = dayStamp;', box);
const dayStamp = box.dayStamp;

(function baseline() {
  assertEq('baseline dayStamp: local midday 2026-09-24 -> 20260924',
    dayStamp(new Date(2026, 8, 24, 12, 0, 0)), 20260924);
  assertEq('baseline dayStamp: local 00:30 is still the same calendar day',
    dayStamp(new Date(2026, 8, 24, 0, 30, 0)), 20260924);
  assertEq('baseline dayStamp: local 23:59 is still the same calendar day',
    dayStamp(new Date(2026, 8, 24, 23, 59, 0)), 20260924);
  assertEq('baseline dayStamp: year boundary 2026-01-01 -> 20260101',
    dayStamp(new Date(2026, 0, 1, 12, 0, 0)), 20260101);
})();

// =========================================================================
// H1: helper extraction (FAILS before the fix -- failing-first proof).
// =========================================================================
let helperSrc = null;
try {
  helperSrc = X.extractFunction(APP, /^function localDayDateAtOffset\(/, 'localDayDateAtOffset');
  assert('helper extraction: localDayDateAtOffset found adjacent to dayStamp', true);
} catch (e) {
  assert('helper extraction: localDayDateAtOffset found adjacent to dayStamp (' + e.message + ')', false);
}

let atOffset = null;
if (helperSrc) {
  const hbox = {};
  vm.createContext(hbox);
  try {
    vm.runInContext(dayStampSrc + '\n' + helperSrc + '\nthis.atOffset = localDayDateAtOffset;', hbox);
    atOffset = hbox.atOffset;
    assert('helper extraction: localDayDateAtOffset evaluates in a vm sandbox', typeof atOffset === 'function');
  } catch (e) {
    assert('helper extraction: localDayDateAtOffset evaluates in a vm sandbox (' + e.message + ')', false);
  }
}

// =========================================================================
// H2: local calendar offsets -- noon-anchored, DST-immune by construction.
// =========================================================================
if (atOffset) {
  const base = new Date(2026, 8, 24, 12, 0, 0).getTime(); // Sep 24 2026 midday local
  assertEq('local calendar offset: helper(base,0) stays on the same calendar day',
    dayStamp(new Date(atOffset(base, 0))), 20260924);
  assertEq('local calendar offset: helper(base,-1) is yesterday 20260923',
    dayStamp(new Date(atOffset(base, -1))), 20260923);
  assertEq('local calendar offset: helper(base,+1) is tomorrow 20260925',
    dayStamp(new Date(atOffset(base, +1))), 20260925);
  assertEq('local calendar offset: helper(-1) matches noon-constructed calendar yesterday',
    dayStamp(new Date(atOffset(base, -1))), dayStamp(new Date(2026, 8, 23, 12, 0, 0)));
  assertEq('local calendar offset: month boundary Mar 1 -> Feb 28 yesterday',
    dayStamp(new Date(atOffset(new Date(2026, 2, 1, 12, 0, 0).getTime(), -1))),
    dayStamp(new Date(2026, 1, 28, 12, 0, 0)));
}

// =========================================================================
// H3/H4: 00:30 boundary + DST-date calendar characterization.
// Scan 2026 at local 00:30 for a day where raw `ms - 86400000` lands on the
// WRONG calendar day (the day after a 23h spring-forward transition). The
// helper must return the true calendar yesterday there; raw subtraction does
// not. If this TZ has no such day, discriminate is skipped (NOTE), but the
// strict calendar assertions above and below still run everywhere.
// =========================================================================
function calendarYesterdayStamp(baseMs) {
  const b = new Date(baseMs);
  return dayStamp(new Date(b.getFullYear(), b.getMonth(), b.getDate() - 1, 12, 0, 0, 0));
}
let sensitiveBase = null;
for (let m = 0; m < 12 && !sensitiveBase; m++) {
  for (let d = 1; d <= 31 && !sensitiveBase; d++) {
    const t = new Date(2026, m, d, 0, 30, 0, 0);
    if (t.getMonth() !== m || t.getDate() !== d) continue; // skip overflow days
    const ms = t.getTime();
    if (dayStamp(new Date(ms - 86400000)) !== calendarYesterdayStamp(ms)) sensitiveBase = ms;
  }
}
if (atOffset) {
  if (sensitiveBase === null) {
    console.log('[NOTE] 00:30 boundary: no DST-sensitive 00:30 found in this TZ in 2026; discrimination skipped');
    console.log('[NOTE] DST characterization: no DST-sensitive date in this TZ in 2026; discrimination skipped');
  } else {
    const b = new Date(sensitiveBase);
    const tag = b.getFullYear() + '-' + (b.getMonth() + 1) + '-' + b.getDate() + ' 00:30 local';
    assertEq('00:30 boundary: helper(-1) at ' + tag + ' is the true calendar yesterday',
      dayStamp(new Date(atOffset(sensitiveBase, -1))), calendarYesterdayStamp(sensitiveBase));
    assert('00:30 boundary: raw ms-86400000 lands on the WRONG calendar day here (helper differs from raw)',
      dayStamp(new Date(atOffset(sensitiveBase, -1))) !== dayStamp(new Date(sensitiveBase - 86400000)));
    assertEq('DST characterization: helper(-1) equals noon-constructed calendar yesterday across the transition',
      dayStamp(new Date(atOffset(sensitiveBase, -1))),
      dayStamp(new Date(b.getFullYear(), b.getMonth(), b.getDate() - 1, 12, 0, 0, 0)));
    assertEq('DST characterization: helper(0) stays on the transition-adjacent calendar day',
      dayStamp(new Date(atOffset(sensitiveBase, 0))), dayStamp(b));
  }
} else {
  assert('00:30 boundary: helper present so the early-morning yesterday derivation is testable', false);
  assert('DST characterization: helper present so transition-date behavior is testable', false);
}

// =========================================================================
// S1: static absence -- the three rollover functions must not contain raw
// 24-hour subtraction for yesterday (comments stripped before matching).
// FAILS before the fix, passes after. DAY=86400000 for analytics/heatmap
// lives elsewhere and is intentionally untouched.
// =========================================================================
[['missedYesterdayDailies', /^function missedYesterdayDailies\(/],
 ['creditYesterday', /^function creditYesterday\(/],
 ['runCron', /^function runCron\(/]].forEach(function ([label, anchor]) {
  let src;
  try {
    src = X.extractFunction(APP, anchor, label);
  } catch (e) {
    assert('absence of raw 24h subtraction in ' + label + ' (extractable: ' + e.message + ')', false);
    return;
  }
  const code = stripComments(src);
  assert('absence of raw 24h subtraction in ' + label + ' (no 86400 literal)',
    code.indexOf('86400') === -1);
  assert('absence of raw 24h subtraction in ' + label + ' (no Date.now()-minus pattern)',
    !/Date\s*\.\s*now\s*\(\s*\)\s*-/.test(code));
});

if (failures > 0) { console.error(failures + ' morning-local-day test(s) failed.'); process.exit(1); }
console.log('All morning-local-day tests passed!');
process.exit(0);
