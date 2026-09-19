// round3-republish-push.test.js
// Round-1 REVIEW-2026-09-18.md Part 2 finding 8, both halves.
//
// (a) republishImportedEvents() flagged the records and stopped. It set
//     `republish: true`, toasted "Republished N imported events", and triggered
//     nothing. Those records are historical, so they sit BELOW the sync watermark
//     `evtLastUploadTs`, and an ordinary push selects `ts > since` -- so nothing
//     ever selected them. Before finding 20 that meant never; after it, the 24h
//     full re-push eventually carried them, i.e. the user's opt-in took up to a
//     day to do anything behind a toast that read as though it already had.
//
// (b) the write transaction resolved the SAME `updated` count from oncomplete,
//     onerror AND onabort, so an aborted republish reported a success count. An
//     IndexedDB abort rolls the whole transaction back, so the honest count is 0.
//     Same shape as finding 7 (evtInsertNew), in a lower-stakes place.
//
// Red gate: `git stash push -- app.js sync.js` and run this file.
//
// Run: node tests/round3-republish-push.test.js  (also run by tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const countRepublishEligibleFn = extractFunction(appSrc, /^function countRepublishEligible\(myDev\)\{/, 'countRepublishEligible');
const republishImportedEventsFn = extractFunction(appSrc, /^function republishImportedEvents\(\)\{/, 'republishImportedEvents');

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// A fake IndexedDB events store that models the two things this finding turns on:
// the cursor hands out a COPY of the record, and `update()` is STAGED -- committed
// only on oncomplete, discarded on abort. tests/no-republish-imported.test.js's
// fake writes straight through, which cannot tell a rollback from a commit and so
// cannot express half (b) at all.
function makeFakeDb(list, opts){
  opts = opts || {};
  return {
    transaction: function(){
      const tx = { oncomplete: null, onerror: null, onabort: null };
      const staged = new Map(); // index -> pending value
      tx.objectStore = function(){
        return {
          openCursor: function(){
            let idx = 0;
            const req = { onsuccess: null, onerror: null, result: null };
            function step(){
              if(idx >= list.length){
                req.result = null;
                if(req.onsuccess) req.onsuccess();
                setTimeout(function(){
                  if(opts.abort){ staged.clear(); if(tx.onabort) tx.onabort(); return; }
                  staged.forEach(function(v, i){ list[i] = v; });
                  if(tx.oncomplete) tx.oncomplete();
                }, 0);
                return;
              }
              const here = idx;
              const cursor = {
                value: Object.assign({}, list[here]),
                continue: function(){ idx++; setTimeout(step, 0); },
                update: function(v){ staged.set(here, v); },
                delete: function(){}
              };
              req.result = cursor;
              if(req.onsuccess) req.onsuccess();
            }
            setTimeout(step, 0);
            return req;
          }
        };
      };
      return tx;
    }
  };
}

function makeCtx(list, opts){
  opts = opts || {};
  const toasts = [];
  const pushCalls = [];
  const diag = [];
  const sandbox = {
    console: console, Promise: Promise, Object: Object, String: String, Map: Map,
    setTimeout: setTimeout,
    EVENTS_STORE: 'events',
    idbOpen: function(){ return Promise.resolve(makeFakeDb(list, { abort: !!opts.abort })); },
    syncDeviceId: function(){ return opts.myDev || 'dev-me'; },
    confirmDialog: function(){ return Promise.resolve(opts.confirm !== false); },
    toast: function(m){ toasts.push(String(m)); }
  };
  // Only defined when the scenario says sync exists -- the guards in app.js are
  // `typeof`-based precisely because sync.js is a separate, later-loaded script.
  if(opts.syncCfg !== null){
    sandbox.syncCfg = function(){ return opts.syncCfg || { enabled: true }; };
  }
  if(opts.noPushFn !== true){
    sandbox.syncEventsRepublishPush = function(){
      pushCalls.push({ at: pushCalls.length });
      return opts.pushRejects ? Promise.reject(new Error('boom')) : Promise.resolve();
    };
  }
  sandbox._qDiagPush = function(kind, data){ diag.push({ kind: kind, data: data }); };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext([countRepublishEligibleFn, republishImportedEventsFn].join('\n'), sandbox); }
  catch(e){ console.error('FAIL: extracted app.js source threw during eval:', e); process.exit(1); }
  return { sandbox: sandbox, toasts: toasts, pushCalls: pushCalls, diag: diag, list: list };
}

function imported(uid, dev){ return { uid: uid, dev: dev || 'dev-me', ts: 1000, kind: 'tap', imported: true }; }
function lastToast(t){ return t.length ? t[t.length - 1] : ''; }

async function main(){
  // =====================================================================
  // R1 -- the reported bug. A successful republish must actually push.
  // =====================================================================
  {
    const list = [imported('i-1'), imported('i-2')];
    const ctx = makeCtx(list);
    const n = await ctx.sandbox.republishImportedEvents();
    assertEq('R1a two records were flagged', n, 2);
    assert('R1b both flags were committed', list.every(function(r){ return r.republish === true; }));
    assertEq('R1c the push was triggered exactly once', ctx.pushCalls.length, 1);
    assert('R1d the final toast says the records were pushed',
      /pushed them to Dropbox/.test(lastToast(ctx.toasts)));
    assert('R1e ...and it still states the count, so the old wording is not lost',
      /Republished 2 imported events/.test(lastToast(ctx.toasts)));
  }

  // =====================================================================
  // R2 -- nothing eligible: no push, and no claim that anything happened.
  // =====================================================================
  {
    const list = [{ uid: 'loc-1', dev: 'dev-me', ts: 1000, kind: 'tap' }];
    const ctx = makeCtx(list);
    const n = await ctx.sandbox.republishImportedEvents();
    assertEq('R2a nothing eligible -> 0', n, 0);
    assertEq('R2b ...and no push is attempted', ctx.pushCalls.length, 0);
  }

  // =====================================================================
  // R3 -- declining the confirmation must not push either.
  // =====================================================================
  {
    const list = [imported('i-1')];
    const ctx = makeCtx(list, { confirm: false });
    const n = await ctx.sandbox.republishImportedEvents();
    assertEq('R3a declining reports 0', n, 0);
    assertEq('R3b ...and no push is attempted', ctx.pushCalls.length, 0);
    assert('R3c ...and the record is not flagged', !list[0].republish);
  }

  // =====================================================================
  // R4 -- sync not connected. The flags are still worth setting, but the toast
  // must not imply an upload happened, and nothing may be called.
  // =====================================================================
  {
    const list = [imported('i-1')];
    const ctx = makeCtx(list, { syncCfg: { enabled: false } });
    const n = await ctx.sandbox.republishImportedEvents();
    assertEq('R4a the flag is still set when sync is off', n, 1);
    assert('R4b ...and committed', list[0].republish === true);
    assertEq('R4c ...but no push is attempted', ctx.pushCalls.length, 0);
    assert('R4d ...and the toast says they are waiting on sync, not that they went',
      /when Dropbox sync is connected/.test(lastToast(ctx.toasts)) &&
      !/pushed them/.test(lastToast(ctx.toasts)));
  }

  // =====================================================================
  // R5 -- sync.js absent entirely. This is the load-order case: app.js is parsed
  // before sync.js, and this very function is extracted and run alone by
  // tests/no-republish-imported.test.js. An unguarded reference here would be a
  // ReferenceError inside the action the user just opted into.
  // =====================================================================
  {
    const list = [imported('i-1')];
    const ctx = makeCtx(list, { syncCfg: null, noPushFn: true });
    let threw = null;
    let n = null;
    try { n = await ctx.sandbox.republishImportedEvents(); } catch(e){ threw = e; }
    assert('R5a no throw when syncCfg / syncEventsRepublishPush do not exist', threw === null);
    assertEq('R5b ...the flag is still set', n, 1);
    assert('R5c ...and the toast degrades to the waiting-on-sync wording',
      /when Dropbox sync is connected/.test(lastToast(ctx.toasts)));
  }

  // =====================================================================
  // R6 -- the push fails. The flags are committed and durable, so the next
  // ordinary round still carries them; the toast must say that rather than imply
  // the opt-in was lost, and the count must still come back.
  // =====================================================================
  {
    const list = [imported('i-1')];
    const ctx = makeCtx(list, { pushRejects: true });
    const n = await ctx.sandbox.republishImportedEvents();
    assertEq('R6a a failed push still reports the flags that were set', n, 1);
    assert('R6b ...the flags are committed', list[0].republish === true);
    assert('R6c ...the toast says they go out on the next sync',
      /push failed/.test(lastToast(ctx.toasts)) && /next sync/.test(lastToast(ctx.toasts)));
    assert('R6d ...and the failure is recorded in diagnostics',
      ctx.diag.some(function(d){ return d.kind === 'republishPushFailed'; }));
  }

  // =====================================================================
  // R7 -- half (b). An aborted transaction rolled everything back, so the honest
  // answer is 0, nothing may be pushed, and the toast must not say "Republished".
  // =====================================================================
  {
    const list = [imported('i-1'), imported('i-2')];
    const ctx = makeCtx(list, { abort: true });
    const n = await ctx.sandbox.republishImportedEvents();
    assertEq('R7a an aborted write reports 0, not the walked count', n, 0);
    assert('R7b ...no record is left flagged (the transaction rolled back)',
      list.every(function(r){ return !r.republish; }));
    assertEq('R7c ...nothing is pushed', ctx.pushCalls.length, 0);
    assert('R7d ...and the toast reports the failure',
      /failed/i.test(lastToast(ctx.toasts)) && !/^Republished \d/.test(lastToast(ctx.toasts)));
  }

  // =====================================================================
  // R8/R9 -- the sync.js side: syncEventsRepublishPush() must ask for a FULL
  // re-scan (the records are below the watermark, so nothing else finds them),
  // must NOT set the shrink-guard override, and must hold the shared Web Lock.
  // =====================================================================
  {
    let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
    src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');
    const noop = function(){};
    const lockRequests = [];
    const sandbox = {
      window: {},
      navigator: {
        onLine: true,
        locks: { request: function(name, opts2, run){ lockRequests.push(String(name)); return Promise.resolve().then(run); } }
      },
      document: { addEventListener: noop, getElementById: function(){ return null; },
        createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
        body: { appendChild: noop, removeChild: noop } },
      localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop, key: function(){ return null; }, length: 0 },
      indexedDB: { open: function(){ return {}; } },
      setTimeout: function(){ return 0; }, clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
      console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
      Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
      TextEncoder: TextEncoder, Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer,
      logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
      uid: function(){ return 'x'; }, idbOpen: function(){ return Promise.resolve(null); }
    };
    sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try { vm.runInContext(src, sandbox); } catch(e){ /* registry is assigned before the boot code */ }
    const Q = sandbox.window.QuestaSync;
    assert('R8a eventsRepublishPush is exposed on the registry',
      !!Q && typeof Q.eventsRepublishPush === 'function');
    if(Q && typeof Q.eventsRepublishPush === 'function'){
      const seen = [];
      sandbox.syncEventsPush = function(o){ seen.push(o || {}); return Promise.resolve(); };
      await Q.eventsRepublishPush();
      assertEq('R8b it calls syncEventsPush exactly once', seen.length, 1);
      assert('R8c ...with forceFullPush, the only thing that reaches records below the watermark',
        seen.length === 1 && seen[0].forceFullPush === true);
      assert('R8d ...and WITHOUT force, so the shrink guard stays armed',
        seen.length === 1 && !seen[0].force);
      assert('R9 ...and it runs inside the shared questa-sync Web Lock',
        lockRequests.indexOf('questa-sync') !== -1);
    }
  }

  console.log('\n--- round3-republish-push.test.js summary ---');
  if(failures){ console.error(failures + ' assertion(s) FAILED'); process.exit(1); }
  console.log('round3-republish-push.test.js: all assertions passed');
  process.exit(0);
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
