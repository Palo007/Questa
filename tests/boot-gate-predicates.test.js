// boot-gate-predicates.test.js -- unit tests for the two pure predicates that
// gate the boot-time day-rollover deferral: _syncConfiguredForBoot() and
// shouldDeferDayRollover(cfgConnected, elapsedMs, timeoutMs).
//
// AGENTS.md S4: a function that alone gates whether a feature runs deserves a
// direct unit test of its return value, not just coverage of its caller.
// These two predicates do not exist in app.js yet -- this file is written
// against the planned shape and is EXPECTED TO FAIL (RED) until they land,
// just before `function startDay(){` in app.js.
//
// _syncConfiguredForBoot() deliberately inlines a localStorage read (sync.js
// has not loaded yet at this point in boot) instead of calling syncCfg(); the
// same inline-read pattern already exists elsewhere in app.js. The key string
// read must match SYNC_KEY in sync.js character for character: "questa.sync.v1".
//
// Strategy: pull each function's source out of app.js by anchor (see
// tests/_extract.js) and eval it in a `vm` sandbox. Extraction itself can
// throw (anchor not found) -- every call site below is wrapped so that a
// missing function becomes a labelled [FAIL] assertion, never an unhandled
// exception / crash.
//
// Run: node tests/boot-gate-predicates.test.js  (standalone only -- do NOT
// wire this into tests/run.js as part of this change)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// ---------------------------------------------------------------------------
// Extraction -- must not crash the process even though neither function
// exists yet. A failed extractFunction() call throws; we catch it and turn it
// into a normal labelled assertion failure instead of letting it propagate.
// ---------------------------------------------------------------------------
let syncConfiguredSrc = null, syncConfiguredErr = null;
try {
  syncConfiguredSrc = extractFunction(
    appSrc,
    /^function _syncConfiguredForBoot\(\)\{/,
    '_syncConfiguredForBoot'
  );
} catch (e) {
  syncConfiguredErr = (e && e.message) || String(e);
}
assert(
  '_syncConfiguredForBoot() found in app.js' + (syncConfiguredErr ? ' (' + syncConfiguredErr + ')' : ''),
  syncConfiguredSrc !== null
);

let deferRolloverSrc = null, deferRolloverErr = null;
try {
  deferRolloverSrc = extractFunction(
    appSrc,
    /^function shouldDeferDayRollover\(cfgConnected, elapsedMs, timeoutMs\)\{/,
    'shouldDeferDayRollover'
  );
} catch (e) {
  deferRolloverErr = (e && e.message) || String(e);
}
assert(
  'shouldDeferDayRollover() found in app.js' + (deferRolloverErr ? ' (' + deferRolloverErr + ')' : ''),
  deferRolloverSrc !== null
);

// ---------------------------------------------------------------------------
// Sandbox runners
// ---------------------------------------------------------------------------

// Runs _syncConfiguredForBoot() in a vm sandbox with a fake localStorage that
// records the key it was asked for. `includeDom` optionally adds empty
// document/window stubs (present-but-untouched); when false, neither is
// defined in the sandbox at all, so any accidental DOM touch throws a
// ReferenceError instead of silently succeeding.
function callSyncConfigured(getItemImpl, includeDom) {
  if (syncConfiguredSrc === null) {
    throw new Error('_syncConfiguredForBoot not extracted: ' + syncConfiguredErr);
  }
  let calledKey = null;
  const localStorage = {
    getItem: function (key) { calledKey = key; return getItemImpl(key); }
  };
  const sandbox = { localStorage: localStorage };
  if (includeDom) {
    sandbox.document = {};
    sandbox.window = {};
  }
  sandbox.globalThis = sandbox;
  const code =
    '(function(){ "use strict";\n' +
    syncConfiguredSrc + '\n' +
    'return _syncConfiguredForBoot();\n' +
    '})()';
  const result = vm.runInNewContext(code, sandbox);
  return { result: result, calledKey: calledKey };
}

// Runs shouldDeferDayRollover(cfgConnected, elapsedMs, timeoutMs) in a vm
// sandbox. `bareSandbox` uses a genuinely empty sandbox object (no
// localStorage, no document, no S -- no globals at all) to prove purity.
function callShouldDefer(cfgConnected, elapsedMs, timeoutMs, bareSandbox) {
  if (deferRolloverSrc === null) {
    throw new Error('shouldDeferDayRollover not extracted: ' + deferRolloverErr);
  }
  const sandbox = bareSandbox ? {} : {};
  const code =
    '(function(cfgConnected, elapsedMs, timeoutMs){ "use strict";\n' +
    deferRolloverSrc + '\n' +
    'return shouldDeferDayRollover(cfgConnected, elapsedMs, timeoutMs);\n' +
    '})(' + JSON.stringify(cfgConnected) + ', ' + JSON.stringify(elapsedMs) + ', ' + JSON.stringify(timeoutMs) + ')';
  return vm.runInNewContext(code, sandbox);
}

// Runs callSyncConfigured and turns any thrown error (extraction failure OR a
// runtime throw inside the sandboxed function) into a single labelled
// assertion, so a missing/broken function never crashes this test file.
function expectSyncConfigured(label, getItemImpl, expected, includeDom) {
  let threw = false, errMsg = null, out = null;
  try {
    out = callSyncConfigured(getItemImpl, includeDom !== false);
  } catch (e) {
    threw = true;
    errMsg = (e && e.message) || String(e);
  }
  if (threw) {
    assert(label + ' -> ' + expected + '  [threw: ' + errMsg + ']', false);
    return null;
  }
  assert(label + ' -> ' + expected, out.result === expected);
  return out;
}

// =========================================================================
// _syncConfiguredForBoot()
// =========================================================================

// 1. absent key -> false
expectSyncConfigured(
  '_syncConfiguredForBoot(): absent localStorage key',
  function (key) { return null; },
  false
);

// 2. enabled:false -> false
expectSyncConfigured(
  '_syncConfiguredForBoot(): {enabled:false,refreshToken:"tok"}',
  function (key) { return JSON.stringify({ enabled: false, refreshToken: 'tok' }); },
  false
);

// 3. refreshToken:null -> false
expectSyncConfigured(
  '_syncConfiguredForBoot(): {enabled:true,refreshToken:null}',
  function (key) { return JSON.stringify({ enabled: true, refreshToken: null }); },
  false
);

// 4. corrupt JSON -> false AND does not throw (explicit no-throw assertion,
//    since this predicate runs on the boot path).
(function () {
  let threw = false, errMsg = null, result = null;
  try {
    result = callSyncConfigured(function (key) { return '{not json'; }, true).result;
  } catch (e) {
    threw = true;
    errMsg = (e && e.message) || String(e);
  }
  assert(
    '_syncConfiguredForBoot(): corrupt JSON does not throw' + (threw ? '  [threw: ' + errMsg + ']' : ''),
    threw === false
  );
  assert(
    '_syncConfiguredForBoot(): corrupt JSON -> false',
    threw === false && result === false
  );
})();

// 5. enabled:true & refreshToken set -> true
expectSyncConfigured(
  '_syncConfiguredForBoot(): {enabled:true,refreshToken:"tok"}',
  function (key) { return JSON.stringify({ enabled: true, refreshToken: 'tok' }); },
  true
);

// 6. reads the key "questa.sync.v1" specifically -- record what key our fake
//    localStorage.getItem was asked for.
(function () {
  let threw = false, errMsg = null, calledKey = null;
  try {
    const out = callSyncConfigured(function (key) { return null; }, true);
    calledKey = out.calledKey;
  } catch (e) {
    threw = true;
    errMsg = (e && e.message) || String(e);
  }
  if (threw) {
    assert('_syncConfiguredForBoot(): reads localStorage key "questa.sync.v1"  [threw: ' + errMsg + ']', false);
  } else {
    assert(
      '_syncConfiguredForBoot(): reads localStorage key "questa.sync.v1" (got ' + JSON.stringify(calledKey) + ')',
      calledKey === 'questa.sync.v1'
    );
  }
})();

// 7. touches no DOM: sandbox with NO document and NO window defined.
expectSyncConfigured(
  '_syncConfiguredForBoot(): correct result with no document/window in scope',
  function (key) { return JSON.stringify({ enabled: true, refreshToken: 'tok' }); },
  true,
  false // includeDom = false
);

// =========================================================================
// shouldDeferDayRollover(cfgConnected, elapsedMs, timeoutMs)
// =========================================================================

function expectShouldDefer(label, cfgConnected, elapsedMs, timeoutMs, expected, bareSandbox) {
  let threw = false, errMsg = null, result = null;
  try {
    result = callShouldDefer(cfgConnected, elapsedMs, timeoutMs, bareSandbox);
  } catch (e) {
    threw = true;
    errMsg = (e && e.message) || String(e);
  }
  if (threw) {
    assert(label + ' -> ' + expected + '  [threw: ' + errMsg + ']', false);
    return;
  }
  assert(label + ' -> ' + expected, result === expected);
}

// 8. (false, 0, 8000) -> false
expectShouldDefer('shouldDeferDayRollover(false, 0, 8000)', false, 0, 8000, false);

// 9. (true, 0, 8000) -> true
expectShouldDefer('shouldDeferDayRollover(true, 0, 8000)', true, 0, 8000, true);

// 10. (true, 9000, 8000) -> false
expectShouldDefer('shouldDeferDayRollover(true, 9000, 8000)', true, 9000, 8000, false);

// 11. purity: re-run the three cases above in a sandbox with NO globals at
//     all (no localStorage, no document, no S) and confirm they still hold.
expectShouldDefer('shouldDeferDayRollover(false, 0, 8000) [bare sandbox]', false, 0, 8000, false, true);
expectShouldDefer('shouldDeferDayRollover(true, 0, 8000) [bare sandbox]', true, 0, 8000, true, true);
expectShouldDefer('shouldDeferDayRollover(true, 9000, 8000) [bare sandbox]', true, 9000, 8000, false, true);

// ---------------------------------------------------------------------------
if (failures) {
  console.error('\nFAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\nALL BOOT-GATE-PREDICATES TESTS PASSED');
process.exit(0);
