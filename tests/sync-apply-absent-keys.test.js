// sync-apply-absent-keys.test.js -- regression cover for the 2026-09-18 review.
//
// syncApply() writes a state subset into S. An ABSENT key means "the writer
// expressed no opinion about this collection", not "this collection is empty" --
// which is exactly how its neighbours already behaved (`S.char = subset.char ||
// S.char`, `if(subset.lastCron)`, `S.deletions = ... : (S.deletions || [])`,
// `if(subset.pause){...}`).
//
// Six keys had the opposite polarity and fell back to []:
//   rewards, tags, history, charHistory, monthlyBackups, and prefs.an.{views,metrics}
//
// merge() always emits all twelve keys, so the ordinary sync round never hit it.
// _syncForcePullAttempt does NOT go through merge -- it calls syncApply on the RAW
// remote state. A /state.json written by a build predating monthlyBackups/an, or one
// the user hand-edited in their own Dropbox folder, therefore wiped every saved
// analytics view, metric, reward, tag and history row on the pulling device, and
// save() persisted the loss.
//
// Run: node tests/sync-apply-absent-keys.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

const noop = function(){};
function makeQ(S){
  const sandbox = {
    window: {}, navigator: {onLine: true},
    document: {addEventListener: noop, getElementById: function(){ return null; },
      createElement: function(){ return {style:{},appendChild:noop,setAttribute:noop,click:noop}; },
      body: {appendChild:noop, removeChild:noop}},
    localStorage: {getItem: function(){ return null; }, setItem: noop, removeItem: noop,
      key: function(){ return null; }, length: 0},
    indexedDB: {open: function(){ return {}; }},
    setTimeout: function(){ return 0; }, clearTimeout: noop,
    setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date,
    Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String,
    Boolean: Boolean, Promise: Promise,
    logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return 'devA'; },
    idbOpen: function(){ return Promise.resolve(null); },
    now: function(){ return Date.now(); },
    S: S
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch(e){}
  return sandbox.window.QuestaSync;
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

function liveState(){
  return {
    tasks: [{id:'t1', type:'todo', title:'keep me', updatedAt: 10}],
    rewards: [{id:'r1', title:'Coffee', cost:5, updatedAt:10}],
    tags: [{id:'g1', name:'Health', color:'#f00', updatedAt:10}],
    devices: [{id:'devA', name:'Phone', updatedAt:10}],
    history: [{date:1, v:1}],
    charHistory: [{date:1, hp:50}],
    monthlyBackups: [{key:'2026-08', path:'/x.json'}],
    deletions: [{id:'gone', at:5}],
    char: {hp:50, lvl:1, updatedAt:10},
    lastCron: 20260901,
    prefs: { an: { views:[{id:'v1', name:'My view', updatedAt:10}],
                   metrics:[{id:'m1', name:'Pushups', updatedAt:10}] } }
  };
}

const Q0 = makeQ(liveState());
if (!Q0 || typeof Q0.apply !== 'function') {
  console.error('FAIL: QuestaSync registry missing apply');
  process.exit(1);
}

// ===========================================================================
// A -- a legacy/partial remote must not destroy collections it never mentions
// ===========================================================================
console.log('--- A: absent keys preserve local ---');
{
  const S = liveState();
  const Q = makeQ(S);
  // The minimum a remote state must carry to be accepted: tasks. Everything else
  // is absent, exactly like a /state.json written by an older build.
  Q.apply({ tasks: [{id:'t9', type:'todo', title:'from remote', updatedAt: 99}] });

  assertEq('A1 tasks ARE replaced (the one key the remote spoke about)', S.tasks.length, 1);
  assertEq('A2 ...with the remote task', S.tasks[0].id, 't9');
  assertEq('A3 rewards survive an absent key', S.rewards.length, 1);
  assertEq('A4 tags survive an absent key', S.tags.length, 1);
  assertEq('A5 history survives an absent key', S.history.length, 1);
  assertEq('A6 charHistory survives an absent key', S.charHistory.length, 1);
  assertEq('A7 monthlyBackups survive an absent key', S.monthlyBackups.length, 1);
  assertEq('A8 analytics views survive an absent `an`', S.prefs.an.views.length, 1);
  assertEq('A9 analytics metrics survive an absent `an`', S.prefs.an.metrics.length, 1);
  assertEq('A10 devices survive an absent key', S.devices.length, 1);
  // Unchanged neighbours, asserted so a future edit cannot quietly flip them.
  assertEq('A11 deletions still preserve local (unchanged behaviour)', S.deletions.length, 1);
  assertEq('A12 lastCron still preserves local (unchanged behaviour)', S.lastCron, 20260901);
  assertEq('A13 char still preserves local (unchanged behaviour)', S.char.hp, 50);
}

// ===========================================================================
// B -- an EXPLICIT empty array must still clear. "Delete them all" is a real
//      intent and must remain expressible, or force-pull could never drop rows.
// ===========================================================================
console.log('--- B: an explicit [] still clears ---');
{
  const S = liveState();
  const Q = makeQ(S);
  Q.apply({
    tasks: [], rewards: [], tags: [], devices: [],
    history: [], charHistory: [], monthlyBackups: [],
    an: { views: [], metrics: [] }
  });
  assertEq('B1 explicit [] clears rewards', S.rewards.length, 0);
  assertEq('B2 explicit [] clears tags', S.tags.length, 0);
  assertEq('B3 explicit [] clears history', S.history.length, 0);
  assertEq('B4 explicit [] clears charHistory', S.charHistory.length, 0);
  assertEq('B5 explicit [] clears monthlyBackups', S.monthlyBackups.length, 0);
  assertEq('B6 explicit [] clears analytics views', S.prefs.an.views.length, 0);
  assertEq('B7 explicit [] clears analytics metrics', S.prefs.an.metrics.length, 0);
}

// ===========================================================================
// C -- a populated remote still wins normally
// ===========================================================================
console.log('--- C: a populated remote is applied ---');
{
  const S = liveState();
  const Q = makeQ(S);
  Q.apply({
    tasks: [{id:'t1', type:'todo', title:'keep me', updatedAt:10}],
    rewards: [{id:'r2', title:'Cake', cost:9, updatedAt:20}],
    tags: [{id:'g2', name:'Work', color:'#00f', updatedAt:20}],
    an: { views: [{id:'v2', name:'Remote view', updatedAt:20}], metrics: [] }
  });
  assertEq('C1 remote rewards are applied', S.rewards[0].id, 'r2');
  assertEq('C2 remote tags are applied', S.tags[0].id, 'g2');
  assertEq('C3 remote analytics views are applied', S.prefs.an.views[0].id, 'v2');
  assertEq('C4 an absent `metrics` inside a present `an` still clears explicitly',
    S.prefs.an.metrics.length, 0);
  assertEq('C5 history was absent here, so it survives', S.history.length, 1);
}

// ===========================================================================
if (failures) { console.error('\n' + failures + ' sync-apply-absent-keys assertion(s) FAILED'); process.exit(1); }
console.log('\nAll sync-apply-absent-keys tests passed!');
