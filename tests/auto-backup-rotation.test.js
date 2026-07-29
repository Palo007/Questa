// auto-backup-rotation.test.js -- backup rotation scoping + cross-tier/device isolation.
// Tests:
//   R1: _bkListTier scoped to {prefix}-{deviceShort}-* regex
//   R2: No cross-tier deletion: _bkFire on fourHour never touches daily entries
//   R3: No cross-device deletion: _bkFire on deviceA never touches deviceB entries
//   R4: syncMaybeAutoExport builds blob once for concurrent multi-tier
//   R5: Duplicate-slot cleanup: two files sharing a slot → older deleted
//
// Run: node tests/auto-backup-rotation.test.js   (also run by `node tests/run.js`)
'use strict';
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
  deviceId: 'abc1123456',
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
  setTimeout: function(fn){ return fn; },
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
  lastCron: 0, deletions: [],
  prefs: {}
};

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) {}

// Verify sandbox loaded
if (typeof sandbox._bkListTier !== 'function') {
  console.error('FAIL: _bkListTier not found in sandbox');
  process.exit(1);
}
if (typeof sandbox._bkFire !== 'function') {
  console.error('FAIL: _bkFire not found in sandbox');
  process.exit(1);
}
const Q = sandbox.window.QuestaSync;
if (!Q || typeof Q.maybeAutoExport !== 'function') {
  console.error('FAIL: QuestaSync.maybeAutoExport not found');
  process.exit(1);
}

// --- Test helpers ---
let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function makeBlob(text){
  return { text: async function(){ return text; } };
}

function resetBkLocal(){
  delete inMemStore['questa.autobackup.local'];
}

// deviceId is 'abc1123456' → _bkDeviceShort() = '1123456' (last 6 chars)
// _bkListTier('1123456', '4hour') regex: ^4hour-1123456-\d+-

async function runTests(){
  // =====================================================================
  // R1: _bkListTier scoped to {prefix}-{deviceShort}-* regex
  // Only entries matching the exact prefix AND device are returned.
  // =====================================================================
  {
    sandbox.dbxListFolder = async function(){
      return [
        { name: '4hour-123456-00-20260701-120000.json' },
        { name: '4hour-123456-01-20260701-130000.json' },
        { name: 'daily-123456-00-20260701-000000.json' },
        { name: '4hour-999999-00-20260701-120000.json' },
        { name: 'unrelated.json' }
      ];
    };
    const result = await sandbox._bkListTier('123456', '4hour');
    assert('R1: returns only matching entries (prefix=4hour, device=123456)', result.length === 2);
    assert('R1a: first match correct', result[0].name === '4hour-123456-00-20260701-120000.json');
    assert('R1b: second match correct', result[1].name === '4hour-123456-01-20260701-130000.json');
  }

  // R1 variant: daily prefix
  {
    sandbox.dbxListFolder = async function(){
      return [
        { name: 'daily-123456-00-20260701-000000.json' },
        { name: 'daily-123456-01-20260701-010000.json' },
        { name: '4hour-123456-00-20260701-120000.json' },
        { name: 'weekly-123456-00-20260701-000000.json' }
      ];
    };
    const result = await sandbox._bkListTier('123456', 'daily');
    assert('R1c: daily prefix filters correctly', result.length === 2);
    assert('R1d: only daily entries returned', result.every(function(e){ return e.name.indexOf('daily-123456-') === 0; }));
  }

  // R1 variant: different device
  {
    sandbox.dbxListFolder = async function(){
      return [
        { name: '4hour-123456-00-20260701-120000.json' },
        { name: '4hour-abcdef-00-20260701-120000.json' }
      ];
    };
    const result = await sandbox._bkListTier('abcdef', '4hour');
    assert('R1e: different device short filters correctly', result.length === 1);
    assert('R1f: only abcdef device entry returned', result[0].name === '4hour-abcdef-00-20260701-120000.json');
  }

  // =====================================================================
  // R2: No cross-tier deletion
  // _bkFire('fourHour') only touches 4hour-* entries, never daily-*.
  // Setup: 2 entries in slot 0 of 4hour (triggers dedup → 1 delete),
  //        2 entries in slot 0 of daily (should be untouched).
  // =====================================================================
  {
    resetBkLocal();
    var deletedPaths = [];
    sandbox.dbxListFolder = async function(){
      return [
        { name: '4hour-123456-00-20260701-120000.json' },
        { name: '4hour-123456-00-20260701-130000.json' },
        { name: 'daily-123456-00-20260701-000000.json' },
        { name: 'daily-123456-00-20260701-010000.json' }
      ];
    };
    sandbox.dbxUploadText = async function(){ return {}; };
    sandbox.dbxDelete = async function(p){ deletedPaths.push(p); };

    await sandbox._bkFire('fourHour', makeBlob('test-blob'));

    assert('R2: exactly 1 file deleted (dedup of 4hour slot 0)', deletedPaths.length === 1);
    assert('R2a: deleted file is 4hour prefix', deletedPaths[0].indexOf('/questa-backups/4hour-') === 0);
    assert('R2b: daily files NOT deleted', deletedPaths.every(function(p){ return p.indexOf('daily-') === -1; }));
  }

  // =====================================================================
  // R3: No cross-device deletion
  // _bkFire('fourHour') with device 123456 only touches 4hour-123456-*
  // entries, never 4hour-abcdef-* entries.
  // Setup: 2 entries slot 0 for device 123456 (triggers dedup → 1 delete),
  //        2 entries slot 0 for device abcdef (should be untouched).
  // =====================================================================
  {
    resetBkLocal();
    var deletedPaths = [];
    sandbox.dbxListFolder = async function(){
      return [
        { name: '4hour-123456-00-20260701-120000.json' },
        { name: '4hour-123456-00-20260701-130000.json' },
        { name: '4hour-abcdef-00-20260701-120000.json' },
        { name: '4hour-abcdef-00-20260701-130000.json' }
      ];
    };
    sandbox.dbxUploadText = async function(){ return {}; };
    sandbox.dbxDelete = async function(p){ deletedPaths.push(p); };

    await sandbox._bkFire('fourHour', makeBlob('test-blob'));

    assert('R3: exactly 1 file deleted (dedup of device 123456 slot 0)', deletedPaths.length === 1);
    assert('R3a: deleted file is for device 123456', deletedPaths[0].indexOf('4hour-123456-') !== -1);
    assert('R3b: device abcdef entries NOT deleted', deletedPaths.every(function(p){ return p.indexOf('abcdef') === -1; }));
  }

  // =====================================================================
  // R4: Concurrent multi-tier single-blob
  // syncMaybeAutoExport enables fourHour + daily, both due (lastTs=0),
  // verifies buildBackupFile called exactly once even though 2 tiers fire.
  // =====================================================================
  {
    resetBkLocal();
    var buildCount = 0;
    sandbox.buildBackupFile = async function(eventsArr){
      buildCount++;
      return { blob: makeBlob('test-blob-' + buildCount), filename: 'test.json', eventCount: eventsArr.length };
    };
    sandbox.getEvents = async function(){ return []; };
    sandbox.S.prefs = {
      autoBackupEnabled: { fourHour: true, daily: true }
    };
    sandbox.dbxListFolder = async function(){ return []; };
    sandbox.dbxUploadText = async function(){ return {}; };
    sandbox.dbxDelete = async function(){};

    await Q.maybeAutoExport();

    assert('R4: buildBackupFile called exactly once for 2 concurrent tiers', buildCount === 1);
  }

  // R4 variant: only one tier enabled
  {
    resetBkLocal();
    var buildCount2 = 0;
    sandbox.buildBackupFile = async function(){
      buildCount2++;
      return { blob: makeBlob('single-tier'), filename: 'test.json', eventCount: 0 };
    };
    sandbox.getEvents = async function(){ return []; };
    sandbox.S.prefs = {
      autoBackupEnabled: { fourHour: true, daily: false }
    };

    await Q.maybeAutoExport();

    assert('R4a: buildBackupFile called once with single enabled tier', buildCount2 === 1);
  }

  // R4 variant: no tiers enabled → buildBackupFile never called
  {
    resetBkLocal();
    var buildCount3 = 0;
    sandbox.buildBackupFile = async function(){
      buildCount3++;
      return { blob: makeBlob('should-not-happen'), filename: 'test.json', eventCount: 0 };
    };
    sandbox.getEvents = async function(){ return []; };
    sandbox.S.prefs = {
      autoBackupEnabled: { fourHour: false, daily: false }
    };

    await Q.maybeAutoExport();

    assert('R4b: buildBackupFile not called when no tiers enabled', buildCount3 === 0);
  }

  // =====================================================================
  // R5: Duplicate-slot cleanup
  // Two files share the same slot number (0) with different stamps.
  // The older one (lower stamp) must be deleted, newer kept.
  // =====================================================================
  {
    resetBkLocal();
    var deletedPaths = [];
    sandbox.dbxListFolder = async function(){
      return [
        { name: '4hour-123456-00-20260701-120000.json' },
        { name: '4hour-123456-00-20260701-140000.json' }
      ];
    };
    sandbox.dbxUploadText = async function(){ return {}; };
    sandbox.dbxDelete = async function(p){ deletedPaths.push(p); };

    await sandbox._bkFire('fourHour', makeBlob('test-blob'));

    assert('R5: exactly 1 file deleted for duplicate slot', deletedPaths.length === 1);
    assert('R5a: the OLDER file (120000) was deleted, not the newer (140000)',
      deletedPaths[0] === '/questa-backups/4hour-123456-00-20260701-120000.json');
  }

  // R5 variant: 3 files in same slot → only the 2 older ones deleted
  {
    resetBkLocal();
    var deletedPaths2 = [];
    sandbox.dbxListFolder = async function(){
      return [
        { name: '4hour-123456-00-20260701-100000.json' },
        { name: '4hour-123456-00-20260701-120000.json' },
        { name: '4hour-123456-00-20260701-140000.json' }
      ];
    };
    sandbox.dbxUploadText = async function(){ return {}; };
    sandbox.dbxDelete = async function(p){ deletedPaths2.push(p); };

    await sandbox._bkFire('fourHour', makeBlob('test-blob'));

    assert('R5b: 2 files deleted from triple-duplicate slot', deletedPaths2.length === 2);
    assert('R5c: second-newest (120000) deleted first',
      deletedPaths2[0] === '/questa-backups/4hour-123456-00-20260701-120000.json');
    assert('R5d: oldest (100000) deleted second',
      deletedPaths2[1] === '/questa-backups/4hour-123456-00-20260701-100000.json');
  }
}

runTests().then(function(){
  if(failures){ console.error(failures + ' auto-backup-rotation assertion(s) FAILED'); process.exit(1); }
  console.log('auto-backup-rotation.test.js: all assertions passed');
}).catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
