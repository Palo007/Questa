// event-feed-filter.test.js -- #12 Activity Feed diagnostic filtering
// Verifies getEvents() excludes diagnostic kinds by default but includes them
// with includeDiag:true. Also verifies conflictResolved remains visible.
//
// Strategy: extract BEGIN_EVENTS_HELPERS block from app.js, mock idbOpen +
// IDB cursor chain to return seeded events, then assert filter behavior.
//
// Run: node tests/event-feed-filter.test.js (also run by node tests/run.js)

const fs = require('fs'), path = require('path');

// 1. Extract events helpers block from app.js
const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const match = appSrc.match(/\/\* BEGIN_EVENTS_HELPERS \*\/([\s\S]*?)\/\* END_EVENTS_HELPERS \*\//);
if (!match) {
  console.error("FAIL: Could not find BEGIN_EVENTS_HELPERS block in app.js");
  process.exit(1);
}
const helperCode = match[1];

// 2. Build seeded events — one of each relevant kind
const EVENTS_SEED = [
  { ts: 1000, kind: 'complete', taskType: 'daily', taskTitle: 'Exercise', taskId: 't1' },
  { ts: 2000, kind: 'conflictResolved', taskType: 'char', charTitle: 'Mage', winner: 'remote', loser: 'local', charId: 'c1' },
  { ts: 3000, kind: 'conflictResolved', taskType: 'todo', taskTitle: 'Report', winner: 'local', loser: 'remote', taskId: 't2' },
  { ts: 4000, kind: 'lifecycle', notes: 'boot' },
  { ts: 5000, kind: 'storagePersist', granted: true },
  { ts: 6000, kind: 'multiTabClobberAvoided', preBumpSeq: 3, storedSeq: 4 },
  { ts: 7000, kind: 'quotaError', message: 'localStorage full' },
  { ts: 8000, kind: 'clockSkew' },
  { ts: 9000, kind: 'webLocksUnavailable' },
  { ts: 10000, kind: 'import', notes: 'Backup loaded' },
];

// 3. Mock IDB cursor chain that replays EVENTS_SEED
function buildMockIdb(events) {
  return {
    _events: events.slice().sort((a, b) => a.ts - b.ts),
    transaction: function() {
      const evts = this._events;
      return {
        objectStore: function() {
          return {
            index: function() {
              return {
                openCursor: function() {
                  let idx = 0;
                  const req = {};
                  // Fire onsuccess asynchronously (microtask) so the .then chain works
                  process.nextTick(function fireCursor() {
                    if (idx < evts.length) {
                      req.result = { value: evts[idx], continue: function() { idx++; fireCursor(); } };
                    } else {
                      req.result = null;
                    }
                    if (req.onsuccess) req.onsuccess();
                  });
                  return req;
                }
              };
            }
          };
        }
      };
    }
  };
}

// 4. Eval the helpers in a context with injected globals
const EVENTS_STORE = 'events';
const contextEval = new Function(
  'idbOpen', 'EVENTS_STORE', 'IDBKeyRange',
  helperCode + '\nreturn { getEvents, countEvents, DIAGNOSTIC_KINDS };'
);

// IDBKeyRange mock (just needs .bound, .lowerBound, .upperBound)
const mockKeyRange = {
  bound: function() { return 'range'; },
  lowerBound: function() { return 'range'; },
  upperBound: function() { return 'range'; }
};

let idbInstance = buildMockIdb(EVENTS_SEED);
const getEvents = contextEval(
  function() { return Promise.resolve(idbInstance); },
  EVENTS_STORE,
  mockKeyRange
).getEvents;

const DIAGNOSTIC_KINDS = contextEval(
  function() { return Promise.resolve(idbInstance); },
  EVENTS_STORE,
  mockKeyRange
).DIAGNOSTIC_KINDS;

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// =========================================================================
// F1: DIAGNOSTIC_KINDS contains expected kinds
// =========================================================================
(function() {
  assert('DIAGNOSTIC_KINDS includes lifecycle', DIAGNOSTIC_KINDS.indexOf('lifecycle') >= 0);
  assert('DIAGNOSTIC_KINDS includes storagePersist', DIAGNOSTIC_KINDS.indexOf('storagePersist') >= 0);
  assert('DIAGNOSTIC_KINDS includes webLocksUnavailable', DIAGNOSTIC_KINDS.indexOf('webLocksUnavailable') >= 0);
  assert('DIAGNOSTIC_KINDS includes clockSkew', DIAGNOSTIC_KINDS.indexOf('clockSkew') >= 0);
  assert('DIAGNOSTIC_KINDS includes multiTabClobberAvoided', DIAGNOSTIC_KINDS.indexOf('multiTabClobberAvoided') >= 0);
  assert('DIAGNOSTIC_KINDS includes quotaError', DIAGNOSTIC_KINDS.indexOf('quotaError') >= 0);
  assert('DIAGNOSTIC_KINDS does NOT include conflictResolved', DIAGNOSTIC_KINDS.indexOf('conflictResolved') < 0);
  assert('DIAGNOSTIC_KINDS does NOT include complete', DIAGNOSTIC_KINDS.indexOf('complete') < 0);
  assert('DIAGNOSTIC_KINDS does NOT include import', DIAGNOSTIC_KINDS.indexOf('import') < 0);
})();

// =========================================================================
// F2: getEvents({}) excludes diagnostic kinds, includes conflictResolved + normal
// =========================================================================
(async function() {
  idbInstance = buildMockIdb(EVENTS_SEED);
  const result = await getEvents({});
  const kinds = result.map(e => e.kind).sort();
  assertEq('default: excludes lifecycle', kinds.indexOf('lifecycle') < 0, true);
  assertEq('default: excludes storagePersist', kinds.indexOf('storagePersist') < 0, true);
  assertEq('default: excludes multiTabClobberAvoided', kinds.indexOf('multiTabClobberAvoided') < 0, true);
  assertEq('default: excludes quotaError', kinds.indexOf('quotaError') < 0, true);
  assertEq('default: excludes clockSkew', kinds.indexOf('clockSkew') < 0, true);
  assertEq('default: excludes webLocksUnavailable', kinds.indexOf('webLocksUnavailable') < 0, true);
  assertEq('default: includes conflictResolved', kinds.indexOf('conflictResolved') >= 0, true);
  assertEq('default: includes complete', kinds.indexOf('complete') >= 0, true);
  assertEq('default: includes import', kinds.indexOf('import') >= 0, true);
  assertEq('default: count is 4 (complete + 2 conflictResolved + import)', result.length, 4);
})();

// =========================================================================
// F3: getEvents({includeDiag:true}) includes everything
// =========================================================================
(async function() {
  idbInstance = buildMockIdb(EVENTS_SEED);
  const result = await getEvents({ includeDiag: true });
  const kinds = result.map(e => e.kind).sort();
  assertEq('includeDiag: includes lifecycle', kinds.indexOf('lifecycle') >= 0, true);
  assertEq('includeDiag: includes storagePersist', kinds.indexOf('storagePersist') >= 0, true);
  assertEq('includeDiag: includes multiTabClobberAvoided', kinds.indexOf('multiTabClobberAvoided') >= 0, true);
  assertEq('includeDiag: includes quotaError', kinds.indexOf('quotaError') >= 0, true);
  assertEq('includeDiag: includes clockSkew', kinds.indexOf('clockSkew') >= 0, true);
  assertEq('includeDiag: includes webLocksUnavailable', kinds.indexOf('webLocksUnavailable') >= 0, true);
  assertEq('includeDiag: includes conflictResolved', kinds.indexOf('conflictResolved') >= 0, true);
  assertEq('includeDiag: includes complete', kinds.indexOf('complete') >= 0, true);
  assertEq('includeDiag: includes import', kinds.indexOf('import') >= 0, true);
  assertEq('includeDiag: count is 10 (all events)', result.length, 10);
})();

// =========================================================================
// F4: getEvents({kind:'lifecycle'}) still works — explicit kind override
// =========================================================================
(async function() {
  idbInstance = buildMockIdb(EVENTS_SEED);
  const result = await getEvents({ kind: 'lifecycle' });
  assertEq('explicit kind=lifecycle returns only lifecycle', result.length, 1);
  assertEq('explicit kind=lifecycle event kind is lifecycle', result[0].kind, 'lifecycle');
})();

// =========================================================================
// F5: getEvents({kind:'conflictResolved'}) filters to only conflictResolved
// =========================================================================
(async function() {
  idbInstance = buildMockIdb(EVENTS_SEED);
  const result = await getEvents({ kind: 'conflictResolved' });
  assertEq('explicit kind=conflictResolved returns 2', result.length, 2);
  assertEq('all results are conflictResolved', result.every(e => e.kind === 'conflictResolved'), true);
})();

// =========================================================================
// F6: getEvents({kind:'quotaError'}) — explicit kind on a diag kind still works
// =========================================================================
(async function() {
  idbInstance = buildMockIdb(EVENTS_SEED);
  const result = await getEvents({ kind: 'quotaError' });
  assertEq('explicit kind=quotaError returns 1', result.length, 1);
  assertEq('explicit kind=quotaError event kind is quotaError', result[0].kind, 'quotaError');
})();

// =========================================================================
// F7: conflictResolved char event has charTitle (no taskTitle)
// =========================================================================
(async function() {
  idbInstance = buildMockIdb(EVENTS_SEED);
  const result = await getEvents({ kind: 'conflictResolved' });
  const charEvent = result.find(e => e.taskType === 'char');
  assertEq('char conflictResolved has charTitle', charEvent && charEvent.charTitle, 'Mage');
  assertEq('char conflictResolved has no taskTitle', charEvent && !charEvent.taskTitle, true);
  assertEq('char conflictResolved winner is remote', charEvent && charEvent.winner, 'remote');
})();

// =========================================================================
// F8: exportData's call site -- getEvents({includeDiag:true}) -- 2026-07-13
// (P2-5a). Backups are for debugging: user-facing export downloads must
// include diagnostic-kind events (lifecycle, storagePersist, etc), unlike the
// Activity Feed's getEvents({}) default. This mirrors app.js exportData()'s
// actual call (getEvents({includeDiag:true})) rather than re-testing the
// generic includeDiag flag covered by F3.
// =========================================================================
(async function() {
  idbInstance = buildMockIdb(EVENTS_SEED);
  const result = await getEvents({includeDiag: true}); // same call exportData() makes
  const kinds = result.map(e => e.kind).sort();
  assertEq('exportData path: includes lifecycle (diagnostic)', kinds.indexOf('lifecycle') >= 0, true);
  assertEq('exportData path: includes storagePersist (diagnostic)', kinds.indexOf('storagePersist') >= 0, true);
  assertEq('exportData path: includes quotaError (diagnostic)', kinds.indexOf('quotaError') >= 0, true);
  assertEq('exportData path: still includes normal kinds (complete)', kinds.indexOf('complete') >= 0, true);
  assertEq('exportData path: count is 10 (all events, nothing dropped from backup)', result.length, 10);
})();

// Final summary
setTimeout(function() {
  if (failures) {
    console.error('\nFAILED: ' + failures + ' assertion(s)');
    process.exit(1);
  }
  console.log('\nALL EVENT-FEED-FILTER TESTS PASSED');
  process.exit(0);
}, 500);
