// join-daily-reset.test.js -- regression test for the merged-export daily-reset bug.
//
// Root cause (2026-07-16): join_exports.py merged the OLDER, not-yet-cronned
// backup's done:true daily state over the NEWER, already-reset backup on an
// updatedAt tie (runCron intentionally does not bump updatedAt). The fix mirrors
// sync.js normalizeDailyResets(tasks, max(lastCron)): carry lastCron = max of
// inputs and reset any done daily whose doneAt dayStamp is before that lastCron.
//
// 2026-07-29 (W0.1): this test used to shell out to three untracked repo-root
// backups (questa-RECOVERED-20260712.json, questa-backup-20260716-0744.json,
// questa-backup-20260716-0912.json) and assert hardcoded counts against them.
// Those three files silently became byte-identical copies of an already-joined
// artifact (no lastCron), which permanently broke the test through no code
// fault. Untracked data files must never be load-bearing for a test. This
// version is fully self-contained: it derives a small base export (see
// tests/fixtures/join-daily-reset-base.json -- extracted from a real, intact
// backup, trimmed of bulk fields like the base64 face image) and synthesizes
// three DISTINCT input exports at runtime, differing exactly in the dimensions
// this bug is about: lastCron and daily done/doneAt state. It also gives each
// synthetic input one unique event/charHistory/deletion record so the test can
// assert the join is a true union (no wholesale drop of a non-newest input).
//
// Run: node tests/join-daily-reset.test.js  (also run by node tests/run.js)

const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');

const root = path.join(__dirname, '..');
const joinPy = path.join(root, 'tools', 'join_exports.py');
const basePath = path.join(__dirname, 'fixtures', 'join-daily-reset-base.json');

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

function clone(o){ return JSON.parse(JSON.stringify(o)); }

const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const DAILY_ID = base.tasks.find(t => t.type === 'daily').id;
const HABIT_ID = base.tasks.find(t => t.type === 'habit').id;
assert('fixture base has a daily task', !!DAILY_ID);
assert('fixture base has a non-daily task', !!HABIT_ID);

// A shared updatedAt tie is exactly the condition that exposed the bug: two
// rows for the same task id, same updatedAt, divergent `done`. join_exports.py's
// row-merge treats `done:false` as a "default" value (Python `False == 0`), so
// on a tie the `done:true` side always used to win the raw row-merge -- the
// only thing that can correct it is the lastCron-carry + normalizeDailyResets
// overlay applied afterwards.
const TIE_TS = 1784000000000;
const DAY14 = Date.UTC(2026, 6, 14, 12, 0, 0); // 2026-07-14, noon UTC (TZ-safe)

// -- Variant A: oldest export, NOT yet cronned past the 14th. Daily completed
// and still shows done:true.
const a = clone(base);
a.__savedAt = 1784100000000;
a.lastCron = 20260714;
{
  const d = a.tasks.find(t => t.id === DAILY_ID);
  d.done = true; d.doneAt = DAY14; d.updatedAt = TIE_TS;
  d.checklist = (d.checklist || []).map(c => Object.assign({}, c, { done: true }));
}
a.events.push({ ts: TIE_TS, uid: 'u', dev: 'devA', kind: 'complete', id: 90001 });
a.charHistory.push({ date: 1780000000000, hp: 1, maxHp: 50, xp: 1, mp: 1, gold: 1, lvl: 1 });
a.deletions.push({ id: 'del-a-only', at: 1 });

// -- Variant B: middle export, distinct lastCron, daily untouched (still
// undone from before completion) with an older updatedAt so it never
// contests the tie -- just proves 3-way max(lastCron), not max-of-2.
const b = clone(base);
b.__savedAt = 1784150000000;
b.lastCron = 20260715;
{
  const d = b.tasks.find(t => t.id === DAILY_ID);
  d.done = false; d.doneAt = 0; d.updatedAt = TIE_TS - 5000;
}
b.events.push({ ts: TIE_TS - 5000, uid: 'u', dev: 'devB', kind: 'complete', id: 90002 });
b.charHistory.push({ date: 1780100000000, hp: 2, maxHp: 50, xp: 2, mp: 2, gold: 2, lvl: 2 });
b.deletions.push({ id: 'del-b-only', at: 2 });

// -- Variant C: newest export, already rolled past the 14th (highest
// lastCron). The daily was reset to done:false by that device's own cron, but
// doneAt from the 14th's completion is preserved (char XP/gold already
// granted; only the tick-box resets). Shares Variant A's updatedAt (the tie).
const c = clone(base);
c.__savedAt = 1784200000000;
c.lastCron = 20260716;
{
  const d = c.tasks.find(t => t.id === DAILY_ID);
  d.done = false; d.doneAt = DAY14; d.updatedAt = TIE_TS;
  d.checklist = (d.checklist || []).map(cl => Object.assign({}, cl, { done: false }));
}
c.events.push({ ts: TIE_TS, uid: 'u', dev: 'devC', kind: 'cron', id: 90003 });
c.charHistory.push({ date: 1780200000000, hp: 3, maxHp: 50, xp: 3, mp: 3, gold: 3, lvl: 3 });
c.deletions.push({ id: 'del-c-only', at: 3 });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'questa-join-test-'));
const inPaths = ['a.json', 'b.json', 'c.json'].map(n => path.join(tmpDir, n));
const inputs = [a, b, c];
inPaths.forEach((p, i) => fs.writeFileSync(p, JSON.stringify(inputs[i])));
const outPath = path.join(tmpDir, 'out.json');

let merged;
try {
  execFileSync('python', [joinPy, outPath].concat(inPaths), { encoding: 'utf8' });
  merged = JSON.parse(fs.readFileSync(outPath, 'utf8'));
} catch(e){
  console.error('[FAIL] join_exports.py raised: ' + (e.stdout || '') + (e.stderr || ''));
  process.exit(1);
}

// -- lastCron carry: must be the max across all three distinct inputs, not
// just the newest __savedAt export and not just the max of the tied pair.
assertEq('lastCron carried = max(20260714,20260715,20260716) = 20260716', merged.lastCron, 20260716);

// -- The fix under test: despite the updatedAt tie letting done:true win the
// raw row-merge (see comment above), normalizeDailyResets must catch it
// because doneAt's dayStamp (20260714) is behind the carried lastCron
// (20260716).
const dailies = merged.tasks.filter(t => t.type === 'daily');
assertEq('exactly one merged daily row for the shared id (no duplication)', dailies.length, 1);
const dailiesDone = dailies.filter(t => t.done).length;
assertEq('no daily left done:true after normalizeDailyResets', dailiesDone, 0);

const mergedDaily = dailies[0];
assertEq('tied done:true (stale, not-yet-cronned) daily reset to done:false', mergedDaily.done, false);
assertEq('doneAt preserved across the reset (char XP/gold already granted)', mergedDaily.doneAt, DAY14);
assert('checklist reset alongside the parent daily',
       !Array.isArray(mergedDaily.checklist) || mergedDaily.checklist.every(ch => ch.done === false));

// -- Non-daily task untouched by the overlay.
const mergedHabit = merged.tasks.find(t => t.id === HABIT_ID);
assert('non-daily task present and untouched by normalizeDailyResets', !!mergedHabit);

// -- No wholesale drop of a non-newest input: each variant's unique
// event/charHistory/deletion record must survive the union merge.
assertEq('events union: 2 shared + 3 unique = 5', merged.events.length, 5);
assertEq('charHistory union: 1 shared + 3 unique = 4', merged.charHistory.length, 4);
assertEq('deletions union: 1 shared + 3 unique = 4', merged.deletions.length, 4);
assert('conflicts recorded, not silently dropped', Array.isArray(merged._joinConflicts) && merged._joinConflicts.length >= 1);

// Cleanup: this test creates its own temp inputs/output; leave no trace.
for(const p of inPaths.concat([outPath])){ try { fs.unlinkSync(p); } catch(e){} }
try { fs.rmdirSync(tmpDir); } catch(e){}

if(failures){ console.error('\n' + failures + ' FAILURE(S)'); process.exit(1); }
console.log('\nALL JOIN DAILY-RESET TESTS PASSED');
