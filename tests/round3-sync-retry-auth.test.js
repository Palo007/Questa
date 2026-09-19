// round3-sync-retry-auth.test.js -- round 3 triage, items 9, 10, 11 and 12.
//
// R3-D  item 9:  a 429 Retry-After must be obeyed, not ignored.
//                D1 delta-seconds parse.
//                D2 HTTP-date parse.
//                D3 absent / empty / garbage / past-date / negative all give 0.
//                D4 a 429 carries Retry-After out of dbxDownload on the error.
//                D5 the transient ladder waits AT LEAST Retry-After, not 1s/5s/25s.
//                D6 a Retry-After longer than the cap stops the retries at once
//                   and reports the real wait instead of a bare failure.
//
// R3-E  item 10: a failed config write must not be reported as success.
//                E1 _syncCfgWrite reports ok:false when localStorage throws.
//                E2 ...and ok:true when it does not; syncCfgSave keeps its shape.
//                E3 a connect whose token write is lost does NOT toast
//                   "Dropbox connected", and leaves enabled false.
//
// R3-F  item 11: the 401 retry must use the token it just minted.
//                F1 the retry request carries the FRESH token even when the
//                   config write that would have persisted it was lost.
//                F2 ...and the call then succeeds rather than 401-ing forever.
//
// R3-G  item 12: disconnect must revoke the grant at Dropbox.
//                G1 syncDisconnect() calls /2/auth/token/revoke.
//                G2 ...with the current access token.
//                G3 the local wipe still happens when the revoke fails offline.
//                G4 ...and still preserves deviceId / evtFileCounts (round 2).
//
// Run: node tests/round3-sync-retry-auth.test.js  (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';
const PKCE = 'questa.sync.pkce';
const noop = function(){};
const realSetTimeout = setTimeout;

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function tick(){ return new Promise(function(r){ realSetTimeout(r, 0); }); }

function makeCtx(){
  const store = {};
  const toasts = [];
  const delays = [];
  const loc = { search: '', origin: 'https://test.example', pathname: '/', href: '' };
  let frozen = false;

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
      setItem: function(k, v){
        if(frozen){ const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
        store[k] = String(v);
      },
      removeItem: function(k){ delete store[k]; },
      key: function(){ return null; }, length: 0
    },
    history: { replaceState: noop },
    location: loc,
    crypto: {
      getRandomValues: function(arr){ for(let i=0;i<arr.length;i++) arr[i] = i % 256; return arr; },
      subtle: { digest: async function(){ return new ArrayBuffer(32); } }
    },
    // Records every delay the code asks for, then fires immediately so the
    // suite does not actually sleep. D5/D6 assert on what was RECORDED.
    setTimeout: function(fn, ms){ delays.push(Number(ms) || 0); return realSetTimeout(fn, 0); },
    clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    URLSearchParams: URLSearchParams, TextEncoder: TextEncoder, Buffer: Buffer,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, Error: Error, isFinite: isFinite, isNaN: isNaN,
    parseInt: parseInt, RegExp: RegExp,
    fetch: null,
    logEvent: noop, toast: function(m){ toasts.push(m); }, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return 'test-device-1'; },
    idbOpen: function(){ return Promise.resolve(null); },
    getEvents: function(){ return Promise.resolve([]); },
    confirmDialog: function(){ return Promise.resolve(true); }
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
    sandbox: sandbox, store: store, toasts: toasts, loc: loc, delays: delays,
    freeze: function(v){ frozen = !!v; },
    seedCfg: function(patch){
      store[CFG] = JSON.stringify(Object.assign({
        enabled: true, appKey: 'test-key',
        refreshToken: 'rt-SEED', accessToken: 'tok-STALE',
        accessExpiresAt: Date.now() + 3600000,
        lastRev: null, lastSyncAt: null, lastError: null,
        deviceId: 'test-device-1',
        evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0,
        evtFullScanAt: 0, evtBadRevs: {}, evtFullPushAt: 0,
        evtFileCounts: {}, evtPushBlocked: {}
      }, patch || {}));
    },
    readCfg: function(){ return JSON.parse(store[CFG] || 'null'); }
  };
  ctx.seedCfg();

  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }
  return ctx;
}

// A minimal Response stand-in. `retryAfter` null means the header is absent.
function res429(retryAfter){
  return {
    ok: false, status: 429,
    headers: { get: function(h){ return /^retry-after$/i.test(h) ? retryAfter : null; } },
    text: async function(){ return 'too_many_requests'; },
    json: async function(){ return {}; }
  };
}

// ===========================================================================
// R3-D  item 9 -- Retry-After
// ===========================================================================
async function testD(){
  const c = makeCtx();
  const S = c.sandbox;

  const fakeRes = function(v){ return { headers: { get: function(){ return v; } } }; };

  assert('D1: "120" parses to 120000 ms',
    S._retryAfterMs(fakeRes('120')) === 120000);
  assert('D1b: " 5 " tolerates surrounding whitespace',
    S._retryAfterMs(fakeRes(' 5 ')) === 5000);

  const future = new Date(Date.now() + 90000).toUTCString();
  const parsed = S._retryAfterMs(fakeRes(future));
  assert('D2: an HTTP-date parses to roughly the right delta',
    parsed > 80000 && parsed <= 90000);

  assert('D3a: an absent header gives 0', S._retryAfterMs(fakeRes(null)) === 0);
  assert('D3b: an empty header gives 0', S._retryAfterMs(fakeRes('   ')) === 0);
  assert('D3c: garbage gives 0', S._retryAfterMs(fakeRes('soon-ish')) === 0);
  assert('D3d: a negative value gives 0', S._retryAfterMs(fakeRes('-30')) === 0);
  assert('D3e: a past date gives 0',
    S._retryAfterMs(fakeRes(new Date(Date.now() - 60000).toUTCString())) === 0);
  assert('D3f: a missing headers object gives 0 instead of throwing',
    S._retryAfterMs({}) === 0 && S._retryAfterMs(null) === 0);

  // D4: the header must survive the fetch wrapper and land on the thrown error.
  S.fetch = async function(){ return res429('120'); };
  let caught = null;
  try{ await S.dbxDownload('/state.json'); }catch(e){ caught = e; }
  assert('D4a: a 429 download throws with status 429',
    !!caught && caught.status === 429);
  assert('D4b: ...and carries retryAfterMs = 120000',
    !!caught && caught.retryAfterMs === 120000);

  // D5: under the cap, every wait is at least what the server asked for.
  const c5 = makeCtx();
  const S5 = c5.sandbox;
  let hits5 = 0;
  S5.dbxDownload = function(){
    hits5++;
    const e = new Error('rate limited');
    e.status = 429; e.retryAfterMs = 40000;   // 40s: over the ladder, under the 60s cap
    return Promise.reject(e);
  };
  let err5 = null;
  try{ await S5._syncNowAttempt(0); }catch(e){ err5 = e; }
  assert('D5a: all three transient retries were spent (4 attempts)', hits5 === 4);
  assert('D5b: every wait honoured the 40s Retry-After, not 1s/5s/25s',
    c5.delays.length === 3 && c5.delays.every(function(d){ return d === 40000; }));
  assert('D5c: the failure still surfaces after the retries', !!err5);

  // D6: over the cap, stop immediately and say how long the wait really is.
  const c6 = makeCtx();
  const S6 = c6.sandbox;
  let hits6 = 0;
  S6.dbxDownload = function(){
    hits6++;
    const e = new Error('rate limited');
    e.status = 429; e.retryAfterMs = 300000;  // the 300s window from the review
    return Promise.reject(e);
  };
  let err6 = null;
  try{ await S6._syncNowAttempt(0); }catch(e){ err6 = e; }
  assert('D6a: no retry is attempted past the cap', hits6 === 1);
  assert('D6b: ...and nothing was scheduled to wait', c6.delays.length === 0);
  assert('D6c: the message names the real wait, not a bare failure',
    !!err6 && /rate limiting/.test(err6.message) && /300s/.test(err6.message));
  assert('D6d: the error keeps the 429 status and the asked-for delay',
    !!err6 && err6.status === 429 && err6.retryAfterMs === 300000);
}

// ===========================================================================
// R3-E  item 10 -- a lost config write is not a success
// ===========================================================================
async function testE(){
  const c = makeCtx();
  const S = c.sandbox;

  assert('E1a: _syncCfgWrite exists', typeof S._syncCfgWrite === 'function');
  c.freeze(true);
  const bad = S._syncCfgWrite({ lastRev: 'r-lost' });
  c.freeze(false);
  assert('E1b: a throwing localStorage reports ok:false', !!bad && bad.ok === false);
  assert('E1c: ...and the value really did not land',
    c.readCfg().lastRev !== 'r-lost');

  const good = S._syncCfgWrite({ lastRev: 'r-kept' });
  assert('E2a: a working localStorage reports ok:true', !!good && good.ok === true);
  assert('E2b: ...and the value landed', c.readCfg().lastRev === 'r-kept');
  const ret = S.syncCfgSave({ lastRev: 'r-shape' });
  assert('E2c: syncCfgSave still returns the merged config object',
    !!ret && ret.lastRev === 'r-shape' && ret.deviceId === 'test-device-1');

  // E3: the connect path must not claim success when the tokens were lost.
  const c3 = makeCtx();
  const S3 = c3.sandbox;
  c3.seedCfg({ enabled: false, refreshToken: null, accessToken: null, accessExpiresAt: 0 });
  c3.store[PKCE] = JSON.stringify({ v: 'verifier', r: 'https://test.example/' });
  c3.loc.search = '?code=abc';
  let started = 0;
  S3.syncNow = function(){ started++; return Promise.resolve(); };
  S3.syncForcePush = function(){ started++; return Promise.resolve(); };
  S3.fetch = async function(url){
    if(url && url.indexOf('/oauth2/token') !== -1){
      return { ok: true, status: 200, json: async function(){
        return { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 14400 };
      } };
    }
    return { ok: false, status: 404, json: async function(){ return {}; }, text: async function(){ return ''; } };
  };
  c3.freeze(true);
  await S3.syncHandleRedirect();
  await tick();
  c3.freeze(false);
  assert('E3a: a lost token write does NOT toast "Dropbox connected"',
    c3.toasts.indexOf('Dropbox connected') === -1);
  assert('E3b: ...it reports the failure instead',
    c3.toasts.some(function(t){ return /failed/i.test(t); }));
  assert('E3c: ...and never starts a sync on credentials it does not have',
    started === 0);
  assert('E3d: ...and sync is not left marked enabled',
    c3.readCfg().enabled !== true);
}

// ===========================================================================
// R3-F  item 11 -- the 401 retry uses the token it just minted
// ===========================================================================
async function testF(){
  const c = makeCtx();
  const S = c.sandbox;
  c.seedCfg({ accessToken: 'tok-STALE', refreshToken: 'rt-SEED',
              accessExpiresAt: Date.now() + 3600000 });

  const auths = [];
  let downloads = 0;
  S.fetch = async function(url, opts){
    if(url && url.indexOf('/oauth2/token') !== -1){
      return { ok: true, status: 200, json: async function(){
        return { access_token: 'tok-FRESH', expires_in: 14400 };
      } };
    }
    if(url && url.indexOf('/files/download') !== -1){
      auths.push(opts && opts.headers && opts.headers.Authorization);
      downloads++;
      if(downloads === 1){
        return { ok: false, status: 401,
          headers: { get: function(){ return null; } },
          text: async function(){ return 'invalid_access_token'; },
          json: async function(){ return {}; } };
      }
      return {
        ok: true, status: 200,
        headers: { get: function(h){
          return h === 'dropbox-api-result' ? JSON.stringify({ rev: 'rev-2' }) : null; } },
        text: async function(){
          return JSON.stringify({ state: { tasks: [] }, savedAt: 123, deviceId: 'peer' }); }
      };
    }
    return { ok: false, status: 404, headers: { get: function(){ return null; } },
             text: async function(){ return ''; }, json: async function(){ return {}; } };
  };

  // The whole point: the refreshed token cannot be read back out of storage,
  // so the retry only works if the value is carried through in memory.
  c.freeze(true);
  let out = null, boom = null;
  try{ out = await S.dbxDownload('/state.json'); }catch(e){ boom = e; }
  c.freeze(false);

  assert('F1a: the download was retried exactly once', downloads === 2);
  assert('F1b: the first attempt used the stale token',
    auths[0] === 'Bearer tok-STALE');
  assert('F1c: the retry used the FRESHLY minted token, not the stored one',
    auths[1] === 'Bearer tok-FRESH');
  assert('F2a: the retry succeeded instead of throwing',
    !boom && !!out && out.rev === 'rev-2');
  assert('F2b: ...and returned the remote state', !!out && !!out.state);
}

// ===========================================================================
// R3-G  item 12 -- disconnect revokes the grant at Dropbox
// ===========================================================================
async function testG(){
  const c = makeCtx();
  const S = c.sandbox;
  c.seedCfg({ accessToken: 'tok-LIVE', refreshToken: 'rt-LIVE',
              accessExpiresAt: Date.now() + 3600000,
              deviceId: 'dev-keepme',
              evtFileCounts: { 'dev-keepme-202609.json': { count: 4, hash: 'h' } } });

  const calls = [];
  S.fetch = async function(url, opts){
    calls.push({ url: String(url), opts: opts || {} });
    return { ok: true, status: 200, json: async function(){ return {}; },
             text: async function(){ return ''; } };
  };
  await S.syncDisconnect();
  await tick();

  const revoke = calls.filter(function(x){ return x.url.indexOf('/2/auth/token/revoke') !== -1; });
  assert('G1: syncDisconnect() calls /2/auth/token/revoke', revoke.length === 1);
  assert('G2a: ...with POST',
    revoke.length === 1 && revoke[0].opts.method === 'POST');
  assert('G2b: ...carrying the live access token',
    revoke.length === 1 && revoke[0].opts.headers &&
    revoke[0].opts.headers.Authorization === 'Bearer tok-LIVE');
  assert('G2c: ...and does NOT need a token refresh first',
    calls.filter(function(x){ return x.url.indexOf('/oauth2/token') !== -1; }).length === 0);

  // G3: offline must not block the local disconnect.
  const c3 = makeCtx();
  const S3 = c3.sandbox;
  c3.seedCfg({ accessToken: 'tok-LIVE', refreshToken: 'rt-LIVE',
               accessExpiresAt: Date.now() + 3600000,
               deviceId: 'dev-keepme',
               evtFileCounts: { 'dev-keepme-202609.json': { count: 4, hash: 'h' } },
               evtPushBlocked: { 'dev-keepme-202609.json': { at: 1, local: 2, known: 3 } } });
  S3.fetch = async function(){ throw new Error('offline'); };
  let threw = null;
  try{ await S3.syncDisconnect(); }catch(e){ threw = e; }
  await tick();
  const after = c3.readCfg();
  assert('G3a: a failing revoke does not reject out of syncDisconnect', !threw);
  assert('G3b: the refresh token is gone from this device anyway',
    !after.refreshToken);
  assert('G3c: the access token is gone too', !after.accessToken);
  assert('G3d: sync is disabled', after.enabled === false);
  assert('G4a: deviceId is still preserved (round 2)', after.deviceId === 'dev-keepme');
  assert('G4b: evtFileCounts is still preserved (round 2)',
    !!after.evtFileCounts && !!after.evtFileCounts['dev-keepme-202609.json']);
  assert('G4c: evtPushBlocked is still preserved (round 2)',
    !!after.evtPushBlocked && !!after.evtPushBlocked['dev-keepme-202609.json']);
  assert('G4d: the PKCE verifier is still cleared (2026-09-18)',
    !Object.prototype.hasOwnProperty.call(c3.store, PKCE));
}

// Each block runs in its own try so a missing function in one does not hide
// the verdict on the other three -- that matters for the red gate, where the
// pre-fix code has no _retryAfterMs at all and would otherwise abort at D1.
(async function(){
  const blocks = [['R3-D', testD], ['R3-E', testE], ['R3-F', testF], ['R3-G', testG]];
  for(const [name, fn] of blocks){
    try{ await fn(); }
    catch(e){
      console.error('[FAIL] ' + name + ' threw: ' + ((e && e.message) || e));
      failures++;
    }
  }
  if(failures){ console.error(failures + ' round3-sync-retry-auth assertion(s) FAILED'); process.exit(1); }
  console.log('round3-sync-retry-auth.test.js: all assertions passed');
})();
