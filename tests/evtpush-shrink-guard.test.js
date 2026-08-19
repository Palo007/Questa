// evtpush-shrink-guard.test.js — F3: syncEventsPush() shrink-guard fix
// verification.
//
// syncEventsPush()'s shrink guard (sync.js:1863-1877) is supposed to allow a
// month's local record count to legitimately drop below the last-known
// remote count when that drop is explained by normal age-based pruning. The
// guard as written on HEAD asks the wrong question: "is the NEWEST remaining
// local record itself stale?" (line 1873: `now - localMaxTs > ageLimit`).
// That answers a different question than the one that matters -- whether
// the PRUNE CUTOFF actually swept through this month at all -- so a month
// whose cutoff has JUST crossed into it (records were legitimately pruned,
// but the records that remain are recent) gets blocked FOREVER, because
// localMaxTs (the newest remaining record) is never going to look "stale".
//
// The fix (not yet landed) replaces that single check with two conditions,
// both required, using cutoff = now - ageLimit and r = evtMonthRange(mk):
//   (a) Math.min(...recs.map(ts)) >= cutoff  -- nothing prunable remains
//       locally (a completed prune leaves exactly this behind)
//   (b) r.from < cutoff                      -- the cutoff actually swept
//       into this month (it genuinely held prunable records)
//
// T1 (RED on HEAD, GREEN after the fix): a straddling month with a
//     completed prune -- must push.
// T2 (GREEN on HEAD and after the fix): a straddling month still holding a
//     stale record below cutoff -- must stay blocked (the "rule is not too
//     permissive" guard named in the plan).
//
// Run: node tests/evtpush-shrink-guard.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';
const MY_DEV = 'dev-me';

// Fixture anchor computed relative to real Date.now() so this test can never
// rot with the calendar (see commit 6b93a82 for the class of bug this
// guards against). AGE_LIMIT_MS mirrors sync.js's EVENT_AGE_LIMIT_MS
// fallback literal exactly (sync.js:1848) -- EVENT_AGE_LIMIT_MS itself is
// never defined anywhere in sync.js, so this fallback is always what runs.
const AGE_LIMIT_MS = 18 * 30 * 86400000;
const NOW = Date.now();
const CUTOFF = NOW - AGE_LIMIT_MS;

function makeGetEvents(records){
  return function(opts){
    opts = opts || {};
    const from = Object.prototype.hasOwnProperty.call(opts, 'from') ? opts.from : -Infinity;
    const to = Object.prototype.hasOwnProperty.call(opts, 'to') ? opts.to : Infinity;
    return Promise.resolve(records.filter(function(e){ return e.ts >= from && e.ts <= to; }));
  };
}

// A fresh evaluated sync.js instance per test (mirrors
// tests/evtpull-instrumentation.test.js's makeCtx / sandbox scaffolding).
function makeCtx(opts){
  opts = opts || {};
  const store = {};
  const noop = function(){};
  const uploads = []; // {path, text} for every dbxUploadText call

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

  sandbox.getEvents = makeGetEvents(opts.records || []);
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

  store[CFG] = JSON.stringify(Object.assign({
    enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'at',
    accessExpiresAt: Date.now() + 3600000, lastRev: null, lastSyncAt: null, lastError: null,
    deviceId: MY_DEV, evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0,
    evtFullPushAt: 0, evtFileCounts: {}, evtPushBlocked: {}
  }, opts.cfg || {}));

  // Override the Dropbox upload transport post-eval (same pattern as
  // evtpull-instrumentation.test.js overriding dbxListFolder/dbxDownloadRaw).
  sandbox.dbxUploadText = function(p, text){
    uploads.push({ path: String(p), text: text });
    return Promise.resolve({ rev: 'test-rev' });
  };

  return { sandbox: sandbox, store: store, uploads: uploads };
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

async function push(ctx, opts){ return ctx.sandbox.window.QuestaSync.eventsPush(opts); }

async function main(){
  // Shared month math via the real helpers exposed on the registry -- never
  // reimplemented locally, so it can't drift from sync.js's own definitions.
  const helperCtx = makeCtx();
  const evtHelpers = helperCtx.sandbox.window.QuestaSync.evtHelpers;
  const mk = evtHelpers.evtMonthKey(CUTOFF);
  const r = evtHelpers.evtMonthRange(mk);
  const fname = MY_DEV + '-' + mk + '.json';
  const uploadPath = '/events/' + fname;

  // ---- T1: straddling month with a COMPLETED prune -- must push -----------
  // r.from < CUTOFF (the cutoff swept into this month) and the one record
  // that remains locally sits at the very end of the month, i.e. >= CUTOFF
  // (nothing prunable is left). knownCount > localCount so the guard
  // engages; known.uids is deliberately omitted below -- an empty-Set
  // fallback both survives the config's JSON round-trip (a real Set would
  // flatten to `{}` and break the `[...knownUids]` spread on HEAD) and
  // forces uidsAreSuperset() down its hash-compare path, which always
  // resolves false here since uidHash() is invoked unawaited there --
  // keeping the shrink-guard branch live regardless of the F3 fix itself.
  {
    const recs1 = [
      { uid: 'u-t1-remaining', dev: MY_DEV, ts: r.to, kind: 'tap' }
    ];
    const c = makeCtx({
      records: recs1,
      cfg: {
        evtFileCounts: {
          [fname]: { count: 3, hash: 'known-hash-does-not-match' }
        }
      }
    });
    await push(c);
    const savedCfg = JSON.parse(c.store[CFG]);
    assert('T1: straddling month with a completed prune is actually uploaded',
      c.uploads.some(function(u){ return u.path === uploadPath; }));
    assert('T1: straddling month is NOT recorded as blocked',
      !savedCfg.evtPushBlocked || !savedCfg.evtPushBlocked[fname]);
  }

  // ---- T2: straddling month STILL holding a stale (prunable) record -------
  // Same straddling month, but the local set also includes a record from
  // right after r.from -- i.e. Math.min(local ts) is BELOW cutoff, so a real
  // prune has NOT completed here (real data loss risk). This must stay
  // blocked both on HEAD and after the fix lands.
  {
    const recs2 = [
      { uid: 'u-t2-stale', dev: MY_DEV, ts: r.from + 1000, kind: 'tap' },
      { uid: 'u-t2-recent', dev: MY_DEV, ts: r.to, kind: 'tap' }
    ];
    const c = makeCtx({
      records: recs2,
      cfg: {
        evtFileCounts: {
          [fname]: { count: 5, hash: 'known-hash-does-not-match' }
        }
      }
    });
    await push(c);
    const savedCfg = JSON.parse(c.store[CFG]);
    const blocked = savedCfg.evtPushBlocked && savedCfg.evtPushBlocked[fname];
    assert('T2: month still holding a stale record is NOT uploaded',
      !c.uploads.some(function(u){ return u.path === uploadPath; }));
    assert('T2: month records a blocked state shaped {at, local, known}',
      !!blocked && typeof blocked.at === 'number' && blocked.local === 2 && blocked.known === 5);
  }

  if(failures){ console.error('\n' + failures + ' evtpush-shrink-guard assertion(s) FAILED'); process.exit(1); }
  console.log('\nAll evtpush-shrink-guard assertions passed.');
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
