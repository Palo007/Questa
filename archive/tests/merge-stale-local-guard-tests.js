// archive/tests/merge-stale-local-guard-tests.js — run: node archive/tests/merge-stale-local-guard-tests.js
// Unit tests for GUARD 3 / Phase B (2026-07-11 persistence-loss fix): merge()
// must never let a whole-state-stale `local` (a localStorage revert) delete or
// revert records that `base` + `remote` agree are current.
// Design: .omo/plans/2026-07-11-persistence-loss-fix-plan.md §3, §4.
// Same vm-sandbox pattern as recency-guard-tests.js (loads sync.js only).
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', '..', 'sync.js'), 'utf8');
const ctx = {
  console, setTimeout, clearTimeout, Date, JSON, Math, Promise, String, Object, Array, Map, Set,
  addEventListener(){},
  navigator: { onLine: false },
  localStorage: { _m: {}, getItem(k){ return this._m[k] || null; }, setItem(k, v){ this._m[k] = String(v); }, removeItem(k){ delete this._m[k]; } },
  location: { origin: 'http://localhost', pathname: '/', search: '' },
  history: { replaceState(){} },
  document: { addEventListener(){}, getElementById(){ return null; }, visibilityState: 'hidden' },
  fetch: async () => { throw new Error('no network in tests'); },
  S: { tasks: [], char: {}, rewards: [], tags: [], devices: [], prefs: {} },
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx);

let fails = 0;
function assert(name, cond){
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if(!cond) fails++;
}

const { mergeCollection } = ctx.QuestaSync;
const T = (id, title, up, extra) => Object.assign({ id, type: 'todo', title, updatedAt: up }, extra || {});

// ---- Regression of THIS bug: base+remote have a new task, local reverted to
// a snapshot from BEFORE the task was created -> the new task must SURVIVE,
// not be inferred as a deletion. -----------------------------------------
{
  // The task was created at t=5000. base and remote both saw it (sync had
  // completed before the app-kill). local reverted to a snapshot saved at
  // t=1000 -- before this task existed on this device at all.
  const t2 = T('t2', 'New task', 5000, { createdAt: 5000 });
  const base   = [t2];
  const local  = []; // reverted local never saw t2
  const remote = [t2];
  const localSavedAt = 1000;
  const merged = mergeCollection(base, local, remote, /*remoteSavedAt*/ null, localSavedAt);
  assert('R1 new task created after the stale local snapshot -> survives (not a deletion)', !!merged.find(t => t.id === 't2'));
}

// ---- Rename case: base+remote have the new title, local (reverted) carries
// the OLD title from before the rename -> the new title must WIN. ----------
{
  // Renamed at t=5000. local reverted to a snapshot saved at t=1000, so it
  // still shows the pre-rename title.
  const base   = [T('t1', 'Questa', 5000)];
  const local  = [T('t1', 'Old Title', 1000)]; // whole-state-stale local
  const remote = [T('t1', 'Questa', 5000)];
  const localSavedAt = 1000;
  const merged = mergeCollection(base, local, remote, null, localSavedAt);
  const t1 = merged.find(t => t.id === 't1');
  assert('R2 rename reverted by stale local -> new title "Questa" wins', t1 && t1.title === 'Questa');
}

// ---- TOMBSTONE MODEL (2026-07-12): deletion is driven by an explicit tombstone,
// NOT by a record's absence from a local snapshot (which could be a stale/partial
// revert -- the class of bug that lost long-streak dailies). R3a: absence WITHOUT
// a tombstone now KEEPS the record. R3b: the same absence WITH a tombstone newer
// than the record deletes it. ---------------------------------------------------
{
  const t2 = T('t2', 'Old task', 1000, { createdAt: 1000 });
  const base   = [t2];
  const local  = []; // absent locally, but NO tombstone recorded
  const remote = [t2];
  const localSavedAt = 9000;
  const noTomb = mergeCollection(base, local, remote, null, localSavedAt);
  assert('R3a absence without a tombstone -> record KEPT (tombstone model)', !!noTomb.find(t => t.id === 't2'));
  const withTomb = mergeCollection(base, local, remote, null, localSavedAt, new Map([['t2', 2000]]));
  assert('R3b absence WITH a tombstone (at>updatedAt) -> record deleted', !withTomb.find(t => t.id === 't2'));
}

// ---- Genuine rename still propagates: local is NEWER than base's record and
// carries a real edit -> local edit must still win (guard must not fire). --
{
  const base   = [T('t1', 'Old Title', 1000)];
  const local  = [T('t1', 'New Title (real edit)', 9000)];
  const remote = [T('t1', 'Old Title', 1000)];
  const localSavedAt = 9000; // local snapshot saved AT/AFTER the edit -- not stale
  const merged = mergeCollection(base, local, remote, null, localSavedAt);
  const t1 = merged.find(t => t.id === 't1');
  assert('R4 genuine rename (local newer) still wins, guard does not fire', t1 && t1.title === 'New Title (real edit)');
}

// ---- Parity: when localSavedAt is not stale (>= base's record time), the
// outcome must be BYTE-IDENTICAL to the pre-Phase-B behavior. Re-run the
// existing recency-guard fixtures both with and without localSavedAt. ------
{
  // G1a fixture from recency-guard-tests.js: poisoned base, rename revert.
  const base   = [T('t1', 'Questa', 2000)];
  const local  = [T('t1', 'Questa', 2000)];
  const remote = [T('t1', 'Cuesta', 1000)];
  const withoutGuard = mergeCollection(base, local, remote, 500);
  const withParitySavedAt = mergeCollection(base, local, remote, 500, 2000); // localSavedAt == base's record time -> not stale
  assert('R5a parity: non-stale localSavedAt does not change G1a outcome',
    JSON.stringify(withoutGuard) === JSON.stringify(withParitySavedAt));
}
{
  // G2a fixture: new task created after remote snapshot, kept.
  const t2 = T('t2', 'New task', 3000, { createdAt: 3000 });
  const base   = [t2];
  const local  = [t2];
  const remote = [];
  const withoutGuard = mergeCollection(base, local, remote, 2000);
  const withParitySavedAt = mergeCollection(base, local, remote, 2000, 3000); // localSavedAt == base's record time -> not stale
  assert('R5b parity: non-stale localSavedAt does not change G2a outcome',
    JSON.stringify(withoutGuard) === JSON.stringify(withParitySavedAt));
}
{
  // No localSavedAt supplied at all (5-arg call omitted) -> guard fully off,
  // identical to the 4-arg call (back-compat for any caller not yet updated).
  const t2 = T('t2', 'Old task', 1000, { createdAt: 1000 });
  const base   = [t2];
  const local  = [t2];
  const remote = [];
  const fourArg = mergeCollection(base, local, remote, 5000);
  const fiveArgUndefined = mergeCollection(base, local, remote, 5000, undefined);
  assert('R5c parity: omitted localSavedAt (undefined) behaves identically to 4-arg call',
    JSON.stringify(fourArg) === JSON.stringify(fiveArgUndefined));
}

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
