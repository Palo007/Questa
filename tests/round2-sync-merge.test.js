// round2-sync-merge.test.js -- 2026-09-18 (round 2).
//
// Regression cover for the seven merge/apply fixes marked in sync.js with the
// comment text `2026-09-18 (round 2)`. Every assertion below is RED on the
// pre-fix code and GREEN after.
//
//   R1  mergeCollection's BOTH-CHANGED branch spliced the cross-TZ cron echo's
//       all-false checklist back over a live completion. GUARD 2 only covered
//       the one-sided branch; the moment the user also touched the task
//       locally, control landed here and the ticks were re-cleared. (_echoKeep)
//   R2  _isCronEchoReset re-derived the completion day from doneAt in the
//       MERGING device's timezone instead of reading the frozen doneDay, so it
//       disagreed with normalizeDailyResets about the same record.
//   R3  GUARD 1's checklist splice passed the base it had just declared
//       unreliable, so a strictly OLDER remote reverted a subtask tick.
//   R4  conflictResolved tested `winner === l` AFTER the Object.assign
//       rebuilds, so every task with a checklist or counters reported "remote".
//   R5  syncApply wiped S.prefs.pausedDays when the incoming subset's `pause`
//       object carried no pausedDays key, and clamped pausedAt to 0.
//   R6  _accumCounter derived the per-side absorbed baselines BELOW the legacy
//       branch, so the conflict-retry watermark was inert whenever the base
//       carried no cResetOn: 5+3 gave 8, then 11, then 14 across retries.
//   R7  (a) cResetOn took a plain max, so one device with a wrong date pinned
//       the shared marker in the future forever. (b) mergeDayArray threw out of
//       merge() on a malformed charHistory row or a non-array charHistory.
//
// Run: node tests/round2-sync-merge.test.js   (tests/run.js picks it up too)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* stripped */');
src = src.replace(/\bsyncInit\(\)\s*;?\s*$/, '');

// Harness copied from tests/merge-polarity-k1.test.js. The only additions are the
// optional `opts.logEvent` collector (R4 asserts on an EMITTED event) and `opts.S`
// (R5 drives syncApply, which reads and writes the live state object) -- both are
// sandbox globals sync.js already expects to find.
function makeQ(uidValue, opts){
  opts = opts || {};
  const noop = function(){};
  const sandbox = {
    window: {}, navigator: {onLine: true},
    document: {addEventListener: noop, getElementById: function(){ return null; },
      createElement: function(){ return {style:{},appendChild:noop,setAttribute:noop,click:noop}; },
      body: {appendChild:noop, removeChild:noop}},
    localStorage: {getItem: function(){ return null; }, setItem: noop, removeItem: noop,
      key: function(){ return null; }, length: 0},
    indexedDB: {open: function(){ return {}; }},
    setTimeout: function(){ return 0; }, clearTimeout: noop,
    setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date,
    Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String,
    Boolean: Boolean, Promise: Promise,
    logEvent: opts.logEvent || noop, toast: noop, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return uidValue; },
    idbOpen: function(){ return Promise.resolve(null); },
    now: function(){ return FIXED_NOW; },
    S: opts.S
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); } catch(e){}
  return sandbox.window.QuestaSync;
}

// All fixtures are relative to the real clock, never a hardcoded calendar date
// (commit 6b93a82, and the same note at the head of merge-polarity-k1.test.js):
// _isCronEchoReset and the new cResetOn rule both compare against TODAY, so a
// frozen date would silently stop exercising the fixes.
const FIXED_NOW = Date.now();
const NORMAL = FIXED_NOW - 5000;
const NORMAL_OLDER = FIXED_NOW - 9000;
const NEWER = FIXED_NOW - 1000;

// local mirror of sync.js dayStampOf(), so the test does not depend on it being exported
function ds(ms){ const d = new Date(ms); return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
const TODAY_STAMP = ds(FIXED_NOW);
const FAR_FUTURE_STAMP = ds(FIXED_NOW + 400 * 86400000); // ~13 months out: the "wrong clock" case

const Q = makeQ('devA');
if (!Q || typeof Q.merge !== 'function' || typeof Q.mergeCollection !== 'function' ||
    typeof Q.apply !== 'function') {
  console.error('FAIL: QuestaSync registry missing merge/mergeCollection/apply');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

function mk(overrides) {
  return Object.assign({
    tasks: [], rewards: [], tags: [], devices: [],
    an: {views: [], metrics: []},
    history: [], charHistory: [], monthlyBackups: [],
    lastCron: 0, char: {}, deletions: [], pause: {}
  }, overrides);
}
function findById(arr, id) { return (arr || []).find(function(x){ return x && x.id === id; }); }
function clone(x){ return JSON.parse(JSON.stringify(x)); }
function sub(t, id){ return ((t && t.checklist) || []).find(function(c){ return c && c.id === id; }); }

// The cron echo as normalizeDailyResets actually writes it: done -> false on the
// task and on EVERY subtask, doneAt/doneDay/touchedAt retained, updatedAt untouched.
function cronEcho(t){
  const e = Object.assign({}, clone(t), {done: false});
  if (Array.isArray(e.checklist)) e.checklist = e.checklist.map(function(c){ return Object.assign({}, c, {done:false}); });
  return e;
}

// =========================================================================
// R1 -- the cross-TZ cron echo in mergeCollection's BOTH-CHANGED branch.
// The user completed the daily and ticked c1; a peer one timezone ahead cron-
// reset it and uploaded the echo; the user then ALSO ticked c2 locally, which
// makes both sides differ from base and routes the record here instead of
// through GUARD 2. Without _echoKeep the F4 splice reads c1 as "remote changed,
// local didn't" -- because base and local agree -- and adopts the echo's false.
//
// NOTE on the fixture: the local edit bumps the SUBTASK's touchedAt but not the
// task's updatedAt. _isCronEchoReset requires `_uaRaw(l) === _uaRaw(r)` (a real
// edit always bumps updatedAt, and that is the discriminator against a genuine
// un-tick), so bumping the task stamp would take the record out of the echo
// shape entirely and there would be nothing for this fix to do.
//
// Device ids are chosen so resolveDailyConflict's deterministic id tiebreak
// (both sides carry the same updatedAt and the same event day) resolves to the
// local side; that is what keeps `done` true. The checklist assertion is the
// one that is RED before the fix.
// =========================================================================
(function(){
  const QB = makeQ('devB'); // local device id
  const base = { id: 'r1', type: 'daily', title: 'Stretch', done: true,
                 doneDay: TODAY_STAMP, doneAt: FIXED_NOW - 600000,
                 missedOn: 0, updatedAt: NORMAL, streak: 4,
                 checklist: [ {id:'c1', text:'left',  done:true,  touchedAt: NORMAL},
                              {id:'c2', text:'right', done:false, touchedAt: NORMAL} ] };
  const local = clone(base);
  local.checklist[1].done = true;             // the user ticks c2 after the echo arrives
  local.checklist[1].touchedAt = NEWER;
  const remote = cronEcho(base);              // peer's cron reset, updatedAt UNCHANGED

  const out = QB.mergeCollection([base], [local], [remote], NORMAL, NORMAL, null, 'devA');
  const got = findById(out, 'r1');
  assert('[R1] both-changed cron echo does not un-complete a still-current daily',
    !!got && got.done === true);
  assert('[R1] ...and the checklist splice does not re-clear the c1 tick',
    !!got && !!sub(got, 'c1') && sub(got, 'c1').done === true);
})();

// =========================================================================
// R2 -- _isCronEchoReset must read the FROZEN doneDay, not dayStampOf(doneAt).
// A completion recorded 26h ago on a device 13h ahead has doneDay == TODAY but
// re-derives as YESTERDAY here, so the old guard declined and the echo landed.
// One-sided shape: local is deep-equal to base, only remote (the echo) changed.
// =========================================================================
(function(){
  const base = { id: 'r2', type: 'daily', title: 'Meditate', done: true,
                 doneDay: TODAY_STAMP, doneAt: FIXED_NOW - 26 * 3600000,
                 missedOn: 0, updatedAt: NORMAL, streak: 9,
                 checklist: [ {id:'c1', text:'sit', done:true, touchedAt: NORMAL} ] };
  const local = clone(base);                  // untouched here
  const remote = cronEcho(base);

  const out = Q.mergeCollection([base], [local], [remote], NORMAL, NORMAL, null, 'devB');
  const got = findById(out, 'r2');
  assert('[R2] GUARD 2 uses the frozen doneDay, so a 26h-old completion still current TODAY survives',
    !!got && got.done === true);
  assert('[R2] ...and its subtask tick survives with it',
    !!got && !!sub(got, 'c1') && sub(got, 'c1').done === true);
})();

// =========================================================================
// R3 -- GUARD 1 wins the whole-object race for local, then must not hand a
// subtask back to the remote it just out-ranked. Passing the (unreliable) base
// into mergeChecklist made every remote/local difference read as "remote
// changed, local didn't" and adopted the remote value without ever consulting
// touchedAt -- so a strictly OLDER remote reverted the tick.
// =========================================================================
(function(){
  const base = { id: 'r3', type: 'todo', title: 'Groceries', updatedAt: NEWER,
                 checklist: [ {id:'c1', text:'milk', done:true, touchedAt: NEWER} ] };
  const local = clone(base);                  // deep-equal to base -> !localChanged
  const remote = { id: 'r3', type: 'todo', title: 'Groceries', updatedAt: FIXED_NOW - 5000,
                   checklist: [ {id:'c1', text:'milk', done:false, touchedAt: FIXED_NOW - 5000} ] };

  const out = Q.mergeCollection([base], [local], [remote], NORMAL, NORMAL, null, 'devB');
  const got = findById(out, 'r3');
  assertEq('[R3] GUARD 1 keeps the newer local updatedAt', got && got.updatedAt, NEWER);
  assert('[R3] ...and the older remote does not revert the subtask tick',
    !!got && !!sub(got, 'c1') && sub(got, 'c1').done === true);
})();

// =========================================================================
// R4 -- conflictResolved must name the side that actually won. The identity
// test ran AFTER the checklist splice and _accumCounters had rebuilt the
// object, so `winner === l` was false for every task carrying either, and the
// event always said "remote" with winnerDev/loserDev swapped.
// =========================================================================
(function(){
  const events = [];
  const QL = makeQ('devLocal', { logEvent: function(e){ events.push(e); } });
  const base   = { id: 'r4', type: 'todo', title: 'Old', updatedAt: NORMAL_OLDER,
                   checklist: [ {id:'c1', text:'step', done:false, touchedAt: NORMAL_OLDER} ] };
  const local  = { id: 'r4', type: 'todo', title: 'Local wins', updatedAt: NEWER,
                   checklist: [ {id:'c1', text:'step', done:true, touchedAt: NEWER} ] };
  const remote = { id: 'r4', type: 'todo', title: 'Remote loses', updatedAt: NORMAL,
                   checklist: [ {id:'c1', text:'step edited', done:false, touchedAt: NORMAL} ] };

  QL.mergeCollection([base], [local], [remote], NORMAL, NORMAL, null, 'devRemote');
  const ev = events.filter(function(e){ return e && e.kind === 'conflictResolved' && e.taskId === 'r4'; })[0];
  assert('[R4] a conflictResolved event is emitted for the both-changed task', !!ev);
  assertEq('[R4] ...and it names the real winner', ev && ev.winner, 'local');
  assertEq('[R4] ...with the local device as winnerDev', ev && ev.winnerDev, 'devLocal');
})();

// =========================================================================
// R5 -- syncApply must treat an absent pause.pausedDays as "no opinion", not
// as "empty". _syncForcePullAttempt applies the RAW remote, so a /state.json
// from a build predating pausedDays wiped runCron's pause cover and every
// daily left unticked during the pause took miss damage.
// =========================================================================
(function(){
  const DAYS = [TODAY_STAMP - 2, TODAY_STAMP - 1];
  const S = {
    tasks: [{id:'t1', type:'todo', title:'keep', updatedAt: NORMAL}],
    rewards: [], tags: [], devices: [], history: [], charHistory: [],
    monthlyBackups: [], deletions: [], char: {hp:50, lvl:1},
    lastCron: TODAY_STAMP,
    prefs: { an: {views: [], metrics: []},
             paused: true, pausedDays: DAYS.slice(), pausedAt: FIXED_NOW - 100000 }
  };
  const QS = makeQ('devA', { S: S });
  // A legacy/hand-edited remote: `pause` is present but carries only `paused`.
  QS.apply({ tasks: [], pause: { paused: true } });

  assertEq('[R5] an absent pause.pausedDays preserves the local list',
    JSON.stringify(S.prefs.pausedDays), JSON.stringify(DAYS));
  assertEq('[R5] ...and an absent pause.at does not zero the local pausedAt',
    S.prefs.pausedAt, FIXED_NOW - 100000);
})();

// =========================================================================
// R6 -- the conflict-retry watermark must work when the base carries no
// cResetOn (every habit created since the last cron). _syncNowAttempt applies
// the merge to S BEFORE the upload, so a 409 retry re-merges a local that has
// ALREADY absorbed the peer's taps against the same pristine base.
// =========================================================================
(function(){
  const base   = { id: 'r6', type: 'habit', title: 'Water', cUp: 0, updatedAt: NORMAL_OLDER };
  const remote = { id: 'r6', type: 'habit', title: 'Water', cUp: 3, updatedAt: NORMAL };
  const local  = { id: 'r6', type: 'habit', title: 'Water', cUp: 5, updatedAt: NEWER };
  if (base.cResetOn !== undefined) throw new Error('fixture: base must carry no cResetOn');

  const m1 = findById(Q.mergeCollection([base], [local],  [remote], NORMAL, NORMAL, null, 'devB'), 'r6');
  assertEq('[R6] first merge accumulates both sides', m1 && m1.cUp, 8);
  const m2 = findById(Q.mergeCollection([base], [clone(m1)], [remote], NORMAL, NORMAL, null, 'devB'), 'r6');
  assertEq('[R6] a 409 conflict retry does not re-add the peer taps', m2 && m2.cUp, 8);
  const m3 = findById(Q.mergeCollection([base], [clone(m2)], [remote], NORMAL, NORMAL, null, 'devB'), 'r6');
  assertEq('[R6] ...and neither does a second retry', m3 && m3.cUp, 8);
})();

// =========================================================================
// R7a -- cResetOn is a local day stamp merged with a plain max, so one device
// with a wrong date pinned the shared marker at a day nobody can ever exceed.
// _counterDidReset was then false for every later genuine reset while
// useMarkers stayed true, and the result clamped to 0.
//
// NOTE on the fixture: local is given one extra tap rather than being left
// deep-equal to base. cResetOn is merged inside _accumCounters, which only runs
// in the both-changed branch; with local == base the record takes the one-sided
// path, which adopts the remote object wholesale and never consults this rule.
// =========================================================================
(function(){
  const base   = { id: 'r7', type: 'habit', title: 'Pushups', cUp: 4, cResetOn: TODAY_STAMP, updatedAt: NORMAL_OLDER };
  const local  = { id: 'r7', type: 'habit', title: 'Pushups', cUp: 5, cResetOn: TODAY_STAMP, updatedAt: NEWER };
  const remote = { id: 'r7', type: 'habit', title: 'Pushups', cUp: 6, cResetOn: FAR_FUTURE_STAMP, updatedAt: NORMAL };

  const got = findById(Q.mergeCollection([base], [local], [remote], NORMAL, NORMAL, null, 'devB'), 'r7');
  assert('[R7a] a remote cResetOn in this device\'s future never becomes the merged marker',
    !!got && got.cResetOn !== FAR_FUTURE_STAMP);
  assertEq('[R7a] ...the plausible stamp is carried forward instead', got && got.cResetOn, TODAY_STAMP);
})();

// =========================================================================
// R7b -- mergeDayArray must survive a malformed charHistory. A bad row used to
// throw straight out of merge() into _syncNowAttempt's .catch, and every later
// round failed identically with no recovery from inside the app.
// =========================================================================
(function(){
  let threw = null, out = null;
  try { out = Q.merge(mk({}), mk({}), mk({charHistory: [null]}), NORMAL, NORMAL, 'devA', 'devB'); }
  catch(e){ threw = e; }
  assert('[R7b] a null charHistory row does not throw out of merge()', threw === null);
  assert('[R7b] ...and merge still returns a charHistory array',
    !!out && Array.isArray(out.charHistory));

  let threw2 = null, out2 = null;
  try { out2 = Q.merge(mk({}), mk({}), mk({charHistory: 'oops'}), NORMAL, NORMAL, 'devA', 'devB'); }
  catch(e){ threw2 = e; }
  assert('[R7b] a non-array charHistory does not throw out of merge()', threw2 === null);
  assert('[R7b] ...and merge still returns a charHistory array',
    !!out2 && Array.isArray(out2.charHistory));
})();

// ---- summary ----
console.log('\n--- round2-sync-merge.test.js summary ---');
if (failures) {
  console.error(failures + ' assertion(s) FAILED');
  process.exit(1);
}
console.log('round2-sync-merge.test.js: all assertions passed');
process.exit(0);
