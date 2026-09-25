// xss-record-ids.test.js -- PWA-22 root 3 + esc() hardening.
// Synced record ids (and a few synced scalars) are concatenated raw into
// inline handlers onclick="f('<id>')" and into double-quoted attributes.
// An id such as  x');alert(1);//  runs script on click; an id such as
// x" onmouseover="alert(1)  breaks out of the attribute. Handlers must use
// jsq(), attributes esc(String(x)). ID7: line breaks in an id keep handlers compiling.
//   ID1 behavioural: taskCard/habitCard handlers get the exact id, no alert
//   ID2 attribute break-out (data-id, class from t.type)
//   ID3 renderSelectedHabits: data-hid / value / placeholder, dataset round-trip
//   ID4 static guard over the heavier render functions
//   ID5 esc() encodes the apostrophe
//   ID6 non-regression: a uid()-shaped id renders byte-identical to HEAD c69461e
//
// Run: node tests/xss-record-ids.test.js   (also run by `node tests/run.js`)
const path = require('path');
const { readSource, extractFunction } = require('./_extract');

const src = readSource(path.join(__dirname, '../app.js'));
const ex = name => extractFunction(src, new RegExp('^function ' + name + '\\('), name);

global.S = { tasks: [] };
global.MEDIT = { habits: [] };
const els = {};
global.document = { getElementById: id => (els[id] = els[id] || { innerHTML: '', textContent: '', value: '', querySelectorAll: () => [] }) };

const api = new Function(
  'function valColor(){ return ["","#fff"]; }\n' +
  'function dragOK(){ return true; }\n' +
  'function isDailyDueToday(){ return true; }\n' +
  'function metaRow(){ return ""; }\n' +
  'function rail(){ return ""; }\n' +
  'function repsPerTap(){ return 1; }\n' +
  ex('esc') + '\n' + ex('jsq') + '\n' + ex('taskCard') + '\n' + ex('habitCard') + '\n' + ex('renderSelectedHabits') + '\n' +
  'return { esc, taskCard, habitCard, renderSelectedHabits };'
)();

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function decodeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// A real attribute break-out: an unescaped quote followed by a new attribute.
const breakout = h => /"\s+onmouseover\s*=/.test(h);

// ---- ID1 behavioural handler test ----------------------------------------
const JS_ID = "x');alert(1);//";
function runHandlers(html) {
  const calls = [], alerts = [];
  const spy = name => function (a) { calls.push([name, a]); };
  const bodies = [];
  html.replace(/onclick="([^"]*)"/g, (m, b) => { bodies.push(decodeAttr(b)); return m; });
  let compileErr = false;
  bodies.forEach(b => {
    try {
      new Function('toggle', 'openEdit', 'scoreHabit', 'event', 'alert', b)(
        spy('toggle'), spy('openEdit'), spy('scoreHabit'), { stopPropagation() {} }, () => alerts.push(1));
    } catch (e) { compileErr = true; }
  });
  return { calls, alerts, compileErr, n: bodies.length };
}
const r1 = runHandlers(api.taskCard({ id: JS_ID, type: 'todo', title: 'T' }));
const r2 = runHandlers(api.habitCard({ id: JS_ID, type: 'habit', title: 'H' }));
const names = r => r.calls.map(c => c[0]).sort().join(',');
assert('ID1a taskCard handlers: no alert, toggle/openEdit get the exact id',
  !r1.compileErr && r1.alerts.length === 0 && names(r1) === 'openEdit,toggle' && r1.calls.every(c => c[1] === JS_ID));
assert('ID1b habitCard handlers: no alert, scoreHabit x2/openEdit get the exact id',
  !r2.compileErr && r2.alerts.length === 0 && names(r2) === 'openEdit,scoreHabit,scoreHabit' && r2.calls.every(c => c[1] === JS_ID));

// ---- ID2 attribute break-out ---------------------------------------------
const ATTR_ID = 'x" onmouseover="alert(1)';
assert('ID2a taskCard: hostile id / t.type cannot add an attribute',
  !breakout(api.taskCard({ id: ATTR_ID, type: 'todo" onmouseover="alert(1)', title: 'T' })));
assert('ID2b habitCard: hostile id cannot add an attribute',
  !breakout(api.habitCard({ id: ATTR_ID, type: 'habit', title: 'H' })));

// ---- ID3 renderSelectedHabits --------------------------------------------
MEDIT.habits = [{ id: ATTR_ID, reps: '1"><img src=x onerror=alert(1)>' }];
S.tasks = [{ id: ATTR_ID, type: 'habit', title: 'H', repsPerTap: '2" onmouseover="alert(1)' }];
api.renderSelectedHabits();
const w = els.mSelected.innerHTML;
const hid = w.match(/data-hid="([^"]*)"/);
assert('ID3 renderSelectedHabits: no break-out, no <img, data-hid round-trips',
  !breakout(w) && w.indexOf('<img') < 0 && !!hid && decodeAttr(hid[1]) === ATTR_ID);

// ---- ID4 static guard -----------------------------------------------------
// `i.id` is exempt: in viewRewards it is SHOP_ITEMS, a hardcoded constant, not synced.
const RAW_JS = /\\''\+\(?(?!i\.id\b)[A-Za-z_$][\w$.]*(?:\.id|metricId)(?:\|\|'')?\)?\+'\\'/;
const RAW_ATTR = /="'\+[A-Za-z_$][\w$.]*\.id\+'"/;
const RAW_COL = /(?:--tc:|background:)'\+(?!cssColor\()/;
const idFns = ['drawYesterCheck', 'checklistBlock', 'rail', 'viewRewards', 'renderHabitPicker', 'drawViewBuilder', 'anViewsUI', 'anDetailDashboard'];
const colFns = ['drawViewBuilder', 'anListHTML', 'anRowLegend', 'anTagSummaryBody'];
const badId = idFns.filter(f => { const s = ex(f); return RAW_JS.test(s) || RAW_ATTR.test(s); });
const badCol = colFns.filter(f => RAW_COL.test(ex(f)));
assert('ID4a no raw id in handlers/attributes in ' + idFns.join(',') + (badId.length ? '  (raw: ' + badId.join(',') + ')' : ''), !badId.length);
assert('ID4b every tag colour in style goes through cssColor()' + (badCol.length ? '  (raw: ' + badCol.join(',') + ')' : ''), !badCol.length);

// ---- ID5 esc apostrophe ----------------------------------------------------
assert('ID5 esc("a\'b") === "a&#39;b"', api.esc("a'b") === 'a&#39;b');

// ---- ID6 non-regression (outputs captured at HEAD c69461e) ---------------
const UID = 'lz3k9abc12';
const HEAD_TASK = "<div class=\"task todo \" draggable=\"true\" data-id=\"lz3k9abc12\" data-list=\"tasks\"><div class=\"valdot\" style=\"background:#fff\"></div><div class=\"check\" onclick=\"toggle('lz3k9abc12',event)\"><span class=\"ckbox\"></span></div><div class=\"body\" onclick=\"openEdit('lz3k9abc12')\"><div class=\"ttl\">Buy milk</div></div></div>";
const HEAD_HABIT = "<div class=\"task habit\" draggable=\"true\" data-id=\"lz3k9abc12\" data-list=\"tasks\"><div class=\"valdot\" style=\"background:#fff\"></div><div class=\"check hbtn up\" onclick=\"scoreHabit('lz3k9abc12',1,event)\">+</div><div class=\"body\" onclick=\"openEdit('lz3k9abc12')\"><div class=\"ttl\">Pushups</div></div><div class=\"check hbtn down\" onclick=\"scoreHabit('lz3k9abc12',-1,event)\">−</div></div>";
assert('ID6 uid()-shaped id renders byte-identical to HEAD (taskCard, habitCard)',
  api.taskCard({ id: UID, type: 'todo', title: 'Buy milk' }) === HEAD_TASK &&
  api.habitCard({ id: UID, type: 'habit', title: 'Pushups' }) === HEAD_HABIT);

// ---- ID7 line breaks in an id (review I1) --------------------------------
// A synced id with \n or \r would end the JS string literal inside onclick and
// throw a SyntaxError. U+2028/U+2029 are escaped too for older engines.
['\n', '\r', ' ', ' '].forEach((br, i) => {
  const id = 'a' + br + 'b';
  const r = runHandlers(api.taskCard({ id, type: 'todo', title: 'T' }));
  assert('ID7.' + i + ' id with U+' + br.charCodeAt(0).toString(16).padStart(4, '0') + ': handlers compile, id round-trips',
    r.n === 2 && !r.compileErr && r.calls.length === 2 && r.calls.every(c => c[1] === id));
});

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
