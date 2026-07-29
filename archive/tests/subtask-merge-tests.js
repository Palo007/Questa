// archive/tests/subtask-merge-tests.js — run: node archive/tests/subtask-merge-tests.js
// Unit tests for F4 (2026-07-11): subtask-granular merge (per-item three-way
// checklist merge). Design: .omo/plans/2026-07-11-subtask-granular-merge.md
// Same vm-sandbox pattern as cron-merge-tests.js / sync-fixes-tests.js (loads
// sync.js only — app.js's toggleSub/saveTask stamping is NOT exercised here,
// only the pure sync.js merge functions they feed).
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

const { mergeCollection, mergeChecklist, merge } = ctx.QuestaSync;

// ---- fixture helpers --------------------------------------------------------
const I = (id, text, done, touchedAt) => Object.assign({ id, text, done: !!done }, touchedAt != null ? { touchedAt } : {});

function dsOf(y, m, d){ return y*10000 + m*100 + d; }
function msFor(y, m, d, h){ return new Date(y, m-1, d, h==null?12:h, 0, 0, 0).getTime(); }
const YESTERDAY = dsOf(2026, 7, 10);
const TODAY     = dsOf(2026, 7, 11);
const doneAtYesterdayEvening = msFor(2026, 7, 10, 23);

// (a) add-vs-check on same task: local adds a new item (base item untouched),
// remote checks the existing item. Expect both survive independently.
(function a(){
  const base = [I('1', 'buy milk', false, 10)];
  const local = [I('1', 'buy milk', false, 10), I('2', 'buy eggs', false, 50)];
  const remote = [I('1', 'buy milk', true, 60)];
  const out = mergeChecklist(base, local, remote, false);
  const byId = Object.fromEntries(out.map(x => [x.id, x]));
  assert('(a) item 1 present with done=true (only remote changed it)', byId['1'] && byId['1'].done === true);
  assert('(a) item 2 present (pure local addition)', !!byId['2']);
  assert('(a) exactly 2 items, no duplication', out.length === 2);
})();

// (b) delete-vs-check on different items: local deletes item 1 (no touch on
// item 2), remote checks item 2 only. Expect: 1 gone, 2 checked.
(function b(){
  const base = [I('1', 'a', false, 10), I('2', 'b', false, 10)];
  const local = [I('2', 'b', false, 10)]; // item 1 deleted, item 2 untouched
  const remote = [I('1', 'a', false, 10), I('2', 'b', true, 70)];
  const out = mergeChecklist(base, local, remote, false);
  const byId = Object.fromEntries(out.map(x => [x.id, x]));
  assert('(b) item 1 absent (deleted, survivor side never touched it after base)', !byId['1']);
  assert('(b) item 2 present with done=true', byId['2'] && byId['2'].done === true);
  assert('(b) exactly 1 item', out.length === 1);
})();

// (c) delete-vs-edit same item: local deletes it; remote edits its text AFTER
// base with a fresh touchedAt. Expect: edit wins, item survives with new text.
(function c(){
  const base = [I('1', 'call bank', false, 10)];
  const local = [];
  const remote = [I('1', 'call bank re: fee', false, 80)];
  const out = mergeChecklist(base, local, remote, false);
  assert('(c) edit-vs-delete: item survives', out.length === 1 && out[0].id === '1');
  assert('(c) edit-vs-delete: edited text kept', out[0].text === 'call bank re: fee');
})();

// (d) genuine text conflict: both sides edited the same item's text
// differently. touchedAt arbitrates; equal touchedAt falls back to preferLocal.
// Note: a pure done/done race (both sides toggle the SAME item from the SAME
// base value) cannot produce a genuine disagreement (see plan §7 / sync.js
// mergeChecklist design note) -- a shared boolean base only ever has one
// "changed" state once both sides diverge from it, so this is deliberately
// written as a text conflict instead.
(function d(){
  const base = [I('1', 'draft email', false, 10)];
  {
    const local = [I('1', 'draft the email', false, 90)];
    const remote = [I('1', 'write the email', false, 50)];
    const out = mergeChecklist(base, local, remote, false);
    assert('(d) higher touchedAt wins (local newer)', out[0].text === 'draft the email');
  }
  {
    const local = [I('1', 'draft the email', false, 50)];
    const remote = [I('1', 'write the email', false, 90)];
    const out = mergeChecklist(base, local, remote, false);
    assert('(d) higher touchedAt wins (remote newer)', out[0].text === 'write the email');
  }
  {
    // equal touchedAt -> preferLocal fallback, exercised both ways directly
    const local = [I('1', 'draft the email', false, 50)];
    const remote = [I('1', 'write the email', false, 50)];
    const outRemote = mergeChecklist(base, local, remote, false);
    const outLocal = mergeChecklist(base, local, remote, true);
    assert('(d) tie + preferLocal=false -> remote text wins', outRemote[0].text === 'write the email');
    assert('(d) tie + preferLocal=true -> local text wins', outLocal[0].text === 'draft the email');
  }
})();

// (e) rename-vs-check same item: local only checked it (text untouched vs
// base), remote only renamed it (done untouched vs base). Expect BOTH
// per-field changes survive independently -- demonstrates field-level, not
// whole-item, merge granularity.
(function e(){
  const base = [I('1', 'pack bag', false, 10)];
  const local = [I('1', 'pack bag', true, 60)];   // checked only
  const remote = [I('1', 'pack gym bag', false, 10)]; // renamed only
  const out = mergeChecklist(base, local, remote, false);
  assert('(e) text follows remote (only remote changed it)', out[0].text === 'pack gym bag');
  assert('(e) done follows local (only local changed it)', out[0].done === true);
})();

// (f) legacy id backfill convergence (occurrence-keyed derivation, see plan §3)
(function f(){
  // reimplementation of app.js's legacySubtaskId + migration occurrence loop,
  // pasted here so this test doesn't need to load app.js (different sandbox).
  function legacySubtaskId(taskId, text, occurrence){
    const s = String(taskId) + '\x1f' + String(text || '') + '\x1f' + String(occurrence);
    let h = 5381;
    for(let i=0;i<s.length;i++){ h = ((h*33) ^ s.charCodeAt(i)) >>> 0; }
    return 'lg-' + h.toString(36);
  }
  function backfill(taskId, checklist){
    const seenByText = new Map();
    return checklist.map(c => {
      const text = c.text || '';
      const occurrence = seenByText.get(text) || 0;
      seenByText.set(text, occurrence + 1);
      return Object.assign({}, c, { id: c.id || legacySubtaskId(taskId, text, occurrence) });
    });
  }

  // (f1) same-order convergence: two devices independently backfill the
  // identical (no-id) checklist and must compute identical ids.
  const deviceA_f1 = backfill('t1', [{ text: 'buy milk' }, { text: 'buy eggs' }]);
  const deviceB_f1 = backfill('t1', [{ text: 'buy milk' }, { text: 'buy eggs' }]);
  assert('(f1) same-order convergence: identical ids computed independently',
    deviceA_f1[0].id === deviceB_f1[0].id && deviceA_f1[1].id === deviceB_f1[1].id);
  assert('(f1) distinct-text items get distinct ids', deviceA_f1[0].id !== deviceA_f1[1].id);

  // (f2) reordered-duplicate-text swap (the residual risk documented in plan
  // §3): two devices each have the SAME two physical same-text items, but in
  // swapped order. _physId tracks physical identity independent of text so
  // the test can tell which physical item ended up with which occurrence.
  const P = { _physId: 'P', text: 'milk' };
  const Q = { _physId: 'Q', text: 'milk' };
  const deviceA_f2 = backfill('t1', [P, Q]);       // P first -> occurrence 0
  const deviceB_f2 = backfill('t1', [Q, P]);       // Q first -> occurrence 0 (swapped)
  const idSet = arr => new Set(arr.map(x => x.id));
  assert('(f2) both devices compute the SAME set of ids despite the swap',
    JSON.stringify([...idSet(deviceA_f2)].sort()) === JSON.stringify([...idSet(deviceB_f2)].sort()));
  const aByPhys = Object.fromEntries(deviceA_f2.map(x => [x._physId, x.id]));
  const bByPhys = Object.fromEntries(deviceB_f2.map(x => [x._physId, x.id]));
  assert('(f2) the id assigned to physical item P differs between device A and B (the accepted swap)',
    aByPhys['P'] !== bByPhys['P']);
  // Feed both devices' resulting (id-bearing) arrays into mergeChecklist as
  // base/local/remote -- demonstrates the swap is harmless: still exactly two
  // "milk" items, no duplication, no error, because same-text items are
  // textually indistinguishable to the merge (plan §3's "equivalent merge
  // outcome" argument).
  const mergedF2 = mergeChecklist(deviceA_f2, deviceA_f2, deviceB_f2, false);
  assert('(f2) merge of the swapped-id fixtures yields exactly 2 items (no duplication)', mergedF2.length === 2);
  assert('(f2) every merged item still reads "milk" (no data corruption)', mergedF2.every(x => x.text === 'milk'));
})();

// (g) null base -> union, no deletions (first sync / post-force-push case)
(function g(){
  const out = mergeChecklist(null, [I('1', 'a', false)], [I('2', 'b', false)], false);
  const ids = out.map(x => x.id).sort();
  assert('(g) null base: both items present (nothing dropped without base evidence)',
    JSON.stringify(ids) === JSON.stringify(['1', '2']));
})();

// (h) daily: merged completion tick then normalizeDailyResets clears stale
// done -- full merge() call, not just mergeChecklist standalone. Confirms F4's
// mergeChecklist and F3's normalizeDailyResets overlay compose correctly.
(function h(){
  const D = (id, opts) => Object.assign({
    id, title: id, type: 'daily', done: false, streak: 0, updatedAt: 0, value: 0,
    history: [], checklist: []
  }, opts || {});
  const base = D('d1', { streak: 2, value: 5, updatedAt: 100, checklist: [I('1', 'x', false, 10)] });
  const local = D('d1', { // cron-processed device: reset done/streak, no updatedAt bump (F3)
    streak: 0, value: 3, updatedAt: 100, missedOn: YESTERDAY,
    checklist: [I('1', 'x', false, 10)]
  });
  const remote = D('d1', { // completed the evening before, unsynced until now
    done: true, streak: 3, value: 8, updatedAt: doneAtYesterdayEvening, doneAt: doneAtYesterdayEvening,
    checklist: [I('1', 'x', true, doneAtYesterdayEvening)]
  });
  const m = merge({ tasks: [base] }, { tasks: [local], lastCron: TODAY }, { tasks: [remote], lastCron: 0 }, 0);
  const w = m.tasks.find(t => t.id === 'd1');
  assert('(h) mid-merge: subtask completion survives into the chosen winner before overlay', w !== undefined);
  assert('(h) overlay clears task-level done for the new day', w.done === false);
  assert('(h) overlay clears EVERY checklist item done for the new day', w.checklist.every(c => c.done === false));
  assert('(h) checklist item text/identity preserved through the merge+overlay', w.checklist.length === 1 && w.checklist[0].id === '1' && w.checklist[0].text === 'x');
})();

// (i) ordering determinism: winner-parent's order first, then the other
// side's pure additions appended in original relative order.
(function i(){
  const base = [I('1', 'x'), I('2', 'y')];
  const local = [I('2', 'y', true, 50), I('1', 'x', false, 10)]; // locally reordered: 2 then 1
  const remote = [I('1', 'x', false, 10), I('2', 'y', false, 10), I('3', 'z', false, 20)]; // remote added item 3
  const outRemoteWins = mergeChecklist(base, local, remote, false); // preferLocal=false -> remote "wins"
  assert('(i) remote wins tiebreak: order follows remote\'s own order [1,2,3]',
    JSON.stringify(outRemoteWins.map(x => x.id)) === JSON.stringify(['1', '2', '3']));
  const outLocalWins = mergeChecklist(base, local, remote, true); // preferLocal=true -> local "wins"
  assert('(i) local wins tiebreak: order follows local\'s own order [2,1] + remote\'s pure addition [3]',
    JSON.stringify(outLocalWins.map(x => x.id)) === JSON.stringify(['2', '1', '3']));
})();

// (i2) pure-reorder-vs-check conflict (see plan §13 "honest limits" -- this is
// the concrete, accepted, now-real scenario: a mere reorder carries no
// touchedAt, so it never overrides a genuine field-level change, but it also
// doesn't survive the merge's ORDERING -- only the winner's order is kept.
(function i2(){
  const base = [I('1', 'x', false, 10), I('2', 'y', false, 10)];
  // local only reorders -- no touchedAt bump on either item (mutation-site
  // policy, plan §5: commitSubOrder/commitEditChecklistOrder never stamp
  // touchedAt for a pure reorder).
  const local = [I('2', 'y', false, 10), I('1', 'x', false, 10)];
  // remote only checks item 1.
  const remote = [I('1', 'x', true, 60), I('2', 'y', false, 10)];
  const out = mergeChecklist(base, local, remote, false); // remote "wins" the enclosing whole-task tiebreak
  const byId = Object.fromEntries(out.map(x => [x.id, x]));
  assert('(i2) both items present after the pure-reorder-vs-check merge', out.length === 2);
  assert('(i2) remote\'s genuine check-state change survives (not lost)', byId['1'].done === true);
  assert('(i2) order follows remote\'s order [1,2], NOT local\'s reordered [2,1] -- local\'s reorder is silently discarded (accepted gap, plan §13)',
    JSON.stringify(out.map(x => x.id)) === JSON.stringify(['1', '2']));
})();

console.log(fails ? ('\n' + fails + ' FAILING TEST(S)') : '\nALL PASS');
process.exit(fails ? 1 : 0);
