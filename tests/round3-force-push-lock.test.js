// round3-force-push-lock.test.js
// The loose end left by round-1 finding 8: syncEventsForcePush() reached Dropbox
// with NO Web Lock, and confirmEventsForcePush() dropped the promise it returned.
//
// Round-2 item 2 set the rule -- "route every remote-mutating round through
// _withSyncLock" -- and closed syncForcePush / syncForcePull. This sibling was
// missed, so a force push of the event log from tab A could run fully concurrently
// with tab B's ordinary sync, whose conflict retry then re-merges and re-uploads
// the very records the force push was invoked to settle. syncEventsRepublishPush()
// took the lock when it was added on 2026-09-19; this one did not.
//
// Second half: the dialog called `syncEventsForcePush();` bare. The returned
// promise was dropped, so a rejection was an unhandled rejection and the user sat
// on "Re-uploading events to Dropbox..." with no further word either way. This is
// the button the shrink-block toast tells people to press, so silence reads as
// success.
//
// tests/force-push-events-button.test.js already proves the Settings button exists,
// is hidden when disconnected, and reaches syncEventsPush with
// {force:true, forceFullPush:true}. It says nothing about the lock or the outcome.
//
// Red gate: `git stash push -- sync.js` and run this file.
//
// Run: node tests/round3-force-push-lock.test.js  (also run by tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

function makeCtx(opts){
  opts = opts || {};
  const store = {};
  const toasts = [];
  const locks = [];       // every navigator.locks.request name, in order
  const pushOpts = [];    // every syncEventsPush(opts) argument
  const order = [];       // interleaving proof: 'lock', 'push-start', 'push-end'
  const noop = function(){};
  const sandbox = {
    window: {}, navigator: {
      onLine: true,
      locks: {
        request: function(name, o, run){
          locks.push(String(name));
          order.push('lock:' + name);
          return Promise.resolve().then(run);
        }
      }
    },
    document: { addEventListener: noop, getElementById: function(){ return null; },
      createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop } },
    localStorage: {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function(k, v){ store[k] = String(v); },
      removeItem: function(k){ delete store[k]; },
      key: function(){ return null; }, length: 0
    },
    history: { replaceState: noop },
    location: { search: '', origin: 'https://test.example', pathname: '/', href: '' },
    crypto: { getRandomValues: function(a){ for(let i=0;i<a.length;i++) a[i] = i % 256; return a; },
      subtle: { digest: async function(){ return new ArrayBuffer(32); } } },
    indexedDB: { open: function(){ return {}; } },
    setTimeout: function(){ return 0; }, clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    isNaN: isNaN, URLSearchParams: URLSearchParams, TextEncoder: TextEncoder, Buffer: Buffer,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, fetch: null,
    logEvent: noop, render: noop, esc: function(x){ return x; }, save: noop,
    uid: function(){ return 'dev-me'; },
    idbOpen: function(){ return Promise.resolve(null); },
    toast: function(m){ toasts.push(String(m)); },
    confirmDialog: function(){ return Promise.resolve(opts.confirm !== false); }
  };
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: [], prefs: {}
  };
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch(e){ /* registry is assigned before the boot code */ }

  store[CFG] = JSON.stringify({
    enabled: true, appKey: 'k', refreshToken: 'rt', accessToken: 'at',
    accessExpiresAt: Date.now() + 3600000, lastRev: null, lastSyncAt: null, lastError: null,
    deviceId: 'dev-me', evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0,
    evtFullPushAt: 0, evtFileCounts: {}, evtPushBlocked: opts.blocked || {}
  });

  // Stub the BOUNDARY, as tests/force-push-events-button.test.js does: replace
  // syncEventsPush, leave syncEventsForcePush and confirmEventsForcePush real.
  sandbox.syncEventsPush = function(o){
    pushOpts.push(o || {});
    order.push('push-start');
    if(opts.pushRejects) return Promise.reject(new Error('dropbox exploded'));
    return Promise.resolve().then(function(){ order.push('push-end'); });
  };

  return { sandbox: sandbox, store: store, toasts: toasts, locks: locks, pushOpts: pushOpts, order: order };
}
function lastToast(t){ return t.length ? t[t.length - 1] : ''; }

async function main(){
  // =====================================================================
  // F1 -- the lock. syncEventsForcePush must run its push inside the shared
  // questa-sync Web Lock, and must still carry both flags.
  // =====================================================================
  {
    const c = makeCtx();
    await c.sandbox.syncEventsForcePush();
    assert('F1a the push runs inside the shared questa-sync Web Lock',
      c.locks.indexOf('questa-sync') !== -1);
    assertEq('F1b exactly one push happened', c.pushOpts.length, 1);
    assert('F1c ...still with force:true (the shrink-guard override this path needs)',
      c.pushOpts[0].force === true);
    assert('F1d ...and forceFullPush:true', c.pushOpts[0].forceFullPush === true);
    assertEq('F1e the lock is taken BEFORE the push starts, not around nothing',
      c.order[0], 'lock:questa-sync');
    assert('F1f ...and the push both starts and finishes within it',
      c.order.indexOf('push-start') > 0 && c.order.indexOf('push-end') > c.order.indexOf('push-start'));
  }

  // =====================================================================
  // F2 -- no lock available (an older browser). _withSyncLock's fallback must
  // still run the push rather than silently skipping it.
  // =====================================================================
  {
    const c = makeCtx();
    delete c.sandbox.navigator.locks;
    await c.sandbox.syncEventsForcePush();
    assertEq('F2 without navigator.locks the push still runs', c.pushOpts.length, 1);
  }

  // =====================================================================
  // F3 -- the dialog path, success. The promise must be returned (so it can be
  // awaited at all) and the user must be told it finished.
  // =====================================================================
  {
    const c = makeCtx();
    const ret = c.sandbox.confirmEventsForcePush();
    assert('F3a confirmEventsForcePush returns a promise for the whole round',
      !!ret && typeof ret.then === 'function');
    await ret;
    assertEq('F3b the push happened', c.pushOpts.length, 1);
    assert('F3c ...under the lock', c.locks.indexOf('questa-sync') !== -1);
    assert('F3d ...and the final toast confirms completion, not just the attempt',
      /re-uploaded to Dropbox/i.test(lastToast(c.toasts)));
  }

  // =====================================================================
  // F4 -- the dialog path, failure. Before this the promise was dropped, so a
  // rejection was an UNHANDLED rejection and the user was left on the
  // "Re-uploading..." toast with no word either way.
  // =====================================================================
  {
    const c = makeCtx({ pushRejects: true });
    // The literal defect: a dropped rejected promise. Node reports it on the
    // microtask checkpoint where it still has no handler, so two macrotask hops
    // after the call is enough to see it deterministically.
    const unhandled = [];
    const onUnhandled = function(r){ unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    let threw = null;
    try { await c.sandbox.confirmEventsForcePush(); } catch(e){ threw = e; }
    await new Promise(function(r){ setTimeout(r, 0); });
    await new Promise(function(r){ setTimeout(r, 0); });
    process.removeListener('unhandledRejection', onUnhandled);
    assertEq('F4-0 the rejection is handled, not dropped on the floor', unhandled.length, 0);
    assert('F4a a failing push does not reject out of confirmEventsForcePush', threw === null);
    assert('F4b ...the user is told it failed, with the reason',
      /failed/i.test(lastToast(c.toasts)) && /dropbox exploded/.test(lastToast(c.toasts)));
    assert('F4c ...the last toast is NOT the optimistic "Re-uploading" one',
      !/Re-uploading/i.test(lastToast(c.toasts)));
    const cfg = JSON.parse(c.store[CFG]);
    assert('F4d ...and the failure is recorded in lastError for Settings to show',
      typeof cfg.lastError === 'string' && /force push failed/i.test(cfg.lastError));
  }

  // =====================================================================
  // F5 -- declining the dialog touches nothing at all: no lock, no push, no toast
  // claiming an upload.
  // =====================================================================
  {
    const c = makeCtx({ confirm: false });
    await c.sandbox.confirmEventsForcePush();
    assertEq('F5a declining runs no push', c.pushOpts.length, 0);
    assertEq('F5b ...and takes no lock', c.locks.length, 0);
    assert('F5c ...and claims nothing was uploaded',
      !c.toasts.some(function(t){ return /re-uploaded/i.test(t); }));
  }

  console.log('\n--- round3-force-push-lock.test.js summary ---');
  if(failures){ console.error(failures + ' assertion(s) FAILED'); process.exit(1); }
  console.log('round3-force-push-lock.test.js: all assertions passed');
  process.exit(0);
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
