// evtpush-uids-array.test.js — F8: evtFileCounts[fname].uids must survive a
// localStorage round-trip and uidsAreSuperset() must accept it.
//
// The bug: syncEventsPush() persists `uids` as a `Set` (sync.js ~1897), but
// the whole sync config is written with JSON.stringify and read back with
// JSON.parse (sync.js ~49-58). JSON.stringify(new Set([...])) serializes to
// "{}" -- a Set has no own enumerable properties -- so after ANY reload
// `known.uids` is a truthy but non-iterable `{}`.
//
// That plain object then hits two different call sites:
//
//   1) syncEventsPush()'s shrink guard (sync.js ~1825-1921) does
//      `const knownUids = known.uids || new Set();` then
//      `const missingUids = [...knownUids].filter(...)`. Spreading a plain
//      `{}` throws TypeError: ... is not iterable. That throw escapes
//      syncEventsPush() as a rejected promise. syncEventsSync()'s chain is
//      `syncEventsPush().then(() => syncEventsPull()).catch(...)`, so the
//      throw ALSO skips the event pull for that whole sync round -- cross-
//      device pull silently stops working every time a device's local month
//      count legitimately drops below its last-known count.
//
//   2) uidsAreSuperset() (sync.js ~1737-1749) gates its fast path on
//      `if(knownUids && knownUids.size){` -- Set-only. An array (or the {}
//      produced by (1)) has no `.size`, so the fast path is silently and
//      permanently skipped.
//
// The fix this test is written against (not yet landed):
//   - sync.js:1897 persists uids as a plain ARRAY, not a Set.
//   - sync.js:1866-1868 (the missingUids computation) is deleted outright --
//     provably dead code once uids round-trip correctly.
//   - sync.js:1740 becomes `if(knownUids && knownUids.length){`.
//
// T1 pins the round-trip-shrink-does-not-throw-and-pull-still-runs behavior.
// T2 pins the uidsAreSuperset() array fast path.
//
// Run: node tests/evtpush-uids-array.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';
const MY_DEV = 'dev-me';
const EVENTS_DIR = '/events';

function monthKeyFor(d){
  return String(d.getUTCFullYear()).padStart(4, '0') + String(d.getUTCMonth() + 1).padStart(2, '0');
}
const CUR_MONTH = monthKeyFor(new Date());

// Same sandbox scaffolding as tests/evtpull-instrumentation.test.js (fresh
// vm instance per test so module-level state never bleeds between cases).
function makeCtx(opts){
  opts = opts || {};
  const store = {};
  const noop = function(){};
  const calls = { dbxListFolder: 0, dbxUploadText: 0 };
  const dbxCalls = []; // observable record of what crossed the Dropbox boundary

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
    : function(){ return Promise.resolve(opts.events || []); };

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

  // Seed sync cfg. Building evtFileCounts[fname].uids as a real Set here and
  // letting the SAME JSON.stringify call that seeds localStorage serialize
  // it reproduces the exact real-world round-trip: JSON.stringify(new
  // Set([...])) already collapses to "{}" in one pass (a Set has no own
  // enumerable properties), so syncCfg()'s JSON.parse() on the next read
  // sees the same truthy-but-non-iterable {} a real app reload would.
  store[CFG] = JSON.stringify(Object.assign({
    enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'at',
    accessExpiresAt: Date.now() + 3600000, lastRev: null, lastSyncAt: null, lastError: null,
    deviceId: MY_DEV, evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0
  }, opts.cfg || {}));

  sandbox.dbxListFolder = function(dir){
    calls.dbxListFolder++;
    dbxCalls.push({ fn: 'listFolder', dir: String(dir) });
    return Promise.resolve(opts.entries || []);
  };
  sandbox.dbxDownloadRaw = function(){ return Promise.resolve(null); };
  sandbox.dbxUploadText = function(p, text){
    calls.dbxUploadText++;
    dbxCalls.push({ fn: 'uploadText', path: String(p) });
    return Promise.resolve({ rev: 'up-rev' });
  };

  return { sandbox: sandbox, store: store, calls: calls, dbxCalls: dbxCalls };
}

function tick(){ return new Promise(function(r){ setTimeout(r, 10); }); }

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

async function main(){
  // T0: registry sanity
  {
    const c = makeCtx();
    assert('T0: syncEventsPush is exposed on window.QuestaSync.eventsPush', typeof c.sandbox.window.QuestaSync.eventsPush === 'function');
    assert('T0: syncEventsSync is exposed on window.QuestaSync.eventsSync', typeof c.sandbox.window.QuestaSync.eventsSync === 'function');
    assert('T0: uidsAreSuperset is exposed on window.QuestaSync.evtHelpers', typeof c.sandbox.window.QuestaSync.evtHelpers.uidsAreSuperset === 'function');
  }

  // T1: the round-trip shrink does not throw, and the pull still runs.
  //
  // fname's known uids were recorded as a Set (5 uids) but persisted through
  // JSON.stringify/JSON.parse exactly like a real reload -- so known.uids is
  // now a truthy, non-iterable {}. Local now only has 2 of those 5 uids (a
  // genuine, non-age-related shrink), which drives execution into the
  // missingUids computation at sync.js:1866-1868.
  {
    const fname = MY_DEV + '-' + CUR_MONTH + '.json';
    const now = Date.now();
    const localRecords = [
      { uid: 'u1', dev: MY_DEV, ts: now - 5000, kind: 'tap' },
      { uid: 'u2', dev: MY_DEV, ts: now - 4000, kind: 'tap' }
    ];
    const cfgPatch = {
      evtFileCounts: {
        [fname]: { count: 5, hash: 'known-hash-does-not-match', uids: new Set(['u1', 'u2', 'u3', 'u4', 'u5']) }
      }
    };

    // 1a) syncEventsPush() in isolation must not reject.
    const cA = makeCtx({ cfg: cfgPatch, events: localRecords });
    let threw = false, threwMsg = '';
    try { await cA.sandbox.window.QuestaSync.eventsPush(); }
    catch(e){ threw = true; threwMsg = (e && e.message) || String(e); }
    assert('T1a: syncEventsPush() does not reject on a round-tripped-to-{} uids shrink' + (threw ? ' (threw: ' + threwMsg + ')' : ''), !threw);

    // 1b) the full syncEventsSync() chain (push -> pull) must still reach the
    // pull. dbxListFolder is ONLY ever called from syncEventsPull(), so its
    // presence in dbxCalls is direct evidence the pull actually ran.
    const cB = makeCtx({ cfg: cfgPatch, events: localRecords, entries: [] });
    cB.sandbox.window.QuestaSync.eventsSync();
    await tick(); await tick(); await tick(); await tick(); await tick();
    const pullCall = cB.dbxCalls.find(function(c){ return c.fn === 'listFolder'; });
    assert('T1b: the event pull still runs after a round-tripped shrink (dbxListFolder(' + EVENTS_DIR + ') was recorded)',
      !!pullCall && pullCall.dir === EVENTS_DIR);
  }

  // T2: uidsAreSuperset() fast path engages with ARRAY-shaped uids.
  //
  // knownUids is a plain array (the persisted shape after the fix) that IS a
  // true subset of the local uids, so the uid-superset branch says true, while
  // knownHash is deliberately wrong so the hash branch says false. The two
  // branches disagree, and the returned boolean alone proves which one ran.
  //
  // UPDATED 2026-09-19 (round-1 finding 10): this note used to justify the
  // disagreement with "the hash branch can never return true, because uidHash()
  // is async and its unawaited Promise is never === a string". That was the
  // finding-10 bug, and it is fixed -- the branch is live and is handed the
  // caller's awaited hash. The disagreement now rests only on knownHash being a
  // deliberately wrong value, which is all this test ever needed. The call below
  // passes no 4th argument on purpose: that is the documented safe degrade
  // (false), so it still cannot be the branch that produces the true.
  // Full contract: tests/round3-uids-superset-hash.test.js.
  {
    const c = makeCtx();
    const recs = [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }];
    const knownUidsArray = ['a', 'b']; // true subset of recs' uids -- array-shaped, no .size
    const knownHash = 'deliberately-wrong-hash-value';
    const result = c.sandbox.window.QuestaSync.evtHelpers.uidsAreSuperset(recs, knownHash, knownUidsArray);
    assert('T2: uidsAreSuperset() returns true via the array uid-superset branch (not the always-false hash fallback)', result === true);
  }

  if(failures){ console.error('\n' + failures + ' evtpush-uids-array assertion(s) FAILED'); process.exit(1); }
  console.log('\nevtpush-uids-array.test.js: all assertions passed');
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
