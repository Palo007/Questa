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

assert('openSettings has pause settingRow',
  /settingRow\('pause'/.test(appSrc));

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
const { extractFunction, extractBraceBody } = require('./_extract');

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
const logHistoryFn = extractFunction(appSrc, /^function logHistory\(t, patch\)\{/, 'logHistory');
const logEventFn = extractFunction(appSrc, /^function logEvent\(ev\)\{/, 'logEvent');
const logCharSnapshotFn = extractFunction(appSrc, /^function logCharSnapshot\(\)\{/, 'logCharSnapshot');
const runCronFn = extractFunction(appSrc, /^function runCron\(\)\{/, 'runCron');
const isDailyDueOnFn = extractFunction(appSrc, /^function isDailyDueOn\(t, dow\)\{/, 'isDailyDueOn');
const completionRewardFn = extractFunction(appSrc, /^function completionReward\(task\)\{/, 'completionReward');
const gainXpFn = extractFunction(appSrc, /^function gainXp\(xp\)\{/, 'gainXp');
const deathFn = extractFunction(appSrc, /^function death\(\)\{/, 'death');
const nowFn = extractFunction(appSrc, /^function now\(\)\{/, 'now');
const charSigFn = extractFunction(appSrc, /^function _charSig\(c\)\{/, '_charSig');

// Build test code
const code = [
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
  nowFn,
  charSigFn,
  'return { esc, settingRow, closeOpt, setPause, ensureUiPrefs, save, dayStamp, clamp, valueDelta, missDamage, takeDamage, logHistory, logEvent, logCharSnapshot, runCron, isDailyDueOn, completionReward, gainXp, death, now, uid, _charSig };'
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

const { esc, settingRow, closeOpt, setPause, ensureUiPrefs, save, dayStamp, clamp, valueDelta, missDamage, takeDamage, logHistory, logEvent, logCharSnapshot, runCron, isDailyDueOn, completionReward, gainXp, death, now, uid, _charSig } = api;

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
    S: { prefs: { paused: false } }
  };
  vm.createContext(testSandbox);
  
  const fn2 = new vm.Script(
    '(function(n){ "use strict";\n' + setPauseFn + '\nsetPause(n);\n})'
  ).runInContext(testSandbox);
  
  fn2(true);
  assert('setPause(true) sets prefs.paused = true', testSandbox.S.prefs.paused === true);
  
  testSandbox.S = { prefs: { paused: true } };
  fn2(false);
  assert('setPause(false) sets prefs.paused = false', testSandbox.S.prefs.paused === false);
}

// Test 3: export/import round-trip preserves paused
{
  const testS = {
    prefs: { paused: true, width: 480, filter: {}, sort: {}, tagFilter: {}, filterOpen: false, scroll: {} },
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
}

// Summary
if (failures > 0) {
  console.error('\n' + failures + ' test(s) failed');
  process.exit(1);
} else {
  console.log('\nAll pause-tracking tests passed!');
}