// quick-log-flag.test.js -- per-habit Android shortcut choice in the habit edit sheet.
// 2026-09-24: the web quick-log sheet, ?quick= links and Options link panel were
// removed. The flag stays: the Android app reads it (inbox-meta habits.json) to pick
// its long-press shortcuts. Later the same day the tick became a 4-way choice:
// quickLog false (Off) | true (+1, the old tick) | 'down' (-1) | 'both'.
// Verifies the choice in drawSheet's habit block, quickLogMode/quickLogDirs, that
// openEdit's new-task template does NOT pre-set quickLog, and that saveTask's
// diff-write persistence path is intact.
//
// Run: node tests/quick-log-flag.test.js  (also run by node tests/run.js)
const path = require('path');
const { readSource, extractFunction, extractLine } = require('./_extract.js');

const src = readSource(path.join(__dirname, '../app.js'));
const drawSheetSrc = extractFunction(src, /^function drawSheet\(\)\{/, 'drawSheet');
const quickLogMode = new Function(extractFunction(src, /^function quickLogMode\(t\)\{/, 'quickLogMode') + '\nreturn quickLogMode;')();
const quickLogDirs = new Function('quickLogMode',
  extractFunction(src, /^function quickLogDirs\(t\)\{/, 'quickLogDirs') + '\nreturn quickLogDirs;')(quickLogMode);

let fails = 0;
function assert(d, c) { if (c) console.log('[PASS] ' + d); else { console.error('[FAIL] ' + d); fails++; } }

// T1: drawSheet habit region contains the choice wiring (EDIT write-back).
const habitIdx = drawSheetSrc.indexOf("if(t.type==='habit')");
assert('T1a drawSheet has a habit block', habitIdx >= 0);
const habitRegion = habitIdx >= 0 ? drawSheetSrc.slice(habitIdx) : '';
assert('T1b choice buttons write EDIT.quickLog and re-render', habitRegion.includes("onclick=\"EDIT.quickLog='+o[2]+';drawSheet()\""));
assert('T1c choice offers Off / +1 / -1 / both',
  habitRegion.includes("['off','Off','false']") && habitRegion.includes("['up','+1','true']")
  && habitRegion.includes("['down',") && habitRegion.includes("['both',"));
assert('T1d choice has a stable id', habitRegion.includes('id="eQuickLog"'));

// T2: the selected button reads the task flag through quickLogMode.
assert('T2 selected state reads quickLogMode(t)', habitRegion.includes('quickLogMode(t)'));

// T3: openEdit's new-task template does NOT pre-set quickLog (absent-until-ticked, D1).
const templateLine = extractLine(src, /type:type\|\|'todo',title:'',notes:''/, 'openEdit new-task template');
assert('T3 new-task template found', templateLine.length > 0);
assert('T3 template does not set quickLog', !templateLine.includes('quickLog'));

// T4: saveTask diff-write + updatedAt stamp intact (persistence needs no edit).
const saveTaskSrc = extractFunction(src, /^function saveTask\(/, 'saveTask');
assert('T4a saveTask diff-writes changed fields', saveTaskSrc.includes('if(!_eq(EDIT[k], _base[k])) orig[k] = EDIT[k]'));
assert('T4b saveTask stamps updatedAt', saveTaskSrc.includes('EDIT.updatedAt=now()'));

// T5: the real drawSheet renders the choice with the right button selected.
function render(EDIT) {
  const sheet = { innerHTML: '' };
  const factory = new Function(
    'EDIT', 'document', 'S', 'esc', 'uid', 'drawReminderEditor', 'tagEditorBlock', 'quickLogMode',
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
    () => '',
    quickLogMode
  );
  drawSheet();
  return sheet.innerHTML;
}
const habit = extra => Object.assign({ id: 'h1', type: 'habit', title: 'Run', difficulty: 'easy', cUp: 0, cDown: 0 }, extra);
const onBtn = html => { const m = html.match(/class="on" data-ql="(\w+)"/); return m ? m[1] : null; };
const habitHtml = render(habit({}));
assert('T5a habit sheet renders the Android shortcut choice', habitHtml.includes('id="eQuickLog"'));
assert('T5b unset habit selects Off', onBtn(habitHtml) === 'off');
assert('T5c old tick (true) selects +1', onBtn(render(habit({ quickLog: true }))) === 'up');
assert('T5e down selects -1', onBtn(render(habit({ quickLog: 'down' }))) === 'down');
assert('T5f both selects +1 and -1', onBtn(render(habit({ quickLog: 'both' }))) === 'both');
const todoHtml = render({ id: 't1', type: 'todo', title: 'Mail', difficulty: 'easy', checklist: [] });
assert('T5d non-habit sheet has no Android shortcut choice', !todoHtml.includes('eQuickLog'));

// T6: quickLogDirs -- which Android items a habit gets, limited to its own buttons.
const D = t => JSON.stringify(quickLogDirs(t));
assert('T6a off -> []', D({}) === '[]' && D({ quickLog: false }) === '[]');
assert('T6b true -> [1]', D({ quickLog: true }) === '[1]');
assert('T6c down -> [-1]', D({ quickLog: 'down' }) === '[-1]');
assert('T6d both -> [1,-1]', D({ quickLog: 'both' }) === '[1,-1]');
assert('T6e both on a +-only habit -> [1]', D({ quickLog: 'both', down: false }) === '[1]');
assert('T6f down on a +-only habit -> []', D({ quickLog: 'down', down: false }) === '[]');

if (fails) { console.error('quick-log-flag: ' + fails + ' assertion(s) failed'); process.exit(1); }
console.log('All quick-log-flag tests passed!');
