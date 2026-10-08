// edit-event-diff.test.js -- CR-KT-016: saveTask must log the user's field edits.
//
// Bug (found by the Kotlin session 2026-10-08): saveTask copied the sheet into the live
// record and ran `EDIT = orig` BEFORE building the 'edit' event change list from
// `orig` vs `EDIT` -- one object compared with itself, so title / notes / difficulty /
// checklist / schedule / reminders edits never reached the Activity log.
//
// These tests run the REAL saveTask in a vm sandbox (DOM, sync and fx stubbed) and
// assert on the event logEvent receives.
//
// Run: node tests/edit-event-diff.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
const J = function(x){ return JSON.stringify(x); };
const clone = function(x){ return JSON.parse(JSON.stringify(x)); };

const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const fns = [
  extractFunction(src, /^function saveTask\(\)\{/, 'saveTask'),
  extractFunction(src, /^function attUserDelta\(/, 'attUserDelta'),
  extractFunction(src, /^function attReconcileSave\(/, 'attReconcileSave'),
].join('\n');

// live: the record in S.tasks at save time. base: the sheet-open baseline (EDIT_BASE).
// sheet: what the user has in the sheet when pressing Save (title/notes come from the DOM).
function runSave(live, base, sheet){
  const logged = [];
  let n = 0;
  const ctx = vm.createContext({
    S: { tasks: [live], char: { xp:0, gold:0, mp:0, hp:50, maxHp:50 } },
    document: {
      getElementById: function(id){ return { value: id === 'eTitle' ? sheet.title : (id === 'eNotes' ? (sheet.notes || '') : '') }; },
      querySelectorAll: function(){ return []; },
    },
    uid: function(){ return 'u' + (++n); },
    now: function(){ return 1791460300000 + (++n); },
    logEvent: function(ev){ logged.push(clone(ev)); },
    toast: function(){}, closeSheet: function(){}, save: function(){}, render: function(){},
    floatFx: function(){}, buzz: function(){}, bumpAvatar: function(){},
    setTimeout: function(){}, window: { scrollTo: function(){} },
  });
  vm.runInContext('var EDIT, EDIT_BASE;\n' + fns, ctx);
  ctx.EDIT = clone(sheet);
  ctx.EDIT_BASE = clone(base);
  vm.runInContext('saveTask()', ctx);
  return { events: logged, live: ctx.S.tasks[0] };
}
const fields = function(ev){ return ev ? ev.changes.map(function(c){ return c.field; }) : null; };

const BASE = { id:'t1', type:'todo', title:'Buy milk', notes:'', difficulty:'easy',
  checklist:[ { id:'c1', text:'Shop', done:false } ], updatedAt: 1 };

// A: title + notes + difficulty edits are logged with from/to (the reported bug).
{
  const sheet = Object.assign(clone(BASE), { title:'Buy oat milk', notes:'2 l', difficulty:'hard' });
  const r = runSave(clone(BASE), BASE, sheet);
  const ev = r.events[0];
  assert('A1: one edit event is logged', r.events.length === 1 && ev.kind === 'edit');
  assert('A2: changes are title, notes, difficulty (in that order)', J(fields(ev)) === J(['title','notes','difficulty']));
  assert('A3: title from/to are the old and new title', J(ev.changes[0]) === J({field:'title', from:'Buy milk', to:'Buy oat milk'}));
  assert('A4: the live record got the edit', r.live.title === 'Buy oat milk' && r.live.difficulty === 'hard');
}
// B: checklist add / text change / toggle are logged as items.
{
  const sheet = clone(BASE);
  sheet.checklist = [ { id:'c1', text:'Shop', done:true }, { id:'c2', text:'Pay', done:false } ];
  const r = runSave(clone(BASE), BASE, sheet);
  const cl = r.events[0] && r.events[0].changes.find(function(c){ return c.field === 'checklist'; });
  assert('B1: checklist item list = toggled c1, added c2',
    !!cl && J(cl.items) === J([{type:'toggled', to:'Shop', done:true}, {type:'added', to:'Pay'}]));
}
// C: a subtask that arrived by sync while the sheet was open is kept, but is NOT
// logged as the user's 'added' item.
{
  const live = clone(BASE);
  live.checklist.push({ id:'peer', text:'From the other phone', done:false });
  const sheet = Object.assign(clone(BASE), { title:'Buy milk!' });
  const r = runSave(live, BASE, sheet);
  assert('C1: only the title change is logged', J(fields(r.events[0])) === J(['title']));
  assert('C2: the sync-arrived subtask survives in the live record',
    r.live.checklist.some(function(c){ return c.id === 'peer'; }));
}
// D: Save with no change logs nothing.
{
  const r = runSave(clone(BASE), BASE, clone(BASE));
  assert('D1: no edit event when nothing changed', r.events.length === 0);
}
// E: schedule + image delta in one save.
{
  const base = Object.assign(clone(BASE), { type:'daily', repeat:[true,true,true,true,true,true,true] });
  const sheet = Object.assign(clone(base), { repeat:[true,false,true,false,true,false,true],
    attachments:[ { id:'A', sha:'s', mime:'image/jpeg', w:1, h:1, bytes:1, addedAt:1 } ] });
  const r = runSave(clone(base), base, sheet);
  assert('E1: changes are schedule then attachments', J(fields(r.events[0])) === J(['schedule','attachments']));
}

if(failures){ console.error('\n' + failures + ' FAILED'); process.exit(1); }
console.log('\nAll edit-event-diff tests passed.');
