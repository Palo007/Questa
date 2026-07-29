// archive/tests/sync-fixes-tests.js — run: node archive/tests/sync-fixes-tests.js
// Loads sync.js in a stubbed browser-ish sandbox and unit-tests the 2026-07-11 fixes.
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
const T = (id, done, up, extra) => Object.assign({ id, title: id, type: 'todo', done, updatedAt: up }, extra || {});

(async () => {
  // T1 — Fix B: syncApply must NOT adopt caller's objects into S (aliasing).
  const subset = { char: { hp: 50 }, tasks: [T('a', false, 1)], rewards: [], tags: [],
                   devices: [], lastCron: 0, history: [], charHistory: [], an: { views: [], metrics: [] } };
  ctx.syncApply(subset);
  ctx.S.tasks[0].done = true;              // simulate a user tap after apply
  assert('T1 syncApply deep-copies (no aliasing back into caller subset)', subset.tasks[0].done === false);

  // T2 — fresh local completion survives merge (base==remote, local changed).
  const base2   = { tasks: [T('a', false, 1)] };
  const remote2 = { tasks: [T('a', false, 1)] };
  const local2  = { tasks: [T('a', true, 2)] };
  const m2 = ctx.QuestaSync.merge(base2, local2, remote2, 0);
  assert('T2 local completion (base==remote) wins', m2.tasks[0].done === true);

  // T3 — UPDATED 2026-07-11 (recency-guard, Guard 1): this used to document
  // the base-poisoning bug (poisoned base==local "done", older remote
  // "not done" would let remote win). Guard 1 now refuses to let an OLDER
  // remote (updatedAt=1) overwrite a NEWER local (updatedAt=2) even when base
  // is poisoned -- that is precisely the fix. Local now wins.
  const base3   = { tasks: [T('a', true, 2)] };
  const local3  = { tasks: [T('a', true, 2)] };
  const remote3 = { tasks: [T('a', false, 1)] };
  const m3 = ctx.QuestaSync.merge(base3, local3, remote3, 0);
  assert('T3 poisoned-base replay: Guard 1 now keeps newer local (bug fixed, was: remote won)', m3.tasks[0].done === true);

  // T4 — both-changed tiebreak: newer updatedAt wins; remote wins exact ties.
  const base4   = { tasks: [T('a', false, 1)] };
  const local4  = { tasks: [T('a', true, 10)] };
  const remote4 = { tasks: [T('a', false, 5)] };
  assert('T4a newer local wins both-changed', ctx.QuestaSync.merge(base4, local4, remote4, 0).tasks[0].done === true);
  const remote4b = { tasks: [T('a', false, 10)] };
  assert('T4b exact tie goes remote (documented)', ctx.QuestaSync.merge(base4, local4, remote4b, 0).tasks[0].done === false);

  // T5 — F1 scenario: uncheck (fresh updatedAt) vs older remote edit.
  const base5   = { tasks: [T('a', true, 5)] };
  const local5  = { tasks: [T('a', false, 20)] };           // unchecked, NOW stamped (F1)
  const remote5 = { tasks: [T('a', true, 10, { notes: 'edited elsewhere' })] };
  assert('T5 uncheck with fresh updatedAt wins both-changed', ctx.QuestaSync.merge(base5, local5, remote5, 0).tasks[0].done === false);

  // T6 — F2: both-changed char resolves to LOCAL, regardless of savedAt.
  const m6 = ctx.QuestaSync.merge({ char: { xp: 1 } }, { char: { xp: 5 } }, { char: { xp: 9 } }, Date.now() + 1e12);
  assert('T6 both-changed char takes local even vs future remote savedAt', m6.char.xp === 5);

  // T7 — Fix A/D: syncBasePut stores a pre-serialized string in envelope {b, r}.
  let putArg = null;
  ctx.idbOpen = () => Promise.resolve({
    transaction(){ const tx = { objectStore(){ return { put(v, k){ putArg = v; } }; } };
                   setTimeout(() => { if(tx.oncomplete) tx.oncomplete(); }, 0); return tx; }
  });
  const frozen = '{"tasks":[{"id":"a","done":true}]}';
  const ok = await ctx.syncBasePut(frozen);
  // #5 envelope: stored value is JSON {b: <payload>, r: <rev>}; payload must be byte-identical
  const envelope = putArg ? JSON.parse(putArg) : null;
  assert('T7 syncBasePut stores envelope with byte-identical base payload',
    ok === true && envelope && envelope.b === frozen && ('r' in envelope));

  console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
