// feed-hide-sync.test.js -- Activity Feed render filter for sync/diagnostic noise
// Verifies that renderEventDetail() hides `conflictResolved` + DIAGNOSTIC_KINDS
// rows ONLY when S.prefs.hideSyncDiag is true, and shows everything otherwise.
// Real usage (habitTap/complete/export) and dev attribution are always preserved.
//
// Strategy: extract the feed-render functions (getEventCategory, isFeedNoise,
// _evCatBadge*, _evDeltaSpan, _evDiffText, evSetSearch, renderEventDetail, esc)
// plus DIAGNOSTIC_KINDS from app.js, eval them in a vm with stubbed S + document,
// then call renderEventDetail() on a fixture event array and inspect the HTML.
//
// Run: node tests/feed-hide-sync.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const lines = appSrc.split('\n');

function grab(a, b) { return lines.slice(a - 1, b).join('\n'); }

// DIAGNOSTIC_KINDS (var, line 672) + render helper block (3217-3615, includes
// `let _evWin` at 3217) + esc (5657). Some render globals (`_evFilterType`,
// `_evPage`, `_evSearchQuery`) live elsewhere in app.js; stub them as vars.
// Line numbers updated 2026-07-23 for autoBackupEnabled migration (+13/+30 shift).
// Line numbers updated 2026-07-29 for eventMergeFilter addition (+31 shift,
// everything from old line 766 onward moved down 31 lines; line 672 is
// unaffected since it sits before the insertion point).
const evStubs = 'var _evFilterType="all", _evPage=0, _evSearchQuery="";\n';
const code =
  grab(672, 672) + '\n' +
  evStubs +
  grab(3217, 3615) + '\n' +
  grab(5657, 5657) + '\n' +
  'return { renderEventDetail, isFeedNoise, getEventCategory, DIAGNOSTIC_KINDS };';;

// Stub S with controllable prefs.
const S = { prefs: { hideSyncDiag: false } };

// Minimal DOM stub. renderEventDetail writes rows into #evFeedContent (creating
// it inside #anEventDetail when absent), and also touches querySelectorAll.
function makeEl(id) {
  return {
    _id: id,
    innerHTML: '',
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
  };
}
function makeDoc() {
  const store = {};
  return {
    getElementById(id) {
      if (!store[id]) store[id] = makeEl(id);
      return store[id];
    }
  };
}
const doc = makeDoc();

const sandbox = {
  S,
  document: doc,
  window: {},
  navigator: {},
  console,
  setTimeout: function () {},
  clearTimeout: function () {},
};
sandbox.globalThis = sandbox;

// getEvents shim injected into the same lexical scope so renderEventDetail uses
// our fixture instead of the real IndexedDB-backed implementation.
function buildApiWithEvents(events) {
  const getEventsStub =
    'function getEvents(opts){ return Promise.resolve(' +
    JSON.stringify(events.slice().sort((a, b) => a.ts - b.ts)) + '); }';
  const fn = new vm.Script(
    '(function(S, document, window, navigator, console, setTimeout, clearTimeout){ "use strict";' +
    getEventsStub + '\n' + code + '\n})'
  ).runInNewContext(sandbox);
  return fn(S, doc, sandbox.window, sandbox.navigator, console, function () {}, function () {});
}

const api = buildApiWithEvents([]); // placeholder
const { isFeedNoise, getEventCategory, DIAGNOSTIC_KINDS } = api;

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function countRows(html) { return (html.match(/class="evRow"/g) || []).length; }

// ---- Fixture events ----
// 3 noise rows (conflictResolved, storagePersist, lifecycle) + 3 real rows
// (habitTap, complete, export). The habitTap dev differs from the noise dev so
// we can confirm dev attribution survives on the kept rows.
const fixture = [
  { ts: 1000, kind: 'habitTap', taskType: 'habit', taskTitle: 'Stay positive', dev: 'mrl770yaq56gl' },
  { ts: 2000, kind: 'complete', taskType: 'daily', taskTitle: 'Exercise', dev: 'mrg0grhu3mozs' },
  { ts: 3000, kind: 'export', notes: 'Backup downloaded', dev: 'mrg0grhu3mozs' },
  { ts: 4000, kind: 'conflictResolved', taskType: 'habit', taskTitle: 'Stay positive', winner: 'remote', loser: 'local', dev: 'mrg0grhu3mozs' },
  { ts: 5000, kind: 'storagePersist', granted: true, dev: 'mrg0grhu3mozs' },
  { ts: 6000, kind: 'lifecycle', notes: 'boot', dev: 'mrg0grhu3mozs' },
];

// =========================================================================
// Unit: isFeedNoise
// =========================================================================
assert('isFeedNoise(conflictResolved) === true', isFeedNoise({ kind: 'conflictResolved' }) === true);
assert('isFeedNoise(storagePersist) === true', isFeedNoise({ kind: 'storagePersist' }) === true);
assert('isFeedNoise(lifecycle) === true', isFeedNoise({ kind: 'lifecycle' }) === true);
assert('isFeedNoise(habitTap) === false', isFeedNoise({ kind: 'habitTap' }) === false);
assert('isFeedNoise(complete) === false', isFeedNoise({ kind: 'complete' }) === false);
assert('isFeedNoise(export) === false', isFeedNoise({ kind: 'export' }) === false);

// =========================================================================
// renderEventDetail — OFF (default) shows everything; ON hides sync+diagnostic
// renderEventDetail is fire-and-forget (async via getEvents().then), so we read
// #evFeedContent innerHTML after a tick. Cases run sequentially because the
// captured #evFeedContent element is shared between cases.
// =========================================================================
function renderCase(hideDiag) {
  return new Promise(function (resolve) {
    S.prefs.hideSyncDiag = hideDiag;
    doc.getElementById('anEventDetail').innerHTML = '';
    doc.getElementById('evFeedContent').innerHTML = '';
    const caseApi = buildApiWithEvents(fixture);
    caseApi.renderEventDetail(0, 1e15);
    setTimeout(function () { resolve(doc.getElementById('evFeedContent').innerHTML); }, 40);
  });
}

function finish() {
  if (failures) {
    console.error('\nFAILED: ' + failures + ' assertion(s)');
    process.exit(1);
  }
  console.log('\nALL FEED-HIDE-SYNC TESTS PASSED');
  process.exit(0);
}

renderCase(false).then(function (htmlOff) {
  assert('OFF: 6 rows (all kinds visible)', countRows(htmlOff) === 6);
  assert('OFF: habitTap row present', htmlOff.indexOf('Stay positive') >= 0);
  assert('OFF: complete row present', htmlOff.indexOf('Exercise') >= 0);
  assert('OFF: export row present', htmlOff.indexOf('Backup downloaded') >= 0);
  assert('OFF: dev attribution preserved (mrl device label)', htmlOff.indexOf('mrl770yaq56gl') >= 0);
  return renderCase(true);
}).then(function (htmlOn) {
  assert('ON: 3 rows (sync/diagnostic hidden)', countRows(htmlOn) === 3);
  assert('ON: habitTap row present', htmlOn.indexOf('Stay positive') >= 0);
  assert('ON: complete row present', htmlOn.indexOf('Exercise') >= 0);
  assert('ON: export row present', htmlOn.indexOf('Backup downloaded') >= 0);
  assert('ON: dev attribution preserved (mrl device label)', htmlOn.indexOf('mrl770yaq56gl') >= 0);
  assert('ON: lifecycle row hidden', htmlOn.indexOf('boot') < 0 || countRows(htmlOn) === 3);
  finish();
}).catch(function (e) {
  console.error('\nERROR: ' + (e && e.stack || e));
  process.exit(1);
});

// Safety net in case the async renders never resolve.
setTimeout(function () {
  console.error('\nTIMEOUT: render cases did not complete');
  process.exit(1);
}, 2000);
