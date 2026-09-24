// quick-log-removed.test.js -- the web quick log was removed on 2026-09-24.
// Replaces quick-log-deeplink.test.js. Checks: the ?quick= sheet/links, the Options
// link panel and the manifest "Quick log" shortcut are gone; the ?tab= deep link
// (manifest Habits/Dailies shortcuts) still works; the Android inbox helpers stay.
//
// Run: node tests/quick-log-removed.test.js  (also run by node tests/run.js)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readSource, extractFunction } = require('./_extract.js');

const src = readSource(path.join(__dirname, '../app.js'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));

let fails = 0;
function assert(d, c) { if (c) console.log('[PASS] ' + d); else { console.error('[FAIL] ' + d); fails++; } }

// R1: removed web quick-log symbols are gone from app.js.
['parseQuickParams', 'applyQuickIntent', 'drawQuickSheet', 'buildQuickUrl', 'quickLogHabits',
 'quickLogDedupe', '_pendingQuickLog', '_drainPendingQuickLog', 'quickCopyLink', 'quickShareLink', 'toastAction']
  .forEach(n => assert('R1 app.js no longer has ' + n, !new RegExp('\\b' + n + '\\b').test(src)));

// R2: the Options "Home-screen quick log" panel is gone.
assert('R2a CATS has no quicklog setting', !/key:\s*'quicklog'/.test(src));
assert('R2b openOpt has no quicklog branch', !/key===\s*'quicklog'/.test(src));

// R3: manifest keeps Habits/Dailies, drops Quick log.
const urls = (manifest.shortcuts || []).map(s => s.url);
assert('R3a manifest has no ?quick= shortcut', urls.every(u => !/[?&]quick=/.test(u)));
assert('R3b manifest keeps ?tab=habits and ?tab=dailies', urls.includes('./?tab=habits') && urls.includes('./?tab=dailies'));

// R4: parseTabParam unit contract (real function from app.js).
const sb = { URLSearchParams, TABS: ['habits', 'dailies', 'todos', 'analytics', 'rewards'] };
vm.createContext(sb);
vm.runInContext(extractFunction(src, /^function parseTabParam\(search\)\{/, 'parseTabParam') + '; this.parseTabParam=parseTabParam;', sb);
assert('R4a ?tab=habits -> habits', sb.parseTabParam('?tab=habits') === 'habits');
assert('R4b unknown tab -> null', sb.parseTabParam('?tab=bogus') === null);
assert('R4c old ?quick=today -> null (opens the app normally)', sb.parseTabParam('?quick=today') === null);
assert('R4d Dropbox OAuth ?code= is never a tab link', sb.parseTabParam('?code=abc&tab=habits') === null);
assert('R4e empty search -> null', sb.parseTabParam('') === null);

// R5: boot applies the tab link; inbox helpers the Android app depends on stay.
assert('R5a boot calls parseTabParam(location.search)', /parseTabParam\(location\.search\)/.test(src));
assert('R5b quickLogTargetOk kept (applyInboxLog uses it)', /^function quickLogTargetOk\(t, dir\)\{/m.test(src));
assert('R5c applyInboxLog kept', /^function applyInboxLog\(rec, nowMs\)\{/m.test(src));
assert('R5d habit edit sheet keeps the quickLog tick (Android shortcuts)', /id="eQuickLog"/.test(src) && /EDIT\.quickLog=this\.checked/.test(src));

if (fails) { console.error('quick-log-removed: ' + fails + ' assertion(s) failed'); process.exit(1); }
console.log('All quick-log-removed tests passed!');
