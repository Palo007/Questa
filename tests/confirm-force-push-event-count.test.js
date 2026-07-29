// confirm-force-push-event-count.test.js — W3.6: surface local event count in
// the force-push confirmation dialog so the user can gauge whether THIS
// device is the well-synced one before overwriting Dropbox's state.
//
// Covers confirmForcePush() (sync.js), NOT syncForcePush()/_syncForcePushAttempt()
// (those intentionally do not re-confirm; see the comments right above them).
//
//   T1: dialog text includes the local event count (unconditional, count available)
//   T2: advisory sentence appears when count is below the threshold (n=49)
//   T3: advisory sentence is ABSENT at the threshold boundary (n=50)
//   T4: missing countEvents global degrades gracefully — dialog still opens,
//       no throw, no count sentence at all
//   T5: countEvents() rejecting does not throw and omits the count sentence
//   T6: countEvents() resolving 0 does not throw; count sentence shows "0
//       local events" and the advisory appears (0 < 50)
//
// Run: node tests/confirm-force-push-event-count.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

// A fresh evaluated sync.js instance per call, mirroring tests/force-push-on-connect.test.js.
function makeCtx(countEventsImpl){
  const store = {};
  const toasts = [];
  const dialogs = []; // { title, text }
  let dialogResolve = null;
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
    location: { search: '', origin: 'https://test.example', pathname: '/', href: '' },
    crypto: {
      getRandomValues: function(arr){ for(let i=0;i<arr.length;i++) arr[i] = i % 256; return arr; },
      subtle: { digest: async function(){ return new ArrayBuffer(32); } }
    },
    setTimeout: function(){ return 0; }, // do NOT auto-fire: keeps the 2s boot timer inert
    clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    isNaN: isNaN,
    URLSearchParams: URLSearchParams, TextEncoder: TextEncoder, Buffer: Buffer,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer,
    fetch: null,
    logEvent: noop, toast: function(m){ toasts.push(m); }, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return 'test-device-1'; },
    idbOpen: function(){ return Promise.resolve(null); },
    confirmDialog: function(title, text){
      dialogs.push({ title: title, text: text });
      return new Promise(function(resolve){ dialogResolve = resolve; });
    }
  };
  // Only wire up countEvents when the caller passes an implementation, so
  // T4 (missing global) can omit it entirely rather than setting `undefined`
  // (which would still make `typeof countEvents` report "undefined" either
  // way, but this keeps the intent explicit).
  if(countEventsImpl){ sandbox.countEvents = countEventsImpl; }
  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [{ id: 't1', title: 'Task1', type: 'habit', updatedAt: 1000 }],
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }

  // Force-push itself must never fire in this suite (no Dropbox in these
  // sandboxes) — stub it so an accidental "confirm -> true" path can't blow up.
  sandbox.syncForcePush = function(){ return Promise.resolve(); };

  return { sandbox: sandbox, store: store, toasts: toasts, dialogs: dialogs,
           getDialogResolve: function(){ return dialogResolve; } };
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

async function main(){
  // ---------------------------------------------------------------
  // T1: dialog text includes the local event count (count available, >= threshold)
  // ---------------------------------------------------------------
  {
    const c = makeCtx(function(){ return Promise.resolve(134); });
    const Q = c.sandbox.window.QuestaSync;
    assert('confirmForcePush is exposed on window.QuestaSync', typeof Q.confirmForcePush === 'function');
    await Q.confirmForcePush();
    assert('T1: exactly one confirm dialog opened', c.dialogs.length === 1);
    const text = c.dialogs[0] && c.dialogs[0].text || '';
    assert('T1: dialog text includes the local event count', text.indexOf('134 local events') !== -1);
    assert('T1: dialog still states the replace-Dropbox-state warning', text.indexOf('THIS device') !== -1);
  }

  // ---------------------------------------------------------------
  // T2: advisory sentence appears below the threshold (n=49)
  // ---------------------------------------------------------------
  {
    const c = makeCtx(function(){ return Promise.resolve(49); });
    const Q = c.sandbox.window.QuestaSync;
    await Q.confirmForcePush();
    const text = c.dialogs[0] && c.dialogs[0].text || '';
    assert('T2: count sentence present for n=49', text.indexOf('49 local events') !== -1);
    assert('T2: advisory sentence present below threshold (n=49)', text.indexOf('may not be the most up-to-date device') !== -1);
  }

  // ---------------------------------------------------------------
  // T3: advisory sentence ABSENT at the threshold boundary (n=50)
  // ---------------------------------------------------------------
  {
    const c = makeCtx(function(){ return Promise.resolve(50); });
    const Q = c.sandbox.window.QuestaSync;
    await Q.confirmForcePush();
    const text = c.dialogs[0] && c.dialogs[0].text || '';
    assert('T3: count sentence present for n=50', text.indexOf('50 local events') !== -1);
    assert('T3: advisory sentence ABSENT at threshold (n=50)', text.indexOf('may not be the most up-to-date device') === -1);
  }

  // ---------------------------------------------------------------
  // T4: missing countEvents global degrades gracefully
  // ---------------------------------------------------------------
  {
    const c = makeCtx(null); // no countEvents wired up at all
    assert('T4 setup: countEvents is genuinely absent from the sandbox', typeof c.sandbox.countEvents === 'undefined');
    const Q = c.sandbox.window.QuestaSync;
    let threw = false;
    try { await Q.confirmForcePush(); } catch(e){ threw = true; }
    assert('T4: confirmForcePush does not throw when countEvents is missing', !threw);
    assert('T4: dialog still opens', c.dialogs.length === 1);
    const text = c.dialogs[0] && c.dialogs[0].text || '';
    assert('T4: no count sentence when countEvents is unavailable', text.indexOf('local event') === -1);
  }

  // ---------------------------------------------------------------
  // T5: countEvents() rejecting does not throw and omits the count sentence
  // ---------------------------------------------------------------
  {
    const c = makeCtx(function(){ return Promise.reject(new Error('idb boom')); });
    const Q = c.sandbox.window.QuestaSync;
    let threw = false;
    try { await Q.confirmForcePush(); } catch(e){ threw = true; }
    assert('T5: confirmForcePush does not throw when countEvents rejects', !threw);
    assert('T5: dialog still opens', c.dialogs.length === 1);
    const text = c.dialogs[0] && c.dialogs[0].text || '';
    assert('T5: no count sentence when countEvents rejected', text.indexOf('local event') === -1);
  }

  // ---------------------------------------------------------------
  // T6: countEvents() resolving 0 does not throw; shows "0 local events" + advisory
  // ---------------------------------------------------------------
  {
    const c = makeCtx(function(){ return Promise.resolve(0); });
    const Q = c.sandbox.window.QuestaSync;
    let threw = false;
    try { await Q.confirmForcePush(); } catch(e){ threw = true; }
    assert('T6: confirmForcePush does not throw when countEvents resolves 0', !threw);
    const text = c.dialogs[0] && c.dialogs[0].text || '';
    assert('T6: count sentence shows 0 local events', text.indexOf('0 local events') !== -1);
    assert('T6: advisory sentence present for n=0', text.indexOf('may not be the most up-to-date device') !== -1);
  }

  if(failures){ console.error('\n' + failures + ' confirm-force-push-event-count assertion(s) FAILED'); process.exit(1); }
  console.log('\nconfirm-force-push-event-count.test.js: all assertions passed');
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
