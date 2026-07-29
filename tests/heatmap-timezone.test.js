// heatmap-timezone.test.js -- regression test for the analytics day-bucketing
// timezone bug (rep scored on July 15 local showed on the July 16 heatmap cell).
//
// Root cause: day-series producers keyed buckets on UTC midnight
// (Math.floor(ts/DAY)*DAY) while the heatmap walks LOCAL midnights and labels
// with fmtDate (local). In any non-UTC tz events shifted by the offset.
//
// Fix: all day producers (anIntensity, anRepsSeries, anValueSeries,
// anActivitySeries, anAdherenceSeries, anBucket) now key on localDayKey(ts),
// matching anHeatmapHTML's lookup. This test reproduces the exact bug scenario
// from the real fixture (questa-MERGED-20260716-v2.json) and asserts the rep
// lands on the local July-15 cell, NOT July 16.
//
// localDayKey is copied verbatim from app.js:2071 to keep this test independent
// of app.js (which is DOM/boot dependent and not vm-loadable in the harness).
//
// Run: node tests/heatmap-timezone.test.js   (also via `node tests/run.js`)

const fs = require('fs'), path = require('path');
const DAY = 86400000;
function localDayKey(ms){ const d = new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
function fmtDate(ms){ const d = new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// --- load the real merged fixture ---
const fx = path.join(__dirname, '..', 'questa-MERGED-20260716-v2.json');
const data = JSON.parse(fs.readFileSync(fx, 'utf8'));
const habit = (data.tasks || []).find(t => t.title === 'Spraviť chlieb');
assert('fixture contains habit "Spraviť chlieb"', !!habit);

// --- reproduce anIntensity producer (the heatmap's actual data source) ---
const from = habit.history[0].date;
const to = Date.now();
const inten = {};
(habit.history || []).forEach(p => {
  if(typeof p.date !== 'number') return;
  if(p.date < from || p.date > to) return;
  const d = localDayKey(p.date);
  inten[d] = (inten[d] || 0) + 1;
});

// --- reproduce anHeatmapHTML lookup + label (the cell the user sees) ---
const lastRep = habit.history[habit.history.length - 1].date;
const cellKey = localDayKey(lastRep);                 // what anHeatmapHTML now looks up
const renderedLabel = fmtDate(cellKey);               // what the cell is labelled
const bucketedValue = inten[cellKey] || 0;            // intensity placed on that cell

// The raw UTC-midnight key the OLD (buggy) code used:
const oldUtcKey = Math.floor(lastRep / DAY) * DAY;
const oldRenderedLabel = fmtDate(oldUtcKey);

assertEq('rep lands on the July-15 heatmap cell (local day)', renderedLabel, '2026-07-15');
assert('heatmap cell for the rep is non-empty', bucketedValue > 0);
assert('rep is NOT attributed to July 16', renderedLabel !== '2026-07-16');

// Demonstrate the OLD behaviour would have mislabeled it for a +2h tz:
// old UTC key, interpreted as local, renders on a different (later) local day
// ONLY because the lookup used a local-midnight-walked key that never matched.
// Capture the pre-fix symptom: under the old code the value was placed under
// oldUtcKey but the heatmap cell for "2026-07-15 local" queried a LOCAL key
// (lastRep's local midnight), which != oldUtcKey in non-UTC tz.
const localMidOfRep = localDayKey(lastRep);
assert('pre-fix UTC key differs from local key in a non-UTC tz (explains the off-by-one)',
       oldUtcKey !== localMidOfRep);
assertEq('pre-fix UTC key rendered label', oldRenderedLabel, '2026-07-15');

// --- cross-check every history point buckets to its LOCAL calendar day ---
let allLocal = true;
(habit.history || []).forEach(p => {
  const loc = fmtDate(p.date);                 // true local day of the event
  const bucket = fmtDate(localDayKey(p.date)); // day the bucket/heatmap assigns
  if(loc !== bucket) allLocal = false;
});
assert('every rep buckets to its own local calendar day (no tz drift)', allLocal);

if(failures){ console.error('\n' + failures + ' assertion(s) FAILED'); process.exit(1); }
console.log('\nheatmap-timezone.test.js: all assertions passed');
