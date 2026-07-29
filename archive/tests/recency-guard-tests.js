// archive/tests/recency-guard-tests.js — run: node archive/tests/recency-guard-tests.js
// Unit tests for the 2026-07-11 recency-guarded merge (Guard 1 edit protection,
// Guard 2 creation protection, char guard, D3 clamping). Design:
// .omo/plans/2026-07-11-recency-guard-merge.md ; spec: 2026-07-11-recency-guard-HANDOFF.md
// Same vm-sandbox pattern as sync-fixes-tests.js / cron-merge-tests.js /
// subtask-merge-tests.js (loads sync.js only).
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

const { mergeCollection, merge } = ctx.QuestaSync;
const T = (id, title, up, extra) => Object.assign({ id, type: 'todo', title, updatedAt: up }, extra || {});

// ---- G1: edit protection ---------------------------------------------------

// G1a — rename revert, poisoned base: base==local=="Questa" (updatedAt 2000),
// remote=="Cuesta" (updatedAt 1000), same id -> merged keeps "Questa".
{
  const base   = [T('t1', 'Questa', 2000)];
  const local  = [T('t1', 'Questa', 2000)];
  const remote = [T('t1', 'Cuesta', 1000)];
  const merged = mergeCollection(base, local, remote, 500);
  const t1 = merged.find(t => t.id === 't1');
  assert('G1a rename revert (poisoned base) -> local "Questa" kept', t1 && t1.title === 'Questa');
}

// G1b — no behavior change, clean base: base=="A"(1000), local=="A"(1000),
// remote=="B"(2000) -> merged=="B" (remote genuinely newer still wins).
{
  const base   = [T('t1', 'A', 1000)];
  const local  = [T('t1', 'A', 1000)];
  const remote = [T('t1', 'B', 2000)];
  const merged = mergeCollection(base, local, remote, 1500);
  const t1 = merged.find(t => t.id === 't1');
  assert('G1b clean base, remote genuinely newer -> "B" wins (no behavior change)', t1 && t1.title === 'B');
}

// G1c — tie: equal updatedAt -> remote wins (preserve current tie-break).
{
  const base   = [T('t1', 'A', 1000)];
  const local  = [T('t1', 'A', 1000)];
  const remote = [T('t1', 'B', 1000)];
  const merged = mergeCollection(base, local, remote, 1000);
  const t1 = merged.find(t => t.id === 't1');
  assert('G1c equal updatedAt -> remote wins (tie preserved)', t1 && t1.title === 'B');
}

// ---- G2: creation protection ------------------------------------------------

// G2a — new task, poisoned base: base & local have t2 (createdAt 3000), remote
// lacks it, remoteSavedAt=2000 -> t2 kept.
{
  const t2 = T('t2', 'New task', 3000, { createdAt: 3000 });
  const base   = [t2];
  const local  = [t2];
  const remote = [];
  const merged = mergeCollection(base, local, remote, 2000);
  assert('G2a new task created after remote snapshot -> kept (not a deletion)', !!merged.find(t => t.id === 't2'));
}

// G2b — TOMBSTONE MODEL (2026-07-12): a task in base+local but absent from a
// (possibly stale/partial) remote is NO LONGER inferred as a deletion -- without
// a tombstone it is KEPT. Real remote deletion via tombstone is covered by
// tests/tombstone.test.js. (Was: "deletion propagates" -- the exact behavior
// that silently lost 500+ day dailies.)
{
  const t2 = T('t2', 'Old task', 1000, { createdAt: 1000 });
  const base   = [t2];
  const local  = [t2];
  const remote = [];
  const merged = mergeCollection(base, local, remote, 5000);
  assert('G2b remote absence without a tombstone -> task KEPT (tombstone model)', !!merged.find(t => t.id === 't2'));
}

// G2c — TOMBSTONE MODEL: even a 3-arg call (no remoteSavedAt, no tombstoneMap)
// never deletes on mere absence -- the task is KEPT. (Was: "deletion propagates".)
{
  const t2 = T('t2', 'New task', 3000, { createdAt: 3000 });
  const base   = [t2];
  const local  = [t2];
  const remote = [];
  const merged = mergeCollection(base, local, remote); // 3-arg call, no remoteSavedAt
  assert('G2c no remoteSavedAt / no tombstone -> task KEPT (tombstone model)', !!merged.find(t => t.id === 't2'));
}

// ---- char guard --------------------------------------------------------------

// char-G: base==local char (updatedAt 2000, gold 100), remote char (updatedAt
// 1000, gold 0) -> merged char keeps gold 100.
{
  const base   = { char: { gold: 100, updatedAt: 2000 } };
  const local  = { char: { gold: 100, updatedAt: 2000 } };
  const remote = { char: { gold: 0,   updatedAt: 1000 } };
  const merged = merge(base, local, remote, 1500);
  assert('char-G older remote char cannot overwrite newer local char', merged.char.gold === 100);
}

// char-G2: genuine remote char update (remote.updatedAt > local.updatedAt,
// local unchanged vs base) -> remote wins, no behavior change.
{
  const base   = { char: { gold: 50, updatedAt: 1000 } };
  const local  = { char: { gold: 50, updatedAt: 1000 } };
  const remote = { char: { gold: 80, updatedAt: 2000 } };
  const merged = merge(base, local, remote, 2000);
  assert('char-G2 genuinely newer remote char -> remote wins (no behavior change)', merged.char.gold === 80);
}

// ---- subtask parity (Guard 1 keeps local, remote toggle must not be lost) ---

// S1: Guard 1 keeps local (local newer, poisoned base) while remote toggled a
// subtask that local never saw -> the toggle is merged in, not lost.
{
  const baseChecklist = [{ id: 'c1', text: 'Step 1', done: false }, { id: 'c2', text: 'Step 2', done: false }];
  const localChecklist = [{ id: 'c1', text: 'Step 1 renamed', done: false }, { id: 'c2', text: 'Step 2', done: false }];
  const remoteChecklist = [{ id: 'c1', text: 'Step 1', done: false }, { id: 'c2', text: 'Step 2', done: true }]; // remote toggled c2

  const base   = [T('t1', 'Task', 2000, { checklist: baseChecklist })];
  const local  = [T('t1', 'Task', 2000, { checklist: localChecklist })]; // renamed subtask text, poisoned base == this
  const remote = [T('t1', 'Task', 1000, { checklist: remoteChecklist })]; // older overall updatedAt, but toggled c2

  const merged = mergeCollection(base, local, remote, 500);
  const t1 = merged.find(t => t.id === 't1');
  const c1 = t1 && t1.checklist.find(c => c.id === 'c1');
  const c2 = t1 && t1.checklist.find(c => c.id === 'c2');
  assert('S1 Guard 1 keeps local rename (recency)', c1 && c1.text === 'Step 1 renamed');
  assert('S1 remote subtask toggle not lost despite Guard 1 keeping local', c2 && c2.done === true);
}

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
