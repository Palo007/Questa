// forcepull-events.test.js — W6.15: _syncForcePullAttempt() must also pull
// events, not just state.
//
// Context: `_syncForcePullAttempt` (called by syncForcePull(), the only
// intended caller besides confirmForcePull()'s user-confirmation gate) called
// syncApply(remote.state) and stopped there -- it never touched the event
// store. Same bug class as the clearAllEvents() gap just fixed on the
// restore/import paths: an operation the user believes reconciles everything
// in fact only reconciled state. The fix wires in `syncEventsPull({force:true})`
// (force added in the immediately preceding task, W6.13) after the state pull
// succeeds, guarded and failure-isolated so it can never fail or roll back the
// state reconciliation that already happened.
//
// Covers:
//   T1  a force pull ingests remote event files (core assertion)
//   T2  it passes {force:true} -- a cached rev + inside-throttle-window
//       timestamp do NOT prevent ingestion (both bypasses exercised at once)
//   T3  an event-pull failure does not fail the state force-pull (state still
//       applied, cfg.lastError stays null, failure is diagnosed instead)
//   T4  a missing syncEventsPull global degrades gracefully with no throw
//       (state force-pull still completes; no event-side call is attempted)
//   T5  normal (non-force) sync behavior is unchanged -- a direct
//       eventsPull() call (the existing syncEventsSync() call site) still
//       honors the throttle/rev-cache exactly as before this change
//
// Run: node tests/forcepull-events.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';
const MY_DEV = 'dev-me';

function monthKeyFor(d){
  return String(d.getUTCFullYear()).padStart(4, '0') + String(d.getUTCMonth() + 1).padStart(2, '0');
}
const CUR_MONTH = monthKeyFor(new Date());

// Same harness shape as tests/evtpull-selfhealing.test.js (closest prior art)
// -- a fresh evaluated sync.js instance per test so module-scoped state
// (_syncInFlight, the throttle-diag rate limiter) never bleeds between cases.
function makeCtx(opts){
  opts = opts || {};
  const store = {};
  const noop = function(){};
  const calls = { dbxListFolder: 0, dbxDownloadRaw: 0, dbxDownload: 0, getEvents: 0 };

  const diagEntries = [];
  const sandbox = {
    window: {},
    navigator: { onLine: true },
    document: {
      addEventListener: noop,
      getElementById: function(){ return null; },
      createElement: function(){ return { style: {}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop }
    },
    localStorage: {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function(k, v){ store[k] = String(v); },
      removeItem: function(k){ delete store[k]; },
      key: function(){ return null; }, length: 0
    },
    history: { replaceState: noop },
    location: { search: '', origin: 'https://test.example', pathname: '/', href: '' },
    crypto: {
      getRandomValues: function(arr){ for(let i = 0; i < arr.length; i++) arr[i] = i % 256; return arr; },
      subtle: { digest: async function(){ return new ArrayBuffer(32); } }
    },
    setTimeout: function(){ return 0; },
    clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    isNaN: isNaN,
    URLSearchParams: URLSearchParams, TextEncoder: TextEncoder, Buffer: Buffer,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer,
    fetch: null,
    logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return MY_DEV; },
    idbOpen: function(){ return Promise.resolve(null); }
  };

  sandbox.getEvents = Object.prototype.hasOwnProperty.call(opts, 'getEvents')
    ? opts.getEvents
    : function(){ calls.getEvents++; return Promise.resolve([]); };

  sandbox.window.__qDiag = { errors: diagEntries };
  sandbox._qDiagPush = function(kind, data){
    try{
      sandbox.window.__qDiag.errors.push(Object.assign({ t: Date.now(), kind: kind }, data));
      if(sandbox.window.__qDiag.errors.length > 50) sandbox.window.__qDiag.errors.shift();
    }catch(e){}
  };

  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [{ id: 'local-only', title: 'stale local task' }],
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }

  // seed sync cfg -- enabled + a refreshToken so syncForcePull()'s guards pass.
  store[CFG] = JSON.stringify(Object.assign({
    enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'at',
    accessExpiresAt: Date.now() + 3600000, lastRev: null, lastSyncAt: null, lastError: null,
    deviceId: MY_DEV, evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0,
    evtFullScanAt: Date.now(), evtBadRevs: {}
  }, opts.cfg || {}));

  // dbxDownload(STATE_PATH) is overridden directly (bypassing fetch/syncToken
  // entirely) to hand back the remote state.json wrapper _syncForcePullAttempt
  // expects: { state, savedAt, deviceId, rev }.
  sandbox.dbxDownload = function(p){
    calls.dbxDownload++;
    if(opts.remoteThrows) return Promise.reject(new Error(opts.remoteThrows));
    if(Object.prototype.hasOwnProperty.call(opts, 'remote')) return Promise.resolve(opts.remote);
    return Promise.resolve({ state: { tasks: [{ id: 'remote-task', title: 'from dropbox' }] }, savedAt: Date.now(), deviceId: 'dev-other', rev: 'state-rev-1' });
  };

  sandbox.dbxListFolder = function(){
    calls.dbxListFolder++;
    if(opts.listThrows) return Promise.reject(new Error(opts.listThrows));
    return Promise.resolve(opts.entries || []);
  };
  sandbox.dbxDownloadRaw = function(p){
    calls.dbxDownloadRaw++;
    const name = String(p).split('/').pop();
    const dl = (opts.downloads && Object.prototype.hasOwnProperty.call(opts.downloads, name)) ? opts.downloads[name] : null;
    return Promise.resolve(dl);
  };

  // syncBasePut / evtInsertNew both go through idbOpen -- a working IDB stub
  // is needed any time the state or event pull is expected to actually commit.
  sandbox.EVENTS_STORE = 'events';
  sandbox.idbOpen = function(){
    return Promise.resolve({
      transaction: function(){
        const tx = {};
        tx.objectStore = function(){
          return {
            add: function(){ /* accepted */ },
            get: function(){ return { onsuccess: null, onerror: null }; },
            put: function(){ /* accepted */ }
          };
        };
        Promise.resolve().then(function(){ if(tx.oncomplete) tx.oncomplete(); });
        return tx;
      }
    });
  };

  return { sandbox: sandbox, store: store, calls: calls, diag: diagEntries };
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

function cfgOf(ctx){ return JSON.parse(ctx.store[CFG]); }

async function main(){
  // T1: core assertion -- a force pull ingests remote event files, not just state.
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const records = [{ uid: 'u-t1', dev: 'dev-other', ts: Date.now() - 1000, kind: 'tap' }];
    const c = makeCtx({
      entries: [{ name: name, rev: 'r1' }],
      downloads: { [name]: { text: JSON.stringify(records), rev: 'r1' } }
    });
    await c.sandbox.window.QuestaSync.forcePull();
    assert('T1: state force-pull applied the remote state (S.tasks replaced)',
      c.sandbox.S.tasks.length === 1 && c.sandbox.S.tasks[0].id === 'remote-task');
    assert('T1: the event folder was listed as part of the force pull', c.calls.dbxListFolder === 1);
    assert('T1: the remote event file was downloaded and ingested', c.calls.dbxDownloadRaw === 1);
    const ok = c.diag.find(e => e.kind === 'evtPullOk' && e.name === name);
    assert('T1: the event file shows up as successfully pulled in diagnostics', !!ok);
  }

  // T2: {force:true} is actually what gets passed -- a cached rev AND a
  // within-throttle-window evtLastPullAt would both normally block a plain
  // eventsPull() call, but the force-pull path must bypass both at once.
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const records = [{ uid: 'u-t2', dev: 'dev-other', ts: Date.now() - 1000, kind: 'tap' }];
    const c = makeCtx({
      entries: [{ name: name, rev: 'same-rev' }],
      downloads: { [name]: { text: JSON.stringify(records), rev: 'same-rev' } },
      cfg: {
        evtFileRevs: { [name]: 'same-rev' },  // would short-circuit as revUnchanged without force
        evtLastPullAt: Date.now() - 1000      // well inside the 60s throttle window
      }
    });
    await c.sandbox.window.QuestaSync.forcePull();
    const throttleHit = c.diag.find(e => e.kind === 'evtPullSkip' && e.reason === 'throttled');
    assert('T2: {force:true} bypasses the 60s throttle (no throttled skip is emitted)', !throttleHit);
    const revHit = c.diag.find(e => e.kind === 'evtPullSkip' && e.name === name && e.reason === 'revUnchanged');
    assert('T2: {force:true} bypasses the rev cache (no revUnchanged skip is emitted)', !revHit);
    assert('T2: the file is downloaded despite the matching cached rev', c.calls.dbxDownloadRaw === 1);
    const ok = c.diag.find(e => e.kind === 'evtPullOk' && e.name === name);
    assert('T2: the forced pull still ingests the file', !!ok);
  }

  // T3: an event-pull failure must not fail or roll back the state force-pull.
  {
    const c = makeCtx({ listThrows: 'simulated Dropbox list failure' });
    await c.sandbox.window.QuestaSync.forcePull();
    assert('T3: the state force-pull still applied despite the event pull throwing',
      c.sandbox.S.tasks.length === 1 && c.sandbox.S.tasks[0].id === 'remote-task');
    const saved = cfgOf(c);
    assert('T3: cfg.lastError stays null -- the failure is NOT surfaced as a force-pull error', saved.lastError === null);
    assert('T3: cfg.lastRev was still stamped from the successful state pull', saved.lastRev === 'state-rev-1');
    const failDiag = c.diag.find(e => e.kind === 'forcePullEventsFailed');
    assert('T3: the event-pull failure is diagnosed via _qDiagPush instead of thrown', !!failDiag && /simulated Dropbox list failure/.test(failDiag.error));
  }

  // T4: a missing syncEventsPull global degrades gracefully -- no throw, and
  // the state force-pull still completes; no event-side Dropbox call is made.
  {
    const c = makeCtx({});
    c.sandbox.syncEventsPull = undefined; // simulate a missing/broken sync.js export
    let threw = null;
    try{ await c.sandbox.window.QuestaSync.forcePull(); }
    catch(e){ threw = e; }
    assert('T4: no throw when syncEventsPull is missing', threw === null);
    assert('T4: the state force-pull still applied', c.sandbox.S.tasks.length === 1 && c.sandbox.S.tasks[0].id === 'remote-task');
    const saved = cfgOf(c);
    assert('T4: cfg.lastError stays null', saved.lastError === null);
    assert('T4: no event-folder listing was attempted when syncEventsPull is unavailable', c.calls.dbxListFolder === 0);
  }

  // T5: normal (non-force) sync behavior is unchanged -- calling eventsPull()
  // directly (the existing syncEventsSync() call site) still honors the
  // throttle and rev cache exactly as before this change.
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const c = makeCtx({
      entries: [{ name: name, rev: 'same-rev' }],
      cfg: { evtFileRevs: { [name]: 'same-rev' } }
    });
    await c.sandbox.window.QuestaSync.eventsPull();
    assert('T5: a plain (non-force) pull still skips an unchanged rev (no download)', c.calls.dbxDownloadRaw === 0);
    const hit = c.diag.find(e => e.kind === 'evtPullSkip' && e.name === name && e.reason === 'revUnchanged');
    assert('T5: a plain (non-force) pull still diagnoses revUnchanged as before', !!hit);

    const c2 = makeCtx({ cfg: { evtLastPullAt: Date.now() - 1000 } });
    await c2.sandbox.window.QuestaSync.eventsPull();
    assert('T5: a plain (non-force) pull still honors the 60s throttle (no Dropbox call)', c2.calls.dbxListFolder === 0);
  }

  if(failures){ console.error('\n' + failures + ' forcepull-events assertion(s) FAILED'); process.exit(1); }
  console.log('\nforcepull-events.test.js: all assertions passed');
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
