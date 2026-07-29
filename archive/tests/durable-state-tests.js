// archive/tests/durable-state-tests.js — run: node archive/tests/durable-state-tests.js
// Unit tests for Phase A + C (2026-07-11 persistence-loss fix): the durable
// IndexedDB mirror of S, the newer-wins reconciliation, and the boot-ordering
// guarantee that gates syncInit() behind it.
// Design: .omo/plans/2026-07-11-persistence-loss-fix-plan.md §2, §4.
//
// PATTERN NOTE (same spirit as archive/tests/cron-merge-tests.js's C12 note):
// app.js as a whole cannot be loaded into a vm sandbox -- it synchronously
// touches the DOM, registers dozens of listeners, and calls syncInit() at
// parse time. Per project convention (see tests/reminders.test.js), the
// relevant functions are extracted from app.js by BEGIN/END marker comments
// and evaluated with mocked globals (S, localStorage, a fake IndexedDB, etc).
// This tests the real shipped save()/_idbWriteState()/_idbReadState()/
// reconcileDurableState() source, not a reimplementation.
const fs = require('fs'), path = require('path');

const appCode = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const durableMatch = appCode.match(/\/\* BEGIN_DURABLE_STATE_HELPERS \*\/([\s\S]*?)\/\* END_DURABLE_STATE_HELPERS \*\//);
if(!durableMatch){ console.error('FAIL: could not find BEGIN/END_DURABLE_STATE_HELPERS block in app.js'); process.exit(1); }

const syncCode = fs.readFileSync(path.join(__dirname, '..', '..', 'sync.js'), 'utf8');
const bootMatch = syncCode.match(/\/\* BEGIN_BOOT_GATE \*\/([\s\S]*?)\/\* END_BOOT_GATE \*\//);
if(!bootMatch){ console.error('FAIL: could not find BEGIN/END_BOOT_GATE block in sync.js'); process.exit(1); }

let fails = 0;
function assert(name, cond){
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if(!cond) fails++;
}

// ---- fake IndexedDB: an in-memory Map-backed "state" store, async via
// setTimeout so it exercises the real Promise-chaining code, not a
// synchronous shortcut. ---------------------------------------------------
function makeFakeIdbOpen(store, opts){
  opts = opts || {};
  return function fakeIdbOpen(){
    return Promise.resolve({
      transaction(name){
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        tx.objectStore = function(){
          return {
            put(val, key){
              setTimeout(function(){
                if(opts.writeShouldFail){ tx.error = new Error('fake write fail'); if(tx.onerror) tx.onerror(); return; }
                store.set(key, val);
                if(tx.oncomplete) tx.oncomplete();
              }, 0);
            },
            get(key){
              const req = { result: undefined, onsuccess: null, onerror: null };
              setTimeout(function(){
                req.result = store.has(key) ? store.get(key) : undefined;
                if(req.onsuccess) req.onsuccess();
              }, 0);
              return req;
            }
          };
        };
        return tx;
      }
    });
  };
}

// Evaluate the extracted helper block with injected mocks. Returns an object
// exposing save/_idbWriteState/_idbReadState/reconcileDurableState plus a
// getter for the live (possibly reassigned by reconcileDurableState) S.
function loadDurableHelpers(mocks){
  const body =
    'let S = globals.S;\n' +
    'let IS_DIRTY = false;\n' +
    'const STORE_KEY = globals.STORE_KEY;\n' +
    'const localStorage = globals.localStorage;\n' +
    'const idbOpen = globals.idbOpen;\n' +
    'const migrate = globals.migrate;\n' +
    'const render = globals.render;\n' +
    'const logEvent = globals.logEvent;\n' +
    'const syncIsApplying = globals.syncIsApplying;\n' +
    'const scheduleSync = globals.scheduleSync;\n' +
    'const now = globals.now || Date.now;\n' +
    'let _prevCharSig = null;\n' +
    'function _charSig(c){ if(!c) return \"\"; var o={}; for(var k in c){ if(k!==\"updatedAt\") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return \"\"; } }\n' +
    durableMatch[1] + '\n' +
    'return { save, _idbWriteState, _idbReadState, reconcileDurableState, getS: () => S };';
  const fn = new Function('globals', body);
  return fn(mocks);
}

function makeLocalStorage(){
  return { _m: {}, getItem(k){ return this._m[k] !== undefined ? this._m[k] : null; }, setItem(k, v){ this._m[k] = String(v); }, removeItem(k){ delete this._m[k]; } };
}

(async function(){

  // ---- T1: save() stamps a monotonically increasing __seq + __savedAt, and
  // writes both localStorage and the IDB mirror. ----------------------------
  {
    const store = new Map();
    const ls = makeLocalStorage();
    const S0 = { tasks: [], char: {} };
    const helpers = loadDurableHelpers({
      S: S0, STORE_KEY: 'questa.save.v1', localStorage: ls,
      idbOpen: makeFakeIdbOpen(store), migrate: x => x, render: () => {}, logEvent: () => {}
    });
    helpers.save();
    const seq1 = helpers.getS().__seq;
    const savedAt1 = helpers.getS().__savedAt;
    helpers.save();
    const seq2 = helpers.getS().__seq;
    assert('T1a save() stamps __seq starting at 1', seq1 === 1);
    assert('T1b save() increments __seq monotonically', seq2 === 2);
    assert('T1c save() stamps a __savedAt timestamp', typeof savedAt1 === 'number' && savedAt1 > 0);
    assert('T1d save() writes localStorage', JSON.parse(ls.getItem('questa.save.v1')).__seq === 2);
    await new Promise(r => setTimeout(r, 5));
    assert('T1e save() mirrors into the IDB "state" store', store.has('S') && JSON.parse(store.get('S')).__seq === 2);
  }

  // ---- T2: reconcileDurableState() prefers the IDB copy when its __seq is
  // newer than the live (reverted) localStorage-booted S. -------------------
  {
    const store = new Map();
    store.set('S', JSON.stringify({ tasks: [{ id: 't1', title: 'New task (in IDB)' }], char: {}, __seq: 5, __savedAt: 9000 }));
    let rendered = 0;
    const liveS = { tasks: [], char: {}, __seq: 2, __savedAt: 1000 }; // reverted-old localStorage boot
    const helpers = loadDurableHelpers({
      S: liveS, STORE_KEY: 'questa.save.v1', localStorage: makeLocalStorage(),
      idbOpen: makeFakeIdbOpen(store), migrate: x => x, render: () => { rendered++; }, logEvent: () => {}
    });
    await helpers.reconcileDurableState();
    const finalS = helpers.getS();
    assert('T2a IDB copy (newer __seq) wins over reverted localStorage', finalS.tasks.length === 1 && finalS.tasks[0].id === 't1');
    assert('T2b reconcileDurableState() triggers a re-render when IDB wins', rendered === 1);
  }

  // ---- T3: reconcileDurableState() leaves S alone when IDB is missing. -----
  {
    const store = new Map(); // empty
    const liveS = { tasks: [{ id: 'keep' }], char: {}, __seq: 3, __savedAt: 5000 };
    let rendered = 0;
    const helpers = loadDurableHelpers({
      S: liveS, STORE_KEY: 'questa.save.v1', localStorage: makeLocalStorage(),
      idbOpen: makeFakeIdbOpen(store), migrate: x => x, render: () => { rendered++; }, logEvent: () => {}
    });
    await helpers.reconcileDurableState();
    assert('T3 no IDB copy -> S unchanged, no re-render', helpers.getS().tasks[0].id === 'keep' && rendered === 0);
  }

  // ---- T4: reconcileDurableState() leaves S alone when IDB copy is OLDER
  // than the live one (the ordinary case -- most launches). ------------------
  {
    const store = new Map();
    store.set('S', JSON.stringify({ tasks: [{ id: 'stale-idb' }], char: {}, __seq: 1, __savedAt: 100 }));
    const liveS = { tasks: [{ id: 'fresh-local' }], char: {}, __seq: 4, __savedAt: 9999 };
    let rendered = 0;
    const helpers = loadDurableHelpers({
      S: liveS, STORE_KEY: 'questa.save.v1', localStorage: makeLocalStorage(),
      idbOpen: makeFakeIdbOpen(store), migrate: x => x, render: () => { rendered++; }, logEvent: () => {}
    });
    await helpers.reconcileDurableState();
    assert('T4 older IDB copy does not overwrite newer live/localStorage S', helpers.getS().tasks[0].id === 'fresh-local' && rendered === 0);
  }

  // ---- T5: identical __seq is a cheap no-op (localStorage/live wins, no
  // re-render) -- guards against off-by-one flapping on every boot. ---------
  {
    const store = new Map();
    store.set('S', JSON.stringify({ tasks: [{ id: 'idb-copy' }], char: {}, __seq: 7, __savedAt: 100 }));
    const liveS = { tasks: [{ id: 'live-copy' }], char: {}, __seq: 7, __savedAt: 100 };
    let rendered = 0;
    const helpers = loadDurableHelpers({
      S: liveS, STORE_KEY: 'questa.save.v1', localStorage: makeLocalStorage(),
      idbOpen: makeFakeIdbOpen(store), migrate: x => x, render: () => { rendered++; }, logEvent: () => {}
    });
    await helpers.reconcileDurableState();
    assert('T5 equal __seq -> no-op, live/localStorage copy kept', helpers.getS().tasks[0].id === 'live-copy' && rendered === 0);
  }

  // ---- T6: a broken/unavailable IDB (idbOpen rejects) never throws out of
  // reconcileDurableState() -- boot must proceed regardless. -----------------
  {
    const liveS = { tasks: [{ id: 'keep' }], char: {}, __seq: 1, __savedAt: 100 };
    const helpers = loadDurableHelpers({
      S: liveS, STORE_KEY: 'questa.save.v1', localStorage: makeLocalStorage(),
      idbOpen: () => Promise.reject(new Error('IndexedDB unavailable')),
      migrate: x => x, render: () => {}, logEvent: () => {}
    });
    let threw = false;
    try{ await helpers.reconcileDurableState(); }catch(e){ threw = true; }
    assert('T6 IDB failure is swallowed, does not reject/throw', !threw);
  }

  // ---- T7 (boot ordering): the actual gating snippet from sync.js's tail
  // must call reconcileDurableState() and wait for it before syncInit() runs
  // when reconcileDurableState is available. ---------------------------------
  {
    const order = [];
    const globalsObj = {
      reconcileDurableState: () => new Promise(resolve => setTimeout(() => { order.push('reconcile'); resolve(); }, 5)),
      syncInit: () => { order.push('syncInit'); }
    };
    const fn = new Function('globals', 'const reconcileDurableState = globals.reconcileDurableState; const syncInit = globals.syncInit;\n' + bootMatch[1] + '\nreturn true;');
    fn(globalsObj);
    await new Promise(r => setTimeout(r, 20));
    assert('T7a boot gate calls reconcileDurableState before syncInit', order[0] === 'reconcile' && order[1] === 'syncInit');
  }

  // ---- T8 (boot ordering, fallback): when reconcileDurableState is not
  // defined, syncInit() still runs (back-compat, never silently stop syncing).
  {
    const order = [];
    const globalsObj = { syncInit: () => { order.push('syncInit'); } };
    const fn = new Function('globals', 'const syncInit = globals.syncInit;\n' + bootMatch[1] + '\nreturn true;');
    fn(globalsObj);
    assert('T8 boot gate falls back to plain syncInit() when reconcileDurableState is unavailable', order[0] === 'syncInit');
  }

  // ---- T9 (boot ordering, resilience): if reconcileDurableState() itself
  // rejects, syncInit() must still run (a broken reconcile can't strand sync).
  {
    const order = [];
    const globalsObj = {
      reconcileDurableState: () => new Promise((_, reject) => setTimeout(() => { order.push('reconcile-failed'); reject(new Error('boom')); }, 5)),
      syncInit: () => { order.push('syncInit'); }
    };
    const fn = new Function('globals', 'const reconcileDurableState = globals.reconcileDurableState; const syncInit = globals.syncInit;\n' + bootMatch[1] + '\nreturn true;');
    fn(globalsObj);
    await new Promise(r => setTimeout(r, 20));
    assert('T9 a rejecting reconcileDurableState still lets syncInit() run', order[0] === 'reconcile-failed' && order[1] === 'syncInit');
  }

  console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
