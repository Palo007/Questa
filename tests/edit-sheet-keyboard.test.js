// edit-sheet-keyboard.test.js
// 2026-09-23 UX requests, both on the task edit sheet:
//   1. "+ Add subtask" must land focus in the new row's text input. drawSheet()
//      rebuilds #sheet via innerHTML, which destroys focus -- the old inline
//      onclick left the caret on <body> and the fresh input needed a tap.
//   2. Enter must save AND close the edit view (saveTask() ends in
//      closeSheet(); save(); render();). Fallback ask -- Tab reaches Save --
//      is also pinned: the Save <button> carries no tabindex="-1", so native
//      tab order reaches it.
//   3. (follow-up, 2026-09-23) opening the task sheet must focus AND select the
//      Title field, so the first keystroke replaces the old title (T11).
// Wire-up lives in openEdit() (sheet.onkeydown), NOT inside drawSheet():
// edit-sheet-live-sync and quick-log-flag run drawSheet() in a bare Function
// factory whose parameter list would not carry onSheetKeydown.
//
// Fails before the change: extractFunction anchors for addSubtask /
// onSheetKeydown match 0 lines (throw), the Add button still renders the old
// inline EDIT.checklist.push onclick, openEdit has no .onkeydown assignment,
// and the saveTask-closes pin is the contract Enter relies on.
const path = require('path');
const { readSource, extractFunction, extractLine } = require('./_extract.js');

const src = readSource(path.join(__dirname, '../app.js'));
const addSubtaskSrc = extractFunction(src, /^function addSubtask\(\)/, 'addSubtask');
const keydownSrc = extractFunction(src, /^function onSheetKeydown\(e\)\{/, 'onSheetKeydown');
const openEditSrc = extractFunction(src, /^function openEdit\(id,type\)\{/, 'openEdit');
const saveTaskSrc = extractFunction(src, /^function saveTask\(\)\{/, 'saveTask');
const drawSheetSrc = extractFunction(src, /^function drawSheet\(\)\{/, 'drawSheet');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// --- harness: real drawSheet() against a minimal mock DOM -------------------
function render(EDIT, saveBtnTop) {
  const sheet = { innerHTML: '' };
  const factory = new Function(
    'EDIT', 'document', 'S', 'esc', 'uid', 'drawReminderEditor', 'tagEditorBlock',
    drawSheetSrc + '\nreturn drawSheet;'
  );
  const drawSheet = factory(
    EDIT,
    { getElementById: id => (id === 'sheet' ? sheet : null) },
    { prefs: { saveBtnTop: !!saveBtnTop } },
    s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    () => 'uid1',
    () => '',
    () => ''
  );
  drawSheet();
  return sheet.innerHTML;
}
function newTodo() {
  return { id: null, type: 'todo', title: '', notes: '', difficulty: 'easy', checklist: [] };
}

// --- harness: real addSubtask() against a mock document ---------------------
function runAdd(EDIT) {
  const calls = { drawn: 0, focused: [], scrolled: 0, selector: null };
  const inputs = [
    { focus() { calls.focused.push('row0'); }, scrollIntoView() { calls.scrolled++; } },
    { focus() { calls.focused.push('row1'); }, scrollIntoView() { calls.scrolled++; } },
  ];
  const doc = { querySelectorAll(sel) { calls.selector = sel; return inputs; } };
  const factory = new Function(
    'EDIT', 'drawSheet', 'uid', 'document',
    addSubtaskSrc + '\nreturn addSubtask;'
  );
  const addSubtask = factory(EDIT, () => { calls.drawn++; }, () => 'uidNew', doc);
  let threw = null;
  try { addSubtask(); } catch (e) { threw = e; }
  return { calls, inputs, threw };
}

// --- harness: real onSheetKeydown() -----------------------------------------
// opts: {EDIT, eTitle, key, target, ctrlKey, metaKey, isComposing, defaultPrevented}
function runKey(opts) {
  opts = opts || {};
  const state = { saved: 0, prevented: false };
  const doc = {
    getElementById: id => (id === 'eTitle' && opts.eTitle !== false) ? { id: 'eTitle' } : null,
  };
  const factory = new Function(
    'EDIT', 'document', 'saveTask',
    keydownSrc + '\nreturn onSheetKeydown;'
  );
  const EDIT = ('EDIT' in opts) ? opts.EDIT : {};
  const onSheetKeydown = factory(EDIT, doc, () => { state.saved++; });
  const e = {
    key: ('key' in opts) ? opts.key : 'Enter',
    isComposing: !!opts.isComposing,
    defaultPrevented: !!opts.defaultPrevented,
    ctrlKey: !!opts.ctrlKey,
    metaKey: !!opts.metaKey,
    target: opts.target || { tagName: 'INPUT' },
    preventDefault() { state.prevented = true; },
  };
  let threw = null;
  try { onSheetKeydown(e); } catch (err) { threw = err; }
  return { state, threw };
}

// --- T1: addSubtask pushes a row, re-renders, focuses the LAST input --------
{
  const EDIT = newTodo();
  EDIT.checklist.push({ id: 'old', text: 'existing', done: false });
  const { calls, inputs, threw } = runAdd(EDIT);
  assert('T1a addSubtask does not throw', threw === null);
  assert('T1b it appends one row {id, text:\'\', done:false}',
    EDIT.checklist.length === 2 &&
    EDIT.checklist[1].id === 'uidNew' &&
    EDIT.checklist[1].text === '' &&
    EDIT.checklist[1].done === false);
  assert('T1c it re-renders via drawSheet (innerHTML swap is why focus must be re-applied)',
    calls.drawn === 1);
  assert('T1d focus lands on the LAST row input, not row0',
    calls.focused.length === 1 && calls.focused[0] === 'row1');
  assert('T1e the new row is scrolled into view', calls.scrolled === 1);
  assert('T1f it targets the checklist inputs drawSheet actually renders (' + calls.selector + ')',
    calls.selector === '#eCheck .ci input[type="text"]');
}

// --- T2: addSubtask guards --------------------------------------------------
{
  const noList = { id: 't1', type: 'todo' };  // checklist key absent entirely
  const r1 = runAdd(noList);
  assert('T2a missing checklist array is created, not a TypeError',
    r1.threw === null && Array.isArray(noList.checklist) && noList.checklist.length === 1);
  const r2 = runAdd(null);
  assert('T2b EDIT null (sheet closed under us) is a no-op, not a crash',
    r2.threw === null && r2.calls.drawn === 0);
}

// --- T3: the rendered button routes through addSubtask ----------------------
{
  // The selector contract must be checked on a sheet that actually HAS rows:
  // an empty checklist renders no .ci divs at all.
  const withList = newTodo();
  withList.checklist.push({ id: 'c1', text: 'one', done: false });
  const html = render(withList, false);
  assert('T3a "+ Add subtask" onclick is addSubtask()',
    html.includes('onclick="addSubtask()">+ Add subtask'));
  assert('T3b the old inline push onclick is gone from the rendered sheet',
    !html.includes('EDIT.checklist.push'));
  assert('T3c the selector contract holds: rows live in #eCheck as .ci with a type=text input',
    html.includes('id="eCheck"') && /<div class="ci"/.test(html) && /<input type="text"/.test(html));
}

// --- T4: openEdit wires Enter; drawSheet stays factory-safe -----------------
{
  assert('T4a openEdit assigns sheet.onkeydown = onSheetKeydown',
    openEditSrc.includes("document.getElementById('sheet').onkeydown = onSheetKeydown;"));
  assert('T4b the wiring happens before the scrim is shown (key works from first paint)',
    openEditSrc.indexOf('onSheetKeydown') < openEditSrc.indexOf("scrim').classList.add('show')"));
  assert('T4c drawSheet never references onSheetKeydown (factory-param safety for sibling tests)',
    !/onSheetKeydown/.test(drawSheetSrc));
}

// --- T5: Enter saves from single-line inputs --------------------------------
{
  const r = runKey({ target: { tagName: 'INPUT' } });          // #eTitle
  assert('T5a Enter on the title input calls saveTask', r.state.saved === 1);
  assert('T5b ...and is preventDefault-ed (no stray native action)', r.state.prevented === true);
  const r2 = runKey({ target: { tagName: 'INPUT' } });          // a subtask row input
  assert('T5c Enter on a subtask row input also saves', r2.state.saved === 1);
  const r3 = runKey({ target: { tagName: 'INPUT', type: 'checkbox' } });
  assert('T5d Enter on an in-sheet checkbox saves (non-Enter keys are never intercepted)',
    r3.state.saved === 1);
}

// --- T6: Notes textarea keeps plain Enter as a newline ----------------------
{
  const plain = runKey({ target: { tagName: 'TEXTAREA' } });
  assert('T6a plain Enter in Notes does NOT save (the newline must land)',
    plain.state.saved === 0 && plain.state.prevented === false);
  const ctrl = runKey({ target: { tagName: 'TEXTAREA' }, ctrlKey: true });
  assert('T6b Ctrl+Enter in Notes saves', ctrl.state.saved === 1);
  const meta = runKey({ target: { tagName: 'TEXTAREA' }, metaKey: true });
  assert('T6c Cmd+Enter in Notes saves (macOS muscle memory)', meta.state.saved === 1);
}

// --- T7: native button activation is left alone -----------------------------
{
  const r = runKey({ target: { tagName: 'BUTTON' } });
  assert('T7 Enter on Save/Cancel/Delete/Add-subtask defers to native Enter->click, not double-fire',
    r.state.saved === 0 && r.state.prevented === false);
}

// --- T8: the interference guards --------------------------------------------
{
  const tagInp = runKey({ defaultPrevented: true });           // #eTagInput already used the key
  assert('T8a defaultPrevented (tag input added a tag) -- we stay out',
    tagInp.state.saved === 0);
  const ime = runKey({ isComposing: true });                   // IME commit keystroke
  assert('T8b IME composition Enter never saves', ime.state.saved === 0);
  const noEdit = runKey({ EDIT: null });                       // stale listener, sheet closed
  assert('T8c EDIT null (another #sheet content: settings/reward/picker) -- no save',
    noEdit.state.saved === 0);
  const noTitle = runKey({ EDIT: {}, eTitle: false });         // EDIT set but task sheet not rendered
  assert('T8d #eTitle absent -- task sheet is not what #sheet shows, no save',
    noTitle.state.saved === 0);
  const other = runKey({ key: 'a' });
  assert('T8e non-Enter keys pass through untouched', other.state.saved === 0 && other.state.prevented === false);
  let nullThrew = null;
  try {
    const f = new Function('EDIT', 'document', 'saveTask', keydownSrc + '\nreturn onSheetKeydown;');
    f({}, { getElementById: () => null }, () => {})({ key: 'Enter' });
  } catch (e) { nullThrew = e; }
  assert('T8f an event with no target does not crash', nullThrew === null);
}

// --- T9: fallback ask -- Tab reaches Save -----------------------------------
{
  const bottom = render(newTodo(), false);
  assert('T9a bottom bar renders Save wired to saveTask()',
    bottom.includes('onclick="saveTask()">Save</button>'));
  assert('T9b nothing in the sheet is removed from tab order (no tabindex="-1")',
    !bottom.includes('tabindex="-1"'));
  const top = render(newTodo(), true);
  assert('T9c saveBtnTop mode renders the header Save instead',
    top.includes('onclick="saveTask()"'));
}

// --- T10: Enter -> saveTask really means save AND close ---------------------
{
  assert('T10 saveTask ends in closeSheet(); save(); render(); -- the contract Enter relies on',
    saveTaskSrc.includes('closeSheet(); save(); render();'));
}

// --- T11: opening the sheet focuses AND selects Title -----------------------
// Follow-up ask (2026-09-23): "when I open the task edit window, the title field
// should be selected so that I can directly modify it". Drives the REAL
// openEdit() against a mock DOM and asserts the ORDER of side effects, because
// two plausible-looking variants fail silently in a browser: a focus() fired
// before the scrim gets .show targets a display:none subtree, and a deferred
// focus() (setTimeout / requestAnimationFrame) never raises the mobile keyboard.
{
  function runOpen(opts) {
    opts = opts || {};
    const log = [];
    const title = {
      focus() { log.push('title.focus'); },
      select() { log.push('title.select'); },
    };
    if (opts.noSelect) delete title.select;
    const scrim = { classList: { add(cls) { log.push('scrim.add:' + cls); } } };
    const sheet = { onkeydown: null };
    const doc = {
      getElementById(id) {
        if (id === 'scrim') return scrim;
        if (id === 'sheet') return sheet;
        if (id === 'eTitle') return opts.noTitle ? null : title;
        return null;
      },
    };
    const factory = new Function(
      'id', 'type', 'S', 'EDIT', 'EDIT_BASE', 'document', 'toast', 'render', 'drawSheet', 'onSheetKeydown',
      openEditSrc +
      '\nreturn { open: openEdit,' +
      ' get EDIT(){ return EDIT; },' +
      ' get EDIT_BASE(){ return EDIT_BASE; } };'
    );
    const api = factory(
      'id' in opts ? opts.id : null,
      opts.type || 'todo',
      { tasks: [{ id: 't1', type: 'todo', title: 'Buy milk', difficulty: 'easy' }] },
      {}, {},
      doc,
      () => log.push('toast'),
      () => log.push('render'),
      () => log.push('drawSheet'),
      () => log.push('keydown-wired')
    );
    let threw = null;
    try { api.open('id' in opts ? opts.id : null, opts.type || 'todo'); } catch (e) { threw = e; }
    return { log, threw, api };
  }

  const fresh = runOpen({});
  assert('T11a opening the sheet focuses #eTitle', fresh.log.includes('title.focus'));
  assert('T11b ...and selects its text, so the first keystroke replaces the title',
    fresh.log.includes('title.select'));
  assert('T11c select() runs after focus() (the order a browser needs)',
    fresh.log.indexOf('title.focus') < fresh.log.indexOf('title.select'));
  assert('T11d focus lands only after the scrim is shown (a display:none subtree cannot take it)',
    fresh.log.indexOf('scrim.add:show') < fresh.log.indexOf('title.focus'));
  assert('T11e the focus is synchronous -- no setTimeout/rAF deferral (iOS keyboard needs the gesture stack)',
    !/(setTimeout|requestAnimationFrame)/.test(openEditSrc.slice(openEditSrc.indexOf("'eTitle'"))));

  const existing = runOpen({ id: 't1' });
  assert('T11f editing an existing task focuses + selects too',
    existing.log.includes('title.focus') && existing.log.includes('title.select'));
  assert('T11g ...with EDIT still the task clone (the field being edited is intact)',
    existing.api.EDIT.title === 'Buy milk' && existing.api.EDIT_BASE.title === 'Buy milk' &&
    existing.api.EDIT !== existing.api.EDIT_BASE);

  const noTitle = runOpen({ noTitle: true });
  assert('T11h #eTitle missing (another sheet owns #sheet) is a no-op, not a crash',
    noTitle.threw === null && !noTitle.log.includes('title.focus'));
  const noSelect = runOpen({ noSelect: true });
  assert('T11i an element without select() still focuses (typeof guard, no TypeError)',
    noSelect.threw === null && noSelect.log.includes('title.focus'));
}

if (failures) { console.error(failures + ' assertion(s) failed'); process.exit(1); }
console.log('edit-sheet-keyboard: all assertions passed');
