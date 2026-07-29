// evtpull-instrumentation.test.js — W6.12: syncEventsPull() diagnostic
// instrumentation (instrumentation only, no behavior change).
//
// Cross-device event pull has never worked (a Dropbox events file with 3,379
// events sat unread on both devices) and we don't yet know which early-return
// in syncEventsPull() silently swallowed it. This suite covers the diag push
// added on every continue/return in that function, added in the SAME edit:
//
//   T1  unparsedName  — a stray-suffixed filename (Dropbox " (1)" conflict copy)
//   T2  ownDevice     — a file uploaded by this same device is skipped
//   T3  tooOld        — a file whose month exceeds the age-limit is skipped
//                        (and its rev entry is still deleted from cfg, unchanged)
//   T4  revUnchanged  — a file whose rev matches the cached rev is skipped
//                        WITHOUT downloading it
//   T5  downloadFailed— dbxDownloadRaw() returning null/falsy is skipped
//   T6  parseError    — corrupt JSON is skipped (rev is still recorded, unchanged)
//   T7  notArray      — valid JSON that isn't an array is skipped
//   T8  evtPullOk     — a real new file is inserted; diag carries the insert count
//   T9  missingDeps   — getEvents/idbOpen absent short-circuits before any
//                        Dropbox call, diag'd, no throw
//   T10 throttle      — the 60s throttle is diag'd AT MOST ONCE per pull-cycle
//                        window even across repeated calls (flood guard)
//   T11 no _qDiagPush — completely missing global degrades gracefully, no throw
//   T12 ring cap      — many skips in one pull still respect the 50-entry ring
//
// Run: node tests/evtpull-instrumentation.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';
const MY_DEV = 'dev-me';

function monthKeyFor(d){
  return String(d.getUTCFullYear()).padStart(4, '0') + String(d.getUTCMonth() + 1).padStart(2, '0');
}
const CUR_MONTH = monthKeyFor(new Date());
const oldD = new Date(); oldD.setUTCMonth(oldD.getUTCMonth() - 30); // well past the ~18mo default age limit
const OLD_MONTH = monthKeyFor(oldD);

// A fresh evaluated sync.js instance per test, mirroring tests/force-push-on-connect.test.js
// (each scenario needs its own module instance so lexical state like the new
// throttle-diag rate-limit variable doesn't bleed between tests).
function makeCtx(opts){
  opts = opts || {};
  const store = {};
  const noop = function(){};
  const calls = { dbxListFolder: 0, dbxDownloadRaw: 0, getEvents: 0 };

  const diagEntries = []; // mirrors app.js's window.__qDiag.errors ring exactly
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

  // getEvents: default no pre-existing uids anywhere; overridable per test.
  // Use hasOwnProperty (not `=== undefined`) so { getEvents: undefined } (T9)
  // genuinely leaves it absent instead of falling back to the default stub.
  sandbox.getEvents = Object.prototype.hasOwnProperty.call(opts, 'getEvents')
    ? opts.getEvents
    : function(){ calls.getEvents++; return Promise.resolve([]); };

  if(opts.withDiag !== false){
    sandbox.window.__qDiag = { errors: diagEntries };
    // Exact copy of app.js's ring implementation (window.__qDiag.errors, cap 50,
    // push/shift eviction) -- this test must not build a second buffer, so it
    // mirrors the real sink precisely to prove sync.js's calls interact with it
    // correctly, per the W6.12 brief.
    sandbox._qDiagPush = function(kind, data){
      try{
        sandbox.window.__qDiag.errors.push(Object.assign({ t: Date.now(), kind: kind }, data));
        if(sandbox.window.__qDiag.errors.length > 50) sandbox.window.__qDiag.errors.shift();
      }catch(e){}
    };
  }
  // else: leave _qDiagPush entirely undefined (T11)

  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }

  // seed sync cfg (mirrors other sync tests' CFG shape)
  store[CFG] = JSON.stringify(Object.assign({
    enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'at',
    accessExpiresAt: Date.now() + 3600000, lastRev: null, lastSyncAt: null, lastError: null,
    deviceId: MY_DEV, evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0
  }, opts.cfg || {}));

  // Override Dropbox transport + IDB insert path post-eval (same pattern as
  // confirm-force-push-event-count.test.js overriding syncForcePush post-eval).
  sandbox.dbxListFolder = function(){ calls.dbxListFolder++; return Promise.resolve(opts.entries || []); };
  sandbox.dbxDownloadRaw = function(p){
    calls.dbxDownloadRaw++;
    const name = String(p).split('/').pop();
    const dl = (opts.downloads && Object.prototype.hasOwnProperty.call(opts.downloads, name)) ? opts.downloads[name] : null;
    return Promise.resolve(dl);
  };

  if(opts.idb){
    sandbox.EVENTS_STORE = 'events';
    sandbox.idbOpen = function(){
      return Promise.resolve({
        transaction: function(storeName, mode){
          const tx = {};
          tx.objectStore = function(){ return { add: function(){ /* accepted */ } }; };
          // Fire completion on a microtask, AFTER evtInsertNew's synchronous
          // code (forEach + assigning tx.oncomplete/onerror/onabort) has run --
          // mirrors real IndexedDB's async completion timing.
          Promise.resolve().then(function(){
            if(opts.idb === 'abort'){ if(tx.onabort) tx.onabort(); }
            else { if(tx.oncomplete) tx.oncomplete(); }
          });
          return tx;
        }
      });
    };
  }

  return { sandbox: sandbox, store: store, calls: calls, diag: diagEntries };
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

async function pull(ctx){ return ctx.sandbox.window.QuestaSync.eventsPull(); }

async function main(){
  // T0: registry sanity
  {
    const c = makeCtx();
    assert('T0: syncEventsPull is exposed on window.QuestaSync.eventsPull', typeof c.sandbox.window.QuestaSync.eventsPull === 'function');
  }

  // T1: unparsedName -- a Dropbox conflict-copy-style stray suffix
  {
    const name = 'dev-other-' + CUR_MONTH + ' (1).json';
    const c = makeCtx({ entries: [{ name: name, rev: 'r1' }] });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.name === name; });
    assert('T1: unparsedName produces evtPullSkip for the stray-suffixed file', hit && hit.reason === 'unparsedName');
  }

  // T2: ownDevice -- never re-import our own upload
  {
    const name = MY_DEV + '-' + CUR_MONTH + '.json';
    const c = makeCtx({ entries: [{ name: name, rev: 'r2' }] });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.name === name; });
    assert('T2: ownDevice produces evtPullSkip for our own file', hit && hit.reason === 'ownDevice');
  }

  // T3: tooOld -- month exceeds the age limit; rev entry still deleted (unchanged behavior)
  {
    const name = 'dev-other-' + OLD_MONTH + '.json';
    const c = makeCtx({ entries: [{ name: name, rev: 'r3' }], cfg: { evtFileRevs: { [name]: 'stale-rev' } } });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.name === name; });
    assert('T3: tooOld produces evtPullSkip', hit && hit.reason === 'tooOld');
    const saved = JSON.parse(c.store[CFG]);
    assert('T3: the stale rev entry is still deleted from cfg (control flow unchanged)', !(name in saved.evtFileRevs));
  }

  // T4: revUnchanged -- cached rev matches; must NOT download
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const c = makeCtx({ entries: [{ name: name, rev: 'same-rev' }], cfg: { evtFileRevs: { [name]: 'same-rev' } } });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.name === name; });
    assert('T4: revUnchanged produces evtPullSkip', hit && hit.reason === 'revUnchanged');
    assert('T4: revUnchanged never calls dbxDownloadRaw', c.calls.dbxDownloadRaw === 0);
  }

  // T5: downloadFailed -- dbxDownloadRaw resolves null/falsy
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const c = makeCtx({ entries: [{ name: name, rev: 'r5' }], downloads: { [name]: null } });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.name === name; });
    assert('T5: downloadFailed produces evtPullSkip', hit && hit.reason === 'downloadFailed');
  }

  // T6: parseError -- corrupt JSON; rev is still recorded (unchanged behavior)
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const c = makeCtx({ entries: [{ name: name, rev: 'r6' }], downloads: { [name]: { text: 'not json {', rev: 'r6' } } });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.name === name; });
    assert('T6: parseError produces evtPullSkip', hit && hit.reason === 'parseError');
    const saved = JSON.parse(c.store[CFG]);
    assert('T6: the rev is still recorded for the corrupt file (unchanged behavior)', saved.evtFileRevs[name] === 'r6');
  }

  // T7: notArray -- valid JSON, but not an array
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const c = makeCtx({ entries: [{ name: name, rev: 'r7' }], downloads: { [name]: { text: JSON.stringify({ not: 'array' }), rev: 'r7' } } });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.name === name; });
    assert('T7: notArray produces evtPullSkip', hit && hit.reason === 'notArray');
  }

  // T8: evtPullOk -- a real new file, inserted via the (mocked) IDB path
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const records = [
      { uid: 'u1', dev: 'dev-other', ts: Date.now() - 1000, kind: 'tap' },
      { uid: 'u2', dev: 'dev-other', ts: Date.now() - 500, kind: 'tap' }
    ];
    const c = makeCtx({ entries: [{ name: name, rev: 'r8' }], downloads: { [name]: { text: JSON.stringify(records), rev: 'r8' } }, idb: 'success' });
    await pull(c);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullOk' && e.name === name; });
    assert('T8: evtPullOk produced for the successfully-processed file', !!hit);
    assert('T8: evtPullOk carries the correct insert count', hit && hit.inserted === 2);
  }

  // T9: missingDeps -- getEvents absent short-circuits before any Dropbox call
  {
    const c = makeCtx({ getEvents: undefined });
    assert('T9 setup: getEvents genuinely absent', typeof c.sandbox.getEvents === 'undefined');
    let threw = false;
    try { await pull(c); } catch(e){ threw = true; }
    assert('T9: syncEventsPull does not throw when getEvents is missing', !threw);
    assert('T9: dbxListFolder is never called (short-circuit before any Dropbox call)', c.calls.dbxListFolder === 0);
    const hit = c.diag.find(function(e){ return e.kind === 'evtPullSkip' && e.reason === 'missingDeps'; });
    assert('T9: missingDeps produces evtPullSkip', !!hit);
  }

  // T10: throttle -- diag'd at most once per pull-cycle window, even across repeated calls
  {
    const c = makeCtx({ cfg: { evtLastPullAt: Date.now() - 1000 } }); // well inside the 60s window
    await pull(c);
    await pull(c);
    await pull(c);
    const throttleHits = c.diag.filter(function(e){ return e.kind === 'evtPullSkip' && e.reason === 'throttled'; });
    assert('T10: three throttled calls in the same window produce exactly ONE throttled diag entry', throttleHits.length === 1);
    assert('T10: throttled calls never touch Dropbox', c.calls.dbxListFolder === 0);
  }

  // T11: no _qDiagPush at all -- must degrade gracefully, never throw
  {
    const name = 'dev-other-' + CUR_MONTH + ' (1).json'; // unparsedName path, would normally diag
    const c = makeCtx({ withDiag: false, entries: [{ name: name, rev: 'r11' }] });
    assert('T11 setup: _qDiagPush genuinely absent', typeof c.sandbox._qDiagPush === 'undefined');
    let threw = false;
    try { await pull(c); } catch(e){ threw = true; }
    assert('T11: syncEventsPull does not throw when _qDiagPush is missing', !threw);
    const saved = JSON.parse(c.store[CFG]);
    assert('T11: pull still completes normally (evtLastPullAt advances)', saved.evtLastPullAt > 0);
  }

  // T12: ring cap respected -- many skips in one pull, ring stays at 50 with FIFO eviction
  {
    const entries = [];
    for(let i = 0; i < 60; i++){
      entries.push({ name: 'dev-other-' + CUR_MONTH + '-' + i + ' (1).json', rev: 'r' + i }); // all unparsedName
    }
    const c = makeCtx({ entries: entries });
    await pull(c);
    assert('T12: ring never exceeds the 50-entry cap', c.diag.length === 50);
    assert('T12: ring evicted the oldest first (FIFO) -- entry 0 gone', !c.diag.some(function(e){ return e.name === entries[0].name; }));
    assert('T12: ring kept the newest -- entry 59 present', c.diag.some(function(e){ return e.name === entries[59].name; }));
    assert('T12: oldest surviving entry is index 10 (0..9 evicted)', c.diag[0].name === entries[10].name);
    assert('T12: newest surviving entry is index 59 (last pushed)', c.diag[49].name === entries[59].name);
  }

  if(failures){ console.error('\n' + failures + ' evtpull-instrumentation assertion(s) FAILED'); process.exit(1); }
  console.log('\nevtpull-instrumentation.test.js: all assertions passed');
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
