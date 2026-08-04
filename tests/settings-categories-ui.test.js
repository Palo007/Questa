// settings-categories-ui.test.js -- tests for settings category buttons UI
//
// Verifies:
// 1. Structural: app.js has no catCount, exactly 3 catLabel/catIcon/catChev spans
// 2. Structural: app.js has openCat('appearance'), openCat('interaction'), openCat('activityFeed')
// 3. Structural: index.html CSS has .catBtnRow with gap:10px and margin:14px 0 10px
// 4. Structural: index.html CSS has .catBtn with padding:12px 14px
// 5. Structural: index.html CSS has .catLabel with white-space:normal, line-height:1.25, NO white-space:nowrap
// 6. Structural: index.html has NO .catCount
// 7. Behavioral: VM-rendered catBtn block produces exactly 3 catBtn, 3 catLabel, 3 catChev, 0 catCount,
//    and includes 'Appearance', 'Interaction', 'Activity Feed'
//
// Strategy: read app.js and index.html source for structural regex checks, then extract the
// catBtn rendering block from app.js (anchored on unique comment) and run it in a VM sandbox.
//
// Run: node tests/settings-categories-ui.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

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
assert('app.js has NO catCount class',
  !/catCount/.test(appSrc));

assert('app.js has exactly 3 catLabel spans',
  (appSrc.match(/<span class="catLabel">/g) || []).length === 3);

assert('app.js has exactly 3 catIcon spans',
  (appSrc.match(/<span class="catIcon">/g) || []).length === 3);

assert('app.js has exactly 3 catChev spans',
  (appSrc.match(/<span class="catChev">/g) || []).length === 3);

assert('app.js has openCat(\'appearance\')',
  /openCat\(\\\'appearance\\\'\)/.test(appSrc));

assert('app.js has openCat(\'interaction\')',
  /openCat\(\\\'interaction\\\'\)/.test(appSrc));

assert('app.js has openCat(\'activityFeed\')',
  /openCat\(\\\'activityFeed\\\'\)/.test(appSrc));

// =========================================================================
// 2. Structural guards on index.html CSS
// =========================================================================
assert('index.html has NO .catCount in CSS',
  !html.includes('.catCount'));

assert('index.html .catBtnRow rule has gap:10px',
  /\.catBtnRow\{[^}]*gap:10px/.test(html));

assert('index.html .catBtnRow rule has margin:14px 0 10px',
  /\.catBtnRow\{[^}]*margin:14px 0 10px/.test(html));

assert('index.html .catBtn rule has padding:12px 14px',
  /\.catBtn\{[^}]*padding:12px 14px/.test(html));

assert('index.html .catLabel rule has white-space:normal',
  /\.catLabel\{[^}]*white-space:normal/.test(html));

assert('index.html .catLabel rule has line-height:1.25',
  /\.catLabel\{[^}]*line-height:1\.25/.test(html));

assert('index.html .catLabel rule does NOT have white-space:nowrap',
  !/\.catLabel\{[^}]*white-space:nowrap/.test(html));

// =========================================================================
// 3. Behavioral: VM-rendered catBtn block
// =========================================================================
const { extractFunction, extractBraceBody } = require('./_extract');

// Extract the catBtn rendering block using anchor-based extraction
// Anchor: "// Category buttons for grouped settings (replaces horizontal setList)"
// End: first "h+='</div>';" at or after the anchor
const anchor = '// Category buttons for grouped settings';
const anchorIdx = appSrc.indexOf(anchor);
if (anchorIdx === -1) {
  console.error('[FAIL] Anchor comment not found in app.js');
  process.exit(1);
}

// Find the first "h+='</div>';" at or after the anchor
const searchStart = anchorIdx;
const endMarker = "h+='</div>';";
const endIdx = appSrc.indexOf(endMarker, searchStart);
if (endIdx === -1) {
  console.error('[FAIL] Closing h+=\'</div>\'; not found after anchor');
  process.exit(1);
}

// Extract the block between anchor and endMarker (inclusive of endMarker)
const blockStart = appSrc.indexOf('\n', anchorIdx) + 1; // start of next line after comment
const block = appSrc.slice(blockStart, endIdx + endMarker.length);

// Wrap as a render function
const renderCode = [
  'function renderCatBtns(){',
  '  var h=\'\';',
  block,
  '  return h;',
  '}',
  'return renderCatBtns;'
].join('\n');

// Minimal sandbox for rendering
function noop() {}
const sandbox = {
  S: {
    prefs: { width: 480, filter: {}, sort: {}, tagFilter: {}, filterOpen: false, scroll: {} },
    tasks: [], rewards: [], tags: [], devices: [],
    char: { hp: 50, maxHp: 50, xp: 0, lvl: 1, gold: 0, mp: 0, name: 'Test', face: '🧙', cls: 'Wizard' },
    lastCron: 0, history: [], charHistory: [], monthlyBackups: [], deletions: [], events: []
  },
  document: {
    getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop, classList: { add: noop, remove: noop } }; },
    body: { appendChild: noop, removeChild: noop, classList: { toggle: noop } },
    addEventListener: noop
  },
  window: {},
  navigator: { onLine: true },
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
  renderStats: noop,
  openCat: noop
};
sandbox.globalThis = sandbox;

let renderCatBtns;
try {
  const fn = new vm.Script(
    '(function(S, document, window, setTimeout, clearTimeout, Object, console, JSON, Math, Date, Map, Set, WeakSet, Array, Number, String, Boolean, Promise, logEvent, toast, render, esc, save, uid, localStorage, indexedDB, navigator, _charSig, openSettings, renderStats, openCat){ "use strict";\n' +
    renderCode + '\n})'
  ).runInNewContext(sandbox);
  renderCatBtns = fn(sandbox.S, sandbox.document, sandbox.window, sandbox.setTimeout, sandbox.clearTimeout, sandbox.Object, sandbox.console, sandbox.JSON, sandbox.Math, sandbox.Date, sandbox.Map, sandbox.Set, sandbox.WeakSet, sandbox.Array, sandbox.Number, sandbox.String, sandbox.Boolean, sandbox.Promise, sandbox.logEvent, sandbox.toast, sandbox.render, sandbox.esc, sandbox.save, sandbox.uid, sandbox.localStorage, sandbox.indexedDB, sandbox.navigator, sandbox._charSig, sandbox.openSettings, sandbox.renderStats, sandbox.openCat);
} catch (e) {
  console.error('[FAIL] VM sandbox error:', e.message);
  process.exit(1);
}

const rendered = renderCatBtns();

assert('VM render: exactly 3 class="catBtn"',
  (rendered.match(/class="catBtn"/g) || []).length === 3);

assert('VM render: exactly 3 class="catLabel"',
  (rendered.match(/class="catLabel"/g) || []).length === 3);

assert('VM render: exactly 3 class="catChev"',
  (rendered.match(/class="catChev"/g) || []).length === 3);

assert('VM render: 0 catCount',
  !rendered.includes('catCount'));

assert('VM render: includes "Appearance"',
  rendered.includes('Appearance'));

assert('VM render: includes "Interaction"',
  rendered.includes('Interaction'));

assert('VM render: includes "Activity Feed"',
  rendered.includes('Activity Feed'));

// =========================================================================
// Summary
// =========================================================================
if (failures > 0) {
  console.error('\n' + failures + ' test(s) failed');
  process.exit(1);
} else {
  console.log('\nAll settings-categories-ui tests passed!');
  process.exit(0);
}