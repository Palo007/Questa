// round3-sync-bounds.test.js -- round 3 triage, items 2, 3 and 4.
//
// R3-A  item 3: cfg.evtFileCounts must not grow without bound.
//               A1 a month whose records have all aged out is dropped.
//               A2 an unparseable key is dropped.
//               A3 the live month survives and is rewritten.
//               A4 a not-yet-started month (skewed clock) is dropped, and the
//                  live month's guard survives a flood of them.
//               A5 evtFileCounts never exceeds the hard cap after a push.
//
// R3-B  item 4: the pull's duplicate guard must be COMPLETE or the file skipped.
//               B1 a failed guard read does NOT insert.
//               B2 ...does NOT cache the rev (so the file is retried).
//               B3 ...lands in badRevs.
//               B4 a healthy guard read still inserts and caches the rev.
//               B5 app.js getEvents() honours `strict` on all 3 failure paths.
//
// R3-C  item 2: force push / force pull must take the SAME cross-tab Web Lock
//               that syncNow() takes.
//               C1 force push requests 'questa-sync' exclusively.
//               C2 force pull requests 'questa-sync' exclusively.
//               C3 a force op does not start while the lock is held elsewhere.
//
// Run: node tests/round3-sync-bounds.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const noop = function(){};
let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

const NOW = Date.now();
const DAY = 86400000;
// sync.js falls back to 18*30 days when EVENT_AGE_LIMIT_MS is absent (it is, here).
const AGE_LIMIT = 18 * 30 * DAY;

function monthKeyOf(ts){
  const d = new Date(ts);
  return String(d.getUTCFullYear()).padStart(4, '0') + String(d.getUTCMonth() + 1).padStart(2, '0');
}
const MK_NOW = monthKeyOf(NOW);
const MK_ANCIENT = monthKeyOf(NOW - 5 * 365 * DAY);   // far below the age cutoff

// --- sandbox ---------------------------------------------------------------
const inMemStore = {};
const seedConfig = {
  enabled: true, appKey: 'test-key',
  refreshToken: 'mock-refresh-token',
  accessToken: 'mock-access-token',
  accessExpiresAt: NOW + 3600000,
  deviceId: 'devA',
  lastRev: 'r1', lastSyncAt: null, lastError: null,
  evtLastUploadTs: 0, evtFullPushAt: 0,
  evtFileRevs: {}, evtBadRevs: {}, evtFileCounts: {}, evtPushBlocked: {},
  evtLastPullAt: 0, evtFullScanAt: 0
};

const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: {
    getItem: function(k){ return inMemStore[k] || null; },
    setItem: function(k, v){ inMemStore[k] = v; },
    removeItem: function(k){ delete inMemStore[k]; },
    key: function(){ return null; }, length: 0
  },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(fn){ return fn; }, clearTimeout: noop,
  setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'test-uid'; },
  idbOpen: function(){ return Promise.resolve(null); },
  getEvents: function(){ return Promise.resolve([]); }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
sandbox.S = {
  char: { name: 'Test', lvl: 1, updatedAt: 1000 },
  tasks: [], rewards: [], tags: [], devices: [],
  an: { views: [], metrics: [] },
  history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
};

inMemStore['questa.sync.v1'] = JSON.stringify(seedConfig);
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) {}

const Q = sandbox.window.QuestaSync;
if(!Q){ console.error('FAIL: QuestaSync not found'); process.exit(1); }

function setCfg(patch){
  inMemStore['questa.sync.v1'] = JSON.stringify(Object.assign({}, seedConfig, patch));
}
function readCfg(){ return JSON.parse(inMemStore['questa.sync.v1']); }

// ===========================================================================
// R3-A  item 3 -- evtFileCounts is bounded
// ===========================================================================
function ownEvent(ts, uid){
  return { uid: uid, dev: 'devA', ts: ts, kind: 'tap', taskId: 't1' };
}
// One live own event in the current month; nothing else.
const pushRows = [ownEvent(NOW - 1000, 'e-live')];
sandbox.getEvents = function(opts){
  opts = opts || {};
  const from = (opts.from != null) ? opts.from : -Infinity;
  const to   = (opts.to   != null) ? opts.to   : Infinity;
  return Promise.resolve(pushRows.filter(e => e.ts >= from && e.ts <= to));
};
let uploads = [];
sandbox.dbxUploadText = function(p){ uploads.push(p); return Promise.resolve({ rev: 'rX' }); };

async function testA(){
  setCfg({
    evtFileCounts: {
      ['devA-' + MK_ANCIENT + '.json']: { count: 3, hash: 'h-old', uids: ['o1','o2','o3'] },
      ['devA-' + MK_NOW + '.json']:     { count: 1, hash: 'h-now', uids: ['e-live'] },
      'not-an-event-file.json':         { count: 9, hash: 'h-junk', uids: ['j1'] }
    }
  });
  uploads = [];
  await sandbox.syncEventsPush({});
  const fc = readCfg().evtFileCounts || {};

  assert('A1: an aged-out month is dropped from evtFileCounts',
    fc['devA-' + MK_ANCIENT + '.json'] === undefined);
  assert('A2: an unparseable evtFileCounts key is dropped',
    fc['not-an-event-file.json'] === undefined);
  assert('A3: the live month survives and was rewritten',
    !!fc['devA-' + MK_NOW + '.json'] && fc['devA-' + MK_NOW + '.json'].count === 1);
  assert('A3b: the live month was actually uploaded', uploads.length === 1);

  // A4: a month that has not STARTED yet can never be a real upload record -- it
  // only appears from a badly wrong clock. Before rule 1b these survived the age
  // rule, were the only input that could push the object past the cap, and the cap
  // then evicted by month NAME -- so the real current month (numerically smallest)
  // was thrown away first and the one guard that matters was the one lost.
  const many = {};
  const futureKeys = [];
  const baseYear = new Date(NOW).getUTCFullYear();
  for(let i = 1; i <= 250; i++){
    const mk = monthKeyOf(Date.UTC(baseYear + 1 + Math.floor(i / 12), i % 12, 1));
    if(futureKeys.indexOf(mk) !== -1) continue;
    futureKeys.push(mk);
    many['devA-' + mk + '.json'] = { count: 1, hash: 'h', uids: ['u' + i] };
  }
  // the live month's real guard sits in the same object, as it would in the field
  many['devA-' + MK_NOW + '.json'] = { count: 1, hash: 'h-now', uids: ['e-live'] };
  setCfg({ evtFileCounts: many });
  await sandbox.syncEventsPush({});
  const fc2 = readCfg().evtFileCounts || {};

  assert('A4: a not-yet-started month is dropped from evtFileCounts',
    futureKeys.every(mk => fc2['devA-' + mk + '.json'] === undefined));
  assert('A4b: the CURRENT month keeps its guard despite the future-month flood',
    !!fc2['devA-' + MK_NOW + '.json']);
  assert('A4c: only the live month survives (250 junk entries in, 1 out)',
    Object.keys(fc2).length === 1);
  // A5: the standing invariant, whatever mix went in.
  assert('A5: evtFileCounts never exceeds the hard cap after a push',
    Object.keys(fc2).length <= 240);
}

// ===========================================================================
// R3-B  item 4 -- the pull's duplicate guard must be complete or skip
// ===========================================================================
async function testB(){
  const peerFile = 'devB-' + MK_NOW + '.json';
  const peerRecords = [{ uid: 'p1', dev: 'devB', ts: NOW - 2000, kind: 'tap', taskId: 't1' }];

  sandbox.dbxListFolder = function(){ return Promise.resolve([{ name: peerFile, rev: 'rev-1' }]); };
  sandbox.dbxDownloadRaw = function(){
    return Promise.resolve({ text: JSON.stringify(peerRecords), rev: 'rev-1' });
  };
  let inserts = 0;
  sandbox.evtInsertNew = function(recs){
    inserts += (recs || []).length;
    return Promise.resolve({ added: (recs || []).length, ok: true });
  };

  // --- B1..B3: the guard read FAILS (strict -> null) ---
  sandbox.getEvents = function(opts){
    if(opts && opts.strict) return Promise.resolve(null);   // IDB read error
    return Promise.resolve([]);
  };
  setCfg({});
  inserts = 0;
  await sandbox.syncEventsPull({ force: true });
  let cfg = readCfg();
  assert('B1: a failed duplicate-guard read inserts nothing', inserts === 0);
  assert('B2: ...and does NOT cache the rev, so the file is retried',
    (cfg.evtFileRevs || {})[peerFile] === undefined);
  assert('B3: ...and is recorded in badRevs for the backoff retry',
    !!(cfg.evtBadRevs || {})[peerFile]);

  // --- B4: the guard read SUCCEEDS ---
  sandbox.getEvents = function(){ return Promise.resolve([]); };
  setCfg({});
  inserts = 0;
  await sandbox.syncEventsPull({ force: true });
  cfg = readCfg();
  assert('B4: a healthy guard read inserts and caches the rev',
    inserts === 1 && (cfg.evtFileRevs || {})[peerFile] === 'rev-1');

  // --- B5: app.js getEvents() really honours `strict` on every failure path ---
  const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const body = appSrc.slice(appSrc.indexOf('function getEvents(opts){'));
  const head = body.slice(0, body.indexOf('function countEvents'));
  assert('B5: getEvents() reports failure as null on all 3 paths when strict',
    /const strict = !!opts\.strict;/.test(head)
    && /catch\(e\)\{ resolve\(strict \? null : \[\]\); return; \}/.test(head)
    && /cursorReq\.onerror = \(\)=>resolve\(strict \? null : out\);/.test(head)
    && /\.catch\(\(\)=>strict \? null : \[\]\)/.test(head));
}

// ===========================================================================
// R3-C  item 2 -- force push / force pull take the cross-tab Web Lock
// ===========================================================================
async function testC(){
  const requested = [];
  let heldRelease = null;
  sandbox.navigator.locks = {
    request: function(name, opts, fn){
      requested.push({ name: name, mode: opts && opts.mode });
      const gate = heldRelease ? heldRelease : Promise.resolve();
      return gate.then(fn);
    }
  };

  let pushRan = 0, pullRan = 0;
  sandbox._syncForcePushAttempt = function(){ pushRan++; return Promise.resolve(); };
  sandbox._syncForcePullAttempt = function(){ pullRan++; return Promise.resolve(); };

  setCfg({});
  await Q.forcePush();
  assert('C1: force push takes the shared "questa-sync" lock, exclusively',
    requested.length === 1 && requested[0].name === 'questa-sync' && requested[0].mode === 'exclusive');

  setCfg({});
  await Q.forcePull();
  assert('C2: force pull takes the shared "questa-sync" lock, exclusively',
    requested.length === 2 && requested[1].name === 'questa-sync' && requested[1].mode === 'exclusive');

  // C3: while another tab holds the lock, the force op must WAIT. Before the
  // fix it only checked _syncInFlight, a per-tab variable no other tab can see,
  // so it ran straight through and raced that tab's merge+upload.
  let release;
  heldRelease = new Promise(res => { release = res; });
  setCfg({});
  pushRan = 0;
  const p = Q.forcePush();
  await Promise.resolve(); await Promise.resolve();
  const ranWhileHeld = pushRan;
  release();
  await p;
  assert('C3: a force op does not start while another holder has the lock',
    ranWhileHeld === 0 && pushRan === 1);
}

(async function(){
  try{
    await testA();
    await testB();
    await testC();
  }catch(e){
    console.error('Unhandled:', e && e.stack || e);
    process.exit(1);
  }
  if(failures){ console.error(failures + ' round3-sync-bounds assertion(s) FAILED'); process.exit(1); }
  console.log('round3-sync-bounds.test.js: all assertions passed');
})();
