// tokenize-null-roundtrip.test.js -- regression cover for the 2026-09-18 review.
//
// The schema-2 export tokenizes four event fields through dictionaries
// (kind/source/taskId/taskTitle) via idx(), which returns -1 for null.
// _detokenizeEvents used to read K[-1] / SRC[-1] / TID[-1] / TT[-1], which is
// `undefined` -- and JSON.stringify DROPS an undefined-valued key.
//
// That matters far beyond the field itself. buildBackupFile computes
// _backup.hash over the LEGACY (detokenized) shape, and importData re-stringifies
// the detokenized object and compares. If detokenize is not an exact inverse of
// tokenize, a perfectly good backup fails its OWN integrity gate and the user is
// told the file "appears to be corrupted or tampered with. Import cancelled."
//
// -1 is now an explicit null sentinel on the way back.
//
// Run: node tests/tokenize-null-roundtrip.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const noop = function(){};
const sandbox = {
  console: console, JSON: JSON, Math: Math, Date: Date,
  Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean,
  Map: Map, Set: Set, Promise: Promise,
  window: {}, document: { getElementById: function(){ return null; } },
  localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop },
  S: {}, logEvent: noop, toast: noop
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Same slice technique as tests/tokenized-export.test.js: take just the pure
// tokenize/detokenize helpers so the full DOM boot does not have to succeed.
const a = src.indexOf('const _EXPORT_FIELD_MAP');
const b = src.indexOf('async function buildBackupFile(');
if (a < 0 || b < 0) { console.error('FAIL: could not locate tokenize helpers in app.js'); process.exit(1); }
vm.runInContext(src.slice(a, b), sandbox);

const _tokenizeEvents = sandbox._tokenizeEvents;
const _detokenizeEvents = sandbox._detokenizeEvents;
if (typeof _tokenizeEvents !== 'function' || typeof _detokenizeEvents !== 'function') {
  console.error('FAIL: tokenize helpers not exposed on sandbox'); process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

function roundTrip(events){
  const tok = _tokenizeEvents(events);
  return _detokenizeEvents({ E: tok.E, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT });
}

// ===========================================================================
// T1 -- a null in each dictionary-backed field survives the round trip
// ===========================================================================
console.log('--- T1: explicit nulls survive tokenize -> detokenize ---');
{
  const orig = [{ ts: 1000, uid: 'u1', dev: 'devA',
                  kind: 'complete', taskId: null, taskTitle: 'Run', source: null, notes: 'n' }];
  const back = roundTrip(orig);

  assertEq('T1a one event came back', back.length, 1);
  assert('T1b taskId key still exists', Object.prototype.hasOwnProperty.call(back[0], 'taskId'));
  assertEq('T1c ...and is null, not undefined', back[0].taskId, null);
  assert('T1d source key still exists', Object.prototype.hasOwnProperty.call(back[0], 'source'));
  assertEq('T1e ...and is null, not undefined', back[0].source, null);
  assertEq('T1f a non-null dictionary field is unharmed', back[0].taskTitle, 'Run');
  assertEq('T1g kind is unharmed', back[0].kind, 'complete');
}

// ===========================================================================
// T2 -- the hash gate. This is the assertion that actually mattered: a backup
//       must re-stringify to exactly what was hashed, or import refuses it.
// ===========================================================================
console.log('--- T2: the JSON round trip is byte-exact (the hash gate) ---');
{
  const orig = [
    { ts: 1, uid: 'a', dev: 'd1', kind: 'habitTap', taskId: null, taskTitle: 'Pushups', source: null, dir: 1, reps: 20 },
    { ts: 2, uid: 'b', dev: 'd1', kind: 'complete', taskId: 't1', taskTitle: 'Run', source: 'manual' },
    { ts: 3, uid: 'c', dev: 'd2', kind: null, taskId: null, taskTitle: null, source: null }
  ];
  const back = roundTrip(orig);
  assertEq('T2a the detokenized JSON equals the original JSON',
    JSON.stringify(back), JSON.stringify(orig));
  assertEq('T2b an all-null event keeps all four keys',
    Object.keys(back[2]).sort().join(','), Object.keys(orig[2]).sort().join(','));
}

// ===========================================================================
// T3 -- controls: ordinary events and the dictionaries themselves
// ===========================================================================
console.log('--- T3: ordinary events are unaffected ---');
{
  const orig = [
    { ts: 10, uid: 'x', dev: 'd', kind: 'complete', taskId: 't1', taskTitle: 'A', source: 'manual' },
    { ts: 11, uid: 'y', dev: 'd', kind: 'complete', taskId: 't1', taskTitle: 'A', source: 'manual' },
    { ts: 12, uid: 'z', dev: 'd', kind: 'miss',     taskId: 't2', taskTitle: 'B', source: 'cron' }
  ];
  const tok = _tokenizeEvents(orig);
  assertEq('T3a the kind dictionary deduplicates', tok.K.length, 2);
  assertEq('T3b the taskId dictionary deduplicates', tok.TID.length, 2);
  assertEq('T3c no dictionary entry is null', tok.K.concat(tok.TID, tok.TT, tok.SRC).filter(v=>v===null).length, 0);
  assertEq('T3d the round trip is exact', JSON.stringify(roundTrip(orig)), JSON.stringify(orig));
}

{
  // An ABSENT key must stay absent -- it must not come back as null.
  const orig = [{ ts: 5, uid: 'k', dev: 'd', kind: 'export', taskTitle: 'Export Data' }];
  const back = roundTrip(orig);
  assert('T3e an absent taskId does not reappear', !('taskId' in back[0]));
  assert('T3f an absent source does not reappear', !('source' in back[0]));
  assertEq('T3g the round trip is still exact', JSON.stringify(back), JSON.stringify(orig));
}

{
  assertEq('T3h an empty event list round-trips to empty', roundTrip([]).length, 0);
}

// ===========================================================================
if (failures) { console.error('\n' + failures + ' tokenize-null-roundtrip assertion(s) FAILED'); process.exit(1); }
console.log('\nAll tokenize-null-roundtrip tests passed!');
