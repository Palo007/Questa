// reset-events.test.js -- regression for the "Reset everything" event-log fix.
// Verifies syncEventsDeleteDevice() lists /events and deletes ONLY the matching
// device's files (and tolerates a 409 path/not_found), so a reset cannot leave
// stale event files in Dropbox to be re-pulled into the Activity Feed.
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');

// fetch mock: records delete_v2 paths; serves list_folder + token.
let deletes = [];
function makeFetch(deleteBehavior){
  return function(url, opts){
    const body = (opts && opts.body) ? (typeof opts.body === 'string' ? opts.body : '') : '';
    let parsed = {};
    try { parsed = JSON.parse(body); } catch(e){}
    if(String(url).indexOf('/files/list_folder') !== -1){
      return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ entries:[
        { name:'devX-202607.json', '.tag':'file' },
        { name:'devX-202608.json', '.tag':'file' },
        { name:'devY-202607.json', '.tag':'file' },
        { name:'state.json', '.tag':'file' },
        { name:'junk.txt', '.tag':'file' }
      ]}) });
    }
    if(String(url).indexOf('/files/delete_v2') !== -1){
      deletes.push(parsed.path);
      return deleteBehavior(url, parsed);
    }
    if(String(url).indexOf('/oauth2/token') !== -1){
      return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({ access_token:'tok' }) });
    }
    return Promise.resolve({ ok:false, status:404, json:()=>Promise.resolve({}) });
  };
}

const syncCfgJson = JSON.stringify({ refreshToken:'r', accessToken:'tok', accessExpiresAt: Date.now()+100000, enabled:true });
const ls = {};
const sandbox = {
  window:{}, navigator:{onLine:true},
  document:{ addEventListener:function(){}, getElementById:function(){return null;},
    createElement:function(){return {style:{},appendChild:function(){},setAttribute:function(){},click:function(){}};},
    body:{appendChild:function(){},removeChild:function(){}} },
  localStorage:{ getItem:function(k){ return (k === 'questa.sync.v1') ? syncCfgJson : (ls[k] || null); },
    setItem:function(k,v){ ls[k]=v; }, removeItem:function(k){ delete ls[k]; }, key:function(){return null;}, length:0 },
  indexedDB:{ open:function(){ return {}; } },
  fetch: makeFetch((url, parsed)=>Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({}) })),
  setTimeout:function(){return 0;}, clearTimeout:function(){}, setInterval:function(){return 0;}, clearInterval:function(){},
  console:console, JSON:JSON, Math:Math, Date:Date, Map:Map, Set:Set, WeakSet:WeakSet,
  Array:Array, Object:Object, Number:Number, String:String, Boolean:Boolean, Promise:Promise,
  logEvent:function(){}, toast:function(){}, render:function(){}, esc:function(x){return x;}, save:function(){}, uid:function(){return 'x';}
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try{ vm.runInContext(src, sandbox); }catch(e){ console.error('load error', e); process.exit(1); }
const Q = sandbox.window.QuestaSync;
if(!Q || typeof Q.eventsDeleteDevice !== 'function'){ console.error('FAIL: QuestaSync.eventsDeleteDevice not found'); process.exit(1); }

let failures = 0;
function assert(d,c){ if(c){ console.log('[PASS] '+d); } else { console.error('[FAIL] '+d); failures++; } }

(async () => {
  // --- Case 1: deletes only the matching device's /events files ---
  deletes = [];
  await Q.eventsDeleteDevice('devX');
  assert('deletes exactly devX /events files (2)', deletes.length === 2);
  assert('deletes /events/devX-202607.json', deletes.indexOf('/events/devX-202607.json') !== -1);
  assert('deletes /events/devX-202608.json', deletes.indexOf('/events/devX-202608.json') !== -1);
  assert('does NOT delete other device file', deletes.indexOf('/events/devY-202607.json') === -1);
  assert('does NOT delete state.json', deletes.indexOf('/events/state.json') === -1);
  assert('does NOT delete non-event junk', deletes.indexOf('/events/junk.txt') === -1);

  // --- Case 2: tolerates 409 path/not_found (already gone) without throwing ---
  deletes = [];
  sandbox.fetch = makeFetch((url, parsed)=>{
    return Promise.resolve({ ok:false, status:409, json:()=>Promise.resolve({ error_summary:'path/not_found/' }) });
  });
  await Q.eventsDeleteDevice('devA');
  assert('tolerates 409 path/not_found (no throw)', true);

  // --- Case 3: null devId is a safe no-op ---
  deletes = [];
  await Q.eventsDeleteDevice(null);
  assert('null devId is a no-op', deletes.length === 0);

  if(failures){ console.error(failures+' reset-events assertion(s) FAILED'); process.exit(1); }
  console.log('All reset-events tests passed!');
  process.exit(0);
})();
