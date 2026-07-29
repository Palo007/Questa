// convergence.test.js — 2026-07-12 baseline commutativity harness.
// Asserts  merge(b, L, R)  ≡  merge(b, R, L)  winner-wise across the merge
// branch matrix (mergeCollection, resolveDailyConflict, mergeChecklist, char,
// mergeDevices).  All branches now PASS after #1 landed (F6 char tiebreak +
// deterministic deviceId tiebreak in both char and mergeDevices).

const fs = require('fs'), path = require('path'), vm = require('vm');

// ---- sandbox bootstrap (same pattern as char-merge.test.js) ----
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

// ---- test infrastructure ----
let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Build a full QuestaSync state object with overrides.
function mk(overrides) {
  return Object.assign({
    tasks: [], rewards: [], tags: [], devices: [],
    an: {views: [], metrics: []},
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, char: {}, deletions: []
  }, overrides);
}

// Compare two arrays of objects by id-content (order-independent).
function arraysEquiv(a, b) {
  const mapA = new Map(a.map(function(x){ return [x.id, JSON.stringify(x)]; }));
  const mapB = new Map(b.map(function(x){ return [x.id, JSON.stringify(x)]; }));
  if (mapA.size !== mapB.size) return false;
  for (const [id, val] of mapA) {
    if (mapB.get(id) !== val) return false;
  }
  return true;
}

// Fixed timestamps — no Date.now() dependence.  For commutativity the sides
// AND their savedAt values swap:
//   Forward:  merge(b, L, R, remoteSavedAt=TS_R, localSavedAt=TS_L)
//   Swapped:  merge(b, R, L, remoteSavedAt=TS_L, localSavedAt=TS_R)
const TS_L = 5000;
const TS_R = 4000;

// =========================================================================
// 1. TASKS (mergeCollection) — both-changed, different updatedAt → higher wins
//    This exercises the core `lu > ru ? l : r` tiebreak (:685).
// =========================================================================
(function(){
  var baseTask  = {id:'t1', type:'todo', title:'base',   updatedAt:100, xp:10};
  var localTask = {id:'t1', type:'todo', title:'local',  updatedAt:200, xp:20};
  var remoteTask= {id:'t1', type:'todo', title:'remote', updatedAt:300, xp:30};

  var fwd = Q.merge(mk({tasks:[baseTask]}), mk({tasks:[localTask]}),
                     mk({tasks:[remoteTask]}), TS_R, TS_L);
  var rev = Q.merge(mk({tasks:[baseTask]}), mk({tasks:[remoteTask]}),
                     mk({tasks:[localTask]}), TS_L, TS_R);

  var fwdTask = (fwd.tasks || []).find(function(t){ return t.id === 't1'; });
  var revTask = (rev.tasks || []).find(function(t){ return t.id === 't1'; });

  assert('tasks: winner content identical after L/R swap (title)',
    fwdTask && revTask && fwdTask.title === revTask.title);
  assert('tasks: winner content identical after L/R swap (xp)',
    fwdTask && revTask && fwdTask.xp === revTask.xp);
  assert('tasks: winner is the updatedAt=300 side ("remote")',
    fwdTask && fwdTask.title === 'remote' && revTask && revTask.title === 'remote');
})();

// =========================================================================
// 2. DAILIES (resolveDailyConflict) — both-changed, different event days
//    Exercises rule 1 of resolveDailyConflict (:463): newer event day wins.
// =========================================================================
(function(){
  // eventDay = max(dayStampOf(doneAt), missedOn).  Use distinct day-stamps.
  // dayStampOf(172800000ms) = 19700103, missedOn=19700104.
  var baseDaily = {id:'d1', type:'daily', title:'Read', updatedAt:100,
                   done:false, doneAt:0, missedOn:0};
  var localDaily = {id:'d1', type:'daily', title:'Read', updatedAt:200,
                    done:true, doneAt:172800000, missedOn:0};       // eventDay 19700103
  var remoteDaily = {id:'d1', type:'daily', title:'Read', updatedAt:300,
                     done:false, doneAt:0, missedOn:19700104};     // eventDay 19700104

  var fwd = Q.merge(mk({tasks:[baseDaily]}), mk({tasks:[localDaily]}),
                     mk({tasks:[remoteDaily]}), TS_R, TS_L);
  var rev = Q.merge(mk({tasks:[baseDaily]}), mk({tasks:[remoteDaily]}),
                     mk({tasks:[localDaily]}), TS_L, TS_R);

  var fwdDaily = (fwd.tasks || []).find(function(t){ return t.id === 'd1'; });
  var revDaily = (rev.tasks || []).find(function(t){ return t.id === 'd1'; });

  assert('dailies: winner content identical after L/R swap (done)',
    fwdDaily && revDaily && fwdDaily.done === revDaily.done);
  assert('dailies: winner content identical after L/R swap (missedOn)',
    fwdDaily && revDaily && fwdDaily.missedOn === revDaily.missedOn);
  assert('dailies: winner is the newer-event-day side (missedOn=19700104)',
    fwdDaily && fwdDaily.missedOn === 19700104 &&
    revDaily && revDaily.missedOn === 19700104);
})();

// =========================================================================
// 3. SUBTASKS (mergeChecklist) — both-changed task with checklist, different
//    touchedAt per subtask → higher touchedAt wins.  Exercises F4 mergeChecklist
//    (:512-589).
// =========================================================================
(function(){
  var baseSub = {id:'s1', text:'original', done:false, touchedAt:50};
  var localSub = {id:'s1', text:'local-edit', done:false, touchedAt:200};
  var remoteSub = {id:'s1', text:'remote-edit', done:true, touchedAt:300};

  var baseTask = {id:'t1', type:'todo', title:'task', updatedAt:100,
                  checklist:[baseSub]};
  var localTask = {id:'t1', type:'todo', title:'task', updatedAt:100,
                   checklist:[localSub]};
  var remoteTask = {id:'t1', type:'todo', title:'task', updatedAt:100,
                    checklist:[remoteSub]};

  var fwd = Q.merge(mk({tasks:[baseTask]}), mk({tasks:[localTask]}),
                     mk({tasks:[remoteTask]}), TS_R, TS_L);
  var rev = Q.merge(mk({tasks:[baseTask]}), mk({tasks:[remoteTask]}),
                     mk({tasks:[localTask]}), TS_L, TS_R);

  var fwdCheck = ((fwd.tasks || [])[0] || {}).checklist || [];
  var revCheck = ((rev.tasks || [])[0] || {}).checklist || [];

  assert('subtasks: checklist length identical after L/R swap',
    fwdCheck.length === revCheck.length && fwdCheck.length === 1);
  assert('subtasks: subtask text identical after L/R swap ("remote-edit" wins)',
    fwdCheck[0] && revCheck[0] && fwdCheck[0].text === revCheck[0].text &&
    fwdCheck[0].text === 'remote-edit');
  assert('subtasks: subtask done identical after L/R swap (done=true wins)',
    fwdCheck[0] && revCheck[0] && fwdCheck[0].done === revCheck[0].done &&
    fwdCheck[0].done === true);
})();

// =========================================================================
// 4. CHAR — both-changed, both real → F6 rule: strictly-newer remote wins;
//    tie uses deterministic deviceId tiebreak. Now CONVERGENT after #1.
// =========================================================================
(function(){
  var charA = {name:'Alice', face:'W', cls:'Wizard', lvl:10, xp:500,
               hp:80, maxHp:80, mp:20, gold:100, updatedAt:1000};
  var charB = {name:'Bob', face:'R', cls:'Rogue', lvl:20, xp:2000,
               hp:120, maxHp:120, mp:40, gold:500, updatedAt:2000};

  var fwd = Q.merge(mk({char:{}}), mk({char:charA}), mk({char:charB}),
                     TS_R, TS_L, 'devA', 'devB');
  var rev = Q.merge(mk({char:{}}), mk({char:charB}), mk({char:charA}),
                     TS_L, TS_R, 'devB', 'devA');

  // F6: strictly-newer updatedAt wins. charB (2000) > charA (1000) on both sides.
  assert('char: merge(b,L,R) === merge(b,R,L) winner-wise (F6 + deviceId tiebreak)',
    fwd.char.name === rev.char.name && fwd.char.name === 'Bob');

  // Equal-updatedAt sub-case: deviceId tiebreak picks the higher deviceId.
  var charC = {name:'Alice', face:'W', cls:'Wizard', lvl:10, xp:500,
               hp:80, maxHp:80, mp:20, gold:100, updatedAt:1000};
  var charD = {name:'Bob', face:'R', cls:'Rogue', lvl:20, xp:2000,
               hp:120, maxHp:120, mp:40, gold:500, updatedAt:1000};

  var fwd2 = Q.merge(mk({char:{}}), mk({char:charC}), mk({char:charD}),
                      TS_R, TS_L, 'devA', 'devB');
  var rev2 = Q.merge(mk({char:{}}), mk({char:charD}), mk({char:charC}),
                      TS_L, TS_R, 'devB', 'devA');

  // Tie on updatedAt=1000; deviceId tiebreak: devB > devA → Bob always wins.
  assert('char equal-updatedAt: deviceId tiebreak converges (Bob/devB wins both ways)',
    fwd2.char.name === rev2.char.name && fwd2.char.name === 'Bob');
})();

// =========================================================================
// 5. mergeDevices — both-changed device, EQUAL updatedAt → deterministic
//    deviceId tiebreak (higher deviceId wins).  Now CONVERGENT after #1.
// =========================================================================
(function(){
  var baseDev = {id:'d1', name:'Laptop', updatedAt:100};
  var localDev = {id:'d1', name:'L-Edit', updatedAt:200};
  var remoteDev = {id:'d1', name:'R-Edit', updatedAt:200}; // same updatedAt

  var fwd = Q.merge(mk({devices:[baseDev]}), mk({devices:[localDev]}),
                     mk({devices:[remoteDev]}), TS_R, TS_L, 'devA', 'devB');
  var rev = Q.merge(mk({devices:[baseDev]}), mk({devices:[remoteDev]}),
                     mk({devices:[localDev]}), TS_L, TS_R, 'devB', 'devA');

  var fwdDev = (fwd.devices || []).find(function(d){ return d.id === 'd1'; });
  var revDev = (rev.devices || []).find(function(d){ return d.id === 'd1'; });

  // devB > devA → higher deviceId wins → 'R-Edit' wins on both sides.
  assert('devices: deviceId tiebreak makes merge(b,L,R) === merge(b,R,L)',
    fwdDev && revDev && fwdDev.name === revDev.name);
  assert('devices: winner is "R-Edit" (devB > devA)',
    fwdDev && fwdDev.name === 'R-Edit' && revDev && revDev.name === 'R-Edit');
})();

// ---- summary ----
console.log('\n--- convergence.test.js summary ---');
if (failures) {
  console.error(failures + ' assertion(s) FAILED unexpectedly');
  process.exit(1);
}
console.log('convergence.test.js: all assertions passed');
process.exit(0);
