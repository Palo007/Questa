// reset-local.test.js -- #2 this-device-only reset: merge-layer assertions.
// Verifies that after a reset (empty local, no base), reconnecting pulls
// the world back — the empty local does not clobber remote data.
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

// Helper: build a full sub-state with given tasks and char
function sub(opts){
  return {
    tasks:    opts.tasks    || [],
    rewards:  opts.rewards  || [],
    tags:     opts.tags     || [],
    devices:  opts.devices  || [],
    an:       {views:[], metrics:[]},
    history:  [],
    charHistory: [],
    monthlyBackups: [],
    lastCron: opts.lastCron || 0,
    char:     opts.char     || {},
    deletions: opts.deletions || []
  };
}

// --- R1: empty base + fresh local + full remote → remote tasks kept ---
(function(){
  const fresh = sub({ tasks:[], char:{name:'Adventurer',face:'W',cls:'Warrior',lvl:1,xp:0,hp:50,maxHp:50,mp:0,gold:0} });
  const remote = sub({
    tasks:[
      {id:'t1',type:'habit',title:'Meditate',done:false,createdAt:1000,updatedAt:2000},
      {id:'t2',type:'daily',title:'Exercise',done:true,createdAt:1000,updatedAt:3000,doneAt:3000},
      {id:'t3',type:'todo',title:'Read book',done:false,createdAt:1000,updatedAt:2500}
    ],
    char:{name:'Pali',face:'W',cls:'Warrior',lvl:14,xp:8300,hp:120,maxHp:120,mp:0,gold:540,updatedAt:5000}
  });
  const m = Q.merge(sub({}), fresh, remote, 5000, null);
  assert('R1a empty-local yields remote tasks (3 tasks preserved)', m.tasks.length === 3);
  assert('R1b remote char wins over fresh default', m.char.lvl === 14 && m.char.gold === 540);
})();

// --- R2: cleared-base marker (null base) + fresh local + full remote → remote kept ---
// This is the post-reset scenario: syncBasePut(null) cleared the IDB base.
// The merge layer should still keep the remote.
(function(){
  const fresh = sub({ tasks:[], char:{name:'Adventurer',face:'W',cls:'Warrior',lvl:1,xp:0,hp:50,maxHp:50,mp:0,gold:0} });
  const remote = sub({
    tasks:[
      {id:'t1',type:'habit',title:'Meditate',done:false,createdAt:1000,updatedAt:2000},
      {id:'t4',type:'todo',title:'Write report',done:false,createdAt:1500,updatedAt:2800}
    ],
    char:{name:'Hero',face:'🧝',cls:'Wizard',lvl:7,xp:2100,hp:80,maxHp:80,mp:30,gold:120,updatedAt:4000}
  });
  const m = Q.merge(null, fresh, remote, 4000, null);
  assert('R2a null-base merge keeps remote tasks (2 tasks preserved)', m.tasks.length === 2);
  assert('R2b null-base merge keeps remote char', m.char.lvl === 7 && m.char.gold === 120);
})();

// --- R3: fresh local should NOT produce tombstones for remote entities ---
// After reset, local.tasks is empty. merge must not delete remote tasks.
(function(){
  const fresh = sub({ tasks:[], char:{name:'Adventurer',face:'W',cls:'Warrior',lvl:1,xp:0,hp:50,maxHp:50,mp:0,gold:0} });
  const remote = sub({
    tasks:[
      {id:'t1',type:'habit',title:'Meditate',done:false,createdAt:1000,updatedAt:2000},
      {id:'t2',type:'daily',title:'Exercise',done:false,createdAt:1000,updatedAt:2000}
    ],
    char:{name:'Pali',face:'W',cls:'Warrior',lvl:14,xp:8300,hp:120,maxHp:120,mp:0,gold:540,updatedAt:5000}
  });
  const m = Q.merge(sub({}), fresh, remote, 5000, null);
  const ids = m.tasks.map(t => t.id).sort();
  assert('R3 both remote task IDs preserved after empty-local merge', ids[0]==='t1' && ids[1]==='t2');
})();

// --- R4: re-merge is idempotent — running merge twice yields the same result ---
(function(){
  const fresh = sub({ tasks:[], char:{name:'Adventurer',face:'W',cls:'Warrior',lvl:1,xp:0,hp:50,maxHp:50,mp:0,gold:0} });
  const remote = sub({
    tasks:[
      {id:'t1',type:'habit',title:'Meditate',done:false,createdAt:1000,updatedAt:2000}
    ],
    char:{name:'Pali',face:'W',cls:'Warrior',lvl:14,xp:8300,hp:120,maxHp:120,mp:0,gold:540,updatedAt:5000}
  });
  const m1 = Q.merge(sub({}), fresh, remote, 5000, null);
  // Use m1 as the new "local" with the base being the result of the first merge
  const m2 = Q.merge(sub({}), m1, remote, 5000, null);
  assert('R4 re-merge is idempotent (same char lvl)', m2.char.lvl === 14);
  assert('R4 re-merge is idempotent (same task count)', m2.tasks.length === 1);
})();

if(failures){console.error(failures+' reset-local assertion(s) FAILED');process.exit(1);}
