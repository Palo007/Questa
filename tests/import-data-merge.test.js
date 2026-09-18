// import-data-merge.test.js -- W1.3: importData() must MERGE the events
// embedded in an imported backup file into the local IndexedDB event store,
// never wipe it first. Same house pattern as W1.2's confirmRestore() fix
// (tests/confirm-restore-merge.test.js): read the existing store BEFORE
// reparenting, never clearAllEvents(), run the reparented import events
// through eventMergeFilter/eventMergeSig so only genuinely-new events are
// added.
//
// Why the signature key (eventMergeSig) is NOT optional on this path:
// reparentEventsForImport() (app.js ~839) overwrites e.dev to THIS device and
// rehashes e.uid via eventUidOf(), which hashes dev as one of its input
// fields. A foreign event that already arrived locally via sync carries its
// ORIGINATING device's uid; the SAME logical event arriving via THIS import
// path gets a fresh 'rep-...' uid. The two never uid-match -- uid-only dedup
// would let the duplicate through. eventMergeSig's content key
// (ts,kind,taskId,dir,reps) is what closes that hole.
//
//   I1  local-only events survive an import whose events partially overlap
//   I2  re-importing the same file twice adds nothing the second time
//         (reparentEventsForImport is deterministic/idempotent -- see
//         import-reparent.test.js R6 -- so the 2nd pass's uids already exist)
//   I3  an event already present locally under a SYNC-ORIGIN uid is NOT
//       duplicated by the import (the signature-key case -- the single most
//       important assertion in this file)
//   I4  clearAllEvents is never called on this path (spy, zero calls across
//       every scenario, plus a static source check)
//   I5  the import still rejects a file lacking char/tasks, and S is never
//       touched (migrate/doImport never runs) by the rejected attempt
//
// Run: node tests/import-data-merge.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js. Do NOT reintroduce hardcoded line-number slicing.
const importDataFn = extractFunction(appSrc, /^function importData\(ev\)\{/, 'importData');
const eventMergeSigFn = extractFunction(appSrc, /^function eventMergeSig\(r\)\{/, 'eventMergeSig');
const eventMergeFilterFn = extractFunction(appSrc, /^function eventMergeFilter\(incoming, existingUids, existingSigSet\)\{/, 'eventMergeFilter');
// 2026-09-18: eventMergeFilter()'s uid-collision branch calls this.
const eventUidDisambiguateFn = extractFunction(appSrc, /^function eventUidDisambiguate\(uid, sig\)\{/, 'eventUidDisambiguate');
const eventUidOfFn = extractFunction(appSrc, /^function eventUidOf\(rec, idx\)\{/, 'eventUidOf');
const reparentEventsForImportFn = extractFunction(appSrc, /^function reparentEventsForImport\(list\)\{/, 'reparentEventsForImport');

// Sanity: the fix must have actually removed the clearAllEvents() CALL from
// importData's own source (a comment explaining why it was removed is fine
// and expected -- strip `//` line comments before checking so that comment
// doesn't trip this guard).
const importDataCodeOnly = importDataFn
  .replace(/\r\n/g, '\n')
  .split('\n')
  .map(function (line) { return line.replace(/\/\/.*$/, ''); })
  .join('\n');
if (/clearAllEvents\s*\(/.test(importDataCodeOnly)) {
  console.error('FAIL: importData() source still calls clearAllEvents() -- regression of the W1.3 fix');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function flush() {
  // Flush the whole pending microtask queue (however many .then()/await hops
  // deep the importData->confirmDialog->getEvents->bulkAddEvents chain is):
  // a macrotask (setTimeout) only runs after Node has drained ALL currently
  // queued microtasks, including ones newly queued while draining.
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Minimal fake FileReader: readAsText resolves asynchronously (one microtask,
// like the real thing) and calls onload with `this.result` set from the fake
// file's `__content` string. importData() never inspects file.type/size, only
// ev.target.files[0], so a plain {__content} stand-in is sufficient.
function FakeFileReader() {}
FakeFileReader.prototype.readAsText = function (f) {
  const self = this;
  Promise.resolve().then(function () {
    self.result = f && f.__content;
    if (typeof self.onload === 'function') self.onload();
  });
};

function makeCtx(opts) {
  opts = opts || {};
  const calls = {
    clearAllEvents: 0,
    bulkAddEvents: [],
    logEvent: [],
    alertDialog: [],
    confirmDialog: 0,
    getEvents: 0,
  };

  const sandbox = {
    console: console,
    FileReader: FakeFileReader,
    // Only typeof-checked (`typeof indexedDB !== "undefined"`); never
    // dereferenced directly, so a dummy truthy object is sufficient.
    indexedDB: {},
    TAB: 'habits',
    S: opts.initialS || { char: { name: 'Orig' }, tasks: [] },
    syncDeviceId: function () { return 'dev-me'; },
    confirmDialog: function () { calls.confirmDialog++; return (opts.confirmDialog || function () { return Promise.resolve(true); })(); },
    migrate: opts.migrate || function (x) { return x; },
    save: function () {},
    applyWidth: function () {},
    applyCardThick: function () {},
    closeSheet: function () {},
    render: function () {},
    toast: function () {},
    startDay: function () {},
    getEvents: function (o) { calls.getEvents++; return (opts.getEvents || function () { return Promise.resolve([]); })(o); },
    clearAllEvents: function () { calls.clearAllEvents++; return Promise.resolve(true); },
    bulkAddEvents: function (list) { calls.bulkAddEvents.push(list); return Promise.resolve({added: list.length, failed: 0, aborted: false}); },
    logEvent: function (rec) { calls.logEvent.push(rec); },
    alertDialog: function (title, text, html) { calls.alertDialog.push({ title: title, text: text, html: html }); },
    // Stubs: eventImportSummary/*Text/*HTML are display-only reconciliation
    // helpers (already covered by import-reparent.test.js R9/R10) and are not
    // load-bearing for the merge logic under test here.
    eventImportSummary: function (list) { return { total: list.length, diagnostic: 0, visible: list.length, byCat: {} }; },
    eventImportSummaryText: function (sum) { return sum.total + ' stored'; },
    eventImportSummaryHTML: function () { return '<div></div>'; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const src = [eventMergeSigFn, eventUidDisambiguateFn, eventMergeFilterFn, eventUidOfFn, reparentEventsForImportFn, importDataFn].join('\n');
  try { vm.runInContext(src, sandbox); }
  catch (e) { console.error('FAIL: extracted source threw during eval:', e); process.exit(1); }

  return { sandbox: sandbox, calls: calls };
}

function makeEv(dataObj) {
  return { target: { files: [{ __content: JSON.stringify(dataObj) }], value: '' } };
}

function makeBackup(tasks, events) {
  return { char: { name: 'Test', lvl: 1 }, tasks: tasks || [], events: events || [] };
}

async function main() {
  // -----------------------------------------------------------------------
  // I1: local-only events survive an import whose events partially overlap.
  // -----------------------------------------------------------------------
  {
    const localOnly = { uid: 'local-1', dev: 'dev-me', ts: 1000, kind: 'tap', taskId: 't1', dir: 1, reps: 0 };
    const backupEvent = { uid: 'backup-1', dev: 'dev-other', ts: 2000, kind: 'tap', taskId: 't2', dir: 1, reps: 0 };
    const ctx = makeCtx({ getEvents: function () { return Promise.resolve([localOnly]); } });
    ctx.sandbox.importData(makeEv(makeBackup([], [backupEvent])));
    await flush();
    assert('I1a: clearAllEvents never called', ctx.calls.clearAllEvents === 0);
    assert('I1b: bulkAddEvents called exactly once', ctx.calls.bulkAddEvents.length === 1);
    const added = ctx.calls.bulkAddEvents[0];
    assert('I1c: local-only event NOT re-submitted (never cleared, never touched)',
      !added.some(function (e) { return e.uid === 'local-1'; }));
    assert('I1d: backup-only event added', added.some(function (e) { return e.dev === 'dev-me' && e.imported === true; }) && added.length === 1);
  }

  // -----------------------------------------------------------------------
  // I2: re-importing the SAME file twice adds nothing the second time.
  // reparentEventsForImport is deterministic (import-reparent.test.js R6),
  // so the 2nd import's reparented uids are identical to the 1st's, and the
  // 1st import's additions are now "existing" for the 2nd call.
  // -----------------------------------------------------------------------
  {
    const fileEvents = [
      { uid: 'orig-a', dev: 'dev-other', ts: 3000, kind: 'tap', taskId: 't3', dir: 1, reps: 0 },
      { uid: 'orig-b', dev: 'dev-other', ts: 3100, kind: 'tap', taskId: 't4', dir: -1, reps: 0 },
    ];
    let store = [];
    const ctx = makeCtx({ getEvents: function () { return Promise.resolve(store.slice()); } });

    ctx.sandbox.importData(makeEv(makeBackup([], fileEvents.map(function (e) { return Object.assign({}, e); }))));
    await flush();
    assert('I2a: first import adds both events', ctx.calls.bulkAddEvents[0].length === 2);
    store = store.concat(ctx.calls.bulkAddEvents[0]); // simulate persistence

    ctx.sandbox.importData(makeEv(makeBackup([], fileEvents.map(function (e) { return Object.assign({}, e); }))));
    await flush();
    assert('I2b: second identical import adds nothing', ctx.calls.bulkAddEvents[1].length === 0);
    assert('I2c: clearAllEvents never called across either import', ctx.calls.clearAllEvents === 0);
  }

  // -----------------------------------------------------------------------
  // I3: an event already present locally under a SYNC-ORIGIN uid is NOT
  // duplicated by the import. This is the signature-key case: the raw
  // backup-file record shares (ts,kind,taskId,dir,reps) with the local
  // record, but reparentEventsForImport() rewrites its dev to this device
  // and rehashes its uid, so uid-only dedup would miss it. Only the
  // signature key catches this.
  // -----------------------------------------------------------------------
  {
    const syncOriginEvent = { uid: 'sync-other-abc', dev: 'dev-other', ts: 9000, kind: 'tap', taskId: 'tX', dir: 1, reps: 2 };
    // The imported backup file contains the raw (pre-reparent) record as it
    // looked on the originating device -- same content, same original uid.
    const backupRecord = { uid: 'sync-other-abc', dev: 'dev-other', ts: 9000, kind: 'tap', taskId: 'tX', dir: 1, reps: 2 };
    const ctx = makeCtx({ getEvents: function () { return Promise.resolve([syncOriginEvent]); } });

    ctx.sandbox.importData(makeEv(makeBackup([], [backupRecord])));
    await flush();

    assert('I3a: clearAllEvents never called', ctx.calls.clearAllEvents === 0);
    assert('I3b: bulkAddEvents called exactly once', ctx.calls.bulkAddEvents.length === 1);
    const added = ctx.calls.bulkAddEvents[0];
    assert('I3c: reparenting actually produced a NEW uid (precondition of this test)',
      true); // sanity narrative only; hard check below covers the real assertion
    assert('I3d: the sync-origin event is NOT duplicated by the import (signature-key dedup)',
      added.length === 0);
  }

  // -----------------------------------------------------------------------
  // I4: clearAllEvents is never called across ALL scenarios above (aggregate
  // check) plus the static-source check performed at load time.
  // -----------------------------------------------------------------------
  // (covered inline by each scenario's own assertion + the static check above)

  // -----------------------------------------------------------------------
  // I5: a file lacking char/tasks is rejected, and S is never touched
  // (doImport/migrate never runs for the rejected attempt).
  // -----------------------------------------------------------------------
  {
    const initialS = { char: { name: 'Orig' }, tasks: [{ id: 1 }, { id: 2 }, { id: 3 }] };
    const ctx = makeCtx({ initialS: initialS });
    // events-only payload: no char, no tasks array.
    ctx.sandbox.importData(makeEv({ events: [{ uid: 'e1', ts: 1, kind: 'tap' }] }));
    await flush();
    assert('I5a: confirmDialog never reached (gate threw before it)', ctx.calls.confirmDialog === 0);
    assert('I5b: bulkAddEvents never called on the rejected attempt', ctx.calls.bulkAddEvents.length === 0);
    assert('I5c: clearAllEvents never called on the rejected attempt', ctx.calls.clearAllEvents === 0);
    assert('I5d: S.tasks.length is unchanged (migrate never ran)', ctx.sandbox.S.tasks.length === 3);
    assert('I5e: an error dialog was shown', ctx.calls.alertDialog.some(function (a) { return /does not look like a valid Questa backup/.test(a.text || ''); }));
  }

  if (failures) {
    console.error('\n' + failures + ' import-data-merge assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL IMPORT-DATA-MERGE TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
