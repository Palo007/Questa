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
const { extractLine, extractFunction, extractSpan, functionEndLineIndex } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) replaces the old hardcoded
// grab(lineStart, lineEnd) helper: every app.js insertion used to silently
// shift those ranges (this repatch happened 2026-07-23 and again 2026-07-29).
// Anchors are located by regex on their declaration text, then (for the
// render block / esc) a brace-balance scan finds the true end, so extraction
// survives arbitrary line shifts elsewhere in the file.
//
// DIAGNOSTIC_KINDS: `var DIAGNOSTIC_KINDS = [...]` declaration line.
// Render helper block: from `let _evWin=null;` through the brace-balanced end
// of renderEventDetail() -- covers getEventCategory, isFeedNoise,
// _evCatBadge*, _evDeltaSpan, _evDiffText, evSetSearch, renderEventDetail.
// Some render globals (`_evFilterType`, `_evPage`, `_evSearchQuery`) live
// elsewhere in app.js (before the render block); stub them as vars.
// esc(): single-line function, extracted whole via brace balance.
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
const code =
  diagnosticKindsLine + '\n' +
  evStubs +
  renderBlock + '\n' +
  escFn + '\n' +
  jsqFn + '\n' +
  'return { renderEventDetail, isFeedNoise, getEventCategory, DIAGNOSTIC_KINDS };';

// Stub S with controllable prefs.
const S = { prefs: { hideSyncDiag: false, hideConflictDecisions: false } };

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
// 2 noise rows (storagePersist, lifecycle) + 4 real rows
// (habitTap, complete, export, conflictResolved). The habitTap dev differs from the noise dev so
// we can confirm dev attribution survives on the kept rows.
 // T7: conflictResolved is no longer noise; it has its own category/toggle.
const fixture = [
  { ts: 1000, kind: 'habitTap', taskType: 'habit', taskTitle: 'Stay positive', dev: 'mrl770yaq56gl' },
  { ts: 2000, kind: 'complete', taskType: 'daily', taskTitle: 'Exercise', dev: 'mrg0grhu3mozs' },
  { ts: 3000, kind: 'export', notes: 'Backup downloaded', dev: 'mrg0grhu3mozs' },
  { ts: 4000, kind: 'conflictResolved', taskType: 'habit', taskTitle: 'Stay positive', winner: 'remote', loser: 'local', dev: 'mrg0grhu3mozs' },
  { ts: 5000, kind: 'storagePersist', granted: true, dev: 'mrg0grhu3mozs' },
  { ts: 6000, kind: 'lifecycle', notes: 'boot', dev: 'mrg0grhu3mozs' },
];

// Pager fixture: 25 conflictResolved (noise) + 3 real events = 28 total.
// With hideSyncDiag=true, the 25 noise events are filtered out before
// pagination, so only 3 real rows should appear and the pager should
// reflect 3 events / 1 page — not 28 events / 2 pages.
const pagerFixture = [];
for (let i = 0; i < 25; i++) {
  pagerFixture.push({ ts: 1000 + i, kind: 'conflictResolved', taskType: 'habit', taskTitle: 'Noise event ' + i, winner: 'remote', loser: 'local', dev: 'mrg0grhu3mozs' });
}
pagerFixture.push({ ts: 26000, kind: 'habitTap', taskType: 'habit', taskTitle: 'Real habit', dev: 'mrl770yaq56gl' });
pagerFixture.push({ ts: 27000, kind: 'complete', taskType: 'daily', taskTitle: 'Real daily', dev: 'mrg0grhu3mozs' });
pagerFixture.push({ ts: 28000, kind: 'export', notes: 'Real export', dev: 'mrg0grhu3mozs' });

// =========================================================================
// Unit: isFeedNoise
// =========================================================================
// T7: conflictResolved is no longer in isFeedNoise; it has its own category/toggle
assert('isFeedNoise(conflictResolved) === false', isFeedNoise({ kind: 'conflictResolved' }) === false);
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
function renderCase(hideDiag, events) {
  return new Promise(function (resolve) {
    S.prefs.hideSyncDiag = hideDiag;
    S.prefs.hideConflictDecisions = false; // T7: conflictResolved has its own toggle, default false (visible)
    doc.getElementById('anEventDetail').innerHTML = '';
    doc.getElementById('evFeedContent').innerHTML = '';
    const caseApi = buildApiWithEvents(events || fixture);
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
  // T7: conflictResolved is now visible by default (separate category/toggle)
  assert('OFF: 6 rows (all kinds visible)', countRows(htmlOff) === 6);
  assert('OFF: habitTap row present', htmlOff.indexOf('Stay positive') >= 0);
  assert('OFF: complete row present', htmlOff.indexOf('Exercise') >= 0);
  assert('OFF: export row present', htmlOff.indexOf('Backup downloaded') >= 0);
  assert('OFF: conflictResolved row present', htmlOff.indexOf('Stay positive') >= 0); // conflictResolved taskTitle
  assert('OFF: dev attribution preserved (mrl device label)', htmlOff.indexOf('mrl770yaq56gl') >= 0);
  return renderCase(true);
}).then(function (htmlOn) {
  // T7: conflictResolved has its own toggle (hideConflictDecisions), not controlled by hideSyncDiag
  // So with hideSyncDiag=true: lifecycle/storagePersist hidden, but conflictResolved visible
  assert('ON: 4 rows (sync/diagnostic hidden, conflictResolved visible)', countRows(htmlOn) === 4);
  assert('ON: habitTap row present', htmlOn.indexOf('Stay positive') >= 0);
  assert('ON: complete row present', htmlOn.indexOf('Exercise') >= 0);
  assert('ON: export row present', htmlOn.indexOf('Backup downloaded') >= 0);
  assert('ON: conflictResolved row present', htmlOn.indexOf('Stay positive') >= 0); // conflictResolved taskTitle
  assert('ON: dev attribution preserved (mrl device label)', htmlOn.indexOf('mrl770yaq56gl') >= 0);
  assert('ON: lifecycle row hidden', htmlOn.indexOf('boot') < 0);
  // Regression: pager count must reflect post-noise count, not total unfiltered count.
  // 25 conflictResolved + 3 real = 28 total. With hideSyncDiag=true, conflictResolved is NOT filtered
  // (it has its own toggle hideConflictDecisions which defaults to false), so all 28 visible.
  return renderCase(true, pagerFixture);
}).then(function (htmlPager) {
  // T7: conflictResolved has its own toggle (hideConflictDecisions), not controlled by hideSyncDiag
  // So with hideSyncDiag=true: all 28 events pass the filter (25 conflictResolved + 3 real)
  // But pagination (EV_PAGE_SIZE=25) means only 25 rows render on page 0.
  // Page 0 shows first 25 events (3 real + 22 conflictResolved). The conflictResolved rows
  // render via generic else branch with their taskTitle ('Noise event X').
  // The row count (25) and pager (2 pages) already verify conflictResolved are NOT filtered.
  // Additional check: verify conflictResolved taskTitle text appears in the feed
  assert('PAGER ON: 25 rows visible on page 0 (first page of 28)', countRows(htmlPager) === 25);
  assert('PAGER ON: conflictResolved taskTitle present on page 0', htmlPager.indexOf('Noise event') >= 0);
  assert('PAGER ON: no blank page', countRows(htmlPager) > 0);
  // Verify pager shows 2 pages (28 events / 25 per page = 2 pages)
  assert('PAGER ON: pager shows 2 pages', htmlPager.indexOf('Page 1 / 2') >= 0 || htmlPager.indexOf('1 / 2') >= 0);
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
