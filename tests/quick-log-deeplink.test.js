// quick-log-deeplink.test.js -- deep-link quick log helpers (todo 0)
// Verifies parse -> validate -> dedupe -> apply for ./?quick=<id>&dir=±1,
// the ?quick=today sheet branch, the ?tab= branch, and the OAuth code guard.
//
// Run: node tests/quick-log-deeplink.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const match = appSrc.match(/\/\* BEGIN_QUICKLOG_HELPERS \*\/([\s\S]*?)\/\* END_QUICKLOG_HELPERS \*\//);
if (!match) { console.error('FAIL: no quick-log block'); process.exit(1); }
const helperCode = match[1];
function makeSS() {
  const s = {};
  return { getItem(k) { return (k in s) ? s[k] : null; }, setItem(k, v) { s[k] = String(v); }, removeItem(k) { delete s[k]; }, _s: s };
}
function makeEl(tag) {
  return { tag: tag, cls: '', txt: '', typ: '', kids: [], par: null, oc: null,
    appendChild(c) { c.par = this; this.kids.push(c); return c; },
    remove() { if (this.par) { const i = this.par.kids.indexOf(this); if (i >= 0) this.par.kids.splice(i, 1); this.par = null; } } };
}
function makeDoc() {
  const st = {};
  return { _st: st, getElementById(id) { return st[id] || null; }, createElement(t) { return makeEl(t); }, __add(id, el) { st[id] = el; } };
}
const TABS = ['habits', 'dailies', 'todos', 'analytics', 'rewards'];
const S = { prefs: { lastTab: 'dailies' }, tasks: [
  { id: 'h1', type: 'habit', title: 'Run', difficulty: 'easy' },
  { id: 'd1', type: 'daily', title: 'Brush' },
  { id: 't1', type: 'todo', title: 'Mail' } ] };
const doc = makeDoc();
doc.__add('toast', makeEl('div'));
const sessionStorage = makeSS();
const calls = [], renders = [], sheets = [];
let cleaned = 0;
const sb = { TABS, S, document: doc, sessionStorage, TAB: 'dailies',
  scoreHabit(id, dir, ev) { calls.push({ id, dir }); },
  render() { renders.push(1); }, drawQuickSheet() { sheets.push(1); },
  toast(m) { sb.__t = m; }, bootGateBlocksInput() { return sb.__g === true; },
  history: { replaceState() { cleaned++; } },
  URLSearchParams, Date, String, Object, Array, parseInt, encodeURIComponent,
  setTimeout() { return 0; }, __g: false, __t: null };
sb.globalThis = sb;
vm.createContext(sb);
const api = vm.runInContext(helperCode + '\n;({parseQuickParams,buildQuickUrl,quickLogTargetOk,quickLogDedupe,quickLogClearDedupe,applyQuickIntent,toastAction,quickCleanUrl,_drainPendingQuickLog,QUICKLOG_DEDUPE_MS});', sb);
const { parseQuickParams, buildQuickUrl, quickLogTargetOk, quickLogDedupe,
  quickLogClearDedupe, applyQuickIntent, toastAction, quickCleanUrl,
  _drainPendingQuickLog, QUICKLOG_DEDUPE_MS } = api;
let fails = 0;
function assert(d, c) { if (c) console.log('[PASS] ' + d); else { console.error('[FAIL] ' + d); fails++; } }
function reset(clear) {
  calls.length = 0; renders.length = 0; sheets.length = 0; cleaned = 0;
  sb.__g = false; sb.__t = null; sb.TAB = 'dailies';
  _drainPendingQuickLog();
  if (clear) for (const k of Object.keys(sessionStorage._s)) delete sessionStorage._s[k];
}

// Run: node tests/quick-log-deeplink.test.js  (also run by node tests/run.js)

// Q1: ?quick=<id>&dir=1 parses to a habit intent.
{
  reset(true);
  const it = parseQuickParams('?quick=h1&dir=1');
  assert('Q1 parses to habit intent', !!it && it.kind === 'habit' && it.id === 'h1' && it.dir === 1);
}
// Q2: dir=-1 / down / junk normalise to -1 / -1 / +1.
{
  assert('Q2a dir=-1', parseQuickParams('?quick=h1&dir=-1').dir === -1);
  assert('Q2b dir=down', parseQuickParams('?quick=h1&dir=down').dir === -1);
  assert('Q2c junk dir defaults to +1', parseQuickParams('?quick=h1&dir=bogus').dir === 1);
  assert('Q2d missing dir defaults to +1', parseQuickParams('?quick=h1').dir === 1);
}
// Q3: unknown id is refused at apply time.
{
  reset(true);
  const r = applyQuickIntent({ kind: 'habit', id: 'nope', dir: 1 });
  assert('Q3 unknown id refused', r === null && calls.length === 0);
}
// Q4: a daily / todo target is refused.
{
  reset(true);
  assert('Q4a daily refused by targetOk', quickLogTargetOk(S.tasks[1], 1) === false);
  assert('Q4b todo refused by targetOk', quickLogTargetOk(S.tasks[2], 1) === false);
  assert('Q4c habit accepted by targetOk', quickLogTargetOk(S.tasks[0], 1) === true);
  const r = applyQuickIntent({ kind: 'habit', id: 'd1', dir: 1 });
  assert('Q4d daily apply refused', r === null && calls.length === 0);
}
// Q5: ?quick=today opens the sheet, not a log.
{
  reset(true);
  const it = parseQuickParams('?quick=today');
  assert('Q5a today parses to sheet intent', !!it && it.kind === 'sheet');
  const r = applyQuickIntent(it);
  assert('Q5b sheet intent draws the sheet', r !== null && sheets.length === 1 && calls.length === 0 && cleaned === 1);
}
// Q6: buildQuickUrl round-trips through parseQuickParams.
{
  const u = buildQuickUrl('./', 'h1', 1);
  const back = parseQuickParams(u.slice(u.indexOf('?')));
  assert('Q6 round trip', !!back && back.kind === 'habit' && back.id === 'h1' && back.dir === 1);
}
// Q7: ?tab=habits parses; ?tab=junk is null.
{
  const good = parseQuickParams('?tab=habits');
  assert('Q7a known tab parses', !!good && good.kind === 'tab' && good.tab === 'habits');
  assert('Q7b junk tab refused', parseQuickParams('?tab=junk') === null);
}
// Q8: applying a tab intent leaves TAB on that tab, lastTab untouched.
{
  reset(true);
  const r = applyQuickIntent({ kind: 'tab', id: null, dir: 1, tab: 'habits' });
  assert('Q8a tab applied', r !== null && sb.TAB === 'habits' && renders.length === 1);
  assert('Q8b lastTab untouched', S.prefs.lastTab === 'dailies');
}
// Q9: a ?code= query is ignored (OAuth owns that key).
{
  reset(true);
  assert('Q9 code-only query ignored', parseQuickParams('?code=abc&state=x') === null);
  assert('Q9b code wins over quick', parseQuickParams('?code=abc&quick=h1') === null);
}
// Happy-path apply: habit log calls scoreHabit once, flips TAB, cleans URL.
{
  reset(true);
  const r = applyQuickIntent(parseQuickParams('?quick=h1&dir=1'));
  assert('H1 applied once', !!r && calls.length === 1 && calls[0].id === 'h1' && calls[0].dir === 1);
  assert('H2 TAB flipped to habits', sb.TAB === 'habits');
  assert('H3 URL cleaned', cleaned === 1);
}
// Dedupe: identical (id,dir) inside the window is suppressed, then allowed.
{
  reset(true);
  const t0 = 1000000;
  assert('D1 first tap passes', quickLogDedupe('h1', 1, t0) === false);
  assert('D2 repeat inside window suppressed', quickLogDedupe('h1', 1, t0 + 1000) === true);
  assert('D3 after window allowed', quickLogDedupe('h1', 1, t0 + QUICKLOG_DEDUPE_MS + 1) === false);
  quickLogClearDedupe('h1', 1);
  assert('D4 clear resets the window', quickLogDedupe('h1', 1, t0 + QUICKLOG_DEDUPE_MS + 2) === false);
}
// Gated apply: stashed while the boot gate holds, drained exactly once.
{
  reset(true);
  sb.__g = true;
  const stashed = applyQuickIntent({ kind: 'habit', id: 'h1', dir: 1 });
  assert('G1 gated apply stashes without scoring', !!stashed && calls.length === 0);
  sb.__g = false;
  const drained = _drainPendingQuickLog();
  assert('G2 drain applies exactly once', !!drained && calls.length === 1);
  assert('G3 second drain is a no-op', _drainPendingQuickLog() === null && calls.length === 1);
}
// toastAction: fires once; quickCleanUrl is guarded.
{
  reset(true);
  let n = 0;
  const el = toastAction('hello', 'Undo', function () { n++; });
  assert('T1 toast action node built', !!el && el.kids.length === 2);
  el.kids[1].onclick();
  el.kids[1].onclick();
  assert('T2 action fires exactly once', n === 1);
  quickCleanUrl();
  assert('T3 url cleanup counted', cleaned === 1);
}

if (fails > 0) { console.error(fails + ' assertion(s) failed'); process.exit(1); }
console.log('All tests passed!');
process.exit(0);
