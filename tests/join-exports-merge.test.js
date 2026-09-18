// join-exports-merge.test.js — regression tests for tools/join_exports.py.
//
// AGENTS.md §6 makes join_exports.py a mirror of the app's state schema, and a
// stale joiner a red deploy gate. These four cases each FAILED before the
// 2026-09-18 fixes and pass after:
//
//   J1  _is_default(False) was True in Python (`False == 0`), so in the
//       equal-updatedAt field merge a `done: False` could never beat a
//       `done: True` in EITHER argument order. The device saying "this daily is
//       not done" was structurally unable to be heard.
//   J2  charHistory was de-duped on the raw Date.now() millisecond with
//       `setdefault`, keeping whichever file was listed FIRST — so the newer
//       export's xp/gold/hp for that row were silently discarded. sync.js
//       mergeDayArray buckets by LOCAL day and folds numeric fields with max.
//   J3  the "newest file wins" tie-break iterated inputs in raw argv order, so
//       two runs over the same recovery set produced DIFFERENT state depending
//       on shell glob order. It must order by __savedAt.
//   J4  join_exports.md promised "deletions win over live tasks"; nothing
//       applied the overlay, so a task deleted on the newer device came back.
//
// The joiner is Python, so this shells out. If python is unavailable the file
// SKIPS loudly rather than failing — it must never turn the suite red on a
// machine that simply has no interpreter.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

const TOOL = path.join(__dirname, '..', 'tools', 'join_exports.py');
let PY = null;
for(const cand of ['python', 'python3', 'py']){
  try{ cp.execFileSync(cand, ['-c', 'import sys'], {stdio:'ignore'}); PY = cand; break; }catch(e){}
}
if(!fs.existsSync(TOOL)){ console.log('[SKIP] tools/join_exports.py not present'); process.exit(0); }
if(!PY){ console.log('[SKIP] no python interpreter on PATH — joiner tests not run'); process.exit(0); }

let pass = 0, fail = 0;
function ok(cond, msg){ if(cond){ console.log('[PASS] ' + msg); pass++; } else { console.log('[FAIL] ' + msg); fail++; } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'questa-join-'));
function write(name, obj){ const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(obj)); return p; }
function join(...ins){
  const out = path.join(dir, 'out-' + Math.random().toString(36).slice(2) + '.json');
  cp.execFileSync(PY, [TOOL, out, ...ins], {encoding:'utf8', stdio:['ignore','pipe','pipe']});
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}
// A minimal export shell. lastCron is set to the daily's doneDay so
// normalize_daily_resets does not independently clear `done` and mask J1.
function shell(savedAt, extra){
  return Object.assign({ version:1, __savedAt:savedAt, lastCron:20260101,
    char:{updatedAt:savedAt}, tasks:[], rewards:[], tags:[], devices:[],
    charHistory:[], deletions:[], events:[], prefs:{} }, extra||{});
}

// ── J1: `done: false` must be able to win an equal-updatedAt merge ──────────
{
  const doneTrue  = shell(1000, {tasks:[{id:'D1', type:'daily', title:'Stretch', updatedAt:5000, done:true,  doneDay:20260101}]});
  const doneFalse = shell(9000, {tasks:[{id:'D1', type:'daily', title:'Stretch', updatedAt:5000, done:false}]});
  const a = write('j1a.json', doneTrue), b = write('j1b.json', doneFalse);
  const ab = join(a, b).tasks.find(t=>t.id==='D1');
  const ba = join(b, a).tasks.find(t=>t.id==='D1');
  ok(ab.done === false, 'J1a newer export saying done:false wins the equal-ts merge');
  ok(ba.done === false, 'J1b ...and the same answer regardless of argument order');
}

// ── J2: charHistory folds by local day with max, not first-file-wins ───────
{
  const ts = new Date(2026, 0, 15, 9, 0, 0).getTime();   // LOCAL, so day_stamp_of matches
  const older = shell(2000, {charHistory:[{date:ts,     xp:10, gold:5,  lvl:3}]});
  const newer = shell(9000, {charHistory:[{date:ts+120, xp:20, gold:99, lvl:4}]});
  const a = write('j2a.json', older), b = write('j2b.json', newer);
  const rows = join(a, b).charHistory;
  ok(rows.length === 1, 'J2a two same-local-day rows fold into one bucket');
  ok(rows[0].xp === 20 && rows[0].gold === 99 && rows[0].lvl === 4,
     'J2b each numeric field takes the max, so the newer export is not discarded');
  // order independence
  const rows2 = join(b, a).charHistory;
  ok(rows2.length === 1 && rows2[0].gold === 99, 'J2c same result with the files swapped');
}

// ── J3: the equal-ts winner is the newest __savedAt, not the last argv ─────
{
  const old_ = shell(1000, {tasks:[{id:'H1', type:'habit', title:'Run OLD', updatedAt:5000, cUp:40}]});
  const new_ = shell(9000, {tasks:[{id:'H1', type:'habit', title:'Run NEW', updatedAt:5000, cUp:7}]});
  const a = write('j3old.json', old_), b = write('j3new.json', new_);
  const t1 = join(a, b).tasks.find(t=>t.id==='H1');
  const t2 = join(b, a).tasks.find(t=>t.id==='H1');
  ok(t1.title === 'Run NEW' && t2.title === 'Run NEW',
     'J3a the newest __savedAt wins regardless of command-line order');
  ok(t1.cUp === 7 && t2.cUp === 7, 'J3b ...and the join is deterministic across runs');
}

// ── J4: the tombstone overlay is actually applied ──────────────────────────
{
  const live = shell(1000, {tasks:[{id:'T1', type:'todo', title:'Buy milk', updatedAt:3000}]});
  const del  = shell(9000, {tasks:[], deletions:[{id:'T1', at:8000}]});
  const a = write('j4a.json', live), b = write('j4b.json', del);
  const res = join(a, b);
  ok(!res.tasks.some(t=>t.id==='T1'), 'J4a a task with a newer tombstone is excluded from the output');
  ok(res.deletions.some(d=>d.id==='T1'), 'J4b ...and the tombstone itself is carried forward');

  // ...but an edit made AFTER the delete still resurrects (sync.js mergeCollection rule)
  const reborn = shell(1000, {tasks:[{id:'T2', type:'todo', title:'Re-added', updatedAt:9000}]});
  const del2   = shell(9000, {tasks:[], deletions:[{id:'T2', at:8000}]});
  const c = write('j4c.json', reborn), d = write('j4d.json', del2);
  ok(join(c, d).tasks.some(t=>t.id==='T2'),
     'J4c an edit newer than the tombstone still wins (resurrects), matching sync.js');
}

try{ fs.rmSync(dir, {recursive:true, force:true}); }catch(e){}
console.log('\njoin-exports-merge: ' + pass + ' passed, ' + fail + ' failed');
if(fail) process.exit(1);
console.log('All join-exports-merge tests passed!');
