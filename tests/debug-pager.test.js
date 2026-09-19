// debug-pager.test.js -- the Activity Feed pager and its noise filter.
//
// HISTORY, because it explains the shape of this file (2026-09-19, round 3,
// item 15). This test used to be 89 lines of console.log and ZERO assertions:
// it printed a row count of 0 and nobody noticed, because tests/run.js counted
// exit 0 as a pass. Two separate faults were hiding behind that.
//   1. The extraction was incomplete. renderEventDetail's row builder calls
//      jsq(), which was never extracted, so the .then() body threw a
//      ReferenceError on every run.
//   2. renderEventDetail's catch was a bare `catch(()=>{})` that discarded the
//      cause and printed "Event log unavailable (IndexedDB may be disabled)".
//      So a plain ReferenceError in app code was indistinguishable from private
//      browsing, from the screen and from a diagnostics bundle alike.
// Both are fixed. The catch now records the cause via _qDiagPush, and P0 below
// asserts the render did NOT take that path -- which is what stops this file
// quietly regressing to "renders nothing, reports success" a second time.
//
//   P0      the render SUCCEEDS: no recorded failure, and the fallback message
//           is absent. Everything after this is meaningless without it.
//   P1-P2   category helpers.
//   P3-P6   hideConflictDecisions = false: a full page of 25 rows, newest
//           first, carrying both the conflict noise and the real events.
//   P7-P10  hideConflictDecisions = true: the 25 conflict rows are filtered out
//           and only the 3 real events remain.
//
// Run: node tests/debug-pager.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractLine, extractFunction, extractSpan, functionEndLineIndex } = require('./_extract');

let failures = 0;
function assert(d, c){ if(c) console.log('[PASS] ' + d); else { console.error('[FAIL] ' + d); failures++; } }
function assertEq(d, got, want){
  if(got === want) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const diagnosticKindsLine = extractLine(appSrc, /^var DIAGNOSTIC_KINDS\s*=\s*\[/, 'DIAGNOSTIC_KINDS declaration');
const renderBlock = extractSpan(
  appSrc,
  /^let _evWin=null;/,
  functionEndLineIndex(/^function renderEventDetail\(from,to\)\{/, 'renderEventDetail'),
  'feed render helper block (_evWin..renderEventDetail end)'
);
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
// 2026-09-19: jsq was the missing dependency. The row builder calls it for
// every row, so without it the whole render threw. If a future edit adds
// another helper call inside renderEventDetail, P0 is what will catch it.
const jsqFn = extractFunction(appSrc, /^function jsq\(s\)\{/, 'jsq');

const evStubs = 'var _evFilterType="all", _evPage=0, _evSearchQuery="";\n';
const code =
  diagnosticKindsLine + '\n' +
  evStubs +
  renderBlock + '\n' +
  escFn + '\n' +
  jsqFn + '\n' +
  'return { renderEventDetail, isFeedNoise, getEventCategory, DIAGNOSTIC_KINDS, CONFLICT_CATEGORY };';

const S = { prefs: { hideSyncDiag: true, hideConflictDecisions: false }, devices: [] };

function makeEl(id){
  return { _id: id, innerHTML: '', querySelector: function(){ return null; }, querySelectorAll: function(){ return []; } };
}
function makeDoc(){
  const store = {};
  return { __store: store, getElementById: function(id){ if(!store[id]) store[id] = makeEl(id); return store[id]; } };
}
const doc = makeDoc();

// Every failure renderEventDetail records lands here. Empty is the pass.
const recorded = [];

const sandbox = {
  S, document: doc, window: {}, navigator: {}, console,
  setTimeout: function(fn){ return setTimeout(fn, 0); },
  clearTimeout: function(){},
  _qDiagPush: function(kind, data){ recorded.push({ kind: kind, data: data }); }
};
sandbox.globalThis = sandbox;

const pagerFixture = [];
for(let i = 0; i < 25; i++){
  pagerFixture.push({ ts: 1000 + i, kind: 'conflictResolved', taskType: 'habit', taskTitle: 'Noise event ' + i, winner: 'remote', loser: 'local', dev: 'mrg0grhu3mozs' });
}
pagerFixture.push({ ts: 26000, kind: 'habitTap', taskType: 'habit', taskTitle: 'Real habit', dev: 'mrl770yaq56gl' });
pagerFixture.push({ ts: 27000, kind: 'complete', taskType: 'daily', taskTitle: 'Real daily', dev: 'mrg0grhu3mozs' });
pagerFixture.push({ ts: 28000, kind: 'export', notes: 'Real export', dev: 'mrg0grhu3mozs' });

function buildApiWithEvents(events){
  const getEventsStub =
    'function getEvents(opts){ return Promise.resolve(' +
    JSON.stringify(events.slice().sort(function(a, b){ return a.ts - b.ts; })) + '); }';
  const fn = new vm.Script(
    '(function(S, document, window, navigator, console, setTimeout, clearTimeout, _qDiagPush){ "use strict";' +
    getEventsStub + '\n' + code + '\n})'
  ).runInNewContext(sandbox);
  return fn(S, doc, sandbox.window, sandbox.navigator, console,
            sandbox.setTimeout, sandbox.clearTimeout, sandbox._qDiagPush);
}

const api = buildApiWithEvents(pagerFixture);

// renderEventDetail resolves its own promise chain; one macrotask is enough for
// the getEvents stub (already resolved) plus the .then() body.
function renderAndRead(){
  doc.__store['evFeedContent'] = makeEl('evFeedContent');
  doc.__store['anEventDetail'] = makeEl('anEventDetail');
  api.renderEventDetail(0, 1e15);
  return new Promise(function(res){
    setTimeout(function(){
      res({
        feed: doc.__store['evFeedContent'].innerHTML || '',
        fallback: doc.__store['anEventDetail'].innerHTML || ''
      });
    }, 50);
  });
}
function rowCount(html){ return (html.match(/class="evRow"/g) || []).length; }

(async function(){
  // ---- P0: the render must actually run -------------------------------
  const open = await renderAndRead();
  assertEq('P0a: renderEventDetail recorded no failure', recorded.length, 0);
  assert('P0b: ...and did not fall back to "Event log unavailable"',
    open.fallback.indexOf('Event log unavailable') === -1);
  assert('P0c: ...and wrote real markup into evFeedContent', open.feed.length > 0);

  // ---- P1-P2: category helpers ----------------------------------------
  assert('P1: CONFLICT_CATEGORY is a non-empty string',
    typeof api.CONFLICT_CATEGORY === 'string' && api.CONFLICT_CATEGORY.length > 0);
  assertEq('P2: getEventCategory(conflictResolved) is CONFLICT_CATEGORY',
    api.getEventCategory({ kind: 'conflictResolved' }), api.CONFLICT_CATEGORY);

  // ---- P3-P6: conflict decisions SHOWN --------------------------------
  // 28 events, newest first, one page of 25: the 3 real events plus 22 of the
  // 25 conflict rows. The remaining 3 are on page 2 -- that is the pager.
  assertEq('P3: a full page is 25 rows', rowCount(open.feed), 25);
  assertEq('P4: 22 of the 25 conflict rows fit on page 1', (open.feed.match(/Noise event/g) || []).length, 22);
  assert('P5: the newest real events are all on page 1',
    open.feed.indexOf('Real habit') >= 0 &&
    open.feed.indexOf('Real daily') >= 0 &&
    open.feed.indexOf('Real export') >= 0);
  assert('P6: newest first -- the newest event outranks the oldest noise',
    open.feed.indexOf('Real export') < open.feed.indexOf('Noise event 24'));

  // ---- P7-P10: conflict decisions HIDDEN ------------------------------
  S.prefs.hideConflictDecisions = true;
  const filtered = await renderAndRead();
  assertEq('P7a: hiding conflict decisions still renders cleanly', recorded.length, 0);
  assert('P7b: ...with no fallback message',
    filtered.fallback.indexOf('Event log unavailable') === -1);
  assertEq('P8: only the 3 real events survive the filter', rowCount(filtered.feed), 3);
  assert('P9: every conflict row is gone', filtered.feed.indexOf('Noise event') === -1);
  assert('P10: the real events are untouched by the filter',
    filtered.feed.indexOf('Real habit') >= 0 &&
    filtered.feed.indexOf('Real daily') >= 0 &&
    filtered.feed.indexOf('Real export') >= 0);
  S.prefs.hideConflictDecisions = false;

  if(failures){ console.error(failures + ' debug-pager assertion(s) FAILED'); process.exit(1); }
  console.log('debug-pager.test.js: all assertions passed');
})();
