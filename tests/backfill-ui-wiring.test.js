// backfill-ui-wiring.test.js -- W5.9: wires importEventsBackfill() into
// showSyncDebugOverlay() as a one-off recovery control for reconstructed
// events (tools/reconstruct_events_jul28.py output), NOT into Settings ->
// Import (importData()/confirmRestore()), because importData() hard-gates on
// data.char + Array.isArray(data.tasks) and would either reject an
// events-only file outright or, if padded with dummy char/tasks to pass that
// gate, destroy the real character and all real tasks via S = migrate(data).
//
// Covered here:
//   U1  loading a file through the overlay's wired control adds events and
//       leaves S.tasks.length and S.char byte-for-byte unchanged (the
//       explicit plan acceptance criterion)
//   U2  the overlay's extracted source contains no reference to importData
//       (static check)
//   U3  simulating the control's onchange calls importEventsBackfill and
//       NEVER importData (behavioural, spied)
//   U4  the {"events": [...]} envelope (the real reconstruct_events_jul28.py
//       shape) is accepted, not just a bare array
//   U5  a malformed (non-JSON) file surfaces an error and does not partially
//       mutate the store
//   U6  showSyncDebugOverlay() still renders (does not throw) with the
//       backfill control present, and the control is actually discoverable
//       in the DOM tree it built
//
// Run: node tests/backfill-ui-wiring.test.js (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js. Do NOT reintroduce hardcoded line-number slicing.
const showSyncDebugOverlayFn = extractFunction(appSrc, /^function showSyncDebugOverlay\(\)\{/, 'showSyncDebugOverlay');
const qDiagErrorsHtmlFn = extractFunction(appSrc, /^function _qDiagErrorsHtml\(\)\{/, '_qDiagErrorsHtml');
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
const importEventsBackfillFn = extractFunction(appSrc, /^function importEventsBackfill\(ev\)\{/, 'importEventsBackfill');
const reparentEventsForImportFn = extractFunction(appSrc, /^function reparentEventsForImport\(list\)\{/, 'reparentEventsForImport');
const eventUidOfFn = extractFunction(appSrc, /^function eventUidOf\(rec, idx\)\{/, 'eventUidOf');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// ---------------------------------------------------------------------------
// U2: static check -- the overlay's extracted source must not reference
// importData at all (comment or code). This is the assertion that would
// catch a future edit wiring the "Load reconstructed events" control (or
// anything else added near it) to the dangerous Settings->Import path.
// ---------------------------------------------------------------------------
assert('U2: showSyncDebugOverlay() source contains no reference to importData',
  showSyncDebugOverlayFn.indexOf('importData') === -1);

// ---------------------------------------------------------------------------
// Fake DOM: just enough for showSyncDebugOverlay() to run headlessly. Every
// createElement() call returns a plain object with a settable style, a
// children array via appendChild, and no-op focus/select/remove -- sufficient
// for this function's usage (it never reads back layout/computed values).
// ---------------------------------------------------------------------------
function makeFakeDocument() {
  const body = { children: [], appendChild: function (c) { this.children.push(c); } };
  function makeEl(tag) {
    return {
      tagName: tag,
      style: {},
      children: [],
      appendChild: function (c) { this.children.push(c); },
      focus: function () {},
      select: function () {},
      remove: function () {},
      addEventListener: function () {},
    };
  }
  return {
    body: body,
    createElement: function (tag) { return makeEl(tag); },
    execCommand: function () { return true; },
  };
}

// Fake IndexedDB: mimics questa's "syncmeta"/"base" read, resolving
// asynchronously (setTimeout) like the real IndexedDB API -- a flush() is
// required after calling showSyncDebugOverlay(), matching the async pattern
// used by the other overlay/backfill tests in this suite.
function makeFakeIndexedDB() {
  return {
    open: function () {
      const req = { onsuccess: null, onerror: null, result: null };
      req.result = {
        transaction: function () {
          return {
            objectStore: function () {
              return {
                get: function () {
                  const g = { onsuccess: null, onerror: null, result: undefined };
                  setTimeout(function () { if (g.onsuccess) g.onsuccess(); }, 0);
                  return g;
                },
              };
            },
          };
        },
      };
      setTimeout(function () { if (req.onsuccess) req.onsuccess(); }, 0);
      return req;
    },
  };
}

// Minimal fake FileReader: readAsText resolves asynchronously (one
// microtask, like the real thing) and calls onload with `this.result` set
// from the fake file's `__content` string.
function FakeFileReader() {}
FakeFileReader.prototype.readAsText = function (f) {
  const self = this;
  Promise.resolve().then(function () {
    self.result = f && f.__content;
    if (typeof self.onload === 'function') self.onload();
  });
};

function makeEv(content) {
  return { target: { files: [{ __content: content }], value: '' } };
}

function flush() {
  // Flush the whole pending microtask/macrotask chain. Both async chains this
  // suite drives are more than one macrotask hop deep: the fake indexedDB is
  // open() -> (setTimeout) r.onsuccess -> transaction().objectStore().get()
  // -> (setTimeout) g.onsuccess -> renderOverlay(); and separately the
  // FileReader->confirmDialog->clearSyntheticEvents->bulkAddEvents chain is
  // several .then()/await hops deep. A single setTimeout(0) only drains
  // microtasks queued BEFORE it fires, not ones a later macrotask schedules --
  // so run several rounds to be sure every nested setTimeout has fired.
  return new Promise(function (resolve) {
    let rounds = 0;
    (function tick() {
      rounds++;
      if (rounds >= 6) { resolve(); return; }
      setTimeout(tick, 0);
    })();
  });
}

// Builds a fresh sandbox with the real overlay + backfill source wired up
// exactly as app.js wires them, plus fakes for every DOM/storage/dialog
// dependency they touch. `importData` is a spy (not a no-op): its call count
// is asserted to be exactly 0 in every scenario below.
function makeCtx(initialStore) {
  const state = { list: (initialStore || []).map(function (e) { return Object.assign({}, e); }) };
  const toasts = [];
  const alerts = [];
  const importDataCalls = [];

  const sandbox = {
    console: console,
    JSON: JSON,
    Date: Date,
    FileReader: FakeFileReader,
    indexedDB: makeFakeIndexedDB(),
    document: makeFakeDocument(),
    localStorage: { getItem: function () { return null; } },
    navigator: {},
    window: {},
    APP_VERSION: 'vTEST',
    TAB: 'habits',
    S: { char: { name: 'Hero', lvl: 3, xp: 10, hp: 50, gold: 5 }, tasks: [{ id: 1 }, { id: 2 }] },
    syncDeviceId: function () { return 'dev-me'; },
    confirmDialog: function () { return Promise.resolve(true); },
    alertDialog: function (title, text) { alerts.push({ title: title, text: text }); },
    toast: function (msg) { toasts.push(msg); },
    render: function () {},
    downloadFullDiagnostic: function () {},
    importData: function () { importDataCalls.push(true); },
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

  const src = [escFn, qDiagErrorsHtmlFn, eventUidOfFn, reparentEventsForImportFn, importEventsBackfillFn, showSyncDebugOverlayFn].join('\n');
  try { vm.runInContext(src, sandbox); }
  catch (e) { console.error('FAIL: extracted source threw during eval:', e); process.exit(1); }

  return { sandbox: sandbox, state: state, toasts: toasts, alerts: alerts, importDataCalls: importDataCalls };
}

// Drives the overlay open, waits for its async base-lookup to resolve, and
// returns the <input type=file> element it created (by walking the fake DOM
// tree it built), so a test can drive its onchange handler directly -- the
// same object app.js wires up inside showSyncDebugOverlay().
async function openOverlayAndGetInput(ctx) {
  ctx.sandbox.showSyncDebugOverlay();
  await flush(); // let the fake indexedDB.open()/transaction/get chain resolve
  const bodyChildren = ctx.sandbox.document.body.children;
  const ov = bodyChildren[bodyChildren.length - 1];
  let found = null;
  (ov.children || []).forEach(function (child) {
    if (child.tagName === 'div') {
      (child.children || []).forEach(function (grandchild) {
        if (grandchild.tagName === 'input') found = grandchild;
      });
    }
  });
  if (!found) throw new Error('backfill <input type=file> not found in overlay DOM tree');
  return found;
}

async function main() {
  const initialSSnapshot = JSON.stringify({ char: { name: 'Hero', lvl: 3, xp: 10, hp: 50, gold: 5 }, tasks: [{ id: 1 }, { id: 2 }] });

  // -------------------------------------------------------------------
  // U6: the overlay renders (does not throw) with the backfill control
  // present, and the control is actually discoverable in the DOM tree it
  // built (proves it's wired into the real overlay, not a dead/orphan node).
  // -------------------------------------------------------------------
  {
    const ctx = makeCtx([]);
    let threw = false, input = null;
    try { input = await openOverlayAndGetInput(ctx); } catch (e) { threw = true; console.error(e); }
    assert('U6a: showSyncDebugOverlay() does not throw with the backfill control present', !threw);
    assert('U6b: the backfill <input type=file> control is present in the overlay DOM', !!input && input.tagName === 'input' && input.type === 'file');
    assert('U6c: onchange is wired to a function', typeof input.onchange === 'function');
  }

  // -------------------------------------------------------------------
  // U1 / U3: driving the overlay's own onchange handler with a bare-array
  // envelope adds events, leaves S untouched, and never calls importData.
  // -------------------------------------------------------------------
  {
    const ctx = makeCtx([]);
    const input = await openOverlayAndGetInput(ctx);
    const batch = [
      { ts: 2000, kind: 'tap', taskId: 'h1', dir: 1, reps: 0, source: 'reconstructed' },
      { ts: 2100, kind: 'tap', taskId: 'h2', dir: 1, reps: 0, source: 'reconstructed' },
    ];
    input.onchange(makeEv(JSON.stringify(batch)));
    await flush();

    assert('U1a: S.tasks.length is unchanged after loading through the overlay control', ctx.sandbox.S.tasks.length === 2);
    assert('U1b: S is byte-for-byte unchanged after loading through the overlay control', JSON.stringify(ctx.sandbox.S) === initialSSnapshot);
    assert('U1c: the events were actually added to the store', ctx.state.list.length === 2 && ctx.state.list.every(function (e) { return e.synthetic === true; }));
    assert('U3a: importData was never called', ctx.importDataCalls.length === 0);
    assert('U3b: the "Loaded N events" toast fired (proves importEventsBackfill, not a silent no-op, actually ran)',
      ctx.toasts.some(function (t) { return /Loaded 2 events/.test(t || ''); }));
  }

  // -------------------------------------------------------------------
  // U4: the real reconstruct_events_jul28.py envelope shape, {"events":[...]}
  // (object-wrapped, not a bare array), must be accepted by the wired control.
  // -------------------------------------------------------------------
  {
    const ctx = makeCtx([]);
    const input = await openOverlayAndGetInput(ctx);
    const envelope = {
      events: [
        { ts: 5000, kind: 'tap', taskId: 'j1', dir: 1, reps: 0, synthetic: true },
        { ts: 5100, kind: 'tap', taskId: 'j2', dir: 1, reps: 0, synthetic: true },
        { ts: 5200, kind: 'daily', taskId: 'j3', synthetic: true },
      ],
    };
    input.onchange(makeEv(JSON.stringify(envelope)));
    await flush();

    assert('U4a: the {"events":[...]} envelope is accepted (3 records loaded)', ctx.state.list.length === 3);
    assert('U4b: loaded records are stamped synthetic=true', ctx.state.list.every(function (e) { return e.synthetic === true; }));
    assert('U4c: S untouched by the envelope-shaped load too', JSON.stringify(ctx.sandbox.S) === initialSSnapshot);
    assert('U4d: importData was never called for the envelope shape either', ctx.importDataCalls.length === 0);
    assert('U4e: the "Loaded 3 events" toast fired', ctx.toasts.some(function (t) { return /Loaded 3 events/.test(t || ''); }));
  }

  // -------------------------------------------------------------------
  // U5: a malformed (non-JSON) file surfaces an error and does not
  // partially mutate the store.
  // -------------------------------------------------------------------
  {
    const preexisting = { uid: 'real-1', dev: 'dev-me', ts: 1000, kind: 'tap', taskId: 't1', dir: 1, reps: 0 };
    const ctx = makeCtx([preexisting]);
    const input = await openOverlayAndGetInput(ctx);
    input.onchange(makeEv('{this is not valid JSON'));
    await flush();

    assert('U5a: an error dialog was raised for malformed JSON', ctx.alerts.length === 1 && /not valid JSON/i.test(ctx.alerts[0].text || ''));
    assert('U5b: the store is untouched (still exactly the pre-existing record)', ctx.state.list.length === 1 && ctx.state.list[0].uid === 'real-1');
    assert('U5c: S is untouched', JSON.stringify(ctx.sandbox.S) === initialSSnapshot);
    assert('U5d: importData was never called for a malformed file', ctx.importDataCalls.length === 0);
    assert('U5e: no "Loaded" toast fired for the failed load', !ctx.toasts.some(function (t) { return /Loaded \d+ events/.test(t || ''); }));
  }

  if (failures) {
    console.error('\n' + failures + ' backfill-ui-wiring assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL BACKFILL-UI-WIRING TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
