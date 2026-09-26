// clock-upload-coupling-guard.test.js -- guards the HIDDEN coupling behind the PWA-23
// clock-ahead warning (see tests/clock-ahead-warning.test.js).
//
// app.js replaces the global `dbxUpload` with a pass-through wrapper once sync.js has
// loaded, and reads `server_modified` from what the real function returns. sync.js is
// deliberately NOT changed for this. That only works while ALL of these stay true, and
// a refactor of sync.js could break any of them without failing another test -- the
// warning would just go silent. So each one is asserted here, loudly:
//
//   G1  index.html loads app.js and then sync.js as classic scripts (no type=module),
//       so sync.js's top-level function is a writable global binding
//   G2  sync.js declares `async function dbxUpload(` exactly once, at top level
//   G3  every code reference to dbxUpload in sync.js is a direct call by its global
//       name -- no alias (`const up = dbxUpload`), no method form (`x.dbxUpload(`)
//       that would capture the original before the wrapper is installed
//   G4  both state-upload call sites (_pushWithConflictRetry, _syncForcePushAttempt)
//       still call `dbxUpload(STATE_PATH, ...)` by name
//   G5  the REAL sync.js dbxUpload, run against a fake fetch, returns the files/upload
//       metadata object itself, server_modified included
//   G6  app.js registers _installClockProbe on DOMContentLoaded; firing it after the
//       real sync.js dbxUpload is defined installs the wrapper, and a 5-min-ahead
//       upload through the REAL function reaches the warning
//
// Named "upload", not "probe": tests/run.js skips any file whose name matches /probe/i.
// Run: node tests/clock-upload-coupling-guard.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const root = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(root, 'sync.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function tryGet(fn) { try { return fn(); } catch (e) { console.error('  (' + e.message + ')'); return null; } }

// Strip // line comments and /* */ block comments so prose mentioning dbxUpload is ignored.
function codeOnly(src) {
  return src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
}

async function main() {
  // ---------------- G1: load order ----------------
  {
    const appTag = htmlSrc.search(/<script\b[^>]*\bsrc="app\.js"[^>]*>/);
    const syncTag = htmlSrc.search(/<script\b[^>]*\bsrc="sync\.js"[^>]*>/);
    assert('G1a: index.html has both script tags', appTag >= 0 && syncTag >= 0);
    assert('G1b: app.js loads BEFORE sync.js', appTag >= 0 && syncTag > appTag);
    const syncTagText = (htmlSrc.match(/<script\b[^>]*\bsrc="sync\.js"[^>]*>/) || [''])[0];
    assert('G1c: sync.js is a classic script (no type=module, no defer/async)',
      !!syncTagText && !/type=|\bdefer\b|\basync\b/.test(syncTagText));
  }

  const syncCode = codeOnly(syncSrc);

  // ---------------- G2: one top-level declaration ----------------
  {
    const decls = syncCode.match(/^async function dbxUpload\(/gm) || [];
    assert('G2a: sync.js declares `async function dbxUpload(` exactly once at column 0', decls.length === 1);
    const other = syncCode.match(/\b(let|const|var|class)\s+dbxUpload\b|\bdbxUpload\s*=[^=]/g) || [];
    assert('G2b: no let/const/var/assignment rebinding of dbxUpload in sync.js', other.length === 0);
  }

  // ---------------- G3: every reference is a direct global call ----------------
  {
    const refs = [];
    const re = /(.?)\bdbxUpload\b(\s*\(?)/g;
    let m;
    while ((m = re.exec(syncCode))) refs.push(m);
    const bad = refs.filter(function (r) {
      const prevOk = r[1] === '' || !/[.\w$]/.test(r[1]);
      const callOk = /\(/.test(r[2]);
      return !(prevOk && callOk);
    });
    assert('G3a: sync.js references dbxUpload at least 3 times (decl + 2 call sites)', refs.length >= 3);
    if (bad.length) console.error('  offending refs: ' + bad.map(function (r) { return JSON.stringify(r[0]); }).join(', '));
    assert('G3b: every dbxUpload reference in sync.js is a direct call by global name (no alias/method form)',
      bad.length === 0);
  }

  // ---------------- G4: both state-upload call sites ----------------
  {
    const push = tryGet(function () { return extractFunction(syncSrc, /^async function _pushWithConflictRetry\(/, '_pushWithConflictRetry'); });
    const force = tryGet(function () { return extractFunction(syncSrc, /^async function _syncForcePushAttempt\(/, '_syncForcePushAttempt'); });
    const callRe = /(^|[^.\w$])dbxUpload\(STATE_PATH\b/;
    assert('G4a: _pushWithConflictRetry calls dbxUpload(STATE_PATH, ...) by global name',
      !!push && callRe.test(codeOnly(push)));
    assert('G4b: _syncForcePushAttempt calls dbxUpload(STATE_PATH, ...) by global name',
      !!force && callRe.test(codeOnly(force)));
  }

  // ---------------- G5 + G6: real dbxUpload behind the real wrapper ----------------
  const dbxUploadFn = tryGet(function () { return extractFunction(syncSrc, /^async function dbxUpload\(/, 'dbxUpload'); });
  const probeParts = tryGet(function () {
    return [
      extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS = /, 'HLC_RATCHET_TOLERANCE_MS'),
      extractLine(appSrc, /^const CLOCK_AHEAD_WARN_KEY = /, 'CLOCK_AHEAD_WARN_KEY'),
      extractLine(appSrc, /^const CLOCK_AHEAD_WARN_EVERY_MS = /, 'CLOCK_AHEAD_WARN_EVERY_MS'),
      extractLine(appSrc, /^var _clockAheadWarnedMem = /, '_clockAheadWarnedMem'),
      extractFunction(appSrc, /^function _clockAheadMs\(t0Local, serverModifiedIso\)\{/, '_clockAheadMs'),
      extractFunction(appSrc, /^function _noteClockSample\(t0Local, serverModifiedIso\)\{/, '_noteClockSample'),
      extractFunction(appSrc, /^function _installClockProbe\(\)\{/, '_installClockProbe'),
    ].join('\n');
  });
  const registerLine = tryGet(function () {
    return extractLine(appSrc, /^[^\/]*\.addEventListener\("DOMContentLoaded", _installClockProbe\)/, 'DOMContentLoaded register');
  });
  assert('G6a: app.js has a top-level DOMContentLoaded -> _installClockProbe registration', !!registerLine);

  const SERVER_ISO = '2026-09-26T10:00:00Z';
  const SERVER_MS = Date.parse(SERVER_ISO);
  const meta = { name: 'state.json', rev: 'r42', server_modified: SERVER_ISO, client_modified: SERVER_ISO, size: 10 };
  const fetches = [];
  const alerts = [];
  const listeners = {};
  const sandbox = {
    console: console,
    Date: (function () {
      function D() { return new (Function.prototype.bind.apply(Date, [null].concat([].slice.call(arguments))))(); }
      D.now = function () { return SERVER_MS + 5 * 60000; };
      D.parse = Date.parse; D.UTC = Date.UTC; D.prototype = Date.prototype;
      return D;
    })(),
    fetch: function (url, init) {
      fetches.push(url);
      return Promise.resolve({ status: 200, ok: true, json: function () { return Promise.resolve(meta); }, text: function () { return Promise.resolve(''); } });
    },
    syncToken: function () { return Promise.resolve('tok'); },
    dbxArgHeader: function (o) { return JSON.stringify(o); },
    _retryAfterMs: function () { return 0; },
    alertDialog: function (t, x) { alerts.push({ title: t, text: x }); return Promise.resolve(); },
    _qDiagPush: function () {},
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    document: { addEventListener: function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  let loaded = false;
  if (dbxUploadFn && probeParts && registerLine) {
    try {
      vm.runInContext('class ConflictError extends Error{}\nclass HttpError extends Error{}', sandbox);
      // app.js first (probe + registration), then sync.js (the real dbxUpload) -- the index.html order.
      vm.runInContext(probeParts + '\n' + registerLine, sandbox);
      vm.runInContext(dbxUploadFn, sandbox);
      loaded = true;
    } catch (e) { console.error('  eval failed: ' + e.message); }
  }
  assert('G5/G6 setup: real dbxUpload and the probe evaluate in load order', loaded);

  if (loaded) {
    const real = sandbox.dbxUpload;
    const up = await real('/state.json', { a: 1 }, 'r41');
    assert('G5a: the real dbxUpload posts to files/upload', fetches.length === 1 && /\/2\/files\/upload$/.test(fetches[0]));
    assert('G5b: the real dbxUpload returns the files/upload metadata object itself', up === meta);
    assert('G5c: ...which carries server_modified as a parseable ISO string',
      !!up && typeof up.server_modified === 'string' && !isNaN(Date.parse(up.server_modified)));

    assert('G6b: DOMContentLoaded listener registered exactly once',
      (listeners.DOMContentLoaded || []).length === 1);
    (listeners.DOMContentLoaded || []).forEach(function (fn) { fn(); });
    assert('G6c: after DOMContentLoaded the global dbxUpload is the wrapper',
      sandbox.dbxUpload !== real && sandbox.dbxUpload && sandbox.dbxUpload.__clockProbe === true);
    const up2 = await vm.runInContext('dbxUpload("/state.json", {a:2}, "r42")', sandbox);
    assert('G6d: a call by the global name (as sync.js makes it) goes through the wrapper and returns the metadata',
      up2 === meta && fetches.length === 2);
    assert('G6e: a 5-min-ahead upload through the real function raises the warning',
      alerts.length === 1 && /5 minutes ahead/.test(alerts[0].text));
  }

  if (failures) {
    console.error('\n' + failures + ' clock-upload-coupling-guard assertion(s) FAILED -- the PWA-23 clock-ahead warning' +
      ' depends on sync.js calling dbxUpload by its global name and returning the files/upload metadata.');
    process.exit(1);
  }
  console.log('\nALL CLOCK-PROBE-COUPLING-GUARD TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
