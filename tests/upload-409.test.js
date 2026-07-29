// upload-409.test.js -- #4 Upload-409 body inspection + retry-exhaustion backoff.
// Tests:
//   U1: 409 with non-rev body (e.g. restricted_content) → HttpError, no retry burn
//   U2: 409 with rev body (update/conflict) → ConflictError → re-download + re-merge (existing behavior)
//   U3: Rev-conflict retry exhaustion → lastError set + setTimeout scheduled
//   U4: Empty/unreadable body → treated as ConflictError (legacy compat)
//   U5: Near-limit attempt → only 1 upload before exhaustion
//
// NOTE: _pushWithConflictRetry returns normally (not throws) at exhaustion — it
// sets lastError + schedules setTimeout, then returns. HttpError THROWS (bubbles).
//
// Run: node tests/upload-409.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

// --- Build sandbox with mocks ---
const noop = function(){};
const inMemStore = {};

const seedConfig = {
  enabled: true, appKey: 'test-key',
  refreshToken: 'mock-refresh-token',
  accessToken: 'mock-access-token',
  accessExpiresAt: Date.now() + 3600000,
  lastRev: 'r1', lastSyncAt: null, lastError: null,
  deviceId: 'test-device-1',
  evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0
};
inMemStore['questa.sync.v1'] = JSON.stringify(seedConfig);

const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: {
    getItem: function(key){ return inMemStore[key] || null; },
    setItem: function(key, val){ inMemStore[key] = val; },
    removeItem: function(key){ delete inMemStore[key]; },
    key: function(){ return null; }, length: 0
  },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(fn, ms){ return fn; },
  clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'test-uid'; },
  idbOpen: function(){ return Promise.resolve(null); }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;

sandbox.S = {
  char: { name: 'Test', lvl: 1, updatedAt: 1000 },
  tasks: [{ id: 't1', title: 'Task1', type: 'habit', updatedAt: 1000 }],
  rewards: [], tags: [], devices: [],
  an: { views: [], metrics: [] },
  history: [], charHistory: [], monthlyBackups: [],
  lastCron: 0, deletions: []
};

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) {}

const Q = sandbox.window.QuestaSync;
if (!Q) { console.error('FAIL: QuestaSync not found'); process.exit(1); }

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

function resetConfig(){
  inMemStore['questa.sync.v1'] = JSON.stringify(Object.assign({}, seedConfig, { lastError: null }));
}

function freshMergedJson(){
  return JSON.stringify({
    tasks: [{ id:'t1', title:'Task1', type:'habit', updatedAt:2000 }],
    char: { name:'Test', lvl:2, updatedAt:2000 },
    rewards:[], tags:[], devices:[], an:{views:[],metrics:[]},
    history:[], charHistory:[], monthlyBackups:[], lastCron:0, deletions:[]
  });
}

function remoteDownloadBody(){
  return JSON.stringify({
    schema: 1, savedAt: Date.now(), deviceId: 'remote-device',
    state: {
      tasks: [{ id:'t1', title:'Task1 remote', type:'habit', updatedAt:3000 }],
      char: { name:'Test', lvl:3, updatedAt:3000 },
      rewards:[], tags:[], devices:[], an:{views:[],metrics:[]},
      history:[], charHistory:[], monthlyBackups:[], lastCron:0, deletions:[]
    }
  });
}

function mockFetch409NonRev(){
  return async function(url){
    if(url && url.indexOf('/files/upload') !== -1){
      return { status: 409, ok: false,
        json: async function(){ return { error_summary: 'path/restricted_content' }; },
        text: async function(){ return 'restricted_content'; } };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };
}

function mockFetch409RevConflict(){
  return async function(url){
    if(url && url.indexOf('/files/upload') !== -1){
      return { status: 409, ok: false,
        json: async function(){ return { error_summary: 'path/update/conflict' }; },
        text: async function(){ return 'conflict'; } };
    }
    if(url && url.indexOf('/files/download') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        text: async function(){ return remoteDownloadBody(); } };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };
}

// =====================================================================
// U1: 409 with non-rev body → HttpError, no retry burn
// =====================================================================
(function(){
  var fetchCalls = 0;
  sandbox.fetch = async function(url){
    fetchCalls++;
    if(url && url.indexOf('/files/upload') !== -1){
      return { status: 409, ok: false,
        json: async function(){ return { error_summary: 'path/restricted_content' }; },
        text: async function(){ return 'restricted_content'; } };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };
  resetConfig();
  var mj = freshMergedJson();

  sandbox._pushWithConflictRetry(mj, 'r1', 0).then(function(){
    assert('U1: HttpError should have thrown', false);
  }).catch(function(err){
    assert('U1a: non-rev 409 throws HttpError (not ConflictError)',
      err && err.name === 'HttpError' && err.status === 409);
    assert('U1b: HttpError message contains body summary',
      err && err.message && err.message.indexOf('restricted_content') !== -1);
    assert('U1c: fetch called exactly once (no retry burn)', fetchCalls === 1);
    var cfg = JSON.parse(inMemStore['questa.sync.v1'] || '{}');
    assert('U1d: lastError NOT set by _pushWithConflictRetry for non-rev 409',
      !cfg.lastError);
  }).then(nextTests).catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
})();

function nextTests(){
  // =====================================================================
  // U2: Rev conflict 409 → ConflictError → re-download + re-merge → exhaustion
  // =====================================================================
  var uploadCalls = 0, downloadCalls = 0;
  sandbox.fetch = async function(url){
    if(url && url.indexOf('/files/upload') !== -1){ uploadCalls++; }
    if(url && url.indexOf('/files/download') !== -1){ downloadCalls++; }
    if(url && url.indexOf('/files/upload') !== -1){
      return { status: 409, ok: false,
        json: async function(){ return { error_summary: 'path/update/conflict' }; },
        text: async function(){ return 'conflict'; } };
    }
    if(url && url.indexOf('/files/download') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        text: async function(){ return remoteDownloadBody(); } };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };
  resetConfig();

  // _pushWithConflictRetry returns normally at exhaustion (does NOT throw)
  sandbox._pushWithConflictRetry(freshMergedJson(), 'r1', 0).then(function(){
    // At exhaustion: attempt 0→ConflictError→retry(1), 1→ConflictError→retry(2),
    // 2→ConflictError→retry(3), 3→ConflictError (attempt >= limit)→return normally
    assert('U2a: upload called 4 times (3 retries + final exhaustion)', uploadCalls === 4);
    assert('U2b: download called 3 times (once per retry)', downloadCalls === 3);
    var cfg = JSON.parse(inMemStore['questa.sync.v1'] || '{}');
    assert('U2c: lastError set on retry exhaustion', cfg.lastError && cfg.lastError.indexOf('conflict') !== -1);
  }).catch(function(err){
    assert('U2: should not throw at exhaustion (returns normally)', false);
  }).then(nextTests2).catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
}

function nextTests2(){
  // =====================================================================
  // U3: Retry exhaustion → setTimeout scheduled (delayed retry backoff)
  // =====================================================================
  var timerScheduled = false, timerDelay = 0;
  var origSetTimeout = sandbox.setTimeout;
  sandbox.setTimeout = function(fn, ms){
    timerScheduled = true; timerDelay = ms; return 999;
  };

  sandbox.fetch = mockFetch409RevConflict();
  resetConfig();

  sandbox._pushWithConflictRetry(freshMergedJson(), 'r1', 0).then(function(){
    assert('U3a: setTimeout was scheduled on retry exhaustion', timerScheduled === true);
    assert('U3b: timer delay is SYNC_CONFLICT_BACKOFF_MS (30000)', timerDelay === 30000);
    var cfg = JSON.parse(inMemStore['questa.sync.v1'] || '{}');
    assert('U3c: lastError set on exhaustion', cfg.lastError && cfg.lastError.indexOf('conflict') !== -1);
    sandbox.setTimeout = origSetTimeout;
  }).catch(function(err){
    assert('U3: should not throw at exhaustion', false);
    sandbox.setTimeout = origSetTimeout;
  }).then(nextTests3).catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
}

function nextTests3(){
  // =====================================================================
  // U4: Empty/unreadable body → ConflictError (legacy compat, retries)
  // =====================================================================
  sandbox.fetch = async function(url){
    if(url && url.indexOf('/files/upload') !== -1){
      return { status: 409, ok: false,
        json: async function(){ throw new Error('unreadable'); },
        text: async function(){ return 'garbage'; } };
    }
    if(url && url.indexOf('/files/download') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        text: async function(){ return remoteDownloadBody(); } };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };
  resetConfig();

  // Empty body should be treated as ConflictError (legacy compat) and exhaust
  sandbox._pushWithConflictRetry(freshMergedJson(), 'r1', 0).then(function(){
    var cfg = JSON.parse(inMemStore['questa.sync.v1'] || '{}');
    assert('U4a: empty body treated as ConflictError (retries then exhausts)', cfg.lastError && cfg.lastError.indexOf('conflict') !== -1);
    assert('U4b: lastError NOT an HttpError (legacy compat path used)', cfg.lastError && cfg.lastError.indexOf('upload failed: 409') === -1);
  }).catch(function(err){
    assert('U4: empty body should not throw HttpError', false);
  }).then(nextTests4).catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
}

function nextTests4(){
  // =====================================================================
  // U5: Near-limit attempt → only 1 upload before exhaustion
  // =====================================================================
  var uploadCount = 0;
  sandbox.fetch = async function(url){
    if(url && url.indexOf('/files/upload') !== -1){
      uploadCount++;
      return { status: 409, ok: false,
        json: async function(){ return { error_summary: 'path/update/conflict' }; },
        text: async function(){ return 'conflict'; } };
    }
    if(url && url.indexOf('/files/download') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        text: async function(){ return remoteDownloadBody(); } };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };
  resetConfig();

  // Start at attempt = SYNC_CONFLICT_RETRY_LIMIT - 1 (i.e. attempt=2)
  // attempt 2 → ConflictError → check: 2 < 3 → retry(attempt=3)
  // attempt 3 → ConflictError → check: 3 < 3 → FALSE → exhaustion → return
  // So: 2 uploads, 1 download
  sandbox._pushWithConflictRetry(freshMergedJson(), 'r1', 2).then(function(){
    assert('U5a: only 2 uploads when starting at limit-1', uploadCount === 2);
    var cfg = JSON.parse(inMemStore['questa.sync.v1'] || '{}');
    assert('U5b: lastError set', cfg.lastError && cfg.lastError.indexOf('conflict') !== -1);
  }).catch(function(err){
    assert('U5: near-limit should not throw', false);
  }).then(function(){
    if(failures){ console.error(failures + ' upload-409 assertion(s) FAILED'); process.exit(1); }
    console.log('upload-409.test.js: all assertions passed');
  }).catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
}
