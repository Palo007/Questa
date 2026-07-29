// import-reparent.test.js -- Option A: re-parent imported events to this device
// so they pass the sync upload/ingest gates (evtUploadable / evtIncomingFilter)
// and propagate to other devices. Verifies:
//   R1: synthetic events get dev=myDev, uid set, synthetic deleted, imported=true
//   R2: dev:undefined (no dev key) events are re-parented the same way
//   R3: other-device events are re-parented (dev rewritten, uid reassigned)
//   R4: records ALREADY owned by this device are left untouched (uid/dev preserved)
//   R5: history content (ts/kind/taskId/taskTitle/value/reps/source) preserved
//   R6: idempotency: re-parenting the same list twice yields stable uids
//   R7: eventUidOf is deterministic for identical content
// Run: node tests/import-reparent.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
// Strip the very top diagnostic window block (needs real DOM) so the source
// evaluates in a sandbox; we only need the pure helper functions below.
src = src.replace(/\/\/ Questa app logic[\s\S]*?if\(typeof window!=="undefined"\)\{[\s\S]*?\}\r?\n\r?\n/, '');

const noop = function(){};
let MY_DEV = 'dev-me-123';

const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: { getItem: noop, setItem: noop, removeItem: noop, key: noop, length: 0 },
  indexedDB: undefined,
  setTimeout: function(fn){ return fn; }, clearTimeout: noop,
  setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, save: noop, esc: function(x){ return x; },
  uid: function(){ return 'test-uid'; },
  syncDeviceId: function(){ return MY_DEV; }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;

vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch(e) { /* boot code may need DOM; helpers still defined */ }

const eventUidOf = sandbox.eventUidOf;
const reparentEventsForImport = sandbox.reparentEventsForImport;
const eventImportSummary = sandbox.eventImportSummary;
const eventImportSummaryText = sandbox.eventImportSummaryText;
const eventImportSummaryHTML = sandbox.eventImportSummaryHTML;
if (typeof eventUidOf !== 'function' || typeof reparentEventsForImport !== 'function'
    || typeof eventImportSummary !== 'function' || typeof eventImportSummaryText !== 'function'
    || typeof eventImportSummaryHTML !== 'function') {
  console.error('FAIL: helpers not exposed on sandbox');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// R1: synthetic event re-parented
{
  const list = [{ ts: 1000, kind: 'habitTap', taskId: 't1', taskTitle: 'A', value: 5, reps: 1, source: 'habitica-backfill', synthetic: true }];
  const out = reparentEventsForImport(list);
  const e = out[0];
  assert('R1a: dev stamped to my device', e.dev === MY_DEV);
  assert('R1b: uid assigned', typeof e.uid === 'string' && e.uid.length > 0);
  assert('R1c: synthetic flag removed', !('synthetic' in e));
  assert('R1d: imported audit flag set', e.imported === true);
}

// R2: no dev key at all
{
  const list = [{ ts: 2000, kind: 'complete', taskId: 't2', taskTitle: 'B', value: 10 }];
  const e = reparentEventsForImport(list)[0];
  assert('R2a: dev stamped to my device', e.dev === MY_DEV);
  assert('R2b: uid assigned', typeof e.uid === 'string' && e.uid.length > 0);
  assert('R2c: no synthetic key (was never synthetic)', !('synthetic' in e));
}

// R3: other-device event re-parented (dev rewritten, uid reassigned)
{
  const list = [{ ts: 3000, kind: 'tap', taskId: 't3', dev: 'dev-other', uid: 'dev-other-xyz', value: 2 }];
  const e = reparentEventsForImport(list)[0];
  assert('R3a: dev rewritten to my device', e.dev === MY_DEV);
  assert('R3b: uid reassigned (not original)', e.uid !== 'dev-other-xyz');
  assert('R3c: new uid is content-hash form', e.uid.indexOf('rep-') === 0);
}

// R4: already-owned record untouched
{
  const list = [{ ts: 4000, kind: 'tap', taskId: 't4', dev: MY_DEV, uid: 'my-original-uid', value: 7 }];
  const e = reparentEventsForImport(list)[0];
  assert('R4a: dev preserved', e.dev === MY_DEV);
  assert('R4b: uid preserved', e.uid === 'my-original-uid');
  assert('R4c: imported flag NOT added', !('imported' in e));
  assert('R4d: synthetic untouched (absent)', !('synthetic' in e));
}

// R5: history content preserved
{
  const list = [{ ts: 5000, kind: 'complete', taskId: 't5', taskTitle: 'Title5', value: 12, reps: 3, source: 'habitica-backfill', synthetic: true }];
  const e = reparentEventsForImport(list)[0];
  assert('R5a: ts preserved', e.ts === 5000);
  assert('R5b: kind preserved', e.kind === 'complete');
  assert('R5c: taskId preserved', e.taskId === 't5');
  assert('R5d: taskTitle preserved', e.taskTitle === 'Title5');
  assert('R5e: value preserved', e.value === 12);
  assert('R5f: reps preserved', e.reps === 3);
  assert('R5g: source preserved', e.source === 'habitica-backfill');
  assert('R5h: id stripped', !('id' in e));
}

// R6: idempotency — same list re-parented twice yields identical uids
{
  const base = [{ ts: 6000, kind: 'habitTap', taskId: 't6', value: 1, synthetic: true }];
  const a = reparentEventsForImport(base.map(o => Object.assign({}, o)));
  const b = reparentEventsForImport(base.map(o => Object.assign({}, o)));
  assert('R6a: uids stable across re-parent', a[0].uid === b[0].uid);
  assert('R6b: dev stable', a[0].dev === b[0].dev);
}

// R7: eventUidOf deterministic
{
  const rec = { ts: 7000, kind: 'tap', taskId: 't7', value: 4 };
  // eventUidOf now takes (rec, idx); idx only affects output, content still drives it
  assert('R7a: eventUidOf deterministic for same rec+idx', eventUidOf(rec, 0) === eventUidOf(Object.assign({}, rec), 0));
  assert('R7b: eventUidOf differs on content change', eventUidOf(rec, 0) !== eventUidOf(Object.assign({}, rec, { value: 5 }), 0));
  assert('R7c: eventUidOf differs on index (collision safety)', eventUidOf(rec, 0) !== eventUidOf(rec, 1));
}

// R8: regression — reparenting the REAL merged export yields zero uid collisions,
// so sync's existingUidSet never drops legitimate history (was 941 collisions before fix).
{
  const mergedPath = path.join(__dirname, '..', 'questa-MERGED-20260716.json');
  if (!fs.existsSync(mergedPath)) {
    console.log('[SKIP] R8: merged export not present in repo');
  } else {
    const data = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
    const list = Array.isArray(data.events) ? data.events : [];
    const out = reparentEventsForImport(list.map(o => Object.assign({}, o)));
    const seen = new Set();
    let collisions = 0, missingUid = 0;
    for (const e of out) {
      if (typeof e.uid !== 'string' || !e.uid) { missingUid++; continue; }
      if (seen.has(e.uid)) collisions++; else seen.add(e.uid);
    }
    assert('R8a: every reparented event has a uid', missingUid === 0);
    assert('R8b: ZERO uid collisions across merged export (' + list.length + ' events)', collisions === 0);
    assert('R8c: distinct uids == event count (no loss on sync)', seen.size === list.length);
  }
}

// R9: eventImportSummary reconciles stored vs visible vs diagnostic, and the
// text form explains the discrepancy so users don't read it as a bug.
{
  const sample = [
    { ts: 1, kind: 'habitTap', taskId: 't1' },
    { ts: 2, kind: 'complete', taskType: 'daily', taskId: 't2' },
    { ts: 3, kind: 'subtask', taskType: 'todo', taskId: 't3' },
    { ts: 4, kind: 'lifecycle' },          // diagnostic -> hidden from feed
    { ts: 5, kind: 'storagePersist' },      // diagnostic -> hidden from feed
    { ts: 6, kind: 'import', taskTitle: 'Import Data' } // system category
  ];
  const sum = eventImportSummary(sample);
  assert('R9a: total counts all events', sum.total === 6);
  assert('R9b: diagnostic counted separately', sum.diagnostic === 2);
  assert('R9c: visible = total - diagnostic', sum.visible === 4);
  assert('R9d: byCat.habit == 1', sum.byCat.habit === 1);
  assert('R9e: byCat.daily == 1', sum.byCat.daily === 1);
  assert('R9f: byCat.todo == 1', sum.byCat.todo === 1);
  assert('R9g: byCat.system == 1 (import kind)', sum.byCat.system === 1);
  const txt = eventImportSummaryText(sum);
  assert('R9h: text mentions stored total', /6 stored total/.test(txt));
  assert('R9i: text mentions diagnostic hidden', /system\/diagnostic hidden/.test(txt));
  assert('R9j: text mentions per-category split', /Habits 1, Dailies 1, To-dos 1, System 1/.test(txt));
}

// R10: eventImportSummaryHTML renders a compact table with the reconciling
// counts and the "why the feed may show less" note (mobile-friendly structure).
{
  const sum = eventImportSummary([
    { ts: 1, kind: 'habitTap', taskId: 't1' },
    { ts: 4, kind: 'lifecycle' },
    { ts: 6, kind: 'import', taskTitle: 'Import Data' }
  ]);
  const html = eventImportSummaryHTML(sum);
  assert('R10a: renders a table', /<table class="evSummaryTbl">/.test(html));
  assert('R10b: table shows stored total', /Stored total/.test(html) && /3/.test(html));
  assert('R10c: table shows visible count', /Visible in feed/.test(html) && /2/.test(html));
  assert('R10d: table shows diagnostic hidden', /System \/ diagnostic hidden/.test(html) && /1/.test(html));
  assert('R10e: per-category chips present', /Habits/.test(html) && /System/.test(html));
  assert('R10f: explains feed-vs-stored discrepancy', /hides 1 system\/diagnostic/.test(html));
}

if (failures) {
  console.error(failures + ' import-reparent assertion(s) FAILED');
  process.exit(1);
}
console.log('import-reparent.test.js: all assertions passed');
process.exit(0);
