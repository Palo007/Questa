// evtpull-selfhealing.test.js — W6.13: self-healing hardening of
// syncEventsPull() (periodic full re-scan, bad-rev quarantine, conflict-copy
// diagnosis, and a {force:true} bypass). Added in the SAME edit as the
// production code change (sync.js ~1718-1850).
//
// Context: a Dropbox events file sat unread on another device for a month
// (W6.12 added exit-path instrumentation to find out why). This task does
// NOT pin down which branch caused it -- instead it makes the pull
// self-healing regardless of which branch fired:
//
//   S1  a file pinned by an unchanged rev IS re-pulled once the full-scan
//       interval (24h) has elapsed since cfg.evtFullScanAt
//   S2  ...and is NOT re-pulled before that interval elapses
//   S3  cfg.evtFullScanAt is stamped (to "now") after a full scan runs
//   S4  a never-before-set evtFullScanAt bootstraps the watermark on this
//       pull WITHOUT forcing an immediate full scan (protects existing
//       installs / the pre-existing revUnchanged test from a surprise
//       scan on the very first post-upgrade pull)
//   S5  a corrupt payload does not pin its healthy neighbours out of the
//       pull -- a good file in the same batch still gets pulled+inserted
//   S6  a corrupt payload's rev is recorded in evtBadRevs, NOT in the
//       normal evtFileRevs map (so it can't masquerade as a healthy pin)
//   S7  a conflict-copy-style filename ("name (1).json") is diagnosed
//       (evtPullSkip/unparsedName) rather than silently dropped, and is
//       NOT ingested (see sync.js comment above evtParseFileName for the
//       reasoning -- a conflict copy is a stale, superseded full-month
//       snapshot, not an appended log)
//   S8  {force:true} bypasses the rev cache even within the 60s throttle
//       window AND within the 24h full-scan window
//   S9  {force:true} bypasses the 60s throttle (dbxListFolder still runs)
//   S10 default (no-arg) call: revUnchanged still skips exactly as before
//       (throttle + rev-cache both still apply)
//
// Run: node tests/evtpull-selfhealing.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';
const MY_DEV = 'dev-me';
const DAY_MS = 24 * 3600000;

function monthKeyFor(d){
  return String(d.getUTCFullYear()).padStart(4, '0') + String(d.getUTCMonth() + 1).padStart(2, '0');
}
const CUR_MONTH = monthKeyFor(new Date());

// Same harness shape as tests/evtpull-instrumentation.test.js (closest prior
// art) -- a fresh evaluated sync.js instance per test so lexical state (the
// throttle-diag rate limiter) never bleeds between scenarios.
function makeCtx(opts){
  opts = opts || {};
  const store = {};
  const noop = function(){};
  const calls = { dbxListFolder: 0, dbxDownloadRaw: 0, getEvents: 0 };

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
    tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }

  // seed sync cfg -- includes the two new W6.13 fields alongside the
  // pre-existing ones, mirroring syncCfgDefaults().
  store[CFG] = JSON.stringify(Object.assign({
    enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'at',
    accessExpiresAt: Date.now() + 3600000, lastRev: null, lastSyncAt: null, lastError: null,
    deviceId: MY_DEV, evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0,
    evtFullScanAt: 0, evtBadRevs: {}
  }, opts.cfg || {}));

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
        transaction: function(){
          const tx = {};
          tx.objectStore = function(){ return { add: function(){ /* accepted */ } }; };
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

async function pull(ctx, opts){ return ctx.sandbox.window.QuestaSync.eventsPull(opts); }
function cfgOf(ctx){ return JSON.parse(ctx.store[CFG]); }

async function main(){
  // S1 + S2: full-scan interval gates re-pull of an unchanged-rev file.
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const records = [{ uid: 'u-s1', dev: 'dev-other', ts: Date.now() - 1000, kind: 'tap' }];

    // S2 first: interval NOT elapsed (evtFullScanAt recent) -> still revUnchanged, no download.
    {
      const c = makeCtx({
        entries: [{ name: name, rev: 'same-rev' }],
        downloads: { [name]: { text: JSON.stringify(records), rev: 'same-rev' } },
        cfg: { evtFileRevs: { [name]: 'same-rev' }, evtFullScanAt: Date.now() - 3600000 }, // 1h ago
        idb: 'success'
      });
      await pull(c);
      assert('S2: within the full-scan interval, an unchanged rev is still skipped (no download)', c.calls.dbxDownloadRaw === 0);
      const hit = c.diag.find(e => e.kind === 'evtPullSkip' && e.name === name);
      assert('S2: revUnchanged diag still fires inside the interval', hit && hit.reason === 'revUnchanged');
    }

    // S1: interval elapsed (evtFullScanAt > 24h ago) -> re-pulled despite unchanged rev.
    {
      const c = makeCtx({
        entries: [{ name: name, rev: 'same-rev' }],
        downloads: { [name]: { text: JSON.stringify(records), rev: 'same-rev' } },
        cfg: { evtFileRevs: { [name]: 'same-rev' }, evtFullScanAt: Date.now() - (DAY_MS + 60000) }, // > 24h ago
        idb: 'success'
      });
      await pull(c);
      assert('S1: once the full-scan interval elapsed, the unchanged-rev file IS re-downloaded', c.calls.dbxDownloadRaw === 1);
      const ok = c.diag.find(e => e.kind === 'evtPullOk' && e.name === name);
      assert('S1: the re-pulled file still ingests successfully (idempotent union-insert)', !!ok);

      // S3: evtFullScanAt stamped to ~now after the full scan.
      const saved = cfgOf(c);
      assert('S3: cfg.evtFullScanAt is stamped forward after a full scan', saved.evtFullScanAt > Date.now() - 5000);

      // a diag entry marks that a full scan ran, so it's visible in diagnostics.
      const scanDiag = c.diag.find(e => e.kind === 'evtFullScan');
      assert('S1: a full scan run emits its own diag entry', !!scanDiag);
    }
  }

  // S4: a never-before-set evtFullScanAt (fresh/upgrading config, the default
  // seeded by makeCtx) bootstraps the watermark WITHOUT forcing a scan this
  // cycle -- an unchanged rev is still skipped normally.
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const c = makeCtx({
      entries: [{ name: name, rev: 'same-rev' }],
      cfg: { evtFileRevs: { [name]: 'same-rev' } } // evtFullScanAt left at default 0
    });
    await pull(c);
    assert('S4: a fresh/never-scanned config does NOT force an immediate full scan', c.calls.dbxDownloadRaw === 0);
    const hit = c.diag.find(e => e.kind === 'evtPullSkip' && e.name === name);
    assert('S4: revUnchanged still fires on first pull with a bootstrapped watermark', hit && hit.reason === 'revUnchanged');
    const saved = cfgOf(c);
    assert('S4: evtFullScanAt is nonetheless bootstrapped to a real timestamp', saved.evtFullScanAt > 0);
  }

  // S5 + S6: a corrupt payload doesn't pin/block a healthy neighbour, and its
  // rev lands in evtBadRevs, not evtFileRevs.
  {
    const badName = 'dev-other-' + CUR_MONTH + '.json';
    const goodName = 'dev-other2-' + CUR_MONTH + '.json';
    const goodRecords = [{ uid: 'u-good', dev: 'dev-other2', ts: Date.now() - 1000, kind: 'tap' }];
    const c = makeCtx({
      entries: [{ name: badName, rev: 'rbad' }, { name: goodName, rev: 'rgood' }],
      downloads: {
        [badName]: { text: 'not json {', rev: 'rbad' },
        [goodName]: { text: JSON.stringify(goodRecords), rev: 'rgood' }
      },
      idb: 'success'
    });
    await pull(c);
    const goodHit = c.diag.find(e => e.kind === 'evtPullOk' && e.name === goodName);
    assert('S5: the healthy neighbour is still pulled and inserted despite the corrupt file in the same batch', !!goodHit);
    const badHit = c.diag.find(e => e.kind === 'evtPullSkip' && e.name === badName);
    assert('S5: the corrupt file itself is still diagnosed as a parseError', badHit && badHit.reason === 'parseError');

    const saved = cfgOf(c);
    assert('S6: the corrupt file\'s rev is NOT recorded in the normal evtFileRevs map', !(badName in saved.evtFileRevs));
    assert('S6: the corrupt file\'s rev IS recorded in evtBadRevs instead', badName in saved.evtBadRevs);
    assert('S6: the healthy file\'s rev IS recorded in the normal evtFileRevs map', saved.evtFileRevs[goodName] === 'rgood');
  }

  // S7: a conflict-copy-style filename is diagnosed, never silently dropped,
  // and never ingested (evtParseFileName deliberately does not match it --
  // see the reasoning comment in sync.js above that function).
  {
    const name = 'mrl770yaq56gl-' + CUR_MONTH + ' (1).json';
    const c = makeCtx({ entries: [{ name: name, rev: 'rc1' }] });
    await pull(c);
    const hit = c.diag.find(e => e.name === name);
    assert('S7: a conflict-copy filename produces SOME diag entry (never silently dropped)', !!hit);
    assert('S7: a conflict-copy filename is diagnosed as unparsedName, not ingested', hit.kind === 'evtPullSkip' && hit.reason === 'unparsedName');
    assert('S7: a conflict-copy filename never triggers a download (no ingestion)', c.calls.dbxDownloadRaw === 0);
  }

  // S8 + S9: {force:true} bypasses both the rev cache and the 60s throttle.
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const records = [{ uid: 'u-force', dev: 'dev-other', ts: Date.now() - 1000, kind: 'tap' }];
    const c = makeCtx({
      entries: [{ name: name, rev: 'same-rev' }],
      downloads: { [name]: { text: JSON.stringify(records), rev: 'same-rev' } },
      cfg: {
        evtFileRevs: { [name]: 'same-rev' },     // would normally short-circuit as revUnchanged
        evtLastPullAt: Date.now() - 1000,        // well inside the 60s throttle window
        evtFullScanAt: Date.now()                // full-scan interval freshly reset (would NOT fire on its own)
      },
      idb: 'success'
    });
    await pull(c, { force: true });
    assert('S9: {force:true} bypasses the 60s throttle (dbxListFolder runs)', c.calls.dbxListFolder === 1);
    assert('S8: {force:true} bypasses the rev cache (file is downloaded despite unchanged rev)', c.calls.dbxDownloadRaw === 1);
    const throttleHit = c.diag.find(e => e.kind === 'evtPullSkip' && e.reason === 'throttled');
    assert('S8/S9: no throttled diag is emitted when forced', !throttleHit);
    const ok = c.diag.find(e => e.kind === 'evtPullOk' && e.name === name);
    assert('S8: the forced pull still ingests the file', !!ok);
  }

  // S10: default (no-arg) call -- confirms the normal path is unchanged:
  // revUnchanged still short-circuits, throttle still applies.
  {
    const name = 'dev-other-' + CUR_MONTH + '.json';
    const c = makeCtx({
      entries: [{ name: name, rev: 'same-rev' }],
      cfg: { evtFileRevs: { [name]: 'same-rev' } }
    });
    await pull(c); // no opts at all
    assert('S10: default no-arg call still skips an unchanged rev (no download)', c.calls.dbxDownloadRaw === 0);
    const hit = c.diag.find(e => e.kind === 'evtPullSkip' && e.name === name);
    assert('S10: default no-arg call still diagnoses revUnchanged', hit && hit.reason === 'revUnchanged');

    // and the throttle still applies on a second immediate call with no force.
    const c2 = makeCtx({ cfg: { evtLastPullAt: Date.now() - 1000 } });
    await pull(c2);
    assert('S10: default no-arg call still honors the 60s throttle (no Dropbox call)', c2.calls.dbxListFolder === 0);
  }

  if(failures){ console.error('\n' + failures + ' evtpull-selfhealing assertion(s) FAILED'); process.exit(1); }
  console.log('\nevtpull-selfhealing.test.js: all assertions passed');
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
