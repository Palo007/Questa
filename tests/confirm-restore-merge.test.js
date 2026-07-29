// confirm-restore-merge.test.js -- W1.2: confirmRestore() must MERGE incoming
// backup events into the local IndexedDB event store, never wipe it first.
//
// Root cause this guards against: confirmRestore() used to call
// clearAllEvents() before bulkAddEvents(events), so restoring a backup
// destroyed every local event not present in that backup file. This already
// fired in production and is the mechanism that left two devices holding only
// re-badged copies of each other's history (each device's independent tap
// history got wiped on its own next restore).
//
// The fix: read the existing store first, NEVER clear it, and run incoming
// backup events through the existing eventMergeFilter/eventMergeSig helpers
// (app.js BEGIN_EVENTS_HELPERS block) so only genuinely-new events are added.
//
//   R1  local-only events survive a restore (the regression that matters)
//   R2  overlapping events (same uid) are not duplicated
//   R3  backup-only events are added
//   R4  clearAllEvents is NEVER called on this path (spy, zero calls)
//   R5  the 'restore' event records merged + skipped counts
//   R6  malformed/no-op restore (zero events) still never calls clearAllEvents
//
// Run: node tests/confirm-restore-merge.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js. Do NOT reintroduce hardcoded line-number slicing.
const confirmRestoreFn = extractFunction(appSrc, /^async function confirmRestore\(id\)\{/, 'confirmRestore');

// confirmRestore calls eventMergeFilter/eventMergeSig directly (both defined
// in app.js's BEGIN_EVENTS_HELPERS block). Pull ONLY those two functions --
// NOT the whole BEGIN/END_EVENTS_HELPERS block, which also contains the REAL
// getEvents/clearAllEvents/countEvents/clearSyntheticEvents/clearLifecycleEvents
// (all IDB-backed via idbOpen). Evaluating the whole block would hoist those
// real function declarations over our sandbox mocks (top-level `function`
// declarations in a vm context overwrite same-named globals), defeating the
// spies and throwing on the missing idbOpen global.
const eventMergeSigFn = extractFunction(appSrc, /^function eventMergeSig\(r\)\{/, 'eventMergeSig');
const eventMergeFilterFn = extractFunction(appSrc, /^function eventMergeFilter\(incoming, existingUidSet, existingSigSet\)\{/, 'eventMergeFilter');
const eventsHelpers = eventMergeSigFn + '\n' + eventMergeFilterFn;

// Sanity: the fix must have actually removed the clearAllEvents() CALL from
// confirmRestore's own source (a comment explaining why it was removed is
// fine and expected -- strip `//` line comments before checking so that
// comment doesn't trip this guard).
const confirmRestoreCodeOnly = confirmRestoreFn
  .replace(/\r\n/g, '\n')
  .split('\n')
  .map(function (line) { return line.replace(/\/\/.*$/, ''); })
  .join('\n');
if (/clearAllEvents\s*\(/.test(confirmRestoreCodeOnly)) {
  console.error('FAIL: confirmRestore() source still calls clearAllEvents() -- regression of the W1.2 fix');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Build a fresh sandbox + confirmRestore instance per scenario.
function makeCtx(opts) {
  opts = opts || {};
  const calls = {
    clearAllEvents: 0,
    bulkAddEvents: [],
    logEvent: [],
    alertDialog: [],
    getEvents: 0,
  };

  const sandbox = {
    console: console,
    // Only typeof-checked in confirmRestore (`typeof indexedDB !== "undefined"`);
    // never dereferenced directly, so a dummy object is sufficient.
    indexedDB: {},
    readSnapshot: opts.readSnapshot,
    listSnapshots: opts.listSnapshots || function () { return Promise.resolve([]); },
    confirmDialog: opts.confirmDialog || function () { return Promise.resolve(true); },
    alertDialog: function (title, text) { calls.alertDialog.push({ title: title, text: text }); },
    migrate: opts.migrate || function (x) { return x; },
    save: function () {},
    applyWidth: function () {},
    applyCardThick: function () {},
    closeSheet: function () {},
    render: function () {},
    toast: function () {},
    getEvents: function (o) { calls.getEvents++; return (opts.getEvents || function () { return Promise.resolve([]); })(o); },
    clearAllEvents: function () { calls.clearAllEvents++; return Promise.resolve(true); },
    bulkAddEvents: function (list) { calls.bulkAddEvents.push(list); return Promise.resolve(list.length); },
    logEvent: function (rec) { calls.logEvent.push(rec); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const src = eventsHelpers + '\n' + confirmRestoreFn;
  try { vm.runInContext(src, sandbox); }
  catch (e) { console.error('FAIL: extracted source threw during eval:', e); process.exit(1); }

  return { sandbox: sandbox, calls: calls };
}

function makeSnapshot(events, overrides) {
  overrides = overrides || {};
  const stateSnapshot = { char: { name: 'Test', lvl: 1 }, tasks: [] };
  return Object.assign({
    verified: true,
    ts: 123456,
    type: 'full',
    payload: JSON.stringify({ stateSnapshot: stateSnapshot, events: events }),
  }, overrides);
}

async function main() {
  // -----------------------------------------------------------------------
  // R1: local-only events survive the restore.
  // -----------------------------------------------------------------------
  {
    const localOnly = { uid: 'local-1', ts: 1000, kind: 'tap', taskId: 't1' };
    const backupEvent = { uid: 'backup-1', ts: 2000, kind: 'tap', taskId: 't2' };
    const ctx = makeCtx({
      readSnapshot: function () { return Promise.resolve(makeSnapshot([backupEvent])); },
      getEvents: function () { return Promise.resolve([localOnly]); },
    });
    await ctx.sandbox.confirmRestore('snap1');
    assert('R1a: clearAllEvents never called', ctx.calls.clearAllEvents === 0);
    assert('R1b: bulkAddEvents called exactly once', ctx.calls.bulkAddEvents.length === 1);
    const added = ctx.calls.bulkAddEvents[0];
    assert('R1c: local-only event NOT re-submitted (not in the add batch, was never cleared)',
      !added.some(function (e) { return e.uid === 'local-1'; }));
    assert('R1d: backup-only event added', added.some(function (e) { return e.uid === 'backup-1'; }));
  }

  // -----------------------------------------------------------------------
  // R2: overlapping events (same uid, present both locally and in the backup)
  // are not duplicated.
  // -----------------------------------------------------------------------
  {
    const shared = { uid: 'shared-1', ts: 3000, kind: 'tap', taskId: 't3' };
    const ctx = makeCtx({
      readSnapshot: function () { return Promise.resolve(makeSnapshot([shared])); },
      getEvents: function () { return Promise.resolve([shared]); },
    });
    await ctx.sandbox.confirmRestore('snap2');
    assert('R2a: clearAllEvents never called', ctx.calls.clearAllEvents === 0);
    const added = ctx.calls.bulkAddEvents[0];
    assert('R2b: overlapping event is NOT re-added', added.length === 0);
    assert('R2c: restore event records it as skipped', ctx.calls.logEvent[0].notes.indexOf('1 already present') !== -1
      || /\(1 already present, skipped\)/.test(ctx.calls.logEvent[0].notes));
  }

  // -----------------------------------------------------------------------
  // R3: backup-only events (nothing local at all) are added.
  // -----------------------------------------------------------------------
  {
    const b1 = { uid: 'fresh-1', ts: 4000, kind: 'tap', taskId: 't4' };
    const b2 = { uid: 'fresh-2', ts: 4100, kind: 'tap', taskId: 't5' };
    const ctx = makeCtx({
      readSnapshot: function () { return Promise.resolve(makeSnapshot([b1, b2])); },
      getEvents: function () { return Promise.resolve([]); },
    });
    await ctx.sandbox.confirmRestore('snap3');
    assert('R3a: clearAllEvents never called', ctx.calls.clearAllEvents === 0);
    const added = ctx.calls.bulkAddEvents[0];
    assert('R3b: both backup-only events added', added.length === 2
      && added.some(function (e) { return e.uid === 'fresh-1'; })
      && added.some(function (e) { return e.uid === 'fresh-2'; }));
  }

  // -----------------------------------------------------------------------
  // R4: clearAllEvents is never called across ALL scenarios in this file
  // (already asserted per-case above; this is a belt-and-braces aggregate
  // check plus a static-source check done at load time, above).
  // -----------------------------------------------------------------------
  {
    const ctx = makeCtx({
      readSnapshot: function () { return Promise.resolve(makeSnapshot([{ uid: 'x', ts: 1, kind: 'tap' }])); },
      getEvents: function () { return Promise.resolve([]); },
    });
    await ctx.sandbox.confirmRestore('snap4');
    assert('R4: clearAllEvents call count is exactly 0', ctx.calls.clearAllEvents === 0);
  }

  // -----------------------------------------------------------------------
  // R5: the 'restore' event records BOTH the merged count and the skipped
  // count (mix of one new + one overlapping event).
  // -----------------------------------------------------------------------
  {
    const known = { uid: 'known-1', ts: 5000, kind: 'tap', taskId: 't6' };
    const fresh = { uid: 'new-1', ts: 5100, kind: 'tap', taskId: 't7' };
    const ctx = makeCtx({
      readSnapshot: function () { return Promise.resolve(makeSnapshot([known, fresh])); },
      getEvents: function () { return Promise.resolve([known]); },
    });
    await ctx.sandbox.confirmRestore('snap5');
    assert('R5a: exactly one restore event logged', ctx.calls.logEvent.length === 1);
    const rec = ctx.calls.logEvent[0];
    assert('R5b: restore event kind is "restore"', rec.kind === 'restore');
    assert('R5c: notes report 1 merged event', rec.notes.indexOf('Restored 1 events') !== -1);
    assert('R5d: notes report 1 skipped event', /\(1 already present, skipped\)/.test(rec.notes));
    const added = ctx.calls.bulkAddEvents[0];
    assert('R5e: only the fresh event was actually added', added.length === 1 && added[0].uid === 'new-1');
  }

  // -----------------------------------------------------------------------
  // R6: a restore with zero backup events still never calls clearAllEvents,
  // and skips the merge branch entirely (no bulkAddEvents call at all).
  // -----------------------------------------------------------------------
  {
    const ctx = makeCtx({
      readSnapshot: function () { return Promise.resolve(makeSnapshot([])); },
      getEvents: function () { return Promise.resolve([{ uid: 'untouched-1', ts: 1, kind: 'tap' }]); },
    });
    await ctx.sandbox.confirmRestore('snap6');
    assert('R6a: clearAllEvents never called on an empty-events restore', ctx.calls.clearAllEvents === 0);
    assert('R6b: bulkAddEvents not called at all (events.length === 0 short-circuits the branch)',
      ctx.calls.bulkAddEvents.length === 0);
  }

  if (failures) {
    console.error('\n' + failures + ' confirm-restore-merge assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL CONFIRM-RESTORE-MERGE TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
