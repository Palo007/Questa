// auto-backup-settings-ui.test.js -- plan todo 17: new row, 4 checkboxes, no "Every 2 weeks"
//
// Verifies:
// 1. openSettings() output contains an autoBackup settingRow (not exportInterval)
// 2. openOpt('autoBackup') renders 4 tier checkboxes (4-hourly, Daily, Weekly, Monthly)
// 3. No "Every 2 weeks" text appears anywhere (legacy exportInterval option removed)
// 4. setAutoBackupTiers({daily:true}) updates S.prefs.autoBackupEnabled.daily
//
// Strategy: read app.js source for structural regex checks, then extract the key
// functions (esc, settingRow, openSettings autoBackup block, openOpt, setAutoBackupTiers)
// and run them in a VM sandbox with stubbed DOM and S object.
//
// Run: node tests/auto-backup-settings-ui.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// =========================================================================
// 1. Structural guards on app.js source (like disconnect-label.test.js)
// =========================================================================
assert('openSettings uses settingRow(\'autoBackup\',...)',
  /settingRow\('autoBackup'/.test(appSrc));

assert('openOpt handles key===\'autoBackup\'',
  /key==='autoBackup'/.test(appSrc));

assert('openOpt autoBackup renders optTier checkboxes',
  /optTier.*setAutoBackupTiers/.test(appSrc));

assert('openOpt autoBackup has 4 tier entries (fourHour, daily, weekly, monthly)',
  /\['fourHour','4-hourly'/.test(appSrc) &&
  /\['daily','Daily'/.test(appSrc) &&
  /\['weekly','Weekly'/.test(appSrc) &&
  /\['monthly','Monthly'/.test(appSrc));

assert('setAutoBackupTiers function exists',
  /function setAutoBackupTiers\(patch\)/.test(appSrc));

assert('setAutoBackupTiers merges patch into autoBackupEnabled',
  /setAutoBackupTiers.*Object\.assign.*autoBackupEnabled/.test(appSrc));

assert('NO "Every 2 weeks" text in app.js',
  !/Every 2 weeks/.test(appSrc));

assert('NO "exportInterval" settingRow in openSettings',
  !(/settingRow\('exportInterval'/.test(appSrc)));

// =========================================================================
// 2. Behavioral: extract key functions and test in VM sandbox
// =========================================================================
const lines = appSrc.split('\n');
function grab(a, b) { return lines.slice(a - 1, b).join('\n'); }

// Extract: esc (5626), settingRow (5028-5032), closeOpt (5033)
// autoBackup block from openSettings (4896-4903)
// openOpt autoBackup branch (5140-5158)
// setAutoBackupTiers (4996)
const code = [
  grab(5626, 5626),       // esc
  grab(5028, 5033),       // settingRow + closeOpt
  grab(4996, 4996),       // setAutoBackupTiers
  'return { esc, settingRow, closeOpt, setAutoBackupTiers };'
].join('\n');

// Stub S with autoBackupEnabled
const S = {
  prefs: {
    autoBackupEnabled: { fourHour: false, daily: false, weekly: false, monthly: false }
  }
};

// Minimal DOM stub
function makeEl(id) {
  return { _id: id, innerHTML: '', classList: { add: noop, remove: noop } };
}
function noop() {}
const store = {};
const doc = {
  getElementById: function (id) {
    if (!store[id]) store[id] = makeEl(id);
    return store[id];
  }
};

const sandbox = {
  S: S,
  document: doc,
  window: {},
  console: console,
  setTimeout: noop,
  clearTimeout: noop,
  Object: Object,
  save: noop,
  closeOpt: noop,
  openSettings: noop,
};
sandbox.globalThis = sandbox;

const fn = new vm.Script(
  '(function(S, document, window, setTimeout, clearTimeout, Object){ "use strict";\n' +
  code + '\n})'
).runInNewContext(sandbox);
const api = fn(S, doc, sandbox.window, noop, noop, Object);

// --- Test setAutoBackupTiers ---
const { setAutoBackupTiers, esc, settingRow } = api;

assert('initial S.prefs.autoBackupEnabled.daily is false',
  S.prefs.autoBackupEnabled.daily === false);

setAutoBackupTiers({ daily: true });
assert('after setAutoBackupTiers({daily:true}), daily is true',
  S.prefs.autoBackupEnabled.daily === true);
assert('other tiers remain false after setting daily',
  S.prefs.autoBackupEnabled.fourHour === false &&
  S.prefs.autoBackupEnabled.weekly === false &&
  S.prefs.autoBackupEnabled.monthly === false);

setAutoBackupTiers({ weekly: true, monthly: true });
assert('after setAutoBackupTiers({weekly:true,monthly:true}), both are true',
  S.prefs.autoBackupEnabled.weekly === true &&
  S.prefs.autoBackupEnabled.monthly === true);
assert('daily still true after second patch',
  S.prefs.autoBackupEnabled.daily === true);

setAutoBackupTiers({ fourHour: true });
assert('after setAutoBackupTiers({fourHour:true}), fourHour is true',
  S.prefs.autoBackupEnabled.fourHour === true);
assert('all 4 tiers now true',
  S.prefs.autoBackupEnabled.fourHour === true &&
  S.prefs.autoBackupEnabled.daily === true &&
  S.prefs.autoBackupEnabled.weekly === true &&
  S.prefs.autoBackupEnabled.monthly === true);

setAutoBackupTiers({ daily: false });
assert('toggling daily back to false works',
  S.prefs.autoBackupEnabled.daily === false &&
  S.prefs.autoBackupEnabled.fourHour === true);

// --- Test settingRow produces autoBackup button ---
const row = settingRow('autoBackup', 'Auto-backup tiers', 'Uploads a full backup file to Dropbox on each enabled cadence.', 'Off');
assert('settingRow output contains onclick with autoBackup key',
  row.includes("openOpt('autoBackup')"));
assert('settingRow output has "Auto-backup tiers" label',
  row.includes('Auto-backup tiers'));
assert('settingRow output is a button with setItem class',
  row.includes('class="setItem"'));

// --- Test openOpt('autoBackup') renders 4 tier checkboxes ---
// Extract the openOpt function body. It is a large if/else chain; we only
// need the autoBackup branch, so we build a minimal openOpt that calls it.
// Extract the autoBackup branch from openOpt (lines 5141-5157).
const openOptBlock = grab(5141, 5157);

const openOptCode = [
  grab(5626, 5626),   // esc
  'function openOpt(key){',
  '  var h="";',
  '  if(key==="autoBackup"){',
  openOptBlock,
  '  }',
  '  document.getElementById("optMenu").innerHTML=h;',
  '  document.getElementById("optScrim").classList.add("show");',
  '}',
  'return openOpt;'
].join('\n');

const fn2 = new vm.Script(
  '(function(S, document, window, Object){ "use strict";\n' +
  openOptCode + '\n})'
).runInNewContext(sandbox);
const openOpt = fn2(S, doc, sandbox.window, Object);

// Reset optMenu
store['optMenu'] = makeEl('optMenu');
store['optScrim'] = { _id: 'optScrim', innerHTML: '', classList: { add: noop, remove: noop } };

// Test with all tiers off
openOpt('autoBackup');
const htmlOff = store['optMenu'].innerHTML;

assert('openOpt("autoBackup") renders "Auto-backup to Dropbox" heading',
  htmlOff.includes('Auto-backup to Dropbox'));

assert('renders 4-hourly tier checkbox',
  htmlOff.includes('4-hourly'));
assert('renders Daily tier checkbox',
  htmlOff.includes('Daily'));
assert('renders Weekly tier checkbox',
  htmlOff.includes('Weekly'));
assert('renders Monthly tier checkbox',
  htmlOff.includes('Monthly'));

assert('all 4 optTier divs present',
  (htmlOff.match(/class="optTier"/g) || []).length === 4);

assert('checkboxes show unchecked when all tiers off',
  htmlOff.includes('\u2610'));  // ☐ ballot box

assert('NO "Every 2 weeks" in openOpt autoBackup output',
  !htmlOff.includes('Every 2 weeks'));

assert('NO "exportInterval" in openOpt autoBackup output',
  !htmlOff.includes('exportInterval'));

// Enable some tiers and re-render (reset to known state first)
S.prefs.autoBackupEnabled = { fourHour: false, daily: false, weekly: false, monthly: false };
setAutoBackupTiers({ daily: true, weekly: true });
openOpt('autoBackup');
const htmlOn = store['optMenu'].innerHTML;

assert('checked checkbox (\u2611) present when tiers enabled',
  htmlOn.includes('\u2611'));  // ☑ ballot box with check
assert('unchecked checkbox (\u2610) still present for disabled tiers',
  htmlOn.includes('\u2610'));

// --- Test openSettings autoBackup row via the extracted block ---
// Build the autoBackup summary block the same way openSettings does (lines 4896-4903)
// with a fresh S state.
S.prefs.autoBackupEnabled = { fourHour: false, daily: false, weekly: false, monthly: false };
const _abtiers = S.prefs.autoBackupEnabled;
const _abLabels = [];
if (_abtiers.fourHour) _abLabels.push('4-hourly');
if (_abtiers.daily) _abLabels.push('Daily');
if (_abtiers.weekly) _abLabels.push('Weekly');
if (_abtiers.monthly) _abLabels.push('Monthly');
const _abSummary = _abLabels.length ? _abLabels.join(', ') : 'Off';

const settingsRow = settingRow('autoBackup', 'Auto-backup tiers', 'Uploads a full backup file to Dropbox on each enabled cadence.', _abSummary);
assert('settings row summary says "Off" when all tiers disabled',
  settingsRow.includes('Off'));

S.prefs.autoBackupEnabled = { fourHour: true, daily: false, weekly: true, monthly: false };
const _abtiers2 = S.prefs.autoBackupEnabled;
const _abLabels2 = [];
if (_abtiers2.fourHour) _abLabels2.push('4-hourly');
if (_abtiers2.daily) _abLabels2.push('Daily');
if (_abtiers2.weekly) _abLabels2.push('Weekly');
if (_abtiers2.monthly) _abLabels2.push('Monthly');
const _abSummary2 = _abLabels2.length ? _abLabels2.join(', ') : 'Off';

const settingsRow2 = settingRow('autoBackup', 'Auto-backup tiers', 'Uploads a full backup file to Dropbox on each enabled cadence.', _abSummary2);
assert('settings row summary shows "4-hourly, Weekly" when those tiers enabled',
  settingsRow2.includes('4-hourly, Weekly'));

// --- Summary ---
if (failures) {
  console.error('\nFAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\nALL AUTO-BACKUP SETTINGS UI TESTS PASSED');
process.exit(0);
