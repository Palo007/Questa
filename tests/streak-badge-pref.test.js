// streak-badge-pref.test.js -- S.prefs.showStreaks gates the card streak badge
//
// Feature (2026-09-19): a display-only setting hides the gold "🔥 n" badge on
// daily cards. Streak VALUES are untouched — completeTask/uncompleteDaily/
// creditYesterday/runCron still read and write t.streak, and the Stats page
// still shows its "Top streaks" list. This test pins the display gate only.
//
// Verifies:
// 1. Behavioral: rail() omits `railItem streak` when S.prefs.showStreaks===false
// 2. Behavioral: rail() emits "🔥 5" when showStreaks===true
// 3. Behavioral: default-ON — a legacy state with no showStreaks key still shows
//    the badge (the `!== false` idiom, same as S.prefs.haptics)
// 4. Regression: hiding the streak does not disturb the other rail items
//    (difficulty badge, notdue badge, checklist subFrac) or habit counters
// 5. Structural: the wiring exists — freshState default, CATS.appearance entry,
//    openCat value read, setCatToggle dispatch, setShowStreaks setter
// 6. Structural: the gate is display-only — the streak write sites are NOT
//    guarded by showStreaks
//
// Strategy: anchor-extract rail() + esc() from the real app.js with
// tests/_extract.js (never hardcoded line ranges), eval in a vm with a stubbed
// S and stubbed date helpers, then inspect the returned HTML.
//
// Run: node tests/streak-badge-pref.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// =========================================================================
// Sandbox: real rail() + real esc(), stubbed collaborators
// =========================================================================
const railFn = extractFunction(appSrc, /^function rail\(t\)\{/, 'rail');
const escFn  = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');

// rail() calls these two only on the not-done/not-due-today branch. Returning
// "due today" keeps the notdue badge out of the way unless a test asks for it.
const stubs = [
  'var __notDue = false;',
  'function isDailyDueToday(t){ return !__notDue; }',
  'function nextDueWeekday(t){ return "Mon"; }',
  'var S = { prefs: {} };'
].join('\n');

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(stubs + '\n' + escFn + '\n' + railFn, sandbox);

function renderRail(prefs, task, notDue) {
  sandbox.S.prefs = prefs;
  sandbox.__notDue = !!notDue;
  return sandbox.rail(task);
}

const daily = { id: 't1', type: 'daily', difficulty: 'easy', streak: 5, done: false };

// =========================================================================
// 1-3. The gate itself
// =========================================================================
const offHtml = renderRail({ showStreaks: false }, daily);
assert('showStreaks=false -> no railItem streak span',
  !/railItem streak/.test(offHtml));
assert('showStreaks=false -> the number 5 is not on the card',
  !/🔥/.test(offHtml) && !/>5</.test(offHtml));

const onHtml = renderRail({ showStreaks: true }, daily);
assert('showStreaks=true -> railItem streak span present',
  /railItem streak/.test(onHtml));
assert('showStreaks=true -> shows the streak value 5',
  onHtml.includes('🔥 5'));

const legacyHtml = renderRail({}, daily);
assert('legacy state with no showStreaks key -> badge still shows (default ON)',
  /railItem streak/.test(legacyHtml) && legacyHtml.includes('🔥 5'));

const undefHtml = renderRail({ showStreaks: undefined }, daily);
assert('showStreaks=undefined -> badge still shows (!== false idiom)',
  /railItem streak/.test(undefHtml));

// =========================================================================
// 4. Regression: everything else in the rail is unaffected
// =========================================================================
assert('showStreaks=false -> difficulty badge still renders',
  /railItem diff-easy/.test(offHtml));
assert('showStreaks=false -> rail container still renders',
  offHtml.startsWith('<div class="rail">') && offHtml.endsWith('</div>'));

const withChecklist = Object.assign({}, daily, {
  checklist: [{ done: true }, { done: false }]
});
const clHtml = renderRail({ showStreaks: false }, withChecklist);
assert('showStreaks=false -> checklist subFrac still renders',
  /class="subFrac"/.test(clHtml) && /<b>1<\/b><i><\/i><b>2<\/b>/.test(clHtml));

const notDueHtml = renderRail({ showStreaks: false }, daily, true);
assert('showStreaks=false -> notdue badge still renders',
  /railItem notdue/.test(notDueHtml) && !/railItem streak/.test(notDueHtml));

const reminderHtml = renderRail({ showStreaks: false },
  Object.assign({}, daily, { reminders: [{ enabled: true }] }));
assert('showStreaks=false -> reminder bell still renders',
  /railItem bell/.test(reminderHtml));

const habitHtml = renderRail({ showStreaks: false },
  { id: 'h1', type: 'habit', difficulty: 'hard', cUp: 3, cDown: 1 });
assert('habit counters are untouched by showStreaks',
  /railItem cnt/.test(habitHtml) && habitHtml.includes('+3|−1'));

// =========================================================================
// 5. Structural: the wiring
// =========================================================================
assert('freshState prefs default has showStreaks:true',
  /prefs:\{[^\n]*showStreaks:true/.test(appSrc));

assert('CATS.appearance has a showStreaks toggle entry',
  /key: 'showStreaks', type: 'toggle'/.test(appSrc));

assert('openCat reads showStreaks with the default-ON !== false idiom',
  /s\.key === 'showStreaks'\) val = \(S\.prefs\.showStreaks !== false\)/.test(appSrc));

assert('setCatToggle dispatches showStreaks to setShowStreaks',
  /key === 'showStreaks'\) setShowStreaks\(/.test(appSrc));

const setter = extractFunction(appSrc, /^function setShowStreaks\(n\)\{/, 'setShowStreaks');
assert('setShowStreaks writes the pref, saves and re-renders',
  /S\.prefs\.showStreaks=!!n/.test(setter) && /save\(\)/.test(setter) && /render\(\)/.test(setter));

// Settings modal still has exactly 3 categories (settings-categories-ui.test.js
// asserts this too; repeated here so a future 4th category fails loudly in the
// test that added a toggle rather than only in an unrelated file).
assert('no 4th settings category was added',
  (appSrc.match(/<span class="catLabel">/g) || []).length === 3);

// =========================================================================
// 6. Structural: display-only -- the streak MATH is not gated
// =========================================================================
const streakWrites = (appSrc.match(/t\.streak\s*=/g) || []).length;
assert('streak write sites still exist (math untouched)', streakWrites >= 3);

assert('showStreaks appears only in display/settings code, never near a streak write',
  !/showStreaks[\s\S]{0,200}?t\.streak\s*=\s*\(?t\.streak/.test(appSrc));

assert('the Stats page streak leaderboard is not gated by showStreaks',
  /anStreaks\(\)/.test(appSrc) && !/showStreaks[^\n]*anStreaks/.test(appSrc));

// sync.js must NOT start syncing this device-local display pref.
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
assert('showStreaks is not added to sync.js (stays device-local)',
  !/showStreaks/.test(syncSrc));

// =========================================================================
// Summary
// =========================================================================
if (failures > 0) {
  console.error('\n' + failures + ' test(s) failed');
  process.exit(1);
} else {
  console.log('\nAll streak-badge-pref tests passed!');
  process.exit(0);
}
