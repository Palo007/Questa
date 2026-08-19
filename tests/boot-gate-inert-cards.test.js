// boot-gate-inert-cards.test.js -- todo 11 (D3, direction C): while the boot
// day-rollover decision is deferred waiting for the first sync round, task cards
// must be INERT. Nothing painted in that window may be destructively tappable.
//
// Why this exists (plan .omo/plans/sync-merge-hardening-2026-08-14.md, todo 11,
// constraint 2): one tap on a daily still showing yesterday's tick reaches
// uncompleteDaily(), which decrements t.streak, stamps t.updatedAt, save()s
// (stamping S.char.updatedAt and pushing to the other device) and flips t.done
// false -- so the later missedYesterdayDailies() reports a genuine completion as
// missed. HP damage + streak zeroed + a `miss` event on a daily the user did.
//
// Direction C deliberately does NOT clear the flags before the first paint (that
// ordering is the defect that blocked this wave -- see plan revision 5). The tick
// STAYS PAINTED and is made inert instead. A test asserting "paints unticked"
// cannot pass a correct implementation.
//
// Two layers, both covered here:
//   Layer 1 -- JS: bootGateBlocksInput() guards toggle/scoreHabit/toggleSub as
//              their FIRST statement.
//   Layer 2 -- CSS hook: render() toggles body.bootSyncing and prepends
//              _bootGateBanner()'s `<div class="syncGate">` to the view HTML.
//              (The CSS rule itself is in index.html and is not vm-testable --
//              AGENTS.md S5.)
//
// C1/C3/C4/C5 need bootStartDay() (todo 13) and live in
// tests/boot-gate-rollover.test.js.
//
// Strategy: anchor-extract the real functions from app.js (tests/_extract.js) and
// run them in a vm with stubbed DOM/char helpers. Assertions are on OBSERVABLE
// STATE (t.done / t.streak / t.updatedAt / captured events / rendered HTML /
// body classList), never on call counts (AGENTS.md S4, 2026-07-29 incident).
//
// Run: node tests/boot-gate-inert-cards.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// ---------------------------------------------------------------------------
// Extraction. None of todo 11's three new symbols exist yet, so every call is
// wrapped: a missing anchor becomes a labelled [FAIL], never a process crash.
// ---------------------------------------------------------------------------
function grab(fn, label) {
  try { return fn(); }
  catch (e) { assert('extract ' + label + ' from app.js', false); return null; }
}

const parts = {
  pendingDecl:   grab(() => extractLine(appSrc, /^var _bootRolloverPending\s*=/, '_bootRolloverPending declaration'), '_bootRolloverPending declaration'),
  blocksInput:   grab(() => extractFunction(appSrc, /^function bootGateBlocksInput\(\)\{/, 'bootGateBlocksInput'), 'bootGateBlocksInput()'),
  banner:        grab(() => extractFunction(appSrc, /^function _bootGateBanner\(\)\{/, '_bootGateBanner'), '_bootGateBanner()'),
  toggle:        grab(() => extractFunction(appSrc, /^function toggle\(id, ev\)\{/, 'toggle'), 'toggle()'),
  toggleSub:     grab(() => extractFunction(appSrc, /^function toggleSub\(/, 'toggleSub'), 'toggleSub()'),
  scoreHabit:    grab(() => extractFunction(appSrc, /^function scoreHabit\(/, 'scoreHabit'), 'scoreHabit()'),
  uncompleteDay: grab(() => extractFunction(appSrc, /^function uncompleteDaily\(t\)\{/, 'uncompleteDaily'), 'uncompleteDaily()'),
  render:        grab(() => extractFunction(appSrc, /^function render\(\)\{/, 'render'), 'render()'),
  dueToday:      grab(() => extractLine(appSrc, /^function isDailyDueToday\(/, 'isDailyDueToday'), 'isDailyDueToday()'),
  dueOn:         grab(() => extractLine(appSrc, /^function isDailyDueOn\(/, 'isDailyDueOn'), 'isDailyDueOn()'),
};

if (Object.keys(parts).some(k => parts[k] === null)) {
  console.error('\nFAILED: ' + failures + ' assertion(s) -- todo 11 symbols missing from app.js');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------
function makeSandbox() {
  const events = [];
  const bodyClasses = new Set();
  const view = { innerHTML: '' };
  const S = {
    tasks: [
      { id: 'd1', type: 'daily', title: 'Meditate', done: true, streak: 9, value: 3,
        difficulty: 'medium', updatedAt: 1000, checklist: [{ id: 's1', text: 'sit', done: true }], history: [] },
      { id: 'h1', type: 'habit', title: 'Water', difficulty: 'medium', value: 0, cUp: 0, cDown: 0, history: [] },
    ],
    prefs: { paused: false, pausedDays: [] },
    char: { hp: 50, xp: 0, gold: 0, mp: 0, lvl: 1, updatedAt: 500 },
    lastCron: '1970-01-01',
  };
  const toasts = [];
  const sb = {
    S, console, JSON, Math, Date, Number, String, Boolean, Array, Object,
    TAB: 'dailies',
    // real now() so updatedAt stamps are monotonic and visible
    lastIssued: 0,
    setTimeout: () => 1, clearTimeout: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      body: { classList: {
        toggle: (c, on) => { if (on) bodyClasses.add(c); else bodyClasses.delete(c); },
        add: c => bodyClasses.add(c), remove: c => bodyClasses.delete(c),
        contains: c => bodyClasses.has(c),
      } },
      getElementById: id => (id === 'view' ? view : { innerHTML: '', classList: { add: () => {}, remove: () => {} } }),
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    // helpers render()/uncompleteDaily()/toggleSub() reach for
    saveFocus: () => {}, restoreFocus: () => {}, restoreScroll: () => {},
    renderStats: () => {}, updateHeaderHeightVar: () => {}, initAnalytics: () => {},
    enableDragReorder: () => {}, resetDragState: () => {},
    viewHabits: () => '<div class="task">habit</div>',
    viewDailies: () => '<div class="task">daily</div>',
    viewTodos: () => '', viewAnalytics: () => '', viewRewards: () => '',
    reverseGrant: () => {}, unlogToday: () => {}, completeTask: () => {},
    logHistory: () => {}, buzz: () => false, uid: () => 'gen1',
    logEvent: e => { events.push(e); }, save: () => {},
    toast: m => { toasts.push(m); },
    nextDueWeekday: () => 'Mon',
    repsPerTap: () => 1, grant: () => {}, floatFx: () => {}, takeDamage: () => {},
    valueDelta: () => 1, clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    _suppressHabitClick: null,
  };
  sb.window = sb; sb.globalThis = sb;
  sb.now = function () { sb.lastIssued = Math.max(Date.now(), sb.lastIssued + 1); return sb.lastIssued; };
  vm.createContext(sb);
  const code = [
    parts.pendingDecl, parts.blocksInput, parts.banner, parts.dueToday, parts.dueOn,
    parts.uncompleteDay, parts.toggle, parts.toggleSub, parts.scoreHabit, parts.render,
    'this._setPending=function(v){ _bootRolloverPending=v; };',
    'this._blocks=bootGateBlocksInput; this._banner=_bootGateBanner;',
    'this._toggle=toggle; this._toggleSub=toggleSub; this._scoreHabit=scoreHabit;',
    'this._render=render;',
  ].join('\n');
  vm.runInContext(code, sb);
  return { sb, S, events, bodyClasses, view, toasts };
}

// ---------------------------------------------------------------------------
// U1 -- bootGateBlocksInput() gets a direct unit test of its return value
// (AGENTS.md S4 corollary: a function that alone gates a feature).
// ---------------------------------------------------------------------------
{
  const env = makeSandbox();
  assert('U1a bootGateBlocksInput() is false by default (flag defaults false)', env.sb._blocks() === false);
  env.sb._setPending(true);
  assert('U1b bootGateBlocksInput() is true while _bootRolloverPending', env.sb._blocks() === true);
  env.sb._setPending(false);
  assert('U1c bootGateBlocksInput() is false again once cleared', env.sb._blocks() === false);
}

// ---------------------------------------------------------------------------
// U2 -- _bootGateBanner() is a pure function of the flag.
// ---------------------------------------------------------------------------
{
  const env = makeSandbox();
  assert('U2a _bootGateBanner() is empty when not pending', env.sb._banner() === '');
  env.sb._setPending(true);
  const b = env.sb._banner();
  assert('U2b _bootGateBanner() emits class="syncGate" while pending', /class="syncGate"/.test(b));
  assert('U2c banner text says syncing', /syncing/i.test(b));
}

// ---------------------------------------------------------------------------
// C2 -- no destructive tap in the gate window, and the guard is a GATE not a
// permanent block. Observable state only.
// ---------------------------------------------------------------------------
{
  const env = makeSandbox();
  const t = env.S.tasks[0];
  const beforeUpdatedAt = t.updatedAt;
  env.sb._setPending(true);

  env.sb._toggle('d1');
  assert('C2a during gate: t.done still true', t.done === true);
  assert('C2b during gate: t.streak still 9', t.streak === 9);
  assert('C2c during gate: t.updatedAt unchanged', t.updatedAt === beforeUpdatedAt);
  assert('C2d during gate: no event appended', env.events.length === 0);
  assert('C2e during gate: bootGateBlocksInput() true', env.sb._blocks() === true);

  // toggleSub is guarded too -- a subtask tick stamps c.touchedAt and pushes.
  const sub = t.checklist[0];
  env.sb._toggleSub('d1', 's1', 0);
  assert('C2f during gate: subtask done unchanged', sub.done === true);
  assert('C2g during gate: subtask touchedAt not stamped', sub.touchedAt === undefined);

  // scoreHabit is guarded too.
  const h = env.S.tasks[1];
  env.sb._scoreHabit('h1', 1);
  assert('C2h during gate: habit counter unchanged', (h.cUp || 0) === 0);

  // Layer 2 wiring, through the REAL render().
  env.sb._render();
  assert('C2i during gate: rendered view HTML carries class="syncGate"', /class="syncGate"/.test(env.view.innerHTML));
  assert('C2j during gate: rendered view still POPULATED with cards', /class="task"/.test(env.view.innerHTML));
  assert('C2k during gate: body.classList contains bootSyncing', env.bodyClasses.has('bootSyncing'));

  // ---- gate clears: the very same call must now reach uncompleteDaily() ----
  env.sb._setPending(false);
  env.sb._render();
  assert('C2l after gate: body.classList no longer has bootSyncing', !env.bodyClasses.has('bootSyncing'));
  assert('C2m after gate: no syncGate strip in the view', !/class="syncGate"/.test(env.view.innerHTML));

  env.sb._toggle('d1');
  assert('C2n after gate: toggle reached uncompleteDaily -- t.done false', t.done === false);
  assert('C2o after gate: streak decremented 9 -> 8', t.streak === 8);
  assert('C2p after gate: t.updatedAt stamped', t.updatedAt !== beforeUpdatedAt);
  assert('C2q after gate: an uncomplete event was appended',
    env.events.some(e => e && e.kind === 'uncomplete'));
}

// ---------------------------------------------------------------------------
// G1 -- the guard must be the FIRST statement in each entry point, otherwise a
// side effect before it (e.g. scoreHabit's _suppressHabitClick reset) still runs
// during the gate. Asserted on the extracted source shape, which is the only
// observable for "first statement".
// ---------------------------------------------------------------------------
{
  function firstStatementGuards(src) {
    const body = src.slice(src.indexOf('{') + 1);
    return /^\s*if\s*\(\s*bootGateBlocksInput\(\)\s*\)/.test(body);
  }
  assert('G1a toggle(): bootGateBlocksInput() guard is the first statement', firstStatementGuards(parts.toggle));
  assert('G1b scoreHabit(): bootGateBlocksInput() guard is the first statement', firstStatementGuards(parts.scoreHabit));
  assert('G1c toggleSub(): bootGateBlocksInput() guard is the first statement', firstStatementGuards(parts.toggleSub));
}

// ---------------------------------------------------------------------------
if (failures) {
  console.error('\nFAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\nALL BOOT-GATE-INERT-CARDS TESTS PASSED');
process.exit(0);
