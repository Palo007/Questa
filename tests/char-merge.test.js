// char-merge.test.js -- 2026-07-12 fresh-sync char fix (F5) + updatedAt merge (F6).
// C1-C5: F5 untouched-guard (fresh-sync clobber fix).
// C6-C8: F6 both-changed branch (strictly-newer remote wins, deviceId tiebreak).
const fs=require('fs'), path=require('path'), vm=require('vm');
let src=fs.readFileSync(path.join(__dirname,'../sync.js'),'utf8');
src=src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//,'/* stripped */');
const noop=function(){};
const sandbox={window:{},navigator:{onLine:true},
  document:{addEventListener:noop,getElementById:function(){return null;},
    createElement:function(){return {style:{},appendChild:noop,setAttribute:noop,click:noop};},
    body:{appendChild:noop,removeChild:noop}},
  localStorage:{getItem:function(){return null;},setItem:noop,removeItem:noop,key:function(){return null;},length:0},
  indexedDB:{open:function(){return {};}},
  setTimeout:function(){return 0;},clearTimeout:noop,setInterval:function(){return 0;},clearInterval:noop,
  console:console,JSON:JSON,Math:Math,Date:Date,Map:Map,Set:Set,WeakSet:WeakSet,
  Array:Array,Object:Object,Number:Number,String:String,Boolean:Boolean,Promise:Promise,
  logEvent:noop,toast:noop,render:noop,esc:function(x){return x;},save:noop,
  uid:function(){return 'x';},idbOpen:function(){return Promise.resolve(null);}};
sandbox.self=sandbox.window;sandbox.globalThis=sandbox;
vm.createContext(sandbox);
try{vm.runInContext(src,sandbox);}catch(e){}
const Q=sandbox.window.QuestaSync;
if(!Q||typeof Q.merge!=='function'){console.error('FAIL: QuestaSync.merge not found');process.exit(1);}
let failures=0;
function assert(d,c){if(c)console.log('[PASS] '+d);else{console.error('[FAIL] '+d);failures++;}}
function sub(char){return {tasks:[],rewards:[],tags:[],devices:[],an:{views:[],metrics:[]},
  history:[],charHistory:[],monthlyBackups:[],lastCron:0,char:char||{},deletions:[]};}
const REAL={name:'Pali',face:'W',cls:'Warrior',lvl:14,xp:8300,hp:120,maxHp:120,mp:0,gold:540,updatedAt:5000};
const FRESH={name:'Adventurer',face:'W',cls:'Warrior',lvl:1,xp:0,hp:50,maxHp:50,mp:0,gold:0};
// C1 -- THE BUG: fresh browser, empty base, local default, remote real.
(function(){
  const m=Q.merge(sub({}), sub(FRESH), sub(REAL), 5000, null);
  assert('C1 fresh/reset local yields to real remote char (lvl 14 not 1)', m.char.lvl===14 && m.char.xp===8300 && m.char.gold===540);
})();
// C2 -- symmetric: real local must NOT be clobbered by a default remote.
(function(){
  const m=Q.merge(sub({}), sub(REAL), sub(FRESH), 5000, null);
  assert('C2 real local survives a default remote', m.char.lvl===14 && m.char.gold===540);
})();
// C3 -- two REAL chars, both changed vs empty base: local wins (F2 rule preserved).
(function(){
  const localReal=Object.assign({},REAL,{lvl:14});
  const remoteReal=Object.assign({},REAL,{lvl:20,xp:1,gold:1});
  const m=Q.merge(sub({}), sub(localReal), sub(remoteReal), 5000, null);
  assert('C3 both-real both-changed -> local wins (F2 preserved)', m.char.lvl===14);
})();
// C4 -- died character (lvl1,xp0, gold>0, maxHp>50) is NOT "untouched": treated as real.
(function(){
  const died={name:'Pali',face:'W',cls:'Warrior',lvl:1,xp:0,hp:200,maxHp:200,mp:0,gold:405};
  const m=Q.merge(sub({}), sub(died), sub(FRESH), 5000, null);
  assert('C4 died-but-real local (gold/maxHp retained) not overwritten by fresh remote', m.char.gold===405 && m.char.maxHp===200);
})();
// C5 -- unchanged behavior: identical base/local/remote returns the real char.
(function(){
  const m=Q.merge(sub(REAL), sub(REAL), sub(REAL), 5000, null);
  assert('C5 no-change three-way returns the real char', m.char.lvl===14);
})();
// C6 -- both real & changed, remote strictly newer updatedAt -> remote wins (F6).
(function(){
  const localReal = Object.assign({}, REAL, {lvl:14, updatedAt:5000});
  const remoteReal = Object.assign({}, REAL, {lvl:20, updatedAt:9000});
  const m = Q.merge(sub({}), sub(localReal), sub(remoteReal), 5000, null);
  assert('C6 both-real -> strictly-newer remote wins (F6)', m.char.lvl === 20);
})();
// C7 -- updatedAt tie keeps local (anti-skew bias preserved).
(function(){
  const localReal = Object.assign({}, REAL, {lvl:14, updatedAt:5000});
  const remoteReal = Object.assign({}, REAL, {lvl:20, updatedAt:5000});
  const m = Q.merge(sub({}), sub(localReal), sub(remoteReal), 5000, null);
  assert('C7 both-real updatedAt tie -> local wins', m.char.lvl === 14);
})();
// C8 -- commutativity: merge(A,B) and merge(B,A) pick the SAME winner (deterministic deviceId tiebreak).
(function(){
  const a = Object.assign({}, REAL, {lvl:14, updatedAt:5000, name:'A'});
  const b = Object.assign({}, REAL, {lvl:20, updatedAt:9000, name:'B'});
  const fwd = Q.merge(sub({}), sub(a), sub(b), 9000, 5000, 'devA', 'devB');
  const rev = Q.merge(sub({}), sub(b), sub(a), 5000, 9000, 'devB', 'devA');
  assert('C8 commutativity: merge(A,B) and merge(B,A) same winner', fwd.char.name === rev.char.name);
})();
if(failures){console.error(failures+' char-merge assertion(s) FAILED');process.exit(1);}
console.log('char-merge.test.js: all assertions passed');
