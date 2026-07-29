// paste-edit-task.test.js
// Drives pasteEditTask parsing logic extracted from app.js against a mock context.
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const m = code.match(/async function pasteEditTask\(\)\{[\s\S]*?\r?\n\}\r?\nfunction applyPaste\(text\)\{[\s\S]*?\r?\n\}\r?\n/);
if (!m) {
  console.error('FAIL: could not extract pasteEditTask + applyPaste from app.js');
  process.exit(1);
}
const fnSrc = m[0];

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function makeContext() {
  const ctx = {
    EDIT: { title: '', checklist: [], notes: '' },
    toastMsgs: [],
    uidCtr: 0,
  };
  const navigatorMock = { clipboard: null };
  const toast = (msg) => ctx.toastMsgs.push(msg);
  const uid = () => { ctx.uidCtr++; return 'uid' + ctx.uidCtr; };
  const documentMock = {
    getElementById: (id) => {
      if (id === 'eTitle') return { value: ctx.EDIT.title };
      return null;
    },
    body: { focus: () => {} },
  };
  const windowMock = { focus: () => {} };
  const drawSheet = () => {};
  const factory = new Function(
    'navigator', 'document', 'toast', 'uid', 'drawSheet', 'EDIT', 'window',
    fnSrc + "\nreturn pasteEditTask;"
  );
  const pasteEditTask = factory(
    navigatorMock, documentMock, toast, uid, drawSheet, ctx.EDIT, windowMock
  );
  return {
    ctx,
    pasteEditTask,
    navigatorMock,
    setClipboard: (text) => {
      navigatorMock.clipboard = { readText: () => Promise.resolve(text) };
    },
  };
}

async function runTests() {
  // T1: single-line -> title only
  {
    const { ctx, pasteEditTask, setClipboard } = makeContext();
    setClipboard('New title');
    await pasteEditTask();
    assert('T1a: EDIT.title set', ctx.EDIT.title === 'New title');
    assert('T1b: EDIT.checklist unchanged', ctx.EDIT.checklist.length === 0);
    assert('T1c: toast says Title pasted', ctx.toastMsgs[0] === 'Title pasted');
  }

  // T2: multi-line with checklist and notes
  {
    const { ctx, pasteEditTask, setClipboard } = makeContext();
    setClipboard('Task title\n\nChecklist:\n- [ ] subtask 1\n- [x] subtask 2\n\nNotes:\nnote line 1\nnote line 2');
    await pasteEditTask();
    assert('T2a: title parsed', ctx.EDIT.title === 'Task title');
    assert('T2b: checklist has 2 items', ctx.EDIT.checklist.length === 2);
    assert('T2c: first item unchecked', ctx.EDIT.checklist[0].done === false && ctx.EDIT.checklist[0].text === 'subtask 1');
    assert('T2d: second item checked', ctx.EDIT.checklist[1].done === true && ctx.EDIT.checklist[1].text === 'subtask 2');
    assert('T2e: notes parsed', ctx.EDIT.notes === 'note line 1\nnote line 2');
    assert('T2f: toast says Task pasted', ctx.toastMsgs[0] === 'Task pasted');
  }

  // T3: empty clipboard
  {
    const { ctx, pasteEditTask, setClipboard } = makeContext();
    setClipboard('');
    await pasteEditTask();
    assert('T3a: toast says Clipboard is empty', ctx.toastMsgs[0] === 'Clipboard is empty');
  }

  // T4: clipboard API blocked
  {
    const { ctx, pasteEditTask } = makeContext();
    navigator.clipboard = null;
    await pasteEditTask();
    assert('T4a: toast says blocked', ctx.toastMsgs[0] === 'Clipboard paste is blocked or unsupported in this browser');
  }

  // T5: title-only multi-line (no checklist/notes sections) -> joined with space
  {
    const { ctx, pasteEditTask, setClipboard } = makeContext();
    setClipboard('Line one\nLine two');
    await pasteEditTask();
    assert('T5a: title is joined with space', ctx.EDIT.title === 'Line one Line two');
    assert('T5b: no checklist added', ctx.EDIT.checklist.length === 0);
  }

  // T6: Habitica-style format without Checklist marker
  {
    const { ctx, pasteEditTask, setClipboard } = makeContext();
    setClipboard('Task title\n- [ ] subtask 1\n- [x] subtask 2');
    await pasteEditTask();
    assert('T6a: title parsed', ctx.EDIT.title === 'Task title');
    assert('T6b: checklist has 2 items', ctx.EDIT.checklist.length === 2);
    assert('T6c: first item unchecked', ctx.EDIT.checklist[0].done === false && ctx.EDIT.checklist[0].text === 'subtask 1');
    assert('T6d: second item checked', ctx.EDIT.checklist[1].done === true && ctx.EDIT.checklist[1].text === 'subtask 2');
    assert('T6e: toast says Task pasted', ctx.toastMsgs[0] === 'Task pasted');
  }

  // T7: Habitica-style with plain dash bullets (no checkbox)
  {
    const { ctx, pasteEditTask, setClipboard } = makeContext();
    setClipboard('Task title\n- subtask 1\n- subtask 2');
    await pasteEditTask();
    assert('T7a: title parsed', ctx.EDIT.title === 'Task title');
    assert('T7b: checklist has 2 items', ctx.EDIT.checklist.length === 2);
    assert('T7c: items unchecked', ctx.EDIT.checklist[0].done === false && ctx.EDIT.checklist[1].done === false);
    assert('T7d: toast says Task pasted', ctx.toastMsgs[0] === 'Task pasted');
  }

  console.log('\npaste-edit-task: ' + (failures ? failures + ' FAILED' : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
}

runTests();
