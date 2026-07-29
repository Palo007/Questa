// force-push-on-connect.test.js — Option A: Dropbox "Connect & Force Push".
//
// Covers the intent-preserving connection flow added in the
// 2026-07-15 force-push-on-connect plan:
//   T1: connectForForcePush is exposed on window.QuestaSync
//   T2: confirmConnectForForcePush() stashes the pendingForcePush flag and
//       calls syncConnect(true) on confirmation
//   T3: a standard syncConnect() clears any stale pendingForcePush flag
//   T4: syncHandleRedirect() clears the flag on the no-code early return
//   T5: syncHandleRedirect() clears the flag on the no-verifier early return
//   T6: syncHandleRedirect() routes to syncForcePush (not syncNow) when the
//       flag is set, and to syncNow (not syncForcePush) when it is absent
//   T7: syncHandleRedirect() clears the flag when token exchange fails
//   T8: syncInit() clears a stale flag on a normal load, but MUST NOT drop it
//       on the OAuth redirect-back load (syncHandleRedirect must still see it)
//
// Run: node tests/force-push-on-connect.test.js   (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const FLAG = 'questa.sync.pendingForcePush';
const PKCE = 'questa.sync.pkce';
const CFG = 'questa.sync.v1';

// A fresh evaluated sync.js instance per call — critical for testing syncInit(),
// whose `let _syncInitDone` is a lexical binding that can't be reset from outside
// the module, so each syncInit scenario needs its own module instance.
function makeCtx(){
  const store = {};
  const toasts = [];
  let confirmResolve = null;
  const loc = { search: '', origin: 'https://test.example', pathname: '/', href: '' };
  const noop = function(){};

  const sandbox = {
    window: {},
    navigator: { onLine: true },
    document: {
      addEventListener: noop,
      getElementById: function(){ return null; },
      createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop }
    },
    localStorage: {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function(k, v){ store[k] = String(v); },
      removeItem: function(k){ delete store[k]; },
      key: function(){ return null; }, length: 0
    },
    history: { replaceState: noop },
    location: loc,
    crypto: {
      getRandomValues: function(arr){ for(let i=0;i<arr.length;i++) arr[i] = i % 256; return arr; },
      subtle: { digest: async function(){ return new ArrayBuffer(32); } }
    },
    setTimeout: function(){ return 0; }, // do NOT auto-fire: keeps the 2s boot timer inert
    clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    URLSearchParams: URLSearchParams, TextEncoder: TextEncoder, Buffer: Buffer,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer,
    fetch: null,
    logEvent: noop, toast: function(m){ toasts.push(m); }, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return 'test-device-1'; },
    idbOpen: function(){ return Promise.resolve(null); },
    confirmDialog: function(){ return new Promise(function(resolve){ confirmResolve = resolve; }); }
  };
  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [{ id: 't1', title: 'Task1', type: 'habit', updatedAt: 1000 }],
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  const ctx = {
    sandbox: sandbox, store: store, toasts: toasts, loc: loc,
    getConfirmResolve: function(){ return confirmResolve; },
    seedCfg: function(patch){
      store[CFG] = JSON.stringify(Object.assign({
        enabled: false, appKey: 'test-key', refreshToken: null, accessToken: null,
        accessExpiresAt: 0, lastRev: null, lastSyncAt: null, lastError: null,
        deviceId: 'test-device-1', evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0
      }, patch || {}));
    }
  };
  ctx.seedCfg();

  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }
  return ctx;
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function has(store, k){ return Object.prototype.hasOwnProperty.call(store, k); }
function tick(){ return new Promise(function(r){ setTimeout(r, 0); }); }

function fetchTokenOk(){
  return async function(url){
    if(url && url.indexOf('/oauth2/token') !== -1){
      return { ok: true, status: 200, json: async function(){
        return { access_token: 'at', refresh_token: 'rt', expires_in: 14400 };
      } };
    }
    return { ok: false, status: 404, json: async function(){ return {}; } };
  };
}
function fetchTokenFail(){
  return async function(url){
    if(url && url.indexOf('/oauth2/token') !== -1){
      return { ok: false, status: 400, json: async function(){
        return { error: 'invalid_grant', error_description: 'bad code' };
      } };
    }
    return { ok: false, status: 404, json: async function(){ return {}; } };
  };
}

async function main(){
  // Shared context for the non-syncInit tests.
  const c = makeCtx();
  const S = c.sandbox, store = c.store;
  const Q = S.window.QuestaSync;
  if(!Q){ console.error('FAIL: QuestaSync not found'); process.exit(1); }

  // ---------------------------------------------------------------
  // T1: connectForForcePush exposed on QuestaSync
  // ---------------------------------------------------------------
  assert('T1: QuestaSync.connectForForcePush is a function', typeof Q.connectForForcePush === 'function');

  // ---------------------------------------------------------------
  // T2: confirmConnectForForcePush() stashes flag + calls syncConnect(true)
  // ---------------------------------------------------------------
  delete store[FLAG];
  c.toasts.length = 0;
  const realSyncConnect = S.syncConnect;
  let connectArgs = null, connectCalls = 0;
  S.syncConnect = function(){ connectCalls++; connectArgs = Array.prototype.slice.call(arguments); return Promise.resolve(); };
  if(typeof S.confirmConnectForForcePush === 'function'){
    S.confirmConnectForForcePush();
    await tick();
    const r = c.getConfirmResolve(); if(r){ r(true); }
    await tick();
    assert('T2a: pendingForcePush flag stashed after confirm', store[FLAG] === 'true');
    assert('T2b: syncConnect called once', connectCalls === 1);
    assert('T2c: syncConnect called with keepPendingForcePush=true', connectArgs && connectArgs[0] === true);
  } else {
    assert('T2a: pendingForcePush flag stashed after confirm', false);
    assert('T2b: syncConnect called once', false);
    assert('T2c: syncConnect called with keepPendingForcePush=true', false);
  }
  S.syncConnect = realSyncConnect;

  // ---------------------------------------------------------------
  // T3: standard syncConnect() clears a stale pendingForcePush flag
  // ---------------------------------------------------------------
  store[FLAG] = 'true';
  c.loc.href = '';
  try { await S.syncConnect(); } catch(e){ /* redirect side effects are inert */ }
  assert('T3: standard syncConnect() clears stale pendingForcePush flag', !has(store, FLAG));

  // ---------------------------------------------------------------
  // T4: syncHandleRedirect() clears the flag on no-code early return
  // ---------------------------------------------------------------
  store[FLAG] = 'true';
  c.loc.search = '';
  delete store[PKCE];
  await S.syncHandleRedirect();
  assert('T4: no-code early return clears pendingForcePush flag', !has(store, FLAG));

  // ---------------------------------------------------------------
  // T5: syncHandleRedirect() clears the flag on no-verifier early return
  // ---------------------------------------------------------------
  store[FLAG] = 'true';
  c.loc.search = '?code=abc';
  delete store[PKCE];
  await S.syncHandleRedirect();
  assert('T5: no-verifier early return clears pendingForcePush flag', !has(store, FLAG));

  // ---------------------------------------------------------------
  // T6: routing — flag => syncForcePush; no flag => syncNow
  // ---------------------------------------------------------------
  let forcePushCalls = 0, nowCalls = 0;
  S.syncForcePush = function(){ forcePushCalls++; return Promise.resolve(); };
  S.syncNow = function(){ nowCalls++; return Promise.resolve(); };

  // T6a: with flag set
  c.seedCfg();
  store[FLAG] = 'true';
  store[PKCE] = JSON.stringify({ v: 'verifier', r: 'https://test.example/' });
  c.loc.search = '?code=abc';
  S.fetch = fetchTokenOk();
  forcePushCalls = 0; nowCalls = 0;
  await S.syncHandleRedirect();
  await tick();
  assert('T6a: flag set routes to syncForcePush', forcePushCalls === 1);
  assert('T6b: flag set does NOT call syncNow', nowCalls === 0);
  assert('T6c: flag consumed after force-push connect', !has(store, FLAG));

  // T6d: without flag
  c.seedCfg();
  delete store[FLAG];
  store[PKCE] = JSON.stringify({ v: 'verifier', r: 'https://test.example/' });
  c.loc.search = '?code=abc';
  S.fetch = fetchTokenOk();
  forcePushCalls = 0; nowCalls = 0;
  await S.syncHandleRedirect();
  await tick();
  assert('T6d: no flag routes to syncNow', nowCalls === 1);
  assert('T6e: no flag does NOT call syncForcePush', forcePushCalls === 0);

  // ---------------------------------------------------------------
  // T7: token-exchange failure clears the flag (no sticky state)
  // ---------------------------------------------------------------
  c.seedCfg();
  store[FLAG] = 'true';
  store[PKCE] = JSON.stringify({ v: 'verifier', r: 'https://test.example/' });
  c.loc.search = '?code=abc';
  S.fetch = fetchTokenFail();
  await S.syncHandleRedirect();
  await tick();
  assert('T7a: failed token exchange clears pendingForcePush flag', !has(store, FLAG));
  const cfgAfterFail = JSON.parse(store[CFG] || '{}');
  assert('T7b: failed token exchange records lastError', !!cfgAfterFail.lastError);

  // ---------------------------------------------------------------
  // T8a: syncInit() clears a stale flag on a NORMAL page load (no ?code=)
  // (fresh context: syncInit runs its body exactly once per module instance)
  // ---------------------------------------------------------------
  {
    const c2 = makeCtx();
    c2.store[FLAG] = 'true';
    c2.loc.search = '';
    try { c2.sandbox.syncInit(); } catch(e){ /* best-effort boot side effects */ }
    await tick();
    assert('T8a: syncInit() clears stale pendingForcePush flag on normal load', !has(c2.store, FLAG));
  }

  // ---------------------------------------------------------------
  // T8b: syncInit() must NOT drop the flag on the OAuth redirect-back load —
  // it runs syncHandleRedirect() on the SAME load, which must still see the
  // flag and force-push instead of merging. Regression guard for the
  // "clear the flag too early in syncInit" ordering bug.
  // ---------------------------------------------------------------
  {
    const c3 = makeCtx();
    let fp = 0, nw = 0;
    c3.sandbox.syncForcePush = function(){ fp++; return Promise.resolve(); };
    c3.sandbox.syncNow = function(){ nw++; return Promise.resolve(); };
    c3.seedCfg();
    c3.store[FLAG] = 'true';
    c3.store[PKCE] = JSON.stringify({ v: 'verifier', r: 'https://test.example/' });
    c3.loc.search = '?code=abc';
    c3.sandbox.fetch = fetchTokenOk();
    try { c3.sandbox.syncInit(); } catch(e){ /* best-effort boot side effects */ }
    await tick(); await tick();
    assert('T8b: syncInit() on redirect still routes to syncForcePush', fp === 1);
    assert('T8c: syncInit() on redirect does NOT merge via syncNow', nw === 0);
    assert('T8d: syncInit() on redirect consumes the flag', !has(c3.store, FLAG));
  }

  if(failures){ console.error('\n' + failures + ' force-push-on-connect assertion(s) FAILED'); process.exit(1); }
  console.log('\nforce-push-on-connect.test.js: all assertions passed');
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
