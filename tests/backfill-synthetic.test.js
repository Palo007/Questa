// backfill-synthetic.test.js -- W5.8: importEventsBackfill() (app.js, the
// ONLY safe events-only import entry point -- it loads an events array and
// never touches S) must keep reconstructed/backfilled records flagged
// `synthetic: true` all the way into the store, even though the function it
// delegates to for reparenting -- reparentEventsForImport() -- deliberately
// STRIPS that flag for its main (Settings -> Import) caller. Before this fix,
// synthetic events lost the flag on their way through importEventsBackfill()
// too, which made them indistinguishable from real taps and, critically,
// UPLOADABLE to other devices via sync (evtUploadable/evtOwnMonthRecords in
// sync.js key off `!e.synthetic`).
//
// Fix (app.js ~1150, inside importEventsBackfill, after
// reparentEventsForImport(list) and before bulkAddEvents): re-stamp
// `synthetic = true` on every record in the reparented list.
//
// Second requirement covered here: clearSyntheticEvents() runs before the
// new batch is added, silently destroying any PRE-EXISTING synthetic
// records (making a re-run idempotent/replacing). That must no longer be
// silent -- the count of records it removed is now surfaced via toast()
// ("Replacing N previously reconstructed events.") before the new batch
// lands.
//
//   B1  a loaded record emerges with synthetic === true, surviving
//       reparentEventsForImport() (which strips the flag for its normal caller)
//   B2  such records are excluded by evtUploadable() -- the device-local
//       guarantee that a reconstructed/backfilled event can never be pushed
//   B3  S is never touched: S.tasks.length and S.char are unchanged by a
//       backfill load (this entry point is events-only, by design)
//   B4  first load (no pre-existing synthetic records): no "Replacing N..."
//       toast fires (nothing to report)
//   B5  pre-existing synthetic count is computed and reported via toast
//       BEFORE the new batch is added
//   B6  re-running the loader REPLACES rather than duplicates: the old
//       synthetic batch is gone, only the new batch's records remain
//   B7  a non-synthetic record already in the store is untouched by the load
//
// Run: node tests/backfill-synthetic.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js/sync.js. Do NOT reintroduce hardcoded line-number slicing.
const importEventsBackfillFn = extractFunction(appSrc, /^function importEventsBackfill\(ev\)\{/, 'importEventsBackfill');
const reparentEventsForImportFn = extractFunction(appSrc, /^function reparentEventsForImport\(list\)\{/, 'reparentEventsForImport');
const eventUidOfFn = extractFunction(appSrc, /^function eventUidOf\(rec, idx\)\{/, 'eventUidOf');
const evtUploadableFn = extractFunction(syncSrc, /^function evtUploadable\(events, myDev, sinceTs\)\{/, 'evtUploadable');

// Sanity: the fix must actually re-stamp synthetic=true on the reparented
// list inside importEventsBackfill's own source (between reparent and add).
// NB: match lazily across parens -- the guard body legitimately contains ')'
// (e.g. `if(e && typeof e==="object") e.synthetic = true`), so a [^)]* class
// cannot reach the assignment and would fail against a correct implementation.
if (!/reparented\.forEach\([\s\S]*?synthetic\s*=\s*true/.test(importEventsBackfillFn.replace(/\r\n/g, '\n'))) {
  console.error('FAIL: importEventsBackfill() source does not appear to re-stamp synthetic=true on the reparented list -- regression of the W5.8 fix');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function flush() {
  // Flush the whole pending microtask queue (however many .then()/await hops
  // deep the FileReader->confirmDialog->clearSyntheticEvents->bulkAddEvents
  // chain is): a macrotask (setTimeout) only runs after Node has drained ALL
  // currently queued microtasks, including ones newly queued while draining.
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Minimal fake FileReader: readAsText resolves asynchronously (one microtask,
// like the real thing) and calls onload with `this.result` set from the fake
// file's `__content` string.
function FakeFileReader() {}
FakeFileReader.prototype.readAsText = function (f) {
  const self = this;
  Promise.resolve().then(function () {
    self.result = f && f.__content;
    if (typeof self.onload === 'function') self.onload();
  });
};

function makeEv(list) {
  return { target: { files: [{ __content: JSON.stringify(list) }], value: '' } };
}

function makeCtx(initialStore) {
  // In-memory stand-in for the IndexedDB events store, so clearSyntheticEvents
  // / bulkAddEvents behave with real replace-not-duplicate semantics instead
  // of being no-op call-count spies.
  const state = { list: (initialStore || []).map(function (e) { return Object.assign({}, e); }) };
  const toasts = [];
  const alerts = [];

  const sandbox = {
    console: console,
    FileReader: FakeFileReader,
    indexedDB: {}, // only typeof-checked
    TAB: 'habits',
    S: { char: { name: 'Hero', lvl: 3, xp: 10, hp: 50, gold: 5 }, tasks: [{ id: 1 }, { id: 2 }] },
    syncDeviceId: function () { return 'dev-me'; },
    confirmDialog: function () { return Promise.resolve(true); },
    alertDialog: function (title, text) { alerts.push({ title: title, text: text }); },
    toast: function (msg) { toasts.push(msg); },
    render: function () {},
    clearSyntheticEvents: function () {
      const removed = state.list.filter(function (e) { return e && e.synthetic; }).length;
      state.list = state.list.filter(function (e) { return !(e && e.synthetic); });
      return Promise.resolve(removed);
    },
    bulkAddEvents: function (list) {
      (list || []).forEach(function (e) { state.list.push(Object.assign({}, e)); });
      return Promise.resolve((list || []).length);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const src = [eventUidOfFn, reparentEventsForImportFn, importEventsBackfillFn].join('\n');
  try { vm.runInContext(src, sandbox); }
  catch (e) { console.error('FAIL: extracted source threw during eval:', e); process.exit(1); }

  return { sandbox: sandbox, state: state, toasts: toasts, alerts: alerts };
}

async function main() {
  // A real, non-synthetic, this-device event already in the store (a live
  // tap) -- must survive clearSyntheticEvents/the whole load untouched.
  const realEvent = { uid: 'real-1', dev: 'dev-me', ts: 1000, kind: 'tap', taskId: 't1', dir: 1, reps: 0 };

  const initialSSnapshot = JSON.stringify({ char: { name: 'Hero', lvl: 3, xp: 10, hp: 50, gold: 5 }, tasks: [{ id: 1 }, { id: 2 }] });

  const ctx = makeCtx([realEvent]);

  // Reconstructed records as tools/reconstruct_events_jul28.py emits them:
  // no uid, no dev -- exactly what reparentEventsForImport()/eventUidOf()
  // must stamp.
  const batch1 = [
    { ts: 2000, kind: 'tap', taskId: 'h1', dir: 1, reps: 0, source: 'reconstructed' },
    { ts: 2100, kind: 'tap', taskId: 'h2', dir: 1, reps: 0, source: 'reconstructed' },
    { ts: 2200, kind: 'daily', taskId: 'd1', source: 'reconstructed' },
  ];

  ctx.sandbox.importEventsBackfill(makeEv(batch1));
  await flush();

  // ---------------------------------------------------------------------
  // B4: first load, no pre-existing synthetic records -> no "Replacing N..."
  // toast (nothing to report).
  // ---------------------------------------------------------------------
  assert('B4: no "Replacing" toast on a clean first load (0 pre-existing synthetic)',
    !ctx.toasts.some(function (t) { return /Replacing \d+/.test(t || ''); }));
  assert('B4b: the normal "Loaded N events" toast still fires', ctx.toasts.some(function (t) { return /Loaded 3 events/.test(t || ''); }));

  // ---------------------------------------------------------------------
  // B7: the pre-existing non-synthetic real event is untouched.
  // ---------------------------------------------------------------------
  const stillReal = ctx.state.list.find(function (e) { return e.uid === 'real-1'; });
  assert('B7: pre-existing non-synthetic event survives the load unchanged', !!stillReal && stillReal.dev === 'dev-me' && !stillReal.synthetic);

  // ---------------------------------------------------------------------
  // B1: every record from batch1 emerges with synthetic === true, i.e. the
  // re-stamp survived reparentEventsForImport() (which strips the flag for
  // its normal caller).
  // ---------------------------------------------------------------------
  const loaded1 = ctx.state.list.filter(function (e) { return e.uid !== 'real-1'; });
  assert('B1: all 3 batch1 records stored', loaded1.length === 3);
  assert('B1b: every batch1 record has synthetic === true', loaded1.every(function (e) { return e.synthetic === true; }));
  assert('B1c: every batch1 record was reparented to this device', loaded1.every(function (e) { return e.dev === 'dev-me' && e.imported === true && !!e.uid; }));

  // ---------------------------------------------------------------------
  // B3: S is never touched by this events-only entry point.
  // ---------------------------------------------------------------------
  assert('B3: S is unchanged after a backfill load', JSON.stringify(ctx.sandbox.S) === initialSSnapshot);

  // ---------------------------------------------------------------------
  // B2: synthetic records are excluded by evtUploadable -- the single most
  // important assertion here (the device-local guarantee).
  // ---------------------------------------------------------------------
  const evtUploadableSandbox = { console: console };
  evtUploadableSandbox.globalThis = evtUploadableSandbox;
  vm.createContext(evtUploadableSandbox);
  vm.runInContext(evtUploadableFn, evtUploadableSandbox);
  const allRecords = ctx.state.list.slice(); // real-1 (not synthetic) + 3 synthetic
  const uploadable = evtUploadableSandbox.evtUploadable(allRecords, 'dev-me', 0);
  assert('B2: none of the synthetic batch1 records are uploadable', !uploadable.some(function (e) { return e.synthetic; }));
  assert('B2b: the real (non-synthetic) event IS uploadable (sanity: the filter is discriminating, not blanket)',
    uploadable.some(function (e) { return e.uid === 'real-1'; }));

  // ---------------------------------------------------------------------
  // B5/B6: re-run the loader with a NEW (smaller) batch. The 3 pre-existing
  // synthetic records from batch1 must be counted and reported (B5), then
  // replaced -- not duplicated alongside -- by batch2 (B6).
  // ---------------------------------------------------------------------
  const batch2 = [
    { ts: 3000, kind: 'tap', taskId: 'h9', dir: 1, reps: 0, source: 'reconstructed' },
    { ts: 3100, kind: 'daily', taskId: 'd9', source: 'reconstructed' },
  ];
  ctx.sandbox.importEventsBackfill(makeEv(batch2));
  await flush();

  assert('B5: the pre-existing synthetic count (3) is reported via toast before the new batch replaces it',
    ctx.toasts.some(function (t) { return /Replacing 3 previously reconstructed events\./.test(t || ''); }));
  const afterRerun = ctx.state.list.filter(function (e) { return e.uid !== 'real-1'; });
  assert('B6a: re-running the loader REPLACES rather than duplicates -- exactly 2 synthetic records remain (batch2 size), not 5',
    afterRerun.length === 2);
  assert('B6b: none of batch1\'s taskIds (h1/h2/d1) survive the replace', !afterRerun.some(function (e) { return ['h1', 'h2', 'd1'].indexOf(e.taskId) >= 0; }));
  assert('B6c: batch2 records are present and synthetic', afterRerun.every(function (e) { return e.synthetic === true; }) && afterRerun.some(function (e) { return e.taskId === 'h9'; }));
  assert('B6d: the real event is STILL untouched after the second load', ctx.state.list.some(function (e) { return e.uid === 'real-1'; }));
  assert('B6e: no error dialog was raised across either load', ctx.alerts.length === 0);

  if (failures) {
    console.error('\n' + failures + ' backfill-synthetic assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL BACKFILL-SYNTHETIC TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
