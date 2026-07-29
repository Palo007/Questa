// deviceid-tiebreak.test.js -- 2026-07-13 (P1-4): call sites now thread the
// TRUE writer deviceId (syncDeviceId() for local, wrapper.deviceId for remote,
// as surfaced by dbxDownload) into merge()'s last two params, instead of
// omitting them and letting the char/mergeDevices tiebreak GUESS the remote
// id from remote.devices[0] (order-dependent, wrong with 3+ devices).
//
// This file exercises merge()'s deviceId tiebreak directly (merge() itself
// already supported the params; convergence.test.js already covers the basic
// equal-updatedAt tiebreak). What's new here:
//   1. Exactly-equal char.updatedAt on both sides + explicit deviceIds ->
//      merge(b,L,R,...,'devA','devB') and the mirrored merge(b,R,L,...,'devB','devA')
//      pick the SAME winner (deterministic total order on the higher deviceId).
//   2. A 3-device scenario where remote.devices is seeded with a DECOY first
//      entry that the old guess-from-remote.devices[0] fallback would have
//      picked -- asserts the tiebreak uses the explicitly PASSED
//      remoteDeviceId, not that guess.

const fs = require('fs'), path = require('path'), vm = require('vm');

// ---- sandbox bootstrap (same pattern as convergence.test.js / char-merge.test.js) ----
let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\nsyncInit\(\);\s*$/, '\n');
const noop = function(){};
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
  save: noop, uid: function(){ return 'x'; },
  idbOpen: function(){ return Promise.resolve(null); }
};
sandbox.self = sandbox.window;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) {}
const Q = sandbox.window.QuestaSync;
if (!Q || typeof Q.merge !== 'function') {
  console.error('FAIL: QuestaSync.merge not found');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function mk(overrides) {
  return Object.assign({
    tasks: [], rewards: [], tags: [], devices: [],
    an: {views: [], metrics: []},
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, char: {}, deletions: []
  }, overrides);
}

const TS_L = 5000;
const TS_R = 4000;

// =========================================================================
// 1. Equal char.updatedAt, explicit deviceIds -> mirrored merges converge on
//    the SAME winner (higher deviceId string wins on both sides).
// =========================================================================
(function(){
  var charA = {name:'Alice', face:'W', cls:'Wizard', lvl:10, xp:500,
               hp:80, maxHp:80, mp:20, gold:100, updatedAt:1000};
  var charB = {name:'Bob', face:'R', cls:'Rogue', lvl:20, xp:2000,
               hp:120, maxHp:120, mp:40, gold:500, updatedAt:1000}; // same updatedAt as charA

  var fwd = Q.merge(mk({char:{}}), mk({char:charA}), mk({char:charB}),
                     TS_R, TS_L, 'devA', 'devB');
  var rev = Q.merge(mk({char:{}}), mk({char:charB}), mk({char:charA}),
                     TS_L, TS_R, 'devB', 'devA');

  assert('equal-updatedAt char: mirrored merges pick the SAME winner',
    fwd.char.name === rev.char.name);
  assert('equal-updatedAt char: winner is Bob/devB (higher deviceId string)',
    fwd.char.name === 'Bob' && rev.char.name === 'Bob');
})();

// =========================================================================
// 2. 3-device scenario: remote.devices seeded with a DECOY first entry that
//    the OLD guess-from-remote.devices[0] fallback would have picked instead
//    of the real remote writer. Asserts the tiebreak uses the explicitly
//    PASSED remoteDeviceId (site 1 / site 2 fix), not that guess.
//
//    local device  = 'devB'
//    remote.devices = [{id:'devZ'}, {id:'devA'}]   <- decoy 'devZ' first
//    passed remoteDeviceId = 'devA'                 <- the TRUE writer id
//
//    Guess-based (old, broken) comparison: 'devZ' > 'devB' -> remote would win.
//    Passed-id-based (new, fixed) comparison: 'devA' < 'devB' -> local wins.
//    These disagree, so this scenario proves which code path actually ran.
// =========================================================================
(function(){
  var localChar  = {name:'LocalWins', face:'W', cls:'Wizard', lvl:10, xp:500,
                     hp:80, maxHp:80, mp:20, gold:100, updatedAt:1000};
  var remoteChar = {name:'RemoteDecoy', face:'R', cls:'Rogue', lvl:20, xp:2000,
                     hp:120, maxHp:120, mp:40, gold:500, updatedAt:1000}; // same updatedAt -> tiebreak

  var decoyDevices = [{id:'devZ', name:'Decoy', updatedAt:1}, {id:'devA', name:'Real writer', updatedAt:1}];

  var merged = Q.merge(
    mk({char:{}}),
    mk({char:localChar, devices:[]}),
    mk({char:remoteChar, devices:decoyDevices}),
    TS_R, TS_L,
    'devB',   // localDeviceId
    'devA'    // remoteDeviceId -- explicitly passed, TRUE writer id (not 'devZ')
  );

  assert('3-device decoy: tiebreak uses PASSED remoteDeviceId ("devA"), not guessed "devZ" from remote.devices[0]',
    merged.char.name === 'LocalWins');
})();

// ---- summary ----
console.log('\n--- deviceid-tiebreak.test.js summary ---');
if (failures) {
  console.error(failures + ' assertion(s) FAILED unexpectedly');
  process.exit(1);
}
console.log('deviceid-tiebreak.test.js: all assertions passed');
process.exit(0);
