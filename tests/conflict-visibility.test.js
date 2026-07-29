// conflict-visibility.test.js -- tests for conflictResolved event logging (plan step #9)
// When a both-changed merge discards one side, logEvent({kind:'conflictResolved',...})
// is called so silent loss is inspectable in the event log / diagnostics.
// Two merge sites: (a) char both-changed in merge(), (b) tasks both-changed in mergeCollection().
//
// Run: node tests/conflict-visibility.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

// Load sync.js into a vm sandbox. Strip boot gate + trailing syncInit().
let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

const noop = function(){};
const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop, key: function(){ return null; }, length: 0 },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(){ return 0; }, clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'x'; }, idbOpen: function(){ return Promise.resolve(null); }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) { /* QuestaSync assigned before boot code */ }
const Q = sandbox.window.QuestaSync;
if (!Q || typeof Q.merge !== 'function') { console.error('FAIL: QuestaSync.merge not found'); process.exit(1); }

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){ if(got === want) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; } }

function subset(tasks, charObj, overrides){
  return Object.assign({ tasks: tasks||[], rewards: [], tags: [], devices: [], an: {views:[],metrics:[]},
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, char: charObj||{}, deletions: [] }, overrides||{});
}

// =========================================================================
// C1: Both-changed char (local and remote both differ from base, both real)
//     -> exactly one conflictResolved event with taskType:'char'
// =========================================================================
(function(){
  var events = [];
  sandbox.logEvent = function(ev){ events.push(ev); };

  var baseChar = { lvl:5, xp:100, gold:50, maxHp:100, name:'Wiz1', id:'c1', updatedAt:1000 };
  var localChar = { lvl:6, xp:200, gold:50, maxHp:100, name:'Wiz1', id:'c1', updatedAt:2000 };
  var remoteChar = { lvl:5, xp:100, gold:75, maxHp:100, name:'Wiz1', id:'c1', updatedAt:3000 };

  var base = subset([], baseChar);
  var local = subset([], localChar);
  var remote = subset([], remoteChar);

  var m = Q.merge(base, local, remote, Date.now(), Date.now(), 'dev-local', 'dev-remote');

  var cv = events.filter(function(e){ return e.kind === 'conflictResolved'; });
  assertEq('C1a: exactly one conflictResolved event for char both-changed', cv.length, 1);
  assertEq('C1b: taskType is char', cv[0] && cv[0].taskType, 'char');
  assert('C1c: winner is either local or remote', cv[0] && (cv[0].winner === 'local' || cv[0].winner === 'remote'));
  assert('C1d: loser is the opposite of winner', cv[0] && cv[0].loser !== cv[0].winner);
  assertEq('C1e: charId present', cv[0] && cv[0].charId, 'c1');
  assertEq('C1f: charTitle present', cv[0] && cv[0].charTitle, 'Wiz1');
  // Remote has newer updatedAt (3000 > 2000), so remote should win
  assertEq('C1g: remote wins (newer updatedAt)', cv[0] && cv[0].winner, 'remote');
  assertEq('C1h: local is loser', cv[0] && cv[0].loser, 'local');

  sandbox.logEvent = noop;
})();

// =========================================================================
// C2: Both-changed task (local and remote both differ from base)
//     -> exactly one conflictResolved event with matching taskType
// =========================================================================
(function(){
  var events = [];
  sandbox.logEvent = function(ev){ events.push(ev); };

  var base = subset([
    { id:'t1', type:'todo', title:'Task1', updatedAt:100 }
  ]);
  var local = subset([
    { id:'t1', type:'todo', title:'Task1-Local', updatedAt:200 }
  ]);
  var remote = subset([
    { id:'t1', type:'todo', title:'Task1-Remote', updatedAt:300 }
  ]);

  var m = Q.merge(base, local, remote, Date.now(), Date.now());

  var cv = events.filter(function(e){ return e.kind === 'conflictResolved'; });
  assertEq('C2a: exactly one conflictResolved event for task both-changed', cv.length, 1);
  assertEq('C2b: taskType matches task type', cv[0] && cv[0].taskType, 'todo');
  assertEq('C2c: taskId present', cv[0] && cv[0].taskId, 't1');
  assert('C2d: winner is either local or remote', cv[0] && (cv[0].winner === 'local' || cv[0].winner === 'remote'));
  assert('C2e: loser is the opposite of winner', cv[0] && cv[0].loser !== cv[0].winner);
  // Remote has higher updatedAt (300 > 200), so remote should win
  assertEq('C2f: remote wins (newer updatedAt)', cv[0] && cv[0].winner, 'remote');
  assertEq('C2g: local is loser', cv[0] && cv[0].loser, 'local');

  sandbox.logEvent = noop;
})();

// =========================================================================
// C3 (negative): One-sided task change (only remote changed, local==base)
//     -> ZERO conflictResolved events (no discard happened)
// =========================================================================
(function(){
  var events = [];
  sandbox.logEvent = function(ev){ events.push(ev); };

  var base = subset([
    { id:'t2', type:'habit', title:'Habit1', updatedAt:100 }
  ]);
  var local = subset([
    { id:'t2', type:'habit', title:'Habit1', updatedAt:100 }  // same as base
  ]);
  var remote = subset([
    { id:'t2', type:'habit', title:'Habit1-Remote', updatedAt:200 }  // changed
  ]);

  var m = Q.merge(base, local, remote, Date.now(), Date.now());

  var cv = events.filter(function(e){ return e.kind === 'conflictResolved'; });
  assertEq('C3a: zero conflictResolved events for one-sided change', cv.length, 0);

  sandbox.logEvent = noop;
})();

// =========================================================================
// C4: Both-changed daily -> conflictResolved fires (through resolveDailyConflict path)
// =========================================================================
(function(){
  var events = [];
  sandbox.logEvent = function(ev){ events.push(ev); };

  var base = subset([
    { id:'d1', type:'daily', title:'Daily1', updatedAt:100, done:false, doneAt:0, missedOn:0, repeat:[1,1,1,1,1,1,1] }
  ]);
  var local = subset([
    { id:'d1', type:'daily', title:'Daily1', updatedAt:200, done:true, doneAt:Date.UTC(2026,6,12,8,0,0), missedOn:0, repeat:[1,1,1,1,1,1,1] }
  ]);
  local.lastCron = 20260712;
  var remote = subset([
    { id:'d1', type:'daily', title:'Daily1', updatedAt:300, done:false, doneAt:0, missedOn:20260712, repeat:[1,1,1,1,1,1,1] }
  ]);
  remote.lastCron = 20260712;

  var m = Q.merge(base, local, remote, Date.now(), Date.now());

  var cv = events.filter(function(e){ return e.kind === 'conflictResolved'; });
  assertEq('C4a: conflictResolved fires for daily both-changed', cv.length, 1);
  assertEq('C4b: taskType is daily', cv[0] && cv[0].taskType, 'daily');
  assert('C4c: winner/loser present', cv[0] && cv[0].winner && cv[0].loser);

  sandbox.logEvent = noop;
})();

if(failures > 0){ console.error(failures + ' conflict-visibility test(s) failed.'); process.exit(1); }
console.log('All conflict-visibility tests passed!');
process.exit(0);
