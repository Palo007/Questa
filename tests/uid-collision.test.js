// Review 2026-09-18, Part 2 item 6 — eventUidOf()'s content hash and the two
// dedup filters that consume it.
//
// What was wrong:
//   * eventUidOf() was a 32-bit FNV-1a with a comment claiming collisions were
//     impossible. Measured on the real generator: 1 collision at 60k events,
//     3 at 120k, against a 200k hard cap.
//   * eventMergeFilter() (app.js) and evtIncomingFilter() (sync.js) checked the
//     uid set FIRST and returned, so the content-signature safety net never saw
//     a colliding record. A collision dropped a legitimate event forever.
//
// What this file pins:
//   C1  the digest is 64 bits and still deterministic / content-sensitive
//   C2  eventMergeFilter keeps a colliding record instead of dropping it
//   C3  eventMergeFilter still drops a REAL duplicate (uid + signature match)
//   C4  the re-minted uid is deterministic, so a second import does not pile up
//   C5  evtIncomingFilter keeps a colliding record instead of dropping it
//   C6  evtIncomingFilter dedupes a re-hashed 'rep-' uid by signature, so the
//       32-bit -> 64-bit widening cannot double a user's imported history
//   C7  evtIncomingFilter leaves NON-'rep-' uids on uid-only dedup — two real
//       taps sharing a signature must both survive
//   C8  the legacy Set form still works (old callers, old tests)
//   C9  LOCKSTEP: sync.js evtIncomingSig / evtUidDisambiguate agree with their
//       app.js twins eventMergeSig / eventUidDisambiguate

const fs = require('fs');
const path = require('path');
const { extractFunction } = require('./_extract.js');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

// --- app.js side: the marker block is self-contained, eventUidOf is not ------
const block = appSrc.match(/\/\* BEGIN_EVENTS_HELPERS \*\/([\s\S]*?)\/\* END_EVENTS_HELPERS \*\//);
if (!block) { console.error('FAIL: BEGIN_EVENTS_HELPERS block not found in app.js'); process.exit(1); }
const eventUidOfFn = extractFunction(appSrc, /^function eventUidOf\(rec, idx\)\{/, 'eventUidOf');

const appEval = new Function(
  block[1] + '\n' + eventUidOfFn + '\n' +
  'return { eventMergeSig, eventMergeFilter, eventUidDisambiguate, eventUidOf };'
);
const { eventMergeSig, eventMergeFilter, eventUidDisambiguate, eventUidOf } = appEval();

// --- sync.js side -----------------------------------------------------------
const syncBlock = syncSrc.match(/\/\* BEGIN_EVTSYNC_HELPERS \*\/([\s\S]*?)\/\* END_EVTSYNC_HELPERS \*\//);
if (!syncBlock) { console.error('FAIL: BEGIN_EVTSYNC_HELPERS block not found in sync.js'); process.exit(1); }
const syncEval = new Function(
  syncBlock[1] + '\n' +
  'return { evtIncomingFilter, evtIncomingSig, evtUidDisambiguate };'
);
const { evtIncomingFilter, evtIncomingSig, evtUidDisambiguate } = syncEval();

let failures = 0;
function assert(desc, cond) {
  if (cond) { console.log('[PASS] ' + desc); }
  else { console.error('[FAIL] ' + desc); failures++; }
}

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);
const AGE = 18 * 30 * 86400000;
function rec(over) {
  return Object.assign({ ts: NOW - 1000, kind: 'tap', taskId: 't1', dir: 1, reps: 1,
                         dev: 'devA', uid: 'devA-abc-123456' }, over || {});
}

// ---------------------------------------------------------------------------
// C1: the digest is 64 bits wide, deterministic, and content-sensitive
// ---------------------------------------------------------------------------
{
  const r = rec({ id: 7 });
  const u = eventUidOf(r, 0);
  assert('C1a: uid is rep- plus 16 hex digits (64 bits, was 32)', /^rep-[0-9a-f]{16}$/.test(u));
  assert('C1b: deterministic for identical content', u === eventUidOf(rec({ id: 7 }), 0));
  assert('C1c: changes on a content change', u !== eventUidOf(rec({ id: 7, reps: 2 }), 0));
  assert('C1d: changes on array position', u !== eventUidOf(r, 1));
  // Both 32-bit lanes must be zero-padded to 8 digits, or the halves blur into
  // each other and the extra bits are worth less than they look.
  let allWide = true;
  for (let i = 0; i < 400; i++) {
    if (!/^rep-[0-9a-f]{16}$/.test(eventUidOf(rec({ id: i, ts: NOW - i }), i))) { allWide = false; break; }
  }
  assert('C1e: every uid keeps the full fixed width over 400 records', allWide);
  // Sanity that the lanes are not simply equal to one another.
  const halves = eventUidOf(rec({ id: 99 }), 3).slice(4);
  assert('C1f: the two lanes differ (not one lane printed twice)',
         halves.slice(0, 8) !== halves.slice(8));
}

// ---------------------------------------------------------------------------
// C2/C3/C4: eventMergeFilter — collision vs duplicate
// ---------------------------------------------------------------------------
{
  const stored = rec({ uid: 'rep-deadbeefdeadbeef', taskId: 'stored-task' });
  const uidMap = new Map([[stored.uid, eventMergeSig(stored)]]);
  const sigSet = new Set([eventMergeSig(stored)]);

  // A DIFFERENT event that happens to carry the same uid — the collision.
  const colliding = rec({ uid: 'rep-deadbeefdeadbeef', taskId: 'other-task', ts: NOW - 5000 });
  const out = eventMergeFilter([colliding], uidMap, sigSet);
  assert('C2a: the colliding record is kept, not dropped', out.add.length === 1);
  assert('C2b: it is kept under a re-minted uid', out.add.length === 1 && out.add[0].uid !== colliding.uid);
  assert('C2c: the input record was not mutated', colliding.uid === 'rep-deadbeefdeadbeef');
  assert('C2d: the re-minted uid is what eventUidDisambiguate produces',
         out.add.length === 1 &&
         out.add[0].uid === eventUidDisambiguate(colliding.uid, eventMergeSig(colliding)));

  // Same uid AND same content => a genuine duplicate, still skipped.
  const dup = rec({ uid: 'rep-deadbeefdeadbeef', taskId: 'stored-task' });
  const out2 = eventMergeFilter([dup], uidMap, sigSet);
  assert('C3: a real duplicate is still skipped', out2.add.length === 0 && out2.skipped === 1);

  // C4: run the collision twice — the second pass must see it as known.
  const uidMap2 = new Map(uidMap);
  eventMergeFilter([colliding], uidMap2, sigSet).add.forEach(r => uidMap2.set(r.uid, eventMergeSig(r)));
  const sigSet2 = new Set(sigSet); sigSet2.add(eventMergeSig(colliding));
  const out3 = eventMergeFilter([colliding], uidMap2, sigSet2);
  assert('C4: re-running the same import adds nothing (stable re-mint)', out3.add.length === 0);
}

// ---------------------------------------------------------------------------
// C8: the legacy Set form keeps the old uid-only behaviour
// ---------------------------------------------------------------------------
{
  const colliding = rec({ uid: 'rep-deadbeefdeadbeef', taskId: 'other-task' });
  const out = eventMergeFilter([colliding], new Set(['rep-deadbeefdeadbeef']), new Set());
  assert('C8a: eventMergeFilter with a Set still skips on a uid hit', out.add.length === 0);
  const out2 = evtIncomingFilter([colliding], new Set(['rep-deadbeefdeadbeef']), 'devMine', NOW, AGE);
  assert('C8b: evtIncomingFilter with a Set still skips on a uid hit', out2.length === 0);
}

// ---------------------------------------------------------------------------
// C5/C6/C7: evtIncomingFilter
// ---------------------------------------------------------------------------
{
  const stored = rec({ uid: 'rep-0011223344556677', taskId: 'stored-task', dev: 'devA' });
  const known = new Map([[stored.uid, evtIncomingSig(stored)]]);

  // C5: collision on the sync ingest path
  const colliding = rec({ uid: 'rep-0011223344556677', taskId: 'other-task', ts: NOW - 9000, dev: 'devA' });
  const out = evtIncomingFilter([colliding], known, 'devMine', NOW, AGE);
  assert('C5a: the colliding remote record is inserted, not dropped', out.length === 1);
  assert('C5b: under the same deterministic re-minted uid as app.js would use',
         out.length === 1 && out[0].uid === evtUidDisambiguate(colliding.uid, evtIncomingSig(colliding)));

  // C6: the SAME logical event arriving under a re-hashed 'rep-' uid (32-bit
  // store, 64-bit sender) must dedupe on the signature.
  const rehashed = rec({ uid: 'rep-aaaabbbbccccdddd', taskId: 'stored-task', dev: 'devA' });
  assert('C6 setup: signature matches the stored record',
         evtIncomingSig(rehashed) === evtIncomingSig(stored));
  const out6 = evtIncomingFilter([rehashed], known, 'devMine', NOW, AGE);
  assert('C6: a re-hashed rep- uid for a stored event is deduped by signature', out6.length === 0);

  // C7: a NON-rep uid with a matching signature is a different real tap and
  // must survive — the signature net is deliberately scoped to rep- uids.
  const realTap = rec({ uid: 'devB-xyz-999999', taskId: 'stored-task', dev: 'devB' });
  assert('C7 setup: signature matches the stored record',
         evtIncomingSig(realTap) === evtIncomingSig(stored));
  const out7 = evtIncomingFilter([realTap], known, 'devMine', NOW, AGE);
  assert('C7: a random-uid tap sharing a signature is still inserted', out7.length === 1);
}

// ---------------------------------------------------------------------------
// C9: LOCKSTEP between the app.js and sync.js copies
// ---------------------------------------------------------------------------
{
  const samples = [
    rec({}),
    rec({ kind: 'sub', taskId: '', dir: 0, reps: 0 }),
    rec({ kind: 'note', taskId: 'x|y', dir: -1, reps: 12 }),
    { ts: 0, kind: '', taskId: undefined, dir: undefined, reps: undefined }
  ];
  let sigOk = true, disOk = true;
  samples.forEach(s => {
    if (eventMergeSig(s) !== evtIncomingSig(s)) sigOk = false;
    const sig = eventMergeSig(s);
    if (eventUidDisambiguate('rep-1234', sig) !== evtUidDisambiguate('rep-1234', sig)) disOk = false;
  });
  assert('C9a: eventMergeSig (app.js) === evtIncomingSig (sync.js)', sigOk);
  assert('C9b: eventUidDisambiguate (app.js) === evtUidDisambiguate (sync.js)', disOk);
}

if (failures > 0) {
  console.error('\n' + failures + ' uid-collision test(s) FAILED');
  process.exit(1);
}
console.log('\nAll uid-collision tests passed!');
