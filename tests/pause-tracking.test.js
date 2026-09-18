// pause-tracking.test.js -- tests for pause tracking feature
//
// Verifies:
// 1. Structural: ensureUiPrefs initializes paused default
// 2. Structural: runCron has paused early-return
// 3. Structural: openSettings has pause settingRow
// 4. Structural: setPause function exists
// 5. Structural: renderStats has paused avatar class toggle
// 6. Structural: renderStats has pauseBadge
// 7. Structural: index.html has .avatar.paused::after CSS
// 8. Structural: index.html has .pauseBadge CSS
// 9. Behavioral: S.prefs.paused defaults to false in fresh state (via ensureUiPrefs)
// 10. Behavioral: setPause toggles prefs.paused
// 11. Behavioral: export/import round-trip preserves paused
//
// Run: node tests/pause-tracking.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// =========================================================================
// 1. Structural guards on app.js source
// =========================================================================
assert('ensureUiPrefs initializes paused default',
  /if\(S\.prefs\.paused===undefined\) S\.prefs\.paused=false;/.test(appSrc));

assert('runCron has paused early-return',
  /if\(S\.prefs\.paused\)\{/.test(appSrc) &&
  /S\.lastCron = today;/.test(appSrc) &&
  /t\.done = false;/.test(appSrc) &&
  /save\(\);/.test(appSrc) &&
  /return;/.test(appSrc));

assert('openSettings has pause in Activity Feed category',
  /openCat\(\\'activityFeed\\'\)/.test(appSrc) && /'pause'.*type.*'toggle'/.test(appSrc));

assert('setPause function exists',
  /function setPause\(n\)\{/.test(appSrc));

assert('renderStats has paused avatar class toggle',
  /avatarContainer\.classList\.add\('paused'\)/.test(appSrc) &&
  /avatarContainer\.classList\.remove\('paused'\)/.test(appSrc));

assert('renderStats has pauseBadge',
  /pauseBadge/.test(appSrc));

assert('index.html has .avatar.paused::after CSS',
  fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').includes('.avatar.paused::after'));

assert('index.html has .pauseBadge CSS',
  fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').includes('.pauseBadge'));

// =========================================================================
// 2. Behavioral: extract key functions and test in VM sandbox
// =========================================================================
const { extractFunction, extractBraceBody, extractLine } = require('./_extract');

// Extract functions needed for testing
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
const settingRowFn = extractFunction(appSrc, /^function settingRow\(/, 'settingRow');
const closeOptFn = extractFunction(appSrc, /^function closeOpt\(\)\{/, 'closeOpt');
const setPauseFn = extractFunction(appSrc, /^function setPause\(n\)\{/, 'setPause');
const ensureUiPrefsFn = extractFunction(appSrc, /^function ensureUiPrefs\(\)\{/, 'ensureUiPrefs');
const saveFn = extractFunction(appSrc, /^function save\(\)\{/, 'save');
const dayStampFn = extractFunction(appSrc, /^function dayStamp\(d\)\{/, 'dayStamp');
const clampFn = extractFunction(appSrc, /^function clamp\(v,a,b\)\{/, 'clamp');
const valueDeltaFn = extractFunction(appSrc, /^function valueDelta\(value\)\{/, 'valueDelta');
const missDamageFn = extractFunction(appSrc, /^function missDamage\(task\)\{/, 'missDamage');
const takeDamageFn = extractFunction(appSrc, /^function takeDamage\(amount\)\{/, 'takeDamage');
// 2026-09-18 (round 2): anchor on the first two parameters — logHistory gained an
// optional third, atMs, so runCron can backdate yesterday's miss to yesterday.
const logHistoryFn = extractFunction(appSrc, /^function logHistory\(t, patch/, 'logHistory');
const logEventFn = extractFunction(appSrc, /^function logEvent\(ev\)\{/, 'logEvent');
const logCharSnapshotFn = extractFunction(appSrc, /^function logCharSnapshot\(\)\{/, 'logCharSnapshot');
const runCronFn = extractFunction(appSrc, /^function runCron\(\)\{/, 'runCron');
const isDailyDueOnFn = extractFunction(appSrc, /^function isDailyDueOn\(t, dow\)\{/, 'isDailyDueOn');
const completionRewardFn = extractFunction(appSrc, /^function completionReward\(task\)\{/, 'completionReward');
const gainXpFn = extractFunction(appSrc, /^function gainXp\(xp\)\{/, 'gainXp');
const deathFn = extractFunction(appSrc, /^function death\(\)\{/, 'death');
// K2 (2026-09-11): now() heals a future-poisoned HLC before stamping, so the slice
// needs _hlcHeal and the tolerance constant it reads. Lockstep with app.js (§4).
const nowFn = extractFunction(appSrc, /^function now\(\)\{/, 'now');
const hlcTolLine = extractLine(appSrc, /^const HLC_RATCHET_TOLERANCE_MS\s*=/, 'HLC_RATCHET_TOLERANCE_MS');
const hlcHealFn = extractFunction(appSrc, /^function _hlcHeal\(\)\{/, '_hlcHeal');
const charSigFn = extractFunction(appSrc, /^function _charSig\(c\)\{/, '_charSig');
const xpToLevelFn = extractFunction(appSrc, /^function xpToLevel\(lvl\)\{/, 'xpToLevel');
const isDailyDueTodayFn = extractFunction(appSrc, /^function isDailyDueToday\(t\)\{/, 'isDailyDueToday');
const completeTaskFn = extractFunction(appSrc, /^function completeTask\(t, ev\)\{/, 'completeTask');
const creditYesterdayFn = extractFunction(appSrc, /^function creditYesterday\(t\)\{/, 'creditYesterday');
const resetDailiesFn = extractFunction(appSrc, /^function _resetDailies\(\)\{/, '_resetDailies');
const missedYesterdayDailiesFn = extractFunction(appSrc, /^function missedYesterdayDailies\(\)\{/, 'missedYesterdayDailies');

// Build test code
const code = [
  'const DIFF = { trivial:0.1, easy:1, medium:1.5, hard:2, log:0 };',
  escFn,
  settingRowFn + '\n' + closeOptFn,
  setPauseFn,
  ensureUiPrefsFn,
  saveFn,
  dayStampFn,
  clampFn,
  valueDeltaFn,
  missDamageFn,
  takeDamageFn,
  logHistoryFn,
  logEventFn,
  logCharSnapshotFn,
  runCronFn,
  isDailyDueOnFn,
  completionRewardFn,
  gainXpFn,
  deathFn,
  hlcTolLine,
  hlcHealFn,
  nowFn,
  charSigFn,
  xpToLevelFn,
  isDailyDueTodayFn,
  completeTaskFn,
  creditYesterdayFn,
  resetDailiesFn,
  missedYesterdayDailiesFn,
  'return { esc, settingRow, closeOpt, setPause, ensureUiPrefs, save, dayStamp, clamp, valueDelta, missDamage, takeDamage, logHistory, logEvent, logCharSnapshot, runCron, isDailyDueOn, completionReward, gainXp, death, now, uid, _charSig, xpToLevel, isDailyDueToday, completeTask, creditYesterday, _resetDailies, missedYesterdayDailies };'
].join('\n');

// Stub S
const S = {
  prefs: { paused: false, width: 480, filter: {}, sort: {}, tagFilter: {}, filterOpen: false, scroll: {} },
  tasks: [],
  rewards: [],
  tags: [],
  devices: [],
  char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' },
  lastCron: 0,
  history: [],
  charHistory: [],
  monthlyBackups: [],
  deletions: [],
  events: []
};

const noop = function(){};
const sandbox = {
  S: S,
  window: {},
  navigator: { onLine: true },
  document: {
    addEventListener: noop,
    getElementById: function(id) {
      if (id === 'avatarFace') return { textContent: '', style: {}, classList: { add: noop, remove: noop, contains: function(){return false;}, closest: function(){return {classList:{add:noop,remove:noop}}; } } };
      if (id === 'charName') return { textContent: '' };
      if (id === 'charLvl') return { textContent: '' };
      if (id === 'charClass') return { textContent: '' };
      if (id === 'statGold') return { textContent: '', parentElement: { querySelector: function(){return null;}, appendChild: noop } };
      if (id === 'hpFill') return { style: { width: '' } };
      if (id === 'hpLab') return { textContent: '' };
      if (id === 'xpFill') return { style: { width: '' } };
      if (id === 'xpLab') return { textContent: '' };
      return { textContent: '', style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: noop }, appendChild: noop, querySelector: function(){return null;}, closest: function(){return {classList:{add:noop,remove:noop}}; } };
    },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop, classList: { add: noop, remove: noop } }; },
    body: { appendChild: noop, removeChild: noop, classList: { toggle: noop } }
  },
  localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop, key: function(){ return null; }, length: 0 },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(){ return 0; }, clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'x'; }, idbOpen: function(){ return Promise.resolve(null); },
  buzz: noop, bumpAvatar: noop, floatFx: noop, fxGain: noop, levelFlash: noop,
  _charSig: function(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } },
  _prevCharSig: null,
  IS_DIRTY: false,
  lastIssued: 0,
  _idbWriteState: function(){ return Promise.resolve(); },
  _stateWritePromise: null,
  openSettings: noop,
  renderStats: noop
};
sandbox.globalThis = sandbox;

const fn = new vm.Script(
  '(function(S, document, window, setTimeout, clearTimeout, Object, console, JSON, Math, Date, Map, Set, WeakSet, Array, Number, String, Boolean, Promise, logEvent, toast, render, esc, save, uid, localStorage, indexedDB, navigator, _charSig, openSettings, renderStats){ "use strict";\n' +
  code + '\n})'
).runInNewContext(sandbox);

const api = fn(S, sandbox.document, sandbox.window, sandbox.setTimeout, sandbox.clearTimeout, sandbox.Object, sandbox.console, sandbox.JSON, sandbox.Math, sandbox.Date, sandbox.Map, sandbox.Set, sandbox.WeakSet, sandbox.Array, sandbox.Number, sandbox.String, sandbox.Boolean, sandbox.Promise, sandbox.logEvent, sandbox.toast, sandbox.render, sandbox.esc, sandbox.save, sandbox.uid, sandbox.localStorage, sandbox.indexedDB, sandbox.navigator, sandbox._charSig, sandbox.openSettings, sandbox.renderStats);

const { esc, settingRow, closeOpt, setPause, ensureUiPrefs, save, dayStamp, clamp, valueDelta, missDamage, takeDamage, logHistory, logEvent, logCharSnapshot, runCron, isDailyDueOn, completionReward, gainXp, death, now, uid, _charSig, xpToLevel, isDailyDueToday, completeTask, creditYesterday, _resetDailies, missedYesterdayDailies } = api;

// =========================================================================
// Test 6: streak growth freezes while paused (review P1-3 fix)
// completeTask / creditYesterday must gate ONLY the streak increment on
// !S.prefs.paused -- XP/gold/history/reward recording stays unconditional.
// =========================================================================
function freshDaily(id){
  return { id:id, type:'daily', title:'Daily '+id, difficulty:'medium', value:0,
           streak:3, checklist:[], repeat:[1,1,1,1,1,1,1], history:[] };
}
function freshChar(){ return { hp:50, maxHp:50, xp:0, lvl:1, gold:0, mp:0, name:'Test', face:'🧙', cls:'Wizard' }; }

// 6a. completeTask while paused: streak frozen, rewards still granted
{
  S.prefs.paused = true;
  const t = freshDaily('d-pause-ct');
  S.tasks = [t];
  S.char = freshChar();
  completeTask(t, { clientX:0, clientY:0 });
  assert('6a paused: completeTask(daily) leaves streak unchanged', t.streak === 3);
  assert('6a paused: completeTask(daily) still grants XP', S.char.xp > 0);
  assert('6a paused: completeTask(daily) still marks done', t.done === true);
  assert('6a paused: completeTask(daily) still records history point',
    Array.isArray(t.history) && t.history.length >= 1 && t.history[t.history.length-1].completed === true);
}

// 6b. completeTask while unpaused: streak increments by exactly 1
{
  S.prefs.paused = false;
  const t = freshDaily('d-open-ct');
  S.tasks = [t];
  S.char = freshChar();
  completeTask(t, { clientX:0, clientY:0 });
  assert('6b unpaused: completeTask(daily) increments streak by exactly 1', t.streak === 4);
  assert('6b unpaused: completeTask(daily) still grants XP', S.char.xp > 0);
  assert('6b unpaused: completeTask(daily) marks done', t.done === true);
}

// 6c. creditYesterday while paused: streak frozen, rewards credited, done
{
  S.prefs.paused = true;
  const t = freshDaily('d-pause-cy');
  S.tasks = [t];
  S.char = freshChar();
  creditYesterday(t);
  assert('6c paused: creditYesterday leaves streak unchanged', t.streak === 3);
  assert('6c paused: creditYesterday still credits XP', S.char.xp > 0);
  assert('6c paused: creditYesterday marks done', t.done === true);
}

// 6d. creditYesterday while unpaused: streak increments by exactly 1
{
  S.prefs.paused = false;
  const t = freshDaily('d-open-cy');
  S.tasks = [t];
  S.char = freshChar();
  creditYesterday(t);
  assert('6d unpaused: creditYesterday increments streak by exactly 1', t.streak === 4);
  assert('6d unpaused: creditYesterday still credits XP', S.char.xp > 0);
  assert('6d unpaused: creditYesterday marks done', t.done === true);
}

// Test 1: S.prefs.paused defaults to false in fresh state
{
  const freshS = { prefs: {} };
  // ensureUiPrefs uses global S - create sandbox with S and call ensureUiPrefs()
  const testSandbox = { 
    console: console, 
    JSON: JSON, 
    Object: Object, 
    Array: Array, 
    String: String, 
    Number: Number, 
    Boolean: Boolean, 
    Date: Date, 
    Math: Math, 
    Map: Map, 
    Set: Set, 
    WeakSet: WeakSet, 
    Promise: Promise,
    window: {},
    navigator: { onLine: true },
    document: {
      addEventListener: function(){},
      getElementById: function(){ return null; },
      createElement: function(){ return { style:{}, appendChild: function(){}, setAttribute: function(){}, click: function(){} }; },
      body: { appendChild: function(){}, removeChild: function(){} }
    },
    localStorage: { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){}, key: function(){ return null; }, length: 0 },
    indexedDB: { open: function(){ return {}; } },
    setTimeout: function(){ return 0; }, 
    clearTimeout: function(){}, 
    setInterval: function(){ return 0; }, 
    clearInterval: function(){},
    Math: Math, 
    Date: Date, 
    Map: Map, 
    Set: Set, 
    WeakSet: WeakSet,
    Array: Array, 
    Object: Object, 
    Number: Number, 
    String: String, 
    Boolean: Boolean, 
    Promise: Promise,
    logEvent: function(){}, 
    toast: function(){}, 
    render: function(){}, 
    esc: function(x){ return x; }, 
    save: function(){},
    uid: function(){ return 'x'; }, 
    idbOpen: function(){ return Promise.resolve(null); },
    _charSig: function(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } },
    _prevCharSig: null,
    IS_DIRTY: false,
    lastIssued: 0,
    _idbWriteState: function(){ return Promise.resolve(); },
    _stateWritePromise: null,
    openSettings: function(){},
    renderStats: function(){},
    S: freshS
  };
  vm.createContext(testSandbox);
  const fn2 = new vm.Script(
    '(function(){ "use strict";\n' + ensureUiPrefsFn + '\nensureUiPrefs();\n})'
  ).runInContext(testSandbox);
  fn2();
  assert('fresh state has prefs.paused === false', freshS.prefs.paused === false);
}

// Test 2: setPause toggles prefs.paused
{
  // setPause uses global S, save, closeOpt, openSettings, renderStats
  // Create a test sandbox with all required globals
  const testSandbox = { 
    console: console, 
    JSON: JSON, 
    Object: Object, 
    Array: Array, 
    String: String, 
    Number: Number, 
    Boolean: Boolean, 
    Date: Date, 
    Math: Math, 
    Map: Map, 
    Set: Set, 
    WeakSet: WeakSet, 
    Promise: Promise,
    window: {},
    navigator: { onLine: true },
    document: {
      addEventListener: function(){},
      getElementById: function(){ return null; },
      createElement: function(){ return { style:{}, appendChild: function(){}, setAttribute: function(){}, click: function(){} }; },
      body: { appendChild: function(){}, removeChild: function(){} }
    },
    localStorage: { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){}, key: function(){ return null; }, length: 0 },
    indexedDB: { open: function(){ return {}; } },
    setTimeout: function(){ return 0; }, 
    clearTimeout: function(){}, 
    setInterval: function(){ return 0; }, 
    clearInterval: function(){},
    Math: Math, 
    Date: Date, 
    Map: Map, 
    Set: Set, 
    WeakSet: WeakSet,
    Array: Array, 
    Object: Object, 
    Number: Number, 
    String: String, 
    Boolean: Boolean, 
    Promise: Promise,
    logEvent: function(){}, 
    toast: function(){}, 
    render: function(){}, 
    esc: function(x){ return x; }, 
    save: function(){},
    uid: function(){ return 'x'; }, 
    idbOpen: function(){ return Promise.resolve(null); },
    _charSig: function(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } },
    _prevCharSig: null,
    IS_DIRTY: false,
    lastIssued: 0,
    _idbWriteState: function(){ return Promise.resolve(); },
    _stateWritePromise: null,
    openSettings: function(){},
    renderStats: function(){},
    closeOpt: function(){},
    now: function(){ return 7; },
    S: { prefs: { paused: false } }
  };
  vm.createContext(testSandbox);
  
  const fn2 = new vm.Script(
    '(function(n){ "use strict";\n' + setPauseFn + '\nsetPause(n);\n})'
  ).runInContext(testSandbox);
  
  fn2(true);
  assert('setPause(true) sets prefs.paused = true', testSandbox.S.prefs.paused === true);
  assert('setPause(true) stamps prefs.pausedAt (LWW timestamp)', testSandbox.S.prefs.pausedAt === 7);
  
  testSandbox.S = { prefs: { paused: true } };
  fn2(false);
  assert('setPause(false) sets prefs.paused = false', testSandbox.S.prefs.paused === false);
  assert('setPause(false) stamps prefs.pausedAt', testSandbox.S.prefs.pausedAt === 7);
}

// Test 2b: setPause(true) initializes pausedDays when missing
{
  const testSandbox = { 
    console: console, 
    JSON: JSON, 
    Object: Object, 
    Array: Array, 
    String: String, 
    Number: Number, 
    Boolean: Boolean, 
    Date: Date, 
    Math: Math, 
    Map: Map, 
    Set: Set, 
    WeakSet: WeakSet, 
    Promise: Promise,
    window: {},
    navigator: { onLine: true },
    document: {
      addEventListener: function(){},
      getElementById: function(){ return null; },
      createElement: function(){ return { style:{}, appendChild: function(){}, setAttribute: function(){}, click: function(){} }; },
      body: { appendChild: function(){}, removeChild: function(){} }
    },
    localStorage: { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){}, key: function(){ return null; }, length: 0 },
    indexedDB: { open: function(){ return {}; } },
    setTimeout: function(){ return 0; }, 
    clearTimeout: function(){}, 
    setInterval: function(){ return 0; }, 
    clearInterval: function(){},
    Math: Math, 
    Date: Date, 
    Map: Map, 
    Set: Set, 
    WeakSet: WeakSet,
    Array: Array, 
    Object: Object, 
    Number: Number, 
    String: String, 
    Boolean: Boolean, 
    Promise: Promise,
    logEvent: function(){}, 
    toast: function(){}, 
    render: function(){}, 
    esc: function(x){ return x; }, 
    save: function(){},
    uid: function(){ return 'x'; }, 
    idbOpen: function(){ return Promise.resolve(null); },
    _charSig: function(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } },
    _prevCharSig: null,
    IS_DIRTY: false,
    lastIssued: 0,
    _idbWriteState: function(){ return Promise.resolve(); },
    _stateWritePromise: null,
    openSettings: function(){},
    renderStats: function(){},
    closeOpt: function(){},
    now: function(){ return 7; },
    S: { prefs: { paused: false } }
  };
  vm.createContext(testSandbox);
  
  const fn2 = new vm.Script(
    '(function(n){ "use strict";\n' + setPauseFn + '\nsetPause(n);\n})'
  ).runInContext(testSandbox);
  
  fn2(true);
  assert('setPause(true) initializes pausedDays when missing', Array.isArray(testSandbox.S.prefs.pausedDays) && testSandbox.S.prefs.pausedDays.length === 0);
  assert('setPause(true) sets prefs.paused = true', testSandbox.S.prefs.paused === true);
  assert('setPause(true) stamps prefs.pausedAt (LWW timestamp)', testSandbox.S.prefs.pausedAt === 7);
}

// Test 3: export/import round-trip preserves paused
{
  const testS = {
    prefs: { paused: true, pausedDays: [20260802, 20260803], pausedAt: 12345, width: 480, filter: {}, sort: {}, tagFilter: {}, filterOpen: false, scroll: {} },
    tasks: [],
    rewards: [],
    tags: [],
    devices: [],
    char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' },
    lastCron: 0,
    history: [],
    charHistory: [],
    monthlyBackups: [],
    deletions: [],
    events: []
  };

  // Simulate exportData -> buildBackupFile -> _tokenizeSnapshot -> _detokenizeSnapshot
  // We'll test that prefs.paused survives the tokenize/detokenize cycle
  const { extractFunction: ef } = require('./_extract');
  const tokenizeSnapshotFn = ef(appSrc, /^function _tokenizeSnapshot\(s\)\{/, '_tokenizeSnapshot');
  const detokenizeSnapshotFn = ef(appSrc, /^function _detokenizeSnapshot\(tok\)\{/, '_detokenizeSnapshot');
  const buildFieldMapFn = ef(appSrc, /^function _buildFieldMap\(snap\)\{/, '_buildFieldMap');
  const tokDeepFn = ef(appSrc, /^function _tokDeep\(o, fm\)\{/, '_tokDeep');
  const detDeepFn = ef(appSrc, /^function _detDeep\(o, rmap\)\{/, '_detDeep');

const tokenizeCode = [
  '(function(){',
  tokenizeSnapshotFn,
  detokenizeSnapshotFn,
  buildFieldMapFn,
  tokDeepFn,
  detDeepFn,
  'return { _tokenizeSnapshot, _detokenizeSnapshot };',
  '})()'
].join('\n');

  const tokenizeSandbox = { ...sandbox, JSON: JSON, Object: Object, Array: Array };
  tokenizeSandbox.self = tokenizeSandbox.window; tokenizeSandbox.globalThis = tokenizeSandbox;
  vm.createContext(tokenizeSandbox);
  let tokenizeMod;
  try { tokenizeMod = vm.runInContext(tokenizeCode, tokenizeSandbox); } catch(e) { console.error('Tokenize VM error:', e); process.exit(1); }

  const { _tokenizeSnapshot, _detokenizeSnapshot } = tokenizeMod;

  const tok = _tokenizeSnapshot(testS);
  const detok = _detokenizeSnapshot(tok);

  assert('export/import round-trip preserves prefs.paused', detok.prefs.paused === true);
  assert('export/import round-trip preserves prefs.pausedDays',
    Array.isArray(detok.prefs.pausedDays) && detok.prefs.pausedDays.length === 2 &&
    detok.prefs.pausedDays[0] === 20260802 && detok.prefs.pausedDays[1] === 20260803);
  assert('export/import round-trip preserves prefs.pausedAt', detok.prefs.pausedAt === 12345);
}

// =========================================================================
// Test 5: pause sync across devices (review P1-2 fix)
// =========================================================================
// Load sync.js into a vm sandbox (strip the boot gate) exactly like
// tests/tombstone.test.js / tests/auto-backup-sync-exclusion.test.js.
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8')
  .replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const syncSandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: { getItem: function(){ return null; }, setItem: noop, removeItem: noop, key: function(){ return null; }, length: 0 },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(){ return 0; }, clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'x'; }, idbOpen: function(){ return Promise.resolve(null); },
  S: {
    char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0 },
    tasks: [], rewards: [], tags: [], devices: [],
    prefs: { paused: false, width: 480 },
    lastCron: 0, history: [], charHistory: [], monthlyBackups: [], deletions: []
  }
};
syncSandbox.self = syncSandbox.window; syncSandbox.globalThis = syncSandbox;
vm.createContext(syncSandbox);
try { vm.runInContext(syncSrc, syncSandbox); } catch(e) { console.error('FAIL: sync.js VM load threw:', e); process.exit(1); }
const Q = syncSandbox.window.QuestaSync;
if (!Q || typeof Q.merge !== 'function') { console.error('FAIL: QuestaSync.merge not found in sync.js'); process.exit(1); }

// Minimal subset builder: only `pause` varies; everything else empty.
function pauseSub(pause){
  return { tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, char: {}, deletions: [],
    pause: pause };
}

// 5a. syncSubset() ships the pause whitelist (paused/pausedDays/at)
{
  syncSandbox.S.prefs = { paused: true, pausedDays: [20260802, 20260803], pausedAt: 5, width: 480 };
  const sub = syncSandbox.syncSubset();
  assert('5a syncSubset() ships pause.paused', sub.pause && sub.pause.paused === true);
  assert('5a syncSubset() ships pause.pausedDays',
    sub.pause && Array.isArray(sub.pause.pausedDays) && sub.pause.pausedDays.length === 2 &&
    sub.pause.pausedDays[0] === 20260802 && sub.pause.pausedDays[1] === 20260803);
  assert('5a syncSubset() ships pause.at', sub.pause && sub.pause.at === 5);
  assert('5a syncSubset() still excludes raw prefs (whitelist only)', !('prefs' in sub));
  syncSandbox.S.prefs = { paused: false, width: 480 };
}

// 5b. syncApply() restores pause and deep-copies pausedDays
{
  syncSandbox.S.prefs = { paused: false, width: 480 };
  const sub = { pause: { paused: true, pausedDays: [20260802, 20260803], at: 5 }, tasks: [] };
  const applied = syncSandbox.syncApply(sub);
  assert('5b syncApply() returns true', applied === true);
  assert('5b syncApply() restores paused', syncSandbox.S.prefs.paused === true);
  assert('5b syncApply() restores pausedDays',
    Array.isArray(syncSandbox.S.prefs.pausedDays) && syncSandbox.S.prefs.pausedDays.length === 2 &&
    syncSandbox.S.prefs.pausedDays[0] === 20260802 && syncSandbox.S.prefs.pausedDays[1] === 20260803);
  assert('5b syncApply() restores pausedAt', syncSandbox.S.prefs.pausedAt === 5);
  sub.pause.pausedDays.push(999999);
  assert('5b syncApply() deep-copies pausedDays (input mutation does not alias)',
    Array.isArray(syncSandbox.S.prefs.pausedDays) && syncSandbox.S.prefs.pausedDays.length === 2 &&
    syncSandbox.S.prefs.pausedDays.indexOf(999999) === -1);
}

// 5c. merge() LWW by `at` (base ignored), tie -> local
{
  const base = pauseSub({ paused: false, pausedDays: [], at: 0 });
  const local = pauseSub({ paused: false, pausedDays: [], at: 5 });
  const remote = pauseSub({ paused: true, pausedDays: [], at: 9 });
  const m = Q.merge(base, local, remote, 1000, 1000);
  assert('5c LWW: remote at=9 beats local at=5 -> paused=true', m.pause.paused === true && m.pause.at === 9);
}
{
  const base = pauseSub({ paused: false, pausedDays: [], at: 0 });
  const local = pauseSub({ paused: true, pausedDays: [], at: 9 });
  const remote = pauseSub({ paused: false, pausedDays: [], at: 5 });
  const m = Q.merge(base, local, remote, 1000, 1000);
  assert('5c LWW: local at=9 beats remote at=5 -> local wins', m.pause.paused === true && m.pause.at === 9);
}
{
  const base = pauseSub({ paused: false, pausedDays: [], at: 0 });
  const local = pauseSub({ paused: true, pausedDays: [], at: 5 });
  const remote = pauseSub({ paused: false, pausedDays: [], at: 5 });
  const m = Q.merge(base, local, remote, 1000, 1000);
  assert('5c LWW: tie at=5 resolves to local', m.pause.paused === true && m.pause.at === 5);
}

// 5d. merge() unions base+local+remote pausedDays, deduped, sorted, pruned to 7
{
  const base = pauseSub({ paused: false, pausedDays: [], at: 0 });
  const local = pauseSub({ paused: false, pausedDays: [1], at: 1 });
  const remote = pauseSub({ paused: false, pausedDays: [2], at: 1 });
  const m = Q.merge(base, local, remote, 1000, 1000);
  assert('5d union: [1] + [2] -> sorted [1,2]',
    Array.isArray(m.pause.pausedDays) && m.pause.pausedDays.length === 2 &&
    m.pause.pausedDays[0] === 1 && m.pause.pausedDays[1] === 2);
}
{
  const base = pauseSub({ paused: false, pausedDays: [0], at: 0 });
  const local = pauseSub({ paused: false, pausedDays: [1,2,3,4,5,6,7,2], at: 1 });
  const remote = pauseSub({ paused: false, pausedDays: [8], at: 1 });
  const m = Q.merge(base, local, remote, 1000, 1000);
  assert('5d union: dedup + sort + prune to last 7 -> 2..8',
    Array.isArray(m.pause.pausedDays) && m.pause.pausedDays.length === 7 &&
    m.pause.pausedDays.join(',') === '2,3,4,5,6,7,8');
}

// =========================================================================
// Test 4: openOpt('pause') renders the pause chooser (review P0-1 fix)
// =========================================================================
// Structural: openOpt has a pause branch wired to setPause(1)/setPause(0)
assert('openOpt handles key===\'pause\'',
  /key==='pause'/.test(appSrc));
assert('openOpt pause branch calls setPause(1) and setPause(0)',
  /setPause\(1\)/.test(appSrc) && /setPause\(0\)/.test(appSrc));

// Behavioral: extract the real width + pause branches (brace-balanced) and
// render them through a minimal openOpt wrapper writing to #optMenu, exactly
// like tests/auto-backup-settings-ui.test.js does for the autoBackup branch.
const widthBlock = extractBraceBody(appSrc, /if\(key==='width'\)\{\s*$/, 'openOpt width branch');
const pauseBlock = extractBraceBody(appSrc, /else if\(key==='pause'\)\{\s*$/, 'openOpt pause branch');

const pauseOpenOptCode = [
  'function openOpt(key){',
  '  var h="";',
  '  if(key==="width"){',
  widthBlock,
  '  } else if(key==="pause"){',
  pauseBlock,
  '  }',
  '  document.getElementById("optMenu").innerHTML=h;',
  '  document.getElementById("optScrim").classList.add("show");',
  '}',
  'return openOpt;'
].join('\n');

function makePauseEl(id) { return { _id: id, innerHTML: '', classList: { add: noop, remove: noop } }; }
const pauseStore = {};
const pauseDoc = {
  getElementById: function (id) { if (!pauseStore[id]) pauseStore[id] = makePauseEl(id); return pauseStore[id]; }
};
const pauseSandbox = {
  S: { prefs: { paused: false, width: 480 } },
  window: {},
  console: console,
  setTimeout: noop, clearTimeout: noop,
  Object: Object, Array: Array, String: String, Number: Number, Boolean: Boolean
};
pauseSandbox.globalThis = pauseSandbox;

// document is passed as an explicit parameter (not a context global) --
// same pattern as tests/auto-backup-settings-ui.test.js.
let pauseOpenOpt;
try {
  const pauseOpenOptFn = new vm.Script(
    '(function(S, document, window, Object, Array, String, Number, Boolean){ "use strict";\n' +
    pauseOpenOptCode + '\n})'
  ).runInNewContext(pauseSandbox);
  pauseOpenOpt = pauseOpenOptFn(pauseSandbox.S, pauseDoc, pauseSandbox.window, Object, Array, String, Number, Boolean);
} catch (e) { console.error('openOpt pause VM error:', e); process.exit(1); }

// paused=false -> Off button active
pauseOpenOpt('pause');
const pauseHtmlOff = pauseStore['optMenu'].innerHTML;
assert('openOpt("pause") renders "Pause tracking" heading',
  pauseHtmlOff.includes('Pause tracking'));
assert('openOpt("pause") renders an optHint paragraph',
  /<p class="optHint">/.test(pauseHtmlOff));
assert('openOpt("pause") has an optChoices div',
  pauseHtmlOff.includes('class="optChoices"'));
assert('openOpt("pause") has On button calling setPause(1)',
  pauseHtmlOff.includes('onclick="setPause(1)"'));
assert('openOpt("pause") has Off button calling setPause(0)',
  pauseHtmlOff.includes('onclick="setPause(0)"'));
assert('when paused=false, On button does NOT have "on" class',
  !/<button type="button" class="on" onclick="setPause\(1\)"/.test(pauseHtmlOff));
assert('when paused=false, Off button HAS "on" class',
  /<button type="button" class="on" onclick="setPause\(0\)"/.test(pauseHtmlOff));

// paused=true -> On button active
pauseSandbox.S.prefs.paused = true;
pauseOpenOpt('pause');
const pauseHtmlOn = pauseStore['optMenu'].innerHTML;
assert('when paused=true, On button HAS "on" class',
  /<button type="button" class="on" onclick="setPause\(1\)"/.test(pauseHtmlOn));
assert('when paused=true, Off button does NOT have "on" class',
  !/<button type="button" class="on" onclick="setPause\(0\)"/.test(pauseHtmlOn));

// width branch must NOT leak pause markup
pauseOpenOpt('width');
const widthHtml = pauseStore['optMenu'].innerHTML;
assert('openOpt("width") does NOT contain "Pause tracking"',
  !widthHtml.includes('Pause tracking'));
assert('openOpt("width") does NOT contain setPause',
  !widthHtml.includes('setPause'));

// =========================================================================
// Test 7: runCron + missedYesterdayDailies pause-day accounting (P1-4 fix)
// Deterministic day stamps: the sandbox `Date` is a fake whose clock reads
// the module-level `cronNow`. Mutate cronNow to simulate day progression.
// Day X is the local calendar day of CRON_BASE; X+1 = next day, X-1 = prior.
// =========================================================================
const CRON_BASE = Date.UTC(2026, 7, 3, 12, 0, 0); // fixed noon, local day = X
let cronNow = CRON_BASE;
class FakeDate extends Date {
  constructor(...args){ if (args.length === 0) super(cronNow); else super(...args); }
  static now(){ return cronNow; }
}
const ds = d => d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
const X   = ds(new Date(CRON_BASE));
const Xm1 = ds(new Date(CRON_BASE - 86400000));
const Xp1 = ds(new Date(CRON_BASE + 86400000));

function makeCronSandbox(){
  const S2 = {
    prefs: { paused: false, pausedDays: [], width: 480, filter: {}, sort: {}, tagFilter: {}, filterOpen: false, scroll: {} },
    tasks: [], rewards: [], tags: [], devices: [],
    char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' },
    lastCron: 0, history: [], charHistory: [], monthlyBackups: [], deletions: [], events: []
  };
  const sb = { ...sandbox, S: S2, Date: FakeDate };
  sb.globalThis = sb;
  const f = new vm.Script(
    '(function(S, document, window, setTimeout, clearTimeout, Object, console, JSON, Math, Date, Map, Set, WeakSet, Array, Number, String, Boolean, Promise, logEvent, toast, render, esc, save, uid, localStorage, indexedDB, navigator, _charSig, openSettings, renderStats){ "use strict";\n' +
    code + '\n})'
  ).runInNewContext(sb);
  const a = f(S2, sb.document, sb.window, sb.setTimeout, sb.clearTimeout, sb.Object, sb.console, sb.JSON, sb.Math, sb.Date, sb.Map, sb.Set, sb.WeakSet, sb.Array, sb.Number, sb.String, sb.Boolean, sb.Promise, sb.logEvent, sb.toast, sb.render, sb.esc, sb.save, sb.uid, sb.localStorage, sb.indexedDB, sb.navigator, sb._charSig, sb.openSettings, sb.renderStats);
  return { S: S2, api: a };
}
function freshCronDaily(id){
  return { id:id, type:'daily', title:'Daily '+id, difficulty:'medium', value:0,
           streak:3, checklist:[], repeat:[1,1,1,1,1,1,1], history:[], done:false };
}

// 7a. Paused cron on day X: lastCron advances, daily reset, hp unchanged,
//     pausedDays stamped with X, no missedOn, streak unchanged.
{
  cronNow = CRON_BASE;
  const { S, api } = makeCronSandbox();
  S.prefs.paused = true;
  S.lastCron = Xm1;
  const t = freshCronDaily('d-pause7a');
  t.done = true;
  S.tasks = [t];
  S.char = { hp:50, maxHp:50, xp:0, lvl:1, gold:0, mp:0, name:'Test', face:'🧙', cls:'Wizard' };
  api.runCron();
  assert('7a paused cron: lastCron advances to today (X)', S.lastCron === X);
  assert('7a paused cron: daily reset (done=false)', t.done === false);
  assert('7a paused cron: hp unchanged (no damage)', S.char.hp === 50);
  assert('7a paused cron: pausedDays contains X', Array.isArray(S.prefs.pausedDays) && S.prefs.pausedDays.indexOf(X) !== -1);
  assert('7a paused cron: no missedOn stamped', t.missedOn === undefined);
  assert('7a paused cron: streak unchanged', t.streak === 3);
}

// 7b. Unpaused cron on day X+1 with pausedDays=[X]: yesterday X is
//     pause-covered -> no damage, no missedOn, streak unchanged, daily reset.
{
  cronNow = CRON_BASE + 86400000;
  const { S, api } = makeCronSandbox();
  S.prefs.paused = false;
  S.prefs.pausedDays = [X];
  S.lastCron = X;
  const t = freshCronDaily('d-cov7b');
  t.done = true; // was never completed -> would otherwise be missed
  S.tasks = [t];
  S.char = { hp:50, maxHp:50, xp:0, lvl:1, gold:0, mp:0, name:'Test', face:'🧙', cls:'Wizard' };
  api.runCron();
  assert('7b covered yesterday: lastCron advances to X+1', S.lastCron === Xp1);
  assert('7b covered yesterday: no HP loss', S.char.hp === 50);
  assert('7b covered yesterday: no missedOn', t.missedOn === undefined);
  assert('7b covered yesterday: streak unchanged', t.streak === 3);
  assert('7b covered yesterday: daily still reset (done=false)', t.done === false);
}

// 7c. missedYesterdayDailies returns [] when yesterday is pause-covered;
//     control without coverage still lists the missed daily.
{
  cronNow = CRON_BASE + 86400000; // yesterday = X
  const { S, api } = makeCronSandbox();
  S.prefs.pausedDays = [X];
  S.lastCron = Xm1; // not today -> no early return
  S.tasks = [freshCronDaily('d-miss7c')];
  const missed = api.missedYesterdayDailies();
  assert('7c covered yesterday: missedYesterdayDailies() returns []', Array.isArray(missed) && missed.length === 0);
  S.prefs.pausedDays = [];
  const missed2 = api.missedYesterdayDailies();
  assert('7c control unpaused: missedYesterdayDailies() still lists the missed daily', missed2.length === 1);
}

// 7d. Multi-day pause pausedDays=[X-1, X]: cron on X+1 applies zero damage.
{
  cronNow = CRON_BASE + 86400000;
  const { S, api } = makeCronSandbox();
  S.prefs.paused = false;
  S.prefs.pausedDays = [Xm1, X];
  S.lastCron = Xm1; // two covered days since last cron
  const t = freshCronDaily('d-pause7d');
  S.tasks = [t];
  S.char = { hp:50, maxHp:50, xp:0, lvl:1, gold:0, mp:0, name:'Test', face:'🧙', cls:'Wizard' };
  api.runCron();
  assert('7d multi-day pause: no HP loss', S.char.hp === 50);
  assert('7d multi-day pause: no missedOn', t.missedOn === undefined);
  assert('7d multi-day pause: streak unchanged', t.streak === 3);
  assert('7d multi-day pause: daily still reset (done=false)', t.done === false);
  assert('7d multi-day pause: lastCron advances to X+1', S.lastCron === Xp1);
}

// 7e. Unpaused control: cron on X+1 with pausedDays=[] still damages a
//     missed due daily (regression guard vs pre-fix behavior).
{
  cronNow = CRON_BASE + 86400000;
  const { S, api } = makeCronSandbox();
  S.prefs.paused = false;
  S.prefs.pausedDays = [];
  S.lastCron = X;
  const t = freshCronDaily('d-open7e');
  S.tasks = [t];
  S.char = { hp:50, maxHp:50, xp:0, lvl:1, gold:0, mp:0, name:'Test', face:'🧙', cls:'Wizard' };
  api.runCron();
  assert('7e unpaused control: missed due daily takes damage', S.char.hp < 50);
  assert('7e unpaused control: missedOn stamped with yesterday (X)', t.missedOn === X);
  assert('7e unpaused control: streak reset to 0', t.streak === 0);
  assert('7e unpaused control: daily reset (done=false)', t.done === false);
  assert('7e unpaused control: lastCron advances to X+1', S.lastCron === Xp1);
}

// Summary
if (failures > 0) {
  console.error('\n' + failures + ' test(s) failed');
  process.exit(1);
} else {
  console.log('\nAll pause-tracking tests passed!');
}