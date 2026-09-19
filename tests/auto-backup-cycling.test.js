// auto-backup-cycling.test.js -- slot modulo cycling and the bkVersion lazy
// self-heal in _bkFire(). The last entry in AGENTS.md's "Known coverage gaps",
// tracked as P2 in .kilo/plans/1785344033093-dropbox-cycling-backups-review.md.
//
// tests/auto-backup-rotation.test.js already covers _bkListTier's scoping (R1),
// cross-tier and cross-device isolation (R2/R3), the single blob build (R4) and
// same-slot dedup by stamp (R5). Nothing anywhere touched bkVersion, the
// self-heal, the modulo wrap, the over-count eviction, or the just-written pin --
// and two of those are round-2 fixes that have had no standing guard since.
//
//   C1  bkLocalLoad normalises an absent bkVersion to 0, NOT 1
//   C2  self-heal: bkVersion 0 adopts (maxSlot + 1) from what Dropbox already holds
//   C3  self-heal on a fresh device (no files) starts at slot 0
//   C4  self-heal wraps: a full tier comes back to slot 0, not slot count
//   C5  bkVersion 1 does NOT re-heal -- the stored idx is used verbatim
//   C6  a listing failure degrades to "no files" and still stamps bkVersion 1
//   C7  the persisted idx advances by one after a fire
//   C8  ...and wraps modulo the tier count at the end of the cycle
//   C9  the slot in the filename is zero-padded to two digits
//   C10 more occupied slots than the tier allows: oldest evicted, never the
//       slot just written
//   C11 the just-written file survives dedup even when the clock went BACKWARDS
//
// Run: node tests/auto-backup-cycling.test.js   (also run by `node tests/run.js`)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const BK_KEY = 'questa.autobackup.local';
const noop = function(){};
const inMemStore = {};

inMemStore['questa.sync.v1'] = JSON.stringify({
  enabled: true, appKey: 'test-key',
  refreshToken: 'mock-refresh-token', accessToken: 'mock-access-token',
  accessExpiresAt: Date.now() + 3600000,
  lastRev: 'r1', lastSyncAt: null, lastError: null,
  deviceId: 'abc1123456',            // _bkDeviceShort() -> '123456'
  evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0
});
const DEV = '123456';

// A controllable clock. _bkFire takes `now = Date.now()` and _bkStamp renders it
// into the filename, so C11 (the backwards-clock case) cannot be written without
// this. Everything else about Date is the real thing.
const RealDate = Date;
let fakeNow = RealDate.now();
function DateStub(v){ return arguments.length ? new RealDate(v) : new RealDate(DateStub.now()); }
DateStub.now = function(){ return fakeNow; };
DateStub.parse = RealDate.parse;
DateStub.UTC = RealDate.UTC;
DateStub.prototype = RealDate.prototype;

const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: {
    getItem: function(k){ return inMemStore[k] || null; },
    setItem: function(k, v){ inMemStore[k] = String(v); },
    removeItem: function(k){ delete inMemStore[k]; },
    key: function(){ return null; }, length: 0
  },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(fn){ return fn; },
  clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: DateStub, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  isNaN: isNaN, parseInt: parseInt, RegExp: RegExp,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'test-uid'; },
  idbOpen: function(){ return Promise.resolve(null); }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
sandbox.S = {
  char: { name: 'Test', lvl: 1, updatedAt: 1000 },
  tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
  history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: [], prefs: {}
};

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e){ /* registry is assigned before the boot code */ }

for(const name of ['_bkFire', 'bkLocalLoad', '_bkPath']){
  if(typeof sandbox[name] !== 'function'){
    console.error('FAIL: ' + name + ' not found in sandbox'); process.exit(1);
  }
}
// BK_TIERS is a top-level `const`, and in a vm context those live in the global
// LEXICAL scope rather than becoming properties of the sandbox object -- only
// function declarations do that. Read it by evaluating the name in the context.
const BK_TIERS = vm.runInContext('BK_TIERS', sandbox);
if(!BK_TIERS || !BK_TIERS.fourHour){ console.error('FAIL: BK_TIERS not readable'); process.exit(1); }

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

function makeBlob(text){ return { text: async function(){ return text || '{}'; } }; }
function stamp(ts){
  const d = new RealDate(ts), p = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function fileName(prefix, slot, ts){
  return prefix + '-' + DEV + '-' + String(slot).padStart(2, '0') + '-' + stamp(ts) + '.json';
}
// Returns {uploads, deletes} for one _bkFire call against a given remote listing.
async function fire(tierKey, opts){
  opts = opts || {};
  const uploads = [], deletes = [];
  if(opts.bk === null) delete inMemStore[BK_KEY];
  else if(opts.bk) inMemStore[BK_KEY] = JSON.stringify(opts.bk);
  // The folder is LIVE, not a fixed fixture. _bkFire lists again AFTER its upload
  // and dedups what it finds, so a static listing hides the just-written file from
  // the dedup entirely -- which is the one thing C11 is about. Uploads join the
  // listing and deletes leave it, exactly as Dropbox would behave.
  const folder = (opts.remote || []).slice();
  sandbox.dbxListFolder = async function(){
    if(opts.listThrows) throw new Error('dropbox down');
    return folder.map(function(n){ return { name: n }; });
  };
  sandbox.dbxUploadText = async function(p){
    uploads.push(p);
    const name = String(p).replace('/questa-backups/', '');
    if(folder.indexOf(name) === -1) folder.push(name);
    return { rev: 'r' };
  };
  sandbox.dbxDelete = async function(p){
    deletes.push(p);
    const at = folder.indexOf(String(p).replace('/questa-backups/', ''));
    if(at !== -1) folder.splice(at, 1);
    return {};
  };
  if(opts.now !== undefined) fakeNow = opts.now;
  await sandbox._bkFire(tierKey, makeBlob());
  return { uploads: uploads, deletes: deletes, bk: JSON.parse(inMemStore[BK_KEY] || '{}') };
}
function slotOf(p){ const m = /-(\d\d)-\d{8}-\d{6}\.json$/.exec(p || ''); return m ? Number(m[1]) : null; }

const T0 = RealDate.UTC(2026, 6, 1, 12, 0, 0);
const HOUR = 3600000;

async function main(){
  const TIERS = BK_TIERS;
  assertEq('C0 fourHour keeps 10 slots (the fixture below depends on it)', TIERS.fourHour.count, 10);
  assertEq('C0b weekly keeps 4', TIERS.weekly.count, 4);

  // =====================================================================
  // C1 -- bkLocalLoad's normalisation. Round-2 item 50: this defaulted an absent
  // bkVersion to 1 (and _BK_DEFAULT seeded 1), which made `typeof !== 'number' ||
  // < 1` at the self-heal impossible to satisfy -- the branch was DEAD. A device
  // whose site data had been evicted then restarted the rotation at slot 0 and the
  // dedup step deleted the NEWEST backups, keeping the oldest.
  // =====================================================================
  {
    delete inMemStore[BK_KEY];
    const fresh = sandbox.bkLocalLoad();
    assert('C1a a store with no saved state defaults every tier to bkVersion 0',
      ['fourHour', 'daily', 'weekly', 'monthly'].every(function(k){ return fresh[k].bkVersion === 0; }));

    inMemStore[BK_KEY] = JSON.stringify({ fourHour: { lastTs: 111, idx: 3 } });
    const partial = sandbox.bkLocalLoad();
    assertEq('C1b an entry saved WITHOUT bkVersion normalises to 0, not 1 (the self-heal must stay reachable)',
      partial.fourHour.bkVersion, 0);
    assertEq('C1c ...and its other fields are preserved', partial.fourHour.idx, 3);

    inMemStore[BK_KEY] = JSON.stringify({ fourHour: { bkVersion: 1, lastTs: 111, idx: 3 } });
    assertEq('C1d a healed entry keeps bkVersion 1', sandbox.bkLocalLoad().fourHour.bkVersion, 1);

    inMemStore[BK_KEY] = 'not json at all';
    assertEq('C1e unparseable state falls back to the default, heal armed',
      sandbox.bkLocalLoad().fourHour.bkVersion, 0);
  }

  // =====================================================================
  // C2 -- the self-heal itself. Local bookkeeping is gone, but Dropbox still holds
  // slots 00-03, so the next write must be slot 04 rather than clobbering slot 00.
  // =====================================================================
  {
    const remote = [0, 1, 2, 3].map(function(s){ return fileName('4hour', s, T0 - (10 - s) * HOUR); });
    const r = await fire('fourHour', { bk: null, remote: remote, now: T0 });
    assertEq('C2a one file is uploaded', r.uploads.length, 1);
    assertEq('C2b the self-heal resumes at maxSlot + 1, not at 0', slotOf(r.uploads[0]), 4);
    assertEq('C2c bkVersion is stamped 1 so the heal does not run again', r.bk.fourHour.bkVersion, 1);
    assertEq('C2d the persisted idx advances past the slot just written', r.bk.fourHour.idx, 5);
    assertEq('C2e nothing is deleted -- 5 slots is under the 10-slot cap', r.deletes.length, 0);
  }

  // =====================================================================
  // C3 -- a genuinely fresh device. maxSlot stays -1, so (maxSlot + 1) is 0.
  // =====================================================================
  {
    const r = await fire('fourHour', { bk: null, remote: [], now: T0 });
    assertEq('C3a a fresh device seeds slot 0', slotOf(r.uploads[0]), 0);
    assertEq('C3b ...and the next fire is aimed at slot 1', r.bk.fourHour.idx, 1);
  }

  // =====================================================================
  // C4 -- the wrap. A FULL fourHour tier (slots 00-09) must heal back to slot 0.
  // Without the modulo this lands on slot 10, which is outside the cycle and grows
  // the folder forever.
  // =====================================================================
  {
    const remote = [];
    for(let s = 0; s <= 9; s++) remote.push(fileName('4hour', s, T0 - (20 - s) * HOUR));
    const r = await fire('fourHour', { bk: null, remote: remote, now: T0 });
    assertEq('C4a a full tier heals back to slot 0, not slot 10', slotOf(r.uploads[0]), 0);
    assertEq('C4b ...and the persisted idx follows it to 1', r.bk.fourHour.idx, 1);
  }

  // =====================================================================
  // C5 -- an already-healed device must NOT re-derive its slot from Dropbox. The
  // stored idx wins even though the remote listing would suggest a higher slot;
  // re-deriving every fire would ignore local bookkeeping entirely.
  // =====================================================================
  {
    const remote = [0, 1, 2, 3, 4, 5].map(function(s){ return fileName('4hour', s, T0 - (10 - s) * HOUR); });
    const r = await fire('fourHour', {
      bk: { fourHour: { bkVersion: 1, lastTs: T0 - HOUR, idx: 2 }, daily: { bkVersion: 1, lastTs: 0, idx: 0 },
            weekly: { bkVersion: 1, lastTs: 0, idx: 0 }, monthly: { bkVersion: 1, lastTs: 0, idx: 0 } },
      remote: remote, now: T0
    });
    assertEq('C5a the stored idx is used verbatim, no re-heal', slotOf(r.uploads[0]), 2);
    assertEq('C5b ...and it advances from there', r.bk.fourHour.idx, 3);
  }

  // =====================================================================
  // C6 -- Dropbox unreachable during the heal. _bkListTier swallows its own
  // errors and returns [], so this degrades to the fresh-device answer. bkVersion
  // must still be stamped, or every later fire re-lists and re-seeds slot 0.
  // NOTE: because _bkListTier never rethrows, the try/catch around the heal in
  // _bkFire is unreachable in practice. Recorded, not changed -- the observable
  // behaviour below is the contract.
  // =====================================================================
  {
    const r = await fire('fourHour', { bk: null, listThrows: true, now: T0 });
    assertEq('C6a a listing failure still writes a backup', r.uploads.length, 1);
    assertEq('C6b ...at slot 0, the no-files answer', slotOf(r.uploads[0]), 0);
    assertEq('C6c ...and bkVersion is stamped so it does not re-heal forever', r.bk.fourHour.bkVersion, 1);
  }

  // =====================================================================
  // C7/C8/C9 -- plain cycling, no heal. Each fire advances one slot, the last slot
  // wraps to 0, and the slot is zero-padded to two digits in the filename.
  // =====================================================================
  {
    const r = await fire('weekly', {
      bk: { fourHour: { bkVersion: 1, lastTs: 0, idx: 0 }, daily: { bkVersion: 1, lastTs: 0, idx: 0 },
            weekly: { bkVersion: 1, lastTs: T0 - HOUR, idx: 1 }, monthly: { bkVersion: 1, lastTs: 0, idx: 0 } },
      remote: [], now: T0
    });
    assertEq('C7a the fire writes the stored slot', slotOf(r.uploads[0]), 1);
    assertEq('C7b ...and the persisted idx advances by one', r.bk.weekly.idx, 2);
    assertEq('C7c ...and lastTs is stamped with the fire time', r.bk.weekly.lastTs, T0);

    const last = await fire('weekly', {
      bk: { fourHour: { bkVersion: 1, lastTs: 0, idx: 0 }, daily: { bkVersion: 1, lastTs: 0, idx: 0 },
            weekly: { bkVersion: 1, lastTs: T0 - HOUR, idx: 3 }, monthly: { bkVersion: 1, lastTs: 0, idx: 0 } },
      remote: [], now: T0
    });
    assertEq('C8a the last slot of a 4-slot tier is written', slotOf(last.uploads[0]), 3);
    assertEq('C8b ...and the idx wraps to 0 rather than running to 4', last.bk.weekly.idx, 0);

    assert('C9 the slot is zero-padded to two digits in the path',
      /weekly-123456-03-\d{8}-\d{6}\.json$/.test(last.uploads[0]));
  }

  // =====================================================================
  // C10 -- over-count eviction. Weekly allows 4 slots; the remote holds 6 from an
  // earlier, wider configuration. The oldest slots by their newest stamp go, and
  // the slot this call just wrote is explicitly skipped by the eviction loop.
  // =====================================================================
  {
    const remote = [];
    for(let s = 0; s <= 5; s++) remote.push(fileName('weekly', s, T0 - (20 - s) * HOUR));
    const r = await fire('weekly', {
      bk: { fourHour: { bkVersion: 1, lastTs: 0, idx: 0 }, daily: { bkVersion: 1, lastTs: 0, idx: 0 },
            weekly: { bkVersion: 1, lastTs: T0 - HOUR, idx: 0 }, monthly: { bkVersion: 1, lastTs: 0, idx: 0 } },
      remote: remote, now: T0
    });
    // Slot 0 is rewritten by this call, so after dedup six slots remain occupied
    // and two must go: the oldest by newest-stamp, skipping slot 0.
    assert('C10a the over-count backstop deletes down to the tier count',
      r.deletes.filter(function(p){ return !/-00-/.test(p); }).length >= 2);
    assert('C10b the slot just written is never evicted',
      !r.deletes.some(function(p){ return p === r.uploads[0]; }));
    assert('C10c the evicted slots are the oldest ones (01 and 02), not the newest',
      r.deletes.some(function(p){ return /weekly-123456-01-/.test(p); }) &&
      r.deletes.some(function(p){ return /weekly-123456-02-/.test(p); }) &&
      !r.deletes.some(function(p){ return /weekly-123456-05-/.test(p); }));
  }

  // =====================================================================
  // C11 -- round-2's just-written pin. Dedup sorts a slot's files by their
  // filename stamp and keeps the "newest". After the clock is corrected BACKWARDS
  // -- a rewind this repo guards elsewhere (tests/cron-day-rewind.test.js) -- the
  // stale file sorts higher and the FRESH backup was the one deleted, while idx
  // and lastTs still advanced and the log said the upload succeeded. The
  // just-written path is now pinned to the front of its slot regardless of stamp.
  // =====================================================================
  {
    const stale = fileName('weekly', 0, T0 + 5 * HOUR); // stamped in the "future"
    const r = await fire('weekly', {
      bk: { fourHour: { bkVersion: 1, lastTs: 0, idx: 0 }, daily: { bkVersion: 1, lastTs: 0, idx: 0 },
            weekly: { bkVersion: 1, lastTs: 0, idx: 0 }, monthly: { bkVersion: 1, lastTs: 0, idx: 0 } },
      remote: [stale], now: T0            // clock has gone backwards relative to `stale`
    });
    const written = r.uploads[0];
    assert('C11a the fresh backup was uploaded', !!written);
    assert('C11b the higher-sorting STALE file is the one deleted',
      r.deletes.indexOf('/questa-backups/' + stale) !== -1);
    assert('C11c ...and the file this call just wrote survives',
      r.deletes.indexOf(written) === -1);
  }

  console.log('\n--- auto-backup-cycling.test.js summary ---');
  if(failures){ console.error(failures + ' assertion(s) FAILED'); process.exit(1); }
  console.log('auto-backup-cycling.test.js: all assertions passed');
  process.exit(0);
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
