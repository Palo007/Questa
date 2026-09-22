// quick-log-flag.test.js -- quick-log checkbox in the habit edit sheet (todo 0)
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

if (fails) { console.error('todo-0: ' + fails + ' assertion(s) failed (continuing to todo-1 block)'); }
console.log('All quick-log-flag tests passed!');

// F1-F5: quickLogHabits unit contract (todo 1) — run the real helper from app.js.
const _qlMatch = src.match(/\/\* BEGIN_QUICKLOG_HELPERS \*\/([\s\S]*?)\/\* END_QUICKLOG_HELPERS \*\//);
assert('F0 quicklog block found', !!_qlMatch);
const _qlCode = _qlMatch ? _qlMatch[1] : '';
const _qlApi = vm.runInContext(_qlCode + '\n;({quickLogHabits,drawQuickSheet});', vm.createContext({}));
const quickLogHabits = _qlApi.quickLogHabits;
assert('F-decl helper is a function', typeof quickLogHabits === 'function');
assert('F-decl helper between BEGIN/END markers', _qlCode.indexOf('function quickLogHabits(tasks)') !== -1);
{
  const a = { id: 'h1', type: 'habit', title: 'Run' };
  const b = { id: 'h2', type: 'habit', title: 'Read', quickLog: true };
  const c = { id: 'h3', type: 'habit', title: 'Meditate', quickLog: true };
  const r1 = quickLogHabits([a, b, c]);
  assert('F1 flagged-only when any flag', r1.length === 2 && r1[0] === b && r1[1] === c);
}
{
  const a = { id: 'h1', type: 'habit', title: 'Run' };
  const d = { id: 'd1', type: 'daily', title: 'Brush' };
  const list = [a, d];
  assert('F2 fallback returns identical list when no flags', quickLogHabits(list) === list);
  const r2b = quickLogHabits([{ id: 'h9', type: 'habit', title: 'X' }]);
  assert('F2b single unflagged returns same ref', r2b.length === 1 && r2b[0].id === 'h9');
}
{
  // Type-agnostic contract: a flagged daily passed DIRECTLY is returned —
  // the call sites own type==='habit' filtering, not the helper.
  const d = { id: 'd1', type: 'daily', title: 'Brush', quickLog: true };
  const h = { id: 'h1', type: 'habit', title: 'Run' };
  const r3 = quickLogHabits([d, h]);
  assert('F3 flagged daily returned when passed directly', r3.length === 1 && r3[0] === d);
  assert('F3b sheet filters habits first', _qlCode.indexOf("quickLogHabits(habits)") !== -1);
  assert('F3c panel filters habits first', src.indexOf("quickLogHabits(_qlHabits)") !== -1);
}
assert('F4 empty input -> empty', Array.isArray(quickLogHabits([])) && quickLogHabits([]).length === 0);

// S-style render: drawQuickSheet with h1+h4 flagged shows only those rows;
// with flags cleared the original list returns. Uses the real helper block in a vm.
function renderSheet(taskList) {
  const st = {};
  const doc = { getElementById(id) { return st[id] || null; }, _st: st };
  const mk = () => ({ innerHTML: '', classList: { add() {}, remove() {}, contains() { return false; } } });
  st.sheet = mk(); st.scrim = mk();
  const escFn = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sb = { S: { tasks: taskList }, document: doc, esc: escFn, TAB: 'habits' };
  vm.createContext(sb);
  const drawQuickSheet = vm.runInContext(_qlCode + '\n;drawQuickSheet;', sb);
  drawQuickSheet();
  return st.sheet.innerHTML;
}
{
  const base = [
    { id: 'h1', type: 'habit', title: 'Run', difficulty: 'easy' },
    { id: 'h2', type: 'habit', title: 'Cigs', difficulty: 'log', cUp: 1 },
    { id: 'h3', type: 'habit', title: 'Meditate', difficulty: 'log' },
    { id: 'h4', type: 'habit', title: 'Read' }
  ];
  const flagged = base.map(t => (t.id === 'h1' || t.id === 'h4') ? Object.assign({}, t, { quickLog: true }) : Object.assign({}, t));
  const htmlF = renderSheet(flagged);
  assert('S-flag sheet lists h1', htmlF.indexOf('Run') !== -1);
  assert('S-flag sheet lists h4', htmlF.indexOf('Read') !== -1);
  assert('S-flag sheet hides unflagged h3', htmlF.indexOf('Meditate') === -1);
  assert('S-flag sheet logged Log habit excluded', htmlF.indexOf('Cigs') === -1);
  assert('S-flag sheet row count 2', htmlF.split('quickRow').length - 1 === 2);
  const htmlA = renderSheet(base);
  assert('S-fallback sheet keeps 3 rows', htmlA.split('quickRow').length - 1 === 3);
  assert('S-fallback sheet lists h3', htmlA.indexOf('Meditate') !== -1);
  // Flagged + logged Log habit: flag does not override the log-predicate.
  const logged = base.map(t => (t.id === 'h3') ? Object.assign({}, t, { quickLog: true, cUp: 2 }) : Object.assign({}, t));
  const htmlL = renderSheet(logged);
  assert('S-flagged logged h3 excluded by predicate', htmlL.indexOf('Meditate') === -1);
}

// P1-P3: panel source assertions — hint present once, compact, appended after setup note.
{
  const branch = extractBraceBody(src, /\} else if\(key==='quicklog'\)\{/, 'openOpt quicklog branch');
  const idxSetup = branch.indexOf('URL-shortcut widget');
  const idxHint = branch.indexOf('quick-log habit');
  assert('P1 flags-exist hint present exactly once', idxHint !== -1 && branch.indexOf('quick-log habit', idxHint + 1) === -1);
  assert('P2 hint is compact (font-size:11px marker)', branch.indexOf('font-size:11px') !== -1);
  assert('P3 hint appended after setup note', idxSetup !== -1 && idxHint > idxSetup);
}

if (fails) { console.error(fails + ' assertion(s) failed'); process.exit(1); }
console.log('All quick-log-flag todo-1 tests passed!');
