// base-selfcheck.test.js -- #5 Base self-check (Fraser-lite).
// Tests:
//   B1: syncBasePut stores envelope {b, r}; syncBaseGet returns {base, lastRev}
//   B2: syncBaseGet backward-compat: old-format (plain object) still readable
//   B3: Poisoned base + matching rev + different state → base discarded (phantom
//       entity from poisoned base NOT in merged result; kept only by 2-way merge)
//   B4: Clean base + matching rev + matching state → base KEPT (no self-check fire)
//   B5: Poisoned base + different rev → base KEPT (rev mismatch = remote changed,
//       normal 3-way merge applies)
//
// Run: node tests/base-selfcheck.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');
// Strip trailing syncInit() call if present
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

// --- Build sandbox with mocks (same pattern as upload-409.test.js) ---
const noop = function(){};
const inMemStore = {};

const seedConfig = {
  enabled: true, appKey: 'test-key',
  refreshToken: 'mock-refresh-token',
  accessToken: 'mock-access-token',
  accessExpiresAt: Date.now() + 3600000,
  lastRev: 'r2', lastSyncAt: null, lastError: null,
  deviceId: 'test-device-1',
  evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0
};
inMemStore['questa.sync.v1'] = JSON.stringify(seedConfig);

// In-memory IDB mock: syncmeta store keyed by string key
const idbSyncmeta = {};

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
  uid: function(){ return 'test-uid'; }
};

sandbox.idbOpen = function(){
  return Promise.resolve({
    transaction: function(storeName, mode){
      var txReq = { _oncomplete: null, _fired: false };
      var tx = {
        objectStore: function(name){
          return {
            get: function(key){
              var val = idbSyncmeta[key] || undefined;
              var req = { result: val, onsuccess: null, onerror: null };
              Promise.resolve().then(function(){
                if(typeof req.onsuccess === 'function') req.onsuccess.call(req);
              });
              return req;
            },
            put: function(value, key){
              idbSyncmeta[key] = value;
              return {};
            }
          };
        },
        set oncomplete(fn){
          txReq._oncomplete = fn;
          if(!txReq._fired){
            txReq._fired = true;
            Promise.resolve().then(function(){ if(txReq._oncomplete) txReq._oncomplete(); });
          }
        },
        get oncomplete(){ return txReq._oncomplete; },
        onerror: null,
        onabort: null
      };
      return tx;
    }
  });
};

sandbox.self = sandbox.window; sandbox.globalThis = sandbox;

sandbox.S = {
  char: { name: 'Test', lvl: 1, updatedAt: 1000 },
  tasks: [{ id: 't1', title: 'Task1', type: 'habit', updatedAt: 1000 }],
  rewards: [], tags: [], devices: [],
  an: { views: [], metrics: [] },
  history: [], charHistory: [], monthlyBackups: [],
  lastCron: 0, deletions: [], __savedAt: Date.now()
};

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) { /* some init errors OK */ }

const Q = sandbox.window.QuestaSync;
if (!Q) { console.error('FAIL: QuestaSync not found'); process.exit(1); }

let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function resetConfig(){
  inMemStore['questa.sync.v1'] = JSON.stringify(Object.assign({}, seedConfig, { lastError: null }));
}

function clearIdb(){ for(const k in idbSyncmeta) delete idbSyncmeta[k]; }

// =====================================================================
// B1: syncBasePut stores envelope, syncBaseGet returns {base, lastRev}
// =====================================================================
(function(){
  clearIdb(); resetConfig();
  var testData = { tasks: [{ id:'t1', title:'T1', type:'habit', updatedAt:500 }] };

  sandbox.syncBasePut(testData, 'r42').then(function(ok){
    assert('B1a: syncBasePut returns true', ok === true);

    // Verify the raw IDB contains an envelope with 'b' and 'r' keys
    var raw = idbSyncmeta['base'];
    assert('B1b: raw IDB value is a string envelope', typeof raw === 'string');
    var envelope = JSON.parse(raw);
    assert('B1c: envelope has .b (base payload)', 'b' in envelope);
    assert('B1d: envelope has .r (rev)', 'r' in envelope);
    assert('B1e: envelope.r is "r42"', envelope.r === 'r42');

    return sandbox.syncBaseGet();
  }).then(function(result){
    assert('B1f: syncBaseGet returns an object', result && typeof result === 'object');
    assert('B1g: result.base has tasks', result.base && Array.isArray(result.base.tasks));
    assert('B1h: result.base.tasks[0].title is "T1"', result.base.tasks[0].title === 'T1');
    assert('B1i: result.lastRev is "r42"', result.lastRev === 'r42');
  }).catch(function(e){
    assert('B1: no exception', false);
    console.error('  Error:', e);
  }).then(nextB2);
})();

function nextB2(){
  // =====================================================================
  // B2: backward-compat: old-format IDB entry still readable
  // =====================================================================
  clearIdb(); resetConfig();
  var oldFormatData = { tasks: [{ id:'t1', title:'Old Format', type:'habit', updatedAt:200 }] };
  // Old format: just the JSON string, no envelope
  idbSyncmeta['base'] = JSON.stringify(oldFormatData);

  sandbox.syncBaseGet().then(function(result){
    assert('B2a: syncBaseGet returns object from old format', result && typeof result === 'object');
    assert('B2b: result.base has tasks', result.base && Array.isArray(result.base.tasks));
    assert('B2c: result.base.tasks[0].title is "Old Format"', result.base.tasks[0].title === 'Old Format');
    assert('B2d: result.lastRev is null (old format)', result.lastRev === null);
  }).catch(function(e){
    assert('B2: no exception', false);
    console.error('  Error:', e);
  }).then(nextB3);
}

function nextB3(){
  // =====================================================================
  // B3: Poisoned base + matching rev + different state → base discarded
  //
  // Setup:
  //   Base (POISONED): tasks=[t1:"BASE", t2:"PHANTOM"], rev='r2'
  //   Local:           tasks=[t1:"LOCAL"]
  //   Remote:          tasks=[t1:"REMOTE"], rev='r2'
  //
  // Without self-check: merge(poisonedBase, local, remote) would keep t2
  //   (phantom from base) via mergeCollection's "both changed → !localHad &&
  //   !remoteHad → keep base" path.
  // With self-check: base discarded (null), merge({}, local, remote) → t2
  //   NOT in baseMap, NOT in localMap, NOT in remoteMap → never processed → DROPPED.
  // =====================================================================
  clearIdb(); resetConfig();

  // Seed poisoned base: has a phantom task t2 that doesn't exist anywhere else
  var poisonedBase = {
    tasks: [
      { id: 't1', title: 'BASE_VERSION', type: 'habit', updatedAt: 100 },
      { id: 't2', title: 'PHANTOM', type: 'todo', updatedAt: 200 }
    ],
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };
  // Store with rev='r2'
  idbSyncmeta['base'] = JSON.stringify({b: JSON.stringify(poisonedBase), r: 'r2'});

  // Local: only t1, no t2 (t2 is the phantom)
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [{ id: 't1', title: 'LOCAL_VERSION', type: 'habit', updatedAt: 300 }],
    rewards: [], tags: [], devices: [],
    an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, deletions: [], __savedAt: Date.now()
  };

  // Remote: rev='r2' (matches stored), but state has only t1 (no t2)
  var remoteState = {
    tasks: [{ id: 't1', title: 'REMOTE_VERSION', type: 'habit', updatedAt: 500 }],
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  // Mock fetch: handle download (return remote) + upload (accept silently)
  var fetchCalls = 0;
  sandbox.fetch = async function(url){
    fetchCalls++;
    if(url && url.indexOf('/files/download') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        text: async function(){
          return JSON.stringify({ schema:1, savedAt: Date.now(), deviceId:'remote-dev', state: remoteState });
        }
      };
    }
    if(url && url.indexOf('/files/upload') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r3' }); } },
        json: async function(){ return { rev: 'r3' }; }
      };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };

  sandbox._syncNowAttempt(0).then(function(){
    // After merge: t2 (phantom from poisoned base) should NOT exist
    var tasks = sandbox.S.tasks || [];
    var t2 = tasks.find(function(t){ return t && t.id === 't2'; });
    assert('B3a: phantom task t2 NOT in merged result (base discarded)', !t2);

    // t1 should exist with remote's version (remote updatedAt:500 > local updatedAt:300)
    var t1 = tasks.find(function(t){ return t && t.id === 't1'; });
    assert('B3b: t1 exists in merged result', !!t1);
    assert('B3c: t1 has remote version (remote wins by updatedAt)', t1 && t1.title === 'REMOTE_VERSION');

    // Config should have lastRev from remote
    var cfg = JSON.parse(inMemStore['questa.sync.v1'] || '{}');
    assert('B3d: lastRev updated to r3 (post-upload)', cfg.lastRev === 'r3');
    assert('B3e: no lastError', !cfg.lastError);
  }).catch(function(e){
    assert('B3: no exception', false);
    console.error('  Error:', e);
  }).then(nextB4);
}

function nextB4(){
  // =====================================================================
  // B4: Clean base + matching rev + matching state → base KEPT (no fire)
  //
  // Setup:
  //   Base:  tasks=[t1:"X"], rev='r2'
  //   Local: tasks=[t1:"X"] (same as base)
  //   Remote: tasks=[t1:"X"], rev='r2' (same as base — nothing changed)
  //
  // Self-check: remote.rev===storedRev AND stableStringify(remote)===base →
  //   NO discard. Merge is no-op (nothingToPush path).
  // =====================================================================
  clearIdb(); resetConfig();

  var cleanBase = {
    tasks: [{ id: 't1', title: 'CLEAN', type: 'habit', updatedAt: 100 }],
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: [],
    // pause is part of the syncSubset whitelist (2026-08-03 pause-sync fix), so a
    // current base snapshot always carries it; without it the nothingToPush
    // comparison would always see a diff and fire an upload.
    pause: { paused: false, pausedDays: [], at: 0 }
  };
  idbSyncmeta['base'] = JSON.stringify({b: JSON.stringify(cleanBase), r: 'r2'});

  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [{ id: 't1', title: 'CLEAN', type: 'habit', updatedAt: 100 }],
    rewards: [], tags: [], devices: [],
    an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, deletions: [], prefs: { paused: false }, __savedAt: Date.now()
  };

  var remoteState = {
    tasks: [{ id: 't1', title: 'CLEAN', type: 'habit', updatedAt: 100 }],
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: [],
    pause: { paused: false, pausedDays: [], at: 0 }
  };

  var uploadCalled = false;
  sandbox.fetch = async function(url){
    if(url && url.indexOf('/files/download') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        text: async function(){
          return JSON.stringify({ schema:1, savedAt: Date.now(), deviceId:'remote-dev', state: remoteState });
        }
      };
    }
    if(url && url.indexOf('/files/upload') !== -1){
      uploadCalled = true;
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        json: async function(){ return { rev: 'r2' }; }
      };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };

  sandbox._syncNowAttempt(0).then(function(){
    // Nothing changed → no upload expected (nothingToPush path)
    assert('B4a: no upload triggered (nothingToPush)', !uploadCalled);

    var tasks = sandbox.S.tasks || [];
    var t1 = tasks.find(function(t){ return t && t.id === 't1'; });
    assert('B4b: t1 still has clean base version', t1 && t1.title === 'CLEAN');

    // Verify the stored base still has the rev (not corrupted)
    var raw = idbSyncmeta['base'];
    var envelope = JSON.parse(raw);
    assert('B4c: base still stored with rev r2', envelope.r === 'r2');
  }).catch(function(e){
    assert('B4: no exception', false);
    console.error('  Error:', e);
  }).then(nextB5);
}

function nextB5(){
  // =====================================================================
  // B5: Poisoned base + DIFFERENT rev → base KEPT (rev mismatch = normal 3-way)
  //
  // Self-check only fires when rev MATCHES. If rev differs, the base is
  // treated normally (remote changed since last sync → standard 3-way merge).
  // =====================================================================
  clearIdb(); resetConfig();

  var poisonedBase2 = {
    tasks: [
      { id: 't1', title: 'BASE_V', type: 'habit', updatedAt: 100 },
      { id: 't2', title: 'PHANTOM2', type: 'todo', updatedAt: 200 }
    ],
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };
  // Store with rev='r1' (DIFFERENT from remote's rev='r2')
  idbSyncmeta['base'] = JSON.stringify({b: JSON.stringify(poisonedBase2), r: 'r1'});

  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [{ id: 't1', title: 'LOCAL_V', type: 'habit', updatedAt: 300 }],
    rewards: [], tags: [], devices: [],
    an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, deletions: [], __savedAt: Date.now()
  };

  var remoteState2 = {
    tasks: [{ id: 't1', title: 'REMOTE_V', type: 'habit', updatedAt: 500 }],
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };

  sandbox.fetch = async function(url){
    if(url && url.indexOf('/files/download') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r2' }); } },
        text: async function(){
          return JSON.stringify({ schema:1, savedAt: Date.now(), deviceId:'remote-dev', state: remoteState2 });
        }
      };
    }
    if(url && url.indexOf('/files/upload') !== -1){
      return { status: 200, ok: true,
        headers: { get: function(){ return JSON.stringify({ rev: 'r3' }); } },
        json: async function(){ return { rev: 'r3' }; }
      };
    }
    return { status: 400, ok: false, text: async function(){ return 'unexpected'; } };
  };

  sandbox._syncNowAttempt(0).then(function(){
    // Rev mismatch → base NOT discarded → phantom t2 from base IS kept
    // (base had t2, local and remote don't → base's t2 preserved by mergeCollection)
    var tasks = sandbox.S.tasks || [];
    var t2 = tasks.find(function(t){ return t && t.id === 't2'; });
    assert('B5a: phantom t2 KEPT (rev mismatch, base used normally)', t2 && t2.title === 'PHANTOM2');

    var t1 = tasks.find(function(t){ return t && t.id === 't1'; });
    assert('B5b: t1 exists', !!t1);
    // Both local and remote changed from base → tiebreak by updatedAt → remote wins
    assert('B5c: t1 has remote version (remote updatedAt > local)', t1 && t1.title === 'REMOTE_V');
  }).catch(function(e){
    assert('B5: no exception', false);
    console.error('  Error:', e);
  }).then(function(){
    if(failures){ console.error(failures + ' base-selfcheck assertion(s) FAILED'); process.exit(1); }
    console.log('base-selfcheck.test.js: all assertions passed');
    process.exit(0);
  });
}
