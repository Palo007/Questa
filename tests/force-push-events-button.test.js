// force-push-events-button.test.js -- F4: "Force Push Events" button/toast copy match
//
// Defect: sync.js's shrink-guard toast (sync.js:1919) tells the user to press
// "Force Push Events" in Settings, but no such button exists -- app.js's
// Settings sync row (app.js:5330-5334) only ever renders "Force push" /
// "Force pull", guarded by confirmForcePush/confirmForcePull. The instruction
// the app gives is not followable.
//
// This test locks in the fix that will land after it:
//   1. a new confirmEventsForcePush() in sync.js, using non-alarming copy
//      (event files are an additive union with no tombstones -- unlike the
//      destructive state force-push, re-pushing them cannot delete anything
//      on another device)
//   2. a matching guarded button term in the Settings sync row in app.js:
//      (typeof confirmEventsForcePush==="function"?'<button class="btn danger"
//      onclick="confirmEventsForcePush()">Force Push Events</button>':'')
//   3. that button reaching syncEventsForcePush() -> syncEventsPush({force:true,
//      forceFullPush:true}) -- syncEventsForcePush already exists (sync.js:2370-2372)
//
//   TEST 1: the button label and the toast copy agree, character for character
//           ("Force Push Events" must appear in BOTH app.js and sync.js)
//   TEST 2: the Settings row renders the button only when sync is connected
//   TEST 3: clicking reaches syncEventsPush with the exact override options
//           (recorded at the boundary, not a call-count)
//
// Run: node tests/force-push-events-button.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractSpan } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrcRaw = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

let failures = 0;
function assert(desc, cond) { if (cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

// =========================================================================
// TEST 1 -- label and toast agree, character for character
// =========================================================================
assert('sync.js toast tells the user to use "Force Push Events" (sync.js:1919)',
  syncSrcRaw.indexOf('Force Push Events') !== -1);

assert('app.js Settings row actually has a button labeled "Force Push Events" (the instruction must be followable)',
  appSrc.indexOf('Force Push Events') !== -1);

// =========================================================================
// TEST 2 -- the button renders in the Settings sync row only when connected
//
// Route used: openSettings() itself is NOT reachable standalone here -- it
// touches document.getElementById('sheet'), avatar/category UI, export/backup
// rows, snapshot flushing, etc., far beyond what this fix touches. Instead we
// extract just the `if(typeof syncCfg==="function"){...} else {...}` span
// (app.js ~5301-5347) that renders the Sync section, via tests/_extract.js's
// extractSpan with a small custom endFinder (the span's own end is a fixed
// fallback line -- "Sync module not loaded." -- not a function declaration,
// so functionEndLineIndex doesn't apply). This gives the real, unmodified
// rendering source for both the connected (else) and disconnected
// (if !scfg.enabled) branches.
// =========================================================================
function endAfterLine(anchorRegex, label) {
  return function (src, lines, fromIdx) {
    for (let i = fromIdx; i < lines.length; i++) {
      if (anchorRegex.test(lines[i])) return i + 1;
    }
    throw new Error('endAfterLine: anchor not found for ' + label);
  };
}

const syncRowBlock = extractSpan(
  appSrc,
  /^\s*if\(typeof syncCfg==="function"\)\{\s*$/,
  endAfterLine(/Sync module not loaded\./, 'sync-not-loaded fallback line'),
  'openSettings Sync section (connect/connected branch incl. force-push row)'
);

const renderSyncRow = new vm.Script(
  '(function(syncCfg, S, settingRow, esc, syncRelativeTime, confirmForcePush, confirmForcePull, confirmEventsForcePush){ "use strict";\n' +
  'let h="";\n' + syncRowBlock + '\nreturn h;\n})'
).runInNewContext({});

const S2 = { devices: [], prefs: { autoBackupEnabled: { fourHour: false, daily: false, weekly: false, monthly: false } } };
const settingRowStub = function () { return '<div class="setList">[autoBackupRow]</div>'; };
const escStub = function (x) { return x; };
const syncRelativeTimeStub = function () { return 'a moment ago'; };
const confirmForcePushStub = function () {};
const confirmForcePullStub = function () {};
const confirmEventsForcePushStub = function () {};

const htmlConnected = renderSyncRow(
  function () { return { enabled: true, lastSyncAt: 0, lastError: '', deviceId: 'abc123456' }; },
  S2, settingRowStub, escStub, syncRelativeTimeStub, confirmForcePushStub, confirmForcePullStub, confirmEventsForcePushStub
);

assert('Settings row HTML contains the "Force Push Events" button label when connected',
  htmlConnected.indexOf('>Force Push Events<') !== -1);

assert('Settings row HTML wires the button to onclick="confirmEventsForcePush()" when connected',
  htmlConnected.indexOf('onclick="confirmEventsForcePush()"') !== -1);

const htmlDisconnected = renderSyncRow(
  function () { return { enabled: false }; },
  S2, settingRowStub, escStub, syncRelativeTimeStub, confirmForcePushStub, confirmForcePullStub, confirmEventsForcePushStub
);

assert('Settings row HTML has NO "Force Push Events" button when disconnected',
  htmlDisconnected.indexOf('Force Push Events') === -1);

// =========================================================================
// TEST 3 -- clicking reaches the event force-push with the right options
//
// Boundary: syncEventsPush(opts) (sync.js:1825). We stub it to RECORD the
// options object it receives -- never a call-count -- and assert it deep
// equals {force:true, forceFullPush:true}, the same contract syncEventsForcePush
// already promises (sync.js:2370-2372: return syncEventsPush({force:true,
// forceFullPush:true})). We do NOT stub syncEventsForcePush itself: it is the
// middle layer, not the boundary, and must be left real so the test proves
// confirmEventsForcePush actually reaches syncEventsPush with the right shape,
// end to end.
// =========================================================================
const syncSrcForVm = syncSrcRaw.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

function makeCtx(confirmDialogResolvesTo) {
  const noop = function () {};
  const dialogs = [];
  const toasts = [];
  let capturedPushOpts = 'UNSET'; // sentinel: distinguishable from any real opts object, including undefined

  const sandbox = {
    window: {},
    navigator: { onLine: true },
    document: {
      addEventListener: noop,
      getElementById: function () { return null; },
      createElement: function () { return { style: {}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop }
    },
    localStorage: {
      getItem: function () { return null; }, setItem: noop, removeItem: noop, key: function () { return null; }, length: 0
    },
    history: { replaceState: noop },
    location: { search: '', origin: 'https://test.example', pathname: '/', href: '' },
    crypto: {
      getRandomValues: function (arr) { for (let i = 0; i < arr.length; i++) arr[i] = i % 256; return arr; },
      subtle: { digest: async function () { return new ArrayBuffer(32); } }
    },
    setTimeout: function () { return 0; }, clearTimeout: noop, setInterval: function () { return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    isNaN: isNaN,
    URLSearchParams: URLSearchParams, TextEncoder: TextEncoder, Buffer: Buffer,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer,
    fetch: null,
    logEvent: noop, toast: function (m) { toasts.push(m); }, render: noop, esc: function (x) { return x; },
    save: noop, uid: function () { return 'test-device-1'; },
    idbOpen: function () { return Promise.resolve(null); },
    confirmDialog: function (title, text) {
      dialogs.push({ title: title, text: text });
      return Promise.resolve(confirmDialogResolvesTo);
    }
  };
  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  vm.createContext(sandbox);
  try { vm.runInContext(syncSrcForVm, sandbox); }
  catch (e) { console.error('FAIL: sync.js eval threw:', e); process.exit(1); }

  // Boundary: record what syncEventsPush receives -- never merely "was called".
  sandbox.syncEventsPush = function (opts) { capturedPushOpts = opts; return Promise.resolve(); };

  return {
    sandbox: sandbox, dialogs: dialogs, toasts: toasts,
    getCapturedPushOpts: function () { return capturedPushOpts; }
  };
}

async function flushMicrotasks() {
  // confirmEventsForcePush (like confirmForcePush) fires confirmDialog(...).then(...)
  // without awaiting the chain, so its own returned promise settles before that
  // .then() callback runs. A few empty microtask ticks let it run before we assert.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(function (k) { return Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]); });
}

async function main() {
  // Case A: confirmDialog resolves true -> reaches syncEventsPush with the override options
  {
    const c = makeCtx(true);
    assert('confirmEventsForcePush exists as a function in sync.js', typeof c.sandbox.confirmEventsForcePush === 'function');
    if (typeof c.sandbox.confirmEventsForcePush === 'function') {
      await c.sandbox.confirmEventsForcePush();
      await flushMicrotasks();
      const opts = c.getCapturedPushOpts();
      assert('confirm=true: syncEventsPush recorded {force:true, forceFullPush:true}',
        deepEqual(opts, { force: true, forceFullPush: true }));
    }
  }

  // Case B: confirmDialog resolves false -> nothing recorded at the boundary
  {
    const c = makeCtx(false);
    if (typeof c.sandbox.confirmEventsForcePush === 'function') {
      await c.sandbox.confirmEventsForcePush();
      await flushMicrotasks();
      const opts = c.getCapturedPushOpts();
      assert('confirm=false: syncEventsPush boundary recorded NOTHING', opts === 'UNSET');
    } else {
      assert('confirm=false: confirmEventsForcePush exists (case B setup)', false);
    }
  }

  if (failures) { console.error('\n' + failures + ' force-push-events-button assertion(s) FAILED'); process.exit(1); }
  console.log('\nforce-push-events-button.test.js: all assertions passed');
}

main().catch(function (e) { console.error('Unhandled:', e); process.exit(1); });
