// event-merge-filter.test.js -- pure union-insert merge filter for incoming
// sync/import events. Dedupes on BOTH the stable event uid AND a content
// signature, because reparentEventsForImport() (app.js) rewrites e.dev and
// rehashes e.uid via eventUidOf() on the import path -- and eventUidOf()
// hashes dev as one of its inputs. So the SAME logical event can arrive once
// via import (new, reparented uid) and once via cross-device sync (original
// uid): two different uids for one real tap. uid-only dedup would let the
// duplicate through; sig-based dedup catches it (see test M2 below).
// Run: node tests/event-merge-filter.test.js (also run by node tests/run.js)

const fs = require('fs');
const path = require('path');

// 1. Read app.js
const appJsPath = path.join(__dirname, '../app.js');
const code = fs.readFileSync(appJsPath, 'utf8');

// 2. Extract the events helper block
const match = code.match(/\/\* BEGIN_EVENTS_HELPERS \*\/([\s\S]*?)\/\* END_EVENTS_HELPERS \*\//);
if (!match) {
  console.error("FAIL: Could not find events helper block in app.js");
  process.exit(1);
}

// 3. Eval the helpers in the local test scope -- self-contained, no outside globals needed
const helperCode = match[1];
const contextEval = new Function(helperCode + "\nreturn { eventMergeFilter, eventMergeSig };");
const { eventMergeFilter, eventMergeSig } = contextEval();

if (typeof eventMergeFilter !== 'function' || typeof eventMergeSig !== 'function') {
  console.error('FAIL: helpers not exposed from BEGIN_EVENTS_HELPERS block');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) {
    console.log("[PASS] " + desc);
  } else {
    console.error("[FAIL] " + desc);
    failures++;
  }
}

// M1: record already present by uid is skipped
{
  const incoming = [{ uid: 'u1', ts: 1000, kind: 'tap', taskId: 't1' }];
  const existingUidSet = new Set(['u1']);
  const existingSigSet = new Set();
  const r = eventMergeFilter(incoming, existingUidSet, existingSigSet);
  assert('M1a: uid-already-present record dropped', r.add.length === 0);
  assert('M1b: skipped counts it', r.skipped === 1);
}

// M2: record already present by SIGNATURE but with a DIFFERENT uid is skipped
// -- this is the reparenting case (import rewrites dev -> new uid), and is
// the single most important assertion in this file.
{
  const original = { uid: 'orig-uid', ts: 2000, kind: 'tap', taskId: 't2', dir: 1, reps: 3 };
  const reparented = { uid: 'rep-abcdef', ts: 2000, kind: 'tap', taskId: 't2', dir: 1, reps: 3 };
  assert('M2 setup: reparented uid differs from original', reparented.uid !== original.uid);
  assert('M2 setup: signatures match', eventMergeSig(original) === eventMergeSig(reparented));

  const existingUidSet = new Set([original.uid]); // only the original uid is already known
  const existingSigSet = new Set([eventMergeSig(original)]);
  const r = eventMergeFilter([reparented], existingUidSet, existingSigSet);
  assert('M2a: signature-duplicate (different uid) is dropped', r.add.length === 0);
  assert('M2b: skipped counts it', r.skipped === 1);
}

// M3: duplicates within one incoming array are added once
{
  const incoming = [
    { uid: 'dup-1', ts: 3000, kind: 'tap', taskId: 't3' },
    { uid: 'dup-1', ts: 3000, kind: 'tap', taskId: 't3' }, // exact uid dup
    { uid: 'dup-2', ts: 4000, kind: 'tap', taskId: 't4', dir: 1, reps: 2 },
    { uid: 'dup-3', ts: 4000, kind: 'tap', taskId: 't4', dir: 1, reps: 2 } // same sig as dup-2, different uid
  ];
  const r = eventMergeFilter(incoming, new Set(), new Set());
  assert('M3a: exact-uid dup within batch added once', r.add.filter(e => e.uid === 'dup-1').length === 1);
  assert('M3b: same-signature dup within batch (different uid) added once total', r.add.length === 2);
  assert('M3c: skipped counts the two intra-batch dups', r.skipped === 2);
}

// M4: malformed records are dropped and counted in skipped
{
  const incoming = [
    null,                                                    // not an object
    42,                                                       // not an object
    { ts: 5000, kind: 'tap', taskId: 't5' },                  // missing uid
    { uid: '', ts: 5000, kind: 'tap' },                       // falsy uid
    { uid: 'u-bad-ts', ts: 'not-a-number', kind: 'tap' },     // non-numeric ts
    { uid: 'u-bad-ts2', kind: 'tap' }                         // ts missing entirely
  ];
  const r = eventMergeFilter(incoming, new Set(), new Set());
  assert('M4a: all malformed records dropped', r.add.length === 0);
  assert('M4b: skipped counts every malformed record', r.skipped === incoming.length);
}

// M5: a genuinely new record is added
{
  const incoming = [{ uid: 'fresh-1', ts: 6000, kind: 'tap', taskId: 't6', dir: -1, reps: 1 }];
  const r = eventMergeFilter(incoming, new Set(['other-uid']), new Set(['6001|tap|t6|-1|1']));
  assert('M5a: new record added', r.add.length === 1 && r.add[0].uid === 'fresh-1');
  assert('M5b: skipped is zero', r.skipped === 0);
}

// M6: add.length + skipped === incoming.length always holds (mixed batch)
{
  const incoming = [
    { uid: 'ok-1', ts: 7000, kind: 'tap', taskId: 't7' },     // new
    { uid: 'ok-1', ts: 7000, kind: 'tap', taskId: 't7' },     // intra-batch dup
    null,                                                      // malformed
    { uid: 'known-1', ts: 8000, kind: 'tap', taskId: 't8' },  // known by uid
    { uid: 'unknown-but-sig', ts: 9000, kind: 'tap', taskId: 't9', dir: 0, reps: 0 } // known by sig
  ];
  const existingUidSet = new Set(['known-1']);
  const existingSigSet = new Set([eventMergeSig({ ts: 9000, kind: 'tap', taskId: 't9', dir: 0, reps: 0 })]);
  const r = eventMergeFilter(incoming, existingUidSet, existingSigSet);
  assert('M6a: add.length + skipped === incoming.length', r.add.length + r.skipped === incoming.length);
}

// M7: inputs are not mutated
{
  const incoming = [{ uid: 'im-1', ts: 10000, kind: 'tap', taskId: 't10' }];
  const incomingCopy = JSON.parse(JSON.stringify(incoming));
  const existingUidSet = new Set(['other-known']);
  const existingUidSetCopy = new Set(existingUidSet);
  const existingSigSet = new Set(['some-other-sig']);
  const existingSigSetCopy = new Set(existingSigSet);
  eventMergeFilter(incoming, existingUidSet, existingSigSet);
  assert('M7a: incoming array/objects unmutated', JSON.stringify(incoming) === JSON.stringify(incomingCopy));
  assert('M7b: existingUidSet unmutated', existingUidSet.size === existingUidSetCopy.size
    && [...existingUidSet].every(v => existingUidSetCopy.has(v)));
  assert('M7c: existingSigSet unmutated', existingSigSet.size === existingSigSetCopy.size
    && [...existingSigSet].every(v => existingSigSetCopy.has(v)));
}

// M8: eventMergeSig uses '|' separator so field boundaries cannot collapse.
// Under an EMPTY-string join (the work-plan's original spec), these two
// genuinely distinct records both concatenate to "123" + "0" + "0" = "12300"
// -- a and b would be indistinguishable. The '|' separator keeps them apart.
{
  const a = { ts: 1, kind: '23', taskId: '', dir: 0, reps: 0 };
  const b = { ts: 12, kind: '3', taskId: '', dir: 0, reps: 0 };
  assert('M8a: "".join collision would occur (sanity check on the fixture)',
    [a.ts, a.kind, a.taskId, a.dir, a.reps].join('') === [b.ts, b.kind, b.taskId, b.dir, b.reps].join(''));
  assert('M8b: eventMergeSig ("|" separator) keeps them distinct', eventMergeSig(a) !== eventMergeSig(b));
}

if (failures > 0) {
  console.error(failures + " test(s) failed.");
  process.exit(1);
} else {
  console.log("All tests passed!");
  process.exit(0);
}
