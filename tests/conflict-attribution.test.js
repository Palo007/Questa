// conflict-attribution.test.js -- absolute device-id attribution for
// conflictResolved events (winnerDev/loserDev/reason), replacing the
// relative winner:'local'|'remote' words that read as a DIFFERENT device
// depending which of the two synced devices you're looking at the log on.
//
// Covers:
//   1) renderer resolves winnerDev to a friendly device name, no raw id leak
//   2) renderer falls back to devId.slice(0,6) (NOT .slice(-6)) when unnamed
//   3) the actual fix: the SAME real conflict, recorded from device A's own
//      merge() call and from device B's own (mirrored) merge() call, renders
//      IDENTICAL attribution text once winnerDev/loserDev are absolute ids
//   4) backward compat: an old-shape event (no new fields) renders exactly
//      as it does today, forever
//   5) the four emitters (driven through the real mergeCollection()/merge())
//      actually populate winnerDev/loserDev with real device ids, alongside
//      the legacy winner/loser words
//   6) _EXPORT_FIELD_MAP is never extended with these fields (cross-version
//      import guard)
//   7) the tokenizer round-trips the three fields long-form (unmapped)
//   8) an older build's field map (missing any hypothetical short codes for
//      these fields) can still detokenize a newer build's backup and
//      recompute the SAME hash -- the guard for review finding 3.
//
// Run: node tests/conflict-attribution.test.js
// (Deliberately NOT wired into tests/run.js by this change.)

const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { extractLine, extractFunction, extractSpan, functionEndLineIndex } = require('./_extract');

let failures = 0;
function assert(desc, cond) { if (cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// =========================================================================
// PART A -- renderer harness. Same anchor route as tests/feed-hide-sync.test.js
// (its own header names this exact pattern as the template to reuse):
//   - DIAGNOSTIC_KINDS declaration line (isFeedNoise references it)
//   - the render helper block, from `let _evWin=null;` through the
//     brace-balanced end of `function renderEventDetail(from,to){` -- this
//     single contiguous span already contains CONFLICT_CATEGORY,
//     getEventCategory, isFeedNoise, the BEGIN/END_DEVICENAME_HELPERS block
//     (deviceDisplayName), and getCachedDeviceName (nested inside
//     renderEventDetail's own closure), so no separate marker-based pull is
//     needed for the device-name resolver here.
//   - esc(), extracted whole via brace balance.
// =========================================================================
const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const diagnosticKindsLine = extractLine(appSrc, /^var DIAGNOSTIC_KINDS\s*=\s*\[/, 'DIAGNOSTIC_KINDS declaration');
const renderBlock = extractSpan(
  appSrc,
  /^let _evWin=null;/,
  functionEndLineIndex(/^function renderEventDetail\(from,to\)\{/, 'renderEventDetail'),
  'feed render helper block (_evWin..renderEventDetail end)'
);
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
// 2026-09-18: renderEventDetail now escapes the task title for the single-quoted
// JS string inside its onclick with jsq(), not a local .replace(). Extract it the
// same way esc() is extracted so the sandbox keeps mirroring live app.js.
const jsqFn = extractFunction(appSrc, /^function jsq\(s\)\{/, 'jsq');

const evStubs = 'var _evFilterType="all", _evPage=0, _evSearchQuery="";\n';
const renderCode =
  diagnosticKindsLine + '\n' +
  evStubs +
  renderBlock + '\n' +
  escFn + '\n' +
  jsqFn + '\n' +
  'return { renderEventDetail };';

function makeEl(id) {
  return { _id: id, innerHTML: '', querySelector: function () { return null; }, querySelectorAll: function () { return []; } };
}
function makeDoc() {
  const store = {};
  return { getElementById(id) { if (!store[id]) store[id] = makeEl(id); return store[id]; } };
}

// Renders `events` (already sorted/ts-stamped by the caller) against an
// S.devices roster and resolves with the #evFeedContent innerHTML once the
// fire-and-forget getEvents().then(...) render settles.
function renderWith(events, devices) {
  return new Promise(function (resolve) {
    const S = { prefs: { hideSyncDiag: false, hideConflictDecisions: false }, devices: devices || [] };
    const doc = makeDoc();
    const sandbox = { S, document: doc, window: {}, navigator: {}, console, setTimeout: function () {}, clearTimeout: function () {} };
    sandbox.globalThis = sandbox;
    const getEventsStub = 'function getEvents(opts){ return Promise.resolve(' + JSON.stringify(events) + '); }';
    const fn = new vm.Script(
      '(function(S, document, window, navigator, console, setTimeout, clearTimeout){ "use strict";' +
      getEventsStub + '\n' + renderCode + '\n})'
    ).runInNewContext(sandbox);
    const api = fn(S, doc, sandbox.window, sandbox.navigator, console, function () {}, function () {});
    doc.getElementById('anEventDetail').innerHTML = '';
    doc.getElementById('evFeedContent').innerHTML = '';
    api.renderEventDetail(0, 1e15);
    setTimeout(function () { resolve(doc.getElementById('evFeedContent').innerHTML); }, 40);
  });
}

// Pulls out just the "Sync conflict resolved ... kept X's copy" span,
// dropping any trailing " · reason" suffix -- test 3 must not depend on
// the exact wording the emitter fix picks for `reason`.
function conflictPhrase(html) {
  const m = html.match(/Sync conflict resolved[\s\S]*?'s copy/);
  return m ? m[0] : null;
}

// =========================================================================
// PART B -- sync.js merge harness. Same boot-strip route as
// tests/conflict-visibility.test.js (its template for driving the four
// conflictResolved emitters). loadSyncSandbox() is a factory (not a single
// shared sandbox) so every scenario gets its own fresh _conflictLogThrottle
// (a per-module Set) instead of colliding on repeated ids across scenarios.
// =========================================================================
function loadSyncSandbox(uidValue) {
  let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
  src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');
  src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

  const noop = function () {};
  const sandbox = {
    window: {}, navigator: { onLine: true },
    document: {
      addEventListener: noop, getElementById: function () { return null; },
      createElement: function () { return { style: {}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop }
    },
    localStorage: { getItem: function () { return null; }, setItem: noop, removeItem: noop, key: function () { return null; }, length: 0 },
    indexedDB: { open: function () { return {}; } },
    setTimeout: function () { return 0; }, clearTimeout: noop, setInterval: function () { return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    logEvent: noop, toast: noop, render: noop, esc: function (x) { return x; }, save: noop,
    uid: function () { return uidValue || 'x'; }, idbOpen: function () { return Promise.resolve(null); }
  };
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch (e) { /* QuestaSync assigned before boot code */ }
  const Q = sandbox.window.QuestaSync;
  if (!Q || typeof Q.merge !== 'function' || typeof Q.mergeCollection !== 'function') {
    throw new Error('QuestaSync.merge/mergeCollection not found');
  }
  return { Q: Q, sandbox: sandbox };
}
function subset(tasks, charObj, overrides) {
  return Object.assign({
    tasks: tasks || [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, char: charObj || {}, deletions: []
  }, overrides || {});
}

// =========================================================================
// PART C -- tokenizer harness. Same anchor route as tests/tokenized-export.test.js:
// slice app.js from `const _EXPORT_FIELD_MAP` through `async function
// buildBackupFile(` and eval it. That slice's top-level `const
// _EXPORT_FIELD_MAP` is NOT exposed as a sandbox property by vm.runInContext
// (unlike the `function` declarations, which are), so a trailing `var`
// bridge line re-exposes it for tests 6/8.
// =========================================================================
function loadTokenizerSandbox() {
  let src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  src = src.replace(/\/\/ Questa app logic[\s\S]*?if\(typeof window!=="undefined"\)\{[\s\S]*?\}\r?\n\r?\n/, '');

  const noop = function () {};
  const sandbox = {
    window: {}, navigator: { onLine: true },
    document: {
      addEventListener: noop, getElementById: function () { return null; },
      createElement: function () { return { style: {}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop }
    },
    localStorage: { getItem: noop, setItem: noop, removeItem: noop, key: noop, length: 0 },
    indexedDB: undefined,
    setTimeout: function (fn) { return fn; }, clearTimeout: noop,
    setInterval: function () { return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    logEvent: noop, toast: noop, render: noop, save: noop, esc: function (x) { return x; },
    uid: function () { return 'test-uid'; }, syncDeviceId: function () { return 'dev-test'; }
  };
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const anchor = 'const _EXPORT_FIELD_MAP';
  const a = src.indexOf(anchor);
  const b = src.indexOf('async function buildBackupFile(');
  if (a < 0 || b < 0) throw new Error('could not locate tokenize helpers in app.js');
  const helpers = src.slice(a, b) + '\nvar _EXPORT_FIELD_MAP_REF=_EXPORT_FIELD_MAP;\n';
  vm.runInContext(helpers, sandbox);
  return sandbox;
}
function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function finish() {
  if (failures) {
    console.error('\n' + failures + ' conflict-attribution assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL CONFLICT-ATTRIBUTION TESTS PASSED');
  process.exit(0);
}

// =========================================================================
// T1/T2 (RENDERER, NEW SHAPE) + T3 (SAME TEXT ON BOTH DEVICES, via real
// merge()) + T4 (BACKWARD COMPATIBILITY)
// =========================================================================
renderWith(
  [{ ts: 1000, kind: 'conflictResolved', taskTitle: 'Widget', winnerDev: 'mralice000001', loserDev: 'mrbob0000002', winner: 'remote', loser: 'local' }],
  [{ id: 'mralice000001', name: 'Alice Phone' }]
).then(function (html1) {
  // T1: named device -> friendly name shown, raw id never leaks.
  assert('T1: winnerDev with a named device record renders the display name', html1.indexOf('Alice Phone') >= 0);
  assert('T1: raw winnerDev device id is NOT present in the output', html1.indexOf('mralice000001') < 0);

  return renderWith(
    [{ ts: 1000, kind: 'conflictResolved', taskTitle: 'Widget', winnerDev: 'zz9988776655', loserDev: 'aa1122334455', winner: 'remote', loser: 'local' }],
    []
  );
}).then(function (html2) {
  // T2: unnamed device -> devId.slice(0,6), never devId.slice(-6) or the full id.
  assert('T2: unnamed winnerDev falls back to the first six characters', html2.indexOf('zz9988') >= 0);
  assert('T2: unnamed winnerDev does NOT contain the full raw device id', html2.indexOf('zz9988776655') < 0);
  assert('T2: unnamed winnerDev does NOT use the .slice(-6) (last-six) convention', html2.indexOf('776655') < 0);

  // ---- T3 setup: drive the SAME real character conflict through merge()
  // twice -- once as device A's own sync round, once as device B's own
  // (mirrored) sync round for the identical underlying data -- using the
  // real sync.js deterministic tiebreak (comment at merge()'s tiebreak site:
  // "the higher deviceId string wins, on BOTH sides, so merge(b,L,R) and
  // merge(b,R,L) pick the same winner"). Both sides tie on updatedAt so both
  // calls land in that same tiebreak code, keeping this test independent of
  // whichever `reason` wording each specific branch ends up using.
  const baseChar = { id: 'c1', name: 'Wiz1', lvl: 5, xp: 100, gold: 50, maxHp: 100, updatedAt: 1000 };
  const charA = { id: 'c1', name: 'Wiz1', lvl: 6, xp: 150, gold: 50, maxHp: 100, updatedAt: 5000 }; // device A's own local char
  const charB = { id: 'c1', name: 'Wiz1', lvl: 8, xp: 400, gold: 50, maxHp: 100, updatedAt: 5000 }; // device B's own local char (tie)

  const s1 = loadSyncSandbox('a-unused');
  const events1 = [];
  s1.sandbox.logEvent = function (ev) { events1.push(ev); };
  s1.Q.merge(subset([], baseChar), subset([], charA), subset([], charB), Date.now(), Date.now(), 'aaa', 'zzz');
  const cv1 = events1.filter(function (e) { return e.kind === 'conflictResolved'; });

  const s2 = loadSyncSandbox('b-unused');
  const events2 = [];
  s2.sandbox.logEvent = function (ev) { events2.push(ev); };
  s2.Q.merge(subset([], baseChar), subset([], charB), subset([], charA), Date.now(), Date.now(), 'zzz', 'aaa');
  const cv2 = events2.filter(function (e) { return e.kind === 'conflictResolved'; });

  assertEq('T3 setup: exactly one conflictResolved from device A\'s own merge() call', cv1.length, 1);
  assertEq('T3 setup: exactly one conflictResolved from device B\'s own merge() call', cv2.length, 1);

  const devices = [{ id: 'zzz', name: 'Bob' }, { id: 'aaa', name: 'Alice' }];
  return renderWith([Object.assign({ ts: 1000 }, cv1[0])], devices).then(function (htmlA) {
    return renderWith([Object.assign({ ts: 1000 }, cv2[0])], devices).then(function (htmlB) {
      return { htmlA: htmlA, htmlB: htmlB };
    });
  });
}).then(function (pair) {
  const phraseA = conflictPhrase(pair.htmlA);
  const phraseB = conflictPhrase(pair.htmlB);
  assert('T3: device A\'s render produced a conflict phrase', !!phraseA);
  assert('T3: device B\'s render produced a conflict phrase', !!phraseB);
  assertEq('T3: the SAME real conflict renders IDENTICAL attribution text from both devices\' own merge() calls', phraseA, phraseB);

  // T4: an old-shape event (no winnerDev/loserDev/reason at all) must render
  // EXACTLY as it does today -- this must be green now and stay green.
  return renderWith(
    [{ ts: 1000, kind: 'conflictResolved', taskTitle: 'Widget', winner: 'remote', loser: 'local' }],
    []
  );
}).then(function (html4) {
  assert('T4: old-shape event (no new fields) still renders exactly as today',
    html4.indexOf("Sync conflict resolved · Widget · kept remote's copy") >= 0);

  // =======================================================================
  // T5 (EMITTERS): drive a real task conflict through mergeCollection() and
  // a real char conflict through merge(), capturing the RAW emitted event
  // objects via a stubbed logEvent.
  // =======================================================================
  const s5 = loadSyncSandbox('dev-local-111');
  const events5 = [];
  s5.sandbox.logEvent = function (ev) { events5.push(ev); };

  // Task conflict via mergeCollection() directly (already-landed 7th param).
  const taskBase = [{ id: 't1', type: 'todo', title: 'Task1', updatedAt: 100 }];
  const taskLocal = [{ id: 't1', type: 'todo', title: 'Task1-Local', updatedAt: 200 }];
  const taskRemote = [{ id: 't1', type: 'todo', title: 'Task1-Remote', updatedAt: 300 }];
  s5.Q.mergeCollection(taskBase, taskLocal, taskRemote, Date.now(), Date.now(), new Map(), 'dev-remote-999');
  const taskConflicts = events5.filter(function (e) { return e.kind === 'conflictResolved' && e.taskId === 't1'; });

  assertEq('T5 task: exactly one conflictResolved for the task conflict', taskConflicts.length, 1);
  const tc = taskConflicts[0] || {};
  assert('T5 task: winnerDev is a real device id (not the word "local"/"remote")',
    tc.winnerDev === 'dev-remote-999' || tc.winnerDev === 'dev-local-111');
  assert('T5 task: winnerDev is NOT the literal string "remote"', tc.winnerDev !== 'remote');
  assert('T5 task: winnerDev is NOT the literal string "local"', tc.winnerDev !== 'local');
  assertEq('T5 task: winnerDev is the actual newer-writer device id (remote won on updatedAt)', tc.winnerDev, 'dev-remote-999');
  assertEq('T5 task: loserDev is the actual local device id', tc.loserDev, 'dev-local-111');
  assertEq('T5 task: legacy winner field is still present (old readers)', tc.winner, 'remote');
  assertEq('T5 task: legacy loser field is still present (old readers)', tc.loser, 'local');

  // Char conflict via merge() directly.
  const charBase = { id: 'c1', name: 'Wiz1', lvl: 5, xp: 100, gold: 50, maxHp: 100, updatedAt: 1000 };
  const charLocal = { id: 'c1', name: 'Wiz1', lvl: 6, xp: 200, gold: 50, maxHp: 100, updatedAt: 2000 };
  const charRemote = { id: 'c1', name: 'Wiz1', lvl: 5, xp: 100, gold: 75, maxHp: 100, updatedAt: 3000 };
  s5.Q.merge(subset([], charBase), subset([], charLocal), subset([], charRemote), Date.now(), Date.now(), 'dev-local-222', 'dev-remote-333');
  const charConflicts = events5.filter(function (e) { return e.kind === 'conflictResolved' && e.taskType === 'char'; });

  assertEq('T5 char: exactly one conflictResolved for the char conflict', charConflicts.length, 1);
  const cc = charConflicts[0] || {};
  assert('T5 char: winnerDev is NOT the literal string "remote"', cc.winnerDev !== 'remote');
  assert('T5 char: winnerDev is NOT the literal string "local"', cc.winnerDev !== 'local');
  assertEq('T5 char: winnerDev is the actual remote device id (remote won on updatedAt)', cc.winnerDev, 'dev-remote-333');
  assertEq('T5 char: loserDev is the actual local device id', cc.loserDev, 'dev-local-222');
  assertEq('T5 char: legacy winner field is still present (old readers)', cc.winner, 'remote');
  assertEq('T5 char: legacy loser field is still present (old readers)', cc.loser, 'local');

  // =======================================================================
  // T6 (_EXPORT_FIELD_MAP UNCHANGED) + T7 (TOKENIZE ROUND-TRIP, LONG-FORM)
  // + T8 (CROSS-VERSION HASH)
  // =======================================================================
  const tokNew = loadTokenizerSandbox(); // "new build" -- the one that ships the fix
  const mapKeys = Object.keys(tokNew._EXPORT_FIELD_MAP_REF);
  const mapVals = mapKeys.map(function (k) { return tokNew._EXPORT_FIELD_MAP_REF[k]; });
  assert('T6: _EXPORT_FIELD_MAP has no winnerDev key', mapKeys.indexOf('winnerDev') === -1);
  assert('T6: _EXPORT_FIELD_MAP has no loserDev key', mapKeys.indexOf('loserDev') === -1);
  assert('T6: _EXPORT_FIELD_MAP has no reason key', mapKeys.indexOf('reason') === -1);
  assert('T6: _EXPORT_FIELD_MAP has no "wd" short code', mapVals.indexOf('wd') === -1);
  assert('T6: _EXPORT_FIELD_MAP has no "ld" short code', mapVals.indexOf('ld') === -1);
  assert('T6: _EXPORT_FIELD_MAP has no "rn" short code', mapVals.indexOf('rn') === -1);

  const attributedEvent = {
    uid: 'e1', kind: 'conflictResolved', taskId: 't1', taskTitle: 'Widget',
    winner: 'remote', loser: 'local',
    winnerDev: 'dev-remote-333', loserDev: 'dev-local-222', reason: 'device id tiebreak',
    createdAt: 5000, updatedAt: 5000
  };
  const tok = tokNew._tokenizeEvents([attributedEvent]);
  assertEq('T7: tokenized event keeps winnerDev as a LONG-FORM key', tok.E[0].winnerDev, 'dev-remote-333');
  assertEq('T7: tokenized event keeps loserDev as a LONG-FORM key', tok.E[0].loserDev, 'dev-local-222');
  assertEq('T7: tokenized event keeps reason as a LONG-FORM key', tok.E[0].reason, 'device id tiebreak');
  const roundTrip = tokNew._detokenizeEvents({ E: tok.E, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT });
  assertEq('T7: detokenized winnerDev matches the original', roundTrip[0].winnerDev, 'dev-remote-333');
  assertEq('T7: detokenized loserDev matches the original', roundTrip[0].loserDev, 'dev-local-222');
  assertEq('T7: detokenized reason matches the original', roundTrip[0].reason, 'device id tiebreak');

  // T8: an "older build" -- its _EXPORT_FIELD_MAP copy has winnerDev/loserDev/
  // reason deleted (documents the guard even though they were never present
  // on HEAD) -- must still detokenize a NEW build's export and recompute the
  // identical hash, mirroring buildBackupFile's canonical hash form (hash is
  // computed on the long-form object, app.js's `const preJson =
  // JSON.stringify(backup);`, BEFORE tokenization).
  const tokOld = loadTokenizerSandbox(); // separate sandbox = independent _EXPORT_FIELD_MAP object
  vm.runInContext(
    'delete _EXPORT_FIELD_MAP.winnerDev; delete _EXPORT_FIELD_MAP.loserDev; delete _EXPORT_FIELD_MAP.reason;\n' +
    'var _EXPORT_FIELD_MAP_REF=_EXPORT_FIELD_MAP;\n',
    tokOld
  );

  const state = {
    char: { id: 'c1', name: 'Wiz1', lvl: 6, xp: 200 },
    tasks: [{ id: 't1', title: 'Task1', done: false }],
    rewards: [], tags: [], prefs: { width: 480 }
  };
  const events = [attributedEvent];
  const snap = {}; for (const k in state) if (k !== 'events') snap[k] = state[k];
  const snapTok = tokNew._tokenizeSnapshot(snap);
  const evTok = tokNew._tokenizeEvents(events);

  const backup = Object.assign({}, snap, { events: events });
  backup._backup = { schema: 2, appVersion: 'vTEST', eventCount: events.length };
  const preJson = JSON.stringify(backup);
  const originalHash = sha256hex(preJson);
  backup._backup.hash = originalHash;

  const envelope = {
    _backup: backup._backup,
    K: evTok.K, SRC: evTok.SRC, TID: evTok.TID, TT: evTok.TT,
    FM: snapTok.FM, S: snapTok.S, E: evTok.E
  };

  // "old build" import: detokenize with the OLD field-map sandbox.
  const importedSnap = tokOld._detokenizeSnapshot(envelope);
  importedSnap.events = tokOld._detokenizeEvents(envelope);
  importedSnap._backup = Object.assign({}, envelope._backup);

  const expectedHash = importedSnap._backup.hash;
  delete importedSnap._backup.hash;
  const recomputedHash = sha256hex(JSON.stringify(importedSnap));
  importedSnap._backup.hash = expectedHash;

  assertEq('T8: old build detokenizes winnerDev unchanged (long-form passthrough)', importedSnap.events[0].winnerDev, 'dev-remote-333');
  assertEq('T8: old build detokenizes reason unchanged (long-form passthrough)', importedSnap.events[0].reason, 'device id tiebreak');
  assertEq('T8: old build\'s recomputed hash matches the new build\'s stored hash', recomputedHash, originalHash);

  finish();
}).catch(function (e) {
  console.error('\nERROR: ' + (e && e.stack || e));
  process.exit(1);
});

// Safety net in case the async renders never resolve.
setTimeout(function () {
  console.error('\nTIMEOUT: render cases did not complete');
  process.exit(1);
}, 5000);
