// archive/tests/cron-merge-tests.js — run: node archive/tests/cron-merge-tests.js
// Unit tests for F3 (2026-07-11): cron-reset-vs-sync-merge-recency.
// Design: .omo/plans/2026-07-11-cron-merge-recency.md
// Same vm-sandbox pattern as sync-fixes-tests.js (loads sync.js only — app.js's
// runCron itself is NOT exercised here; see the C12 note at the bottom for why).
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', '..', 'sync.js'), 'utf8');
const ctx = {
  console, setTimeout, clearTimeout, Date, JSON, Math, Promise, String, Object, Array,
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

// ---- fixture helpers --------------------------------------------------------
// dayStamp ints built the same way app.js/sync.js dayStampOf() does, but
// computed independently here (not by calling into sync.js) so these tests
// don't just assert "the code agrees with itself".
function dsOf(y, m, d){ return y*10000 + m*100 + d; }
function msFor(y, m, d, h){ return new Date(y, m-1, d, h==null?12:h, 0, 0, 0).getTime(); }

const YESTERDAY = dsOf(2026, 7, 10);
const TODAY     = dsOf(2026, 7, 11);
const doneAtYesterdayEvening = msFor(2026, 7, 10, 23); // 23:xx yesterday
const doneAtTodayMorning     = msFor(2026, 7, 11, 0);  // just after midnight today
const doneAt3DaysAgo         = msFor(2026, 7, 8, 20);

const D = (id, opts) => Object.assign({
  id, title: id, type: 'daily', done: false, streak: 0, updatedAt: 0, value: 0,
  history: [], checklist: []
}, opts || {});
const T = (id, opts, type) => Object.assign({ id, title: id, type: type || 'todo', done: false, updatedAt: 0 }, opts || {});

const { mergeCollection, resolveDailyConflict, normalizeDailyResets, merge } = ctx.QuestaSync;

// C1 — canonical repro (§1.1): D2 completes 23:50 unsynced; D1 crons at 00:00
// (no updatedAt bump under F3); sync merges. Expect the completion RESCUED
// (streak/history/value kept) then the reset overlay clears done for the new day.
(function C1(){
  const base = D('x', { streak: 2, value: 5, updatedAt: 100, history: [{ date: 100, completed: true, value: 5 }] });
  const local = D('x', { // D1: cron-processed, no updatedAt bump (F3)
    streak: 0, value: 3, updatedAt: 100, missedOn: YESTERDAY,
    history: [{ date: 100, completed: true, value: 5 }, { date: doneAtTodayMorning, completed: false, value: 3 }]
  });
  const remote = D('x', { // D2: completion, unsynced until now
    done: true, streak: 3, value: 8, updatedAt: doneAtYesterdayEvening, doneAt: doneAtYesterdayEvening,
    history: [{ date: 100, completed: true, value: 5 }, { date: doneAtYesterdayEvening, completed: true, value: 8 }]
  });
  const m = merge({ tasks: [base] }, { tasks: [local], lastCron: TODAY }, { tasks: [remote], lastCron: 0 }, 0);
  const w = m.tasks.find(t => t.id === 'x');
  assert('C1 canonical repro: streak rescued (s+1, not reset to 0)', w.streak === 3);
  assert('C1 canonical repro: history ends with completed:true', w.history[w.history.length - 1].completed === true);
  assert('C1 canonical repro: value gain kept (not the miss decrement)', w.value === 8);
  assert('C1 canonical repro: overlay resets done for the new day', w.done === false);
  assert('C1 canonical repro: merged lastCron is today', m.lastCron === TODAY);
})();

// C2 — mirror of C1 (local/remote swapped) — result must be identical (symmetry).
(function C2(){
  const base = D('x', { streak: 2, value: 5, updatedAt: 100, history: [{ date: 100, completed: true, value: 5 }] });
  const remote = D('x', {
    streak: 0, value: 3, updatedAt: 100, missedOn: YESTERDAY,
    history: [{ date: 100, completed: true, value: 5 }, { date: doneAtTodayMorning, completed: false, value: 3 }]
  });
  const local = D('x', {
    done: true, streak: 3, value: 8, updatedAt: doneAtYesterdayEvening, doneAt: doneAtYesterdayEvening,
    history: [{ date: 100, completed: true, value: 5 }, { date: doneAtYesterdayEvening, completed: true, value: 8 }]
  });
  const m = merge({ tasks: [base] }, { tasks: [local], lastCron: 0 }, { tasks: [remote], lastCron: TODAY }, 0);
  const w = m.tasks.find(t => t.id === 'x');
  assert('C2 symmetry: streak rescued regardless of which side is local/remote', w.streak === 3);
  assert('C2 symmetry: done reset for the new day', w.done === false);
})();

// C3 — §1.4 second leg: by the time D2 pulls, D1 has ALREADY pushed the
// rescued object (done:false, streak preserved) — not the raw cron-reverted
// one. D2's own copy is unchanged completion -> "remote changed only" branch
// must adopt the rescued object safely (no second loss).
(function C3(){
  const completed = D('x', { done: true, streak: 3, doneAt: doneAtYesterdayEvening, updatedAt: doneAtYesterdayEvening,
    history: [{ date: doneAtYesterdayEvening, completed: true, value: 8 }] });
  const rescued = D('x', { done: false, streak: 3, doneAt: doneAtYesterdayEvening, updatedAt: doneAtYesterdayEvening,
    history: [{ date: doneAtYesterdayEvening, completed: true, value: 8 }] });
  const m = merge({ tasks: [completed] }, { tasks: [completed], lastCron: 0 }, { tasks: [rescued], lastCron: TODAY }, 0);
  const w = m.tasks.find(t => t.id === 'x');
  assert('C3 one-sided adoption of the already-rescued object keeps streak', w.streak === 3);
  assert('C3 one-sided adoption keeps done:false (idempotent, no re-loss)', w.done === false);
})();

// C4 — legitimate miss vs an unsynced cosmetic edit: eventDay must not be
// fooled by a bumped updatedAt on a side with no doneAt/missedOn at all.
(function C4(){
  const base = D('x', { done: true, streak: 2, updatedAt: 50, title: 'Meditate' });
  const local = D('x', { done: false, streak: 0, updatedAt: 50, missedOn: YESTERDAY, title: 'Meditate' }); // cron miss, no bump
  const remote = D('x', { done: true, streak: 2, updatedAt: 900, title: 'Meditate (evening)' }); // title-only edit, no doneAt/missedOn
  const winner = resolveDailyConflict(local, remote);
  assert('C4 legitimate miss beats an unrelated same-evening edit', winner === local);
  assert('C4 streak stays at 0 (real miss)', winner.streak === 0);
})();

// C5 — offline rejoin (matrix #5): a 3-day-old completion must NOT resurrect
// over an intervening real miss.
(function C5(){
  const local = D('x', { done: false, streak: 0, updatedAt: 10, missedOn: YESTERDAY });
  const remote = D('x', { done: true, streak: 6, updatedAt: 20, doneAt: doneAt3DaysAgo });
  const winner = resolveDailyConflict(local, remote);
  assert('C5 offline rejoin: recent miss beats a stale 3-day-old completion', winner === local);
})();

// C6 — post-midnight completion (matrix #3): completed today beats a miss
// judged for yesterday; overlay must NOT undo it (same day as lastCron).
(function C6(){
  const base = D('x', { streak: 4, updatedAt: 5 });
  const local = D('x', { done: false, streak: 0, updatedAt: 5, missedOn: YESTERDAY });
  const remote = D('x', { done: true, streak: 5, updatedAt: doneAtTodayMorning, doneAt: doneAtTodayMorning });
  const m = merge({ tasks: [base] }, { tasks: [local], lastCron: TODAY }, { tasks: [remote], lastCron: 0 }, 0);
  const w = m.tasks.find(t => t.id === 'x');
  assert('C6 post-midnight completion wins over yesterday miss', w.streak === 5);
  assert('C6 overlay leaves same-day completion done:true (no false reset)', w.done === true);
})();

// C7 — both devices cron independently before syncing: identical missedOn on
// both sides -> falls through to the updatedAt tiebreak; remote wins exact ties
// (determinism, unchanged rule).
(function C7(){
  const local = D('x', { done: false, streak: 0, updatedAt: 7, missedOn: YESTERDAY });
  const remote = D('x', { done: false, streak: 0, updatedAt: 7, missedOn: YESTERDAY });
  const winner = resolveDailyConflict(local, remote);
  assert('C7 both-cronned convergence is deterministic (remote wins exact tie)', winner === remote);
})();

// C8 — reset overlay standalone (3 sub-cases).
(function C8(){
  const stale = D('a', { done: true, doneAt: doneAtYesterdayEvening });
  const current = D('b', { done: true, doneAt: doneAtTodayMorning });
  const legacy = D('c', { done: true }); // no doneAt at all — old-app.js compat
  const out = normalizeDailyResets([stale, current, legacy], TODAY);
  assert('C8a stale done (yesterday) is reset under today\'s lastCron', out[0].done === false);
  assert('C8b same-day done (today) is left untouched', out[1].done === true);
  assert('C8c done with no doneAt at all is reset (mixed-version compat)', out[2].done === false);
})();

// C9 — mixed-version regression guard: neither side carries doneAt/missedOn
// (old app.js) -> must be BYTE-IDENTICAL to the pre-F3 rule (plain updatedAt
// tiebreak, remote wins ties).
(function C9(){
  const local = D('x', { done: true, streak: 5, updatedAt: 10 });
  const remote = D('x', { done: false, streak: 0, updatedAt: 20 });
  const winner = resolveDailyConflict(local, remote);
  assert('C9 mixed-version: no day signal on either side -> falls back to newer updatedAt (remote)', winner === remote);
  const localT = D('x', { done: true, streak: 5, updatedAt: 20 });
  const remoteT = D('x', { done: false, streak: 0, updatedAt: 20 });
  assert('C9b mixed-version exact tie -> remote (unchanged from pre-F3 rule)', resolveDailyConflict(localT, remoteT) === remoteT);
})();

// C10 — non-daily types are completely unaffected: mergeCollection must still
// use the plain updatedAt tiebreak for todos/habits (resolveDailyConflict is
// never invoked for them).
(function C10(){
  const baseTodo = [T('t1', { done: false, updatedAt: 1 })];
  const localTodo = [T('t1', { done: true, updatedAt: 50 })];
  const remoteTodo = [T('t1', { done: false, updatedAt: 30 })];
  const outTodo = mergeCollection(baseTodo, localTodo, remoteTodo);
  assert('C10a todos: newer-updatedAt tiebreak unchanged', outTodo[0].done === true);

  const baseHabit = [T('h1', { updatedAt: 1, cUp: 0 }, 'habit')];
  const localHabit = [T('h1', { updatedAt: 1, cUp: 3 }, 'habit')]; // F3: taps no longer force an updatedAt bump upstream, but the object still differs
  const remoteHabit = [T('h1', { updatedAt: 2, cUp: 0 }, 'habit')]; // counter reset side
  const outHabit = mergeCollection(baseHabit, localHabit, remoteHabit);
  // K3 (2026-09-11) LOCKSTEP UPDATE. The subject of this assertion -- "habits go
  // through the plain updatedAt tiebreak, never resolveDailyConflict" -- is unchanged,
  // and updatedAt === 2 still pins it: remote won the arbitration.
  // The `cUp === 0` half encoded the BUG K3 fixes. Local had tapped 3 times (base 0 ->
  // 3) and remote's cUp never moved, so the whole-object winner silently discarded
  // three taps. cUp is now accumulated across the winner (sync.js _accumCounters), so
  // the truthful answer is 3. See tests/earnings-accumulate.test.js K3-E and
  // .omo/plans/K3-earnings-design.md.
  assert('C10b habits: still resolved by updatedAt, not resolveDailyConflict', outHabit[0].cUp === 3 && outHabit[0].updatedAt === 2);
})();

// C11 — purity / idempotence: same inputs -> same output; re-normalizing an
// already-normalized array is a no-op; a conflict-retry re-merge (merging the
// merged result against a fresh remote pull) stays stable.
(function C11(){
  const base = D('x', { streak: 2, value: 5, updatedAt: 100 });
  const local = D('x', { streak: 0, value: 3, updatedAt: 100, missedOn: YESTERDAY });
  const remote = D('x', { done: true, streak: 3, value: 8, updatedAt: doneAtYesterdayEvening, doneAt: doneAtYesterdayEvening });
  const m1 = merge({ tasks: [base] }, { tasks: [local], lastCron: TODAY }, { tasks: [remote], lastCron: 0 }, 0);
  const m2 = merge({ tasks: [base] }, { tasks: [local], lastCron: TODAY }, { tasks: [remote], lastCron: 0 }, 0);
  assert('C11a merge is a pure function of its inputs (same in -> same out)', JSON.stringify(m1) === JSON.stringify(m2));

  const renormalized = normalizeDailyResets(m1.tasks, m1.lastCron);
  assert('C11b normalizeDailyResets is idempotent on its own output', JSON.stringify(renormalized) === JSON.stringify(m1.tasks));

  // conflict-retry: re-merge the just-merged state against a fresh (unchanged) remote pull
  const m3 = merge({ tasks: m1.tasks }, { tasks: m1.tasks, lastCron: m1.lastCron }, { tasks: [remote], lastCron: 0 }, 0);
  assert('C11c conflict-retry re-merge converges without oscillation', m3.tasks[0].streak === m1.tasks[0].streak && m3.tasks[0].done === m1.tasks[0].done);
})();

console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
console.log('\nNOTE (U4, plan §5.1/§6): C12 (runCron unit — completing then cronning\n' +
  'leaves updatedAt untouched, sets missedOn only on true misses, clears it on\n' +
  'complete/credit) is NOT implemented here. app.js is DOM-heavy at the top\n' +
  'level (documents, elements, event listeners) and was not designed to be\n' +
  'vm-loaded in isolation; doing so reliably would need either extracting\n' +
  'runCron/completeTask/creditYesterday into a headless-safe module or\n' +
  'accepting a much heavier jsdom-based harness. Coverage for that logic is\n' +
  'from code review (this session) plus the on-device checklist (plan §5.2),\n' +
  'not an automated test. Flagging rather than silently skipping.');
process.exit(fails ? 1 : 0);
