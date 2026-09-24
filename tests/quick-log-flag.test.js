// quick-log-flag.test.js -- per-habit quickLog checkbox in the habit edit sheet.
// 2026-09-24: the web quick-log sheet, ?quick= links and Options link panel were
// removed. The flag stays: the Android app reads it (inbox-meta habits.json) to pick
// its long-press shortcuts. The F/S/P blocks that tested the removed web parts are gone.
// Verifies the checkbox exists in drawSheet's habit block, reads t.quickLog,
// that openEdit's new-task template does NOT pre-set quickLog (absent-until-ticked),
// and that saveTask's diff-write persistence path is intact.
//
// Run: node tests/quick-log-flag.test.js  (also run by node tests/run.js)
const path = require('path');
const vm = require('vm');
const { readSource, extractFunction, extractLine, extractBraceBody } = require('./_extract.js');

const src = readSource(path.join(__dirname, '../app.js'));
const drawSheetSrc = extractFunction(src, /^function drawSheet\(\)\{/, 'drawSheet');

let fails = 0;
function assert(d, c) { if (c) console.log('[PASS] ' + d); else { console.error('[FAIL] ' + d); fails++; } }

// T1: drawSheet habit region contains the quick-log wiring (EDIT write-back).
const habitIdx = drawSheetSrc.indexOf("if(t.type==='habit')");
assert('T1a drawSheet has a habit block', habitIdx >= 0);
const habitRegion = habitIdx >= 0 ? drawSheetSrc.slice(habitIdx) : '';
assert('T1b habit block writes EDIT.quickLog on toggle', habitRegion.includes('EDIT.quickLog=this.checked'));
assert('T1c habit block re-renders after toggle', habitRegion.includes('EDIT.quickLog=this.checked;drawSheet()'));
assert('T1d checkbox has a stable id', habitRegion.includes('id="eQuickLog"') || habitRegion.includes("id=\\'eQuickLog\\'") || habitRegion.includes('eQuickLog'));

// T2: the checked expression reads the task flag.
assert('T2 checked state reads t.quickLog', habitRegion.includes("t.quickLog?'checked':''") || habitRegion.includes('t.quickLog'));

// T3: openEdit's new-task template does NOT pre-set quickLog (absent-until-ticked, D1).
const templateLine = extractLine(src, /type:type\|\|'todo',title:'',notes:''/, 'openEdit new-task template');
assert('T3 new-task template found', templateLine.length > 0);
assert('T3 template does not set quickLog', !templateLine.includes('quickLog'));

// T4: saveTask diff-write + updatedAt stamp intact (persistence needs no edit).
const saveTaskSrc = extractFunction(src, /^function saveTask\(/, 'saveTask');
assert('T4a saveTask diff-writes changed fields', saveTaskSrc.includes('if(!_eq(EDIT[k], _base[k])) orig[k] = EDIT[k]'));
assert('T4b saveTask stamps updatedAt', saveTaskSrc.includes('EDIT.updatedAt=now()'));

// T5: the real drawSheet still renders for habits (extraction consumers unbroken).
function render(EDIT) {
  const sheet = { innerHTML: '' };
  const factory = new Function(
    'EDIT', 'document', 'S', 'esc', 'uid', 'drawReminderEditor', 'tagEditorBlock',
    drawSheetSrc + '\nreturn drawSheet;'
  );
  const drawSheet = factory(
    EDIT,
    { getElementById: id => (id === 'sheet' ? sheet : null) },
    { prefs: { saveBtnTop: false } },
    s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    () => 'uid1',
    () => '',
    () => ''
  );
  drawSheet();
  return sheet.innerHTML;
}
const habitHtml = render({ id: 'h1', type: 'habit', title: 'Run', difficulty: 'easy', cUp: 0, cDown: 0 });
assert('T5a habit sheet renders the quick-log checkbox', habitHtml.includes('eQuickLog'));
assert('T5b unticked habit renders unchecked', !/\bid="eQuickLog"\s+checked[\s>]/.test(habitHtml));
const flaggedHtml = render({ id: 'h1', type: 'habit', title: 'Run', difficulty: 'easy', cUp: 0, cDown: 0, quickLog: true });
assert('T5c ticked habit renders checked', /id="eQuickLog"[^>]*checked/.test(flaggedHtml) || /checked[^>]*eQuickLog/.test(flaggedHtml) || (flaggedHtml.includes('eQuickLog') && flaggedHtml.includes('checked')));
const todoHtml = render({ id: 't1', type: 'todo', title: 'Mail', difficulty: 'easy', checklist: [] });
assert('T5d non-habit sheet has no quick-log checkbox', !todoHtml.includes('eQuickLog'));

if (fails) { console.error('quick-log-flag: ' + fails + ' assertion(s) failed'); process.exit(1); }
console.log('All quick-log-flag tests passed!');
