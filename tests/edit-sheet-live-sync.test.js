// edit-sheet-live-sync.test.js
// Regression: typing a task Title (or Notes) and then clicking "+ Add subtask"
// used to lose the typed text. drawSheet() rebuilds the whole sheet with
// sheet.innerHTML=h, so any input whose value comes from EDIT must write back to
// EDIT on every keystroke. #eTitle and #eNotes had no oninput handler, so the
// typed text lived only in the destroyed DOM node.
//
// Fails before the fix (no oninput on #eTitle / #eNotes), passes after.
const path = require('path');
const { readSource, extractFunction, extractLine } = require('./_extract.js');

const src = readSource(path.join(__dirname, '../app.js'));
const drawSheetSrc = extractFunction(src, /^function drawSheet\(\)\{/, 'drawSheet');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// --- harness: run the real drawSheet() against a minimal mock DOM -----------
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

function newTodo() {
  return { id: null, type: 'todo', title: '', notes: '', difficulty: 'easy', checklist: [] };
}

// Pull the oninput attribute off a rendered element, so the test exercises the
// handler the app actually ships rather than a copy of it.
function oninputOf(html, idAttr) {
  const tag = html.match(new RegExp('<(?:input|textarea)[^>]*' + idAttr + '[^>]*>'));
  if (!tag) return null;
  const attr = tag[0].match(/oninput="([^"]*)"/);
  return attr ? attr[1] : null;
}

function type(EDIT, idAttr, text) {
  const expr = oninputOf(render(EDIT), 'id="' + idAttr + '"');
  if (!expr) return false;
  // `this` inside an inline oninput is the element itself.
  new Function('EDIT', expr).call({ value: text }, EDIT);
  return true;
}

// --- T1: the handlers exist at all -----------------------------------------
{
  const html = render(newTodo());
  assert('T1a: #eTitle has an oninput handler', !!oninputOf(html, 'id="eTitle"'));
  assert('T1b: #eNotes has an oninput handler', !!oninputOf(html, 'id="eNotes"'));
}

// --- T2: typing writes through to EDIT state --------------------------------
{
  const EDIT = newTodo();
  const ok = type(EDIT, 'eTitle', 'Buy milk');
  assert('T2a: typing in #eTitle updates EDIT.title', ok && EDIT.title === 'Buy milk');

  const EDIT2 = newTodo();
  const ok2 = type(EDIT2, 'eNotes', 'from the corner shop');
  assert('T2b: typing in #eNotes updates EDIT.notes', ok2 && EDIT2.notes === 'from the corner shop');
}

// --- T3: the reported bug — title survives "+ Add subtask" ------------------
{
  const EDIT = newTodo();
  type(EDIT, 'eTitle', 'Buy milk');
  type(EDIT, 'eNotes', 'note text');

  // What the "+ Add subtask" button does, then its drawSheet() re-render.
  EDIT.checklist.push({ id: 'uid1', text: '', done: false });
  const html = render(EDIT);

  assert('T3a: re-rendered title input keeps the typed title',
    /<input[^>]*id="eTitle"[^>]*value="Buy milk"/.test(html));
  assert('T3b: re-rendered notes textarea keeps the typed notes',
    /<textarea[^>]*id="eNotes"[^>]*>note text<\/textarea>/.test(html));
  assert('T3c: the new blank subtask row was added', /class="checklist"/.test(html));
}

// --- T4: every other in-sheet button also re-renders, so guard one of them ---
{
  const EDIT = newTodo();
  type(EDIT, 'eTitle', 'Walk dog');
  EDIT.difficulty = 'hard'; // difficulty button: mutates EDIT then drawSheet()
  assert('T4: title survives a difficulty change re-render',
    /<input[^>]*id="eTitle"[^>]*value="Walk dog"/.test(render(EDIT)));
}

// --- T5: same bug class in the custom-View builder --------------------------
// vSet() reads #vName back before re-rendering, but vToggleType()/vToggleTag()
// and bAddMetric()/bEditMetric() do not — so an unsaved view name was lost when
// toggling a type/tag filter. Source-level check: drawViewBuilder() is too
// entangled (V_SOURCES, anPrefs, ensureTags, ...) to render in isolation.
{
  const vName = extractLine(src, /id="vName"/, '#vName input');
  assert('T5: #vName input syncs to VDRAFT.name on input',
    /oninput="VDRAFT\.name=this\.value"/.test(vName));
}

if (failures) { console.error(failures + ' assertion(s) failed'); process.exit(1); }
console.log('edit-sheet-live-sync: all assertions passed');
