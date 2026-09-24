// morning-rollover-contract.test.js -- todo 6 (morning-rollover ship-integrity):
// single contract file pinning every wave-1 seam by ANCHOR (tests/_extract.js),
// never by hardcoded line numbers, never by loading the whole browser app.
//
// Pins:
//   S1 sync.js durable-reconcile boot gate (BEGIN/END_BOOT_GATE markers +
//      reconcileDurableState().then(syncInit).catch(syncInit) shape)
//   S2 sync.js guarded 2-second onQuestaFirstSyncRound callback (typeof guard,
//      both-handlers .then(fire, fire), 2000 ms timer inside syncInit)
//   A1 app.js boot exits route through _runDayRollover(); no direct startDay()
//      on boot paths (bootStartDay + onQuestaFirstSyncRound contain no
//      startDay() call; _runDayRollover contains exactly one)
//   A2 commitYesterCheck() contains save() before runCron() (ordered index
//      check on comment-stripped body)
//   A3 _runDayRollover() calls startDay() before the guarded quick-log drain
//      (ordered index check; drain is typeof-guarded + try/caught)
//   A4 render() still exposes the gate banner (_bootGateBanner() in the single
//      v.innerHTML assignment) and the body bootSyncing class toggle
//   H1 index.html contains the body.bootSyncing .task CSS hook
//   H2 index.html has exactly one app.js script followed by one sync.js script
//      and ends with </body></html>
//   R1 tests/run.js requires assertion evidence ([PASS]/bare PASS), not exit
//      code alone
//   V1 APP_VERSION format vYYYY.MM.DD-HHMM (v2026.09.24-1221 or later --
//      bumped by todo 5; later features bump again)
//   V2 sw.js CACHE is questa-v238 or later (bumped by todo 5)
//
// Run: node tests/morning-rollover-contract.test.js (also run by node tests/run.js)

const fs = require('fs'), path = require('path');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const runSrc = fs.readFileSync(path.join(__dirname, './run.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function grab(fn, label) {
  try { return fn(); }
  catch (e) { assert('extract ' + label + ' from source (' + (e && e.message) + ')', false); return null; }
}
const stripComments = s => s.replace(/\/\/[^\n\r]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- anchor extraction (every seam pinned by declaration text) ----
const P = {
  commit: grab(() => extractFunction(appSrc, /^function commitYesterCheck\(\)\{/, 'commitYesterCheck'), 'commitYesterCheck'),
  runner: grab(() => extractFunction(appSrc, /^function _runDayRollover\(\)\{/, '_runDayRollover'), '_runDayRollover'),
  firstRound: grab(() => extractFunction(appSrc, /^function onQuestaFirstSyncRound\(\)\{/, 'onQuestaFirstSyncRound'), 'onQuestaFirstSyncRound'),
  bootStartDay: grab(() => extractFunction(appSrc, /^function bootStartDay\(\)\{/, 'bootStartDay'), 'bootStartDay'),
  render: grab(() => extractFunction(appSrc, /^function render\(\)\{/, 'render'), 'render'),
  syncInit: grab(() => extractFunction(syncSrc, /^function syncInit\(\)\{/, 'syncInit'), 'syncInit'),
};

if (Object.keys(P).some(k => P[k] === null)) {
  console.error('\nFAILED: ' + failures + ' assertion(s) -- contract symbols missing');
  process.exit(1);
}

// ============ S1: sync.js durable-reconcile boot gate ============
{
  assert('S1a sync.js carries the BEGIN/END_BOOT_GATE markers',
    syncSrc.indexOf('/* BEGIN_BOOT_GATE */') !== -1 && syncSrc.indexOf('/* END_BOOT_GATE */') !== -1);
  const gateBlock = (syncSrc.match(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//) || [''])[0];
  assert('S1b boot gate waits for reconcileDurableState before syncInit (both arms)',
    /typeof\s+reconcileDurableState\s*===\s*["']function["']/.test(gateBlock) &&
    /reconcileDurableState\(\)\.then\(syncInit\)\.catch\(syncInit\)/.test(gateBlock));
  assert('S1c boot gate falls back to syncInit() when reconcile is absent',
    /else\s*\{\s*\n?\s*syncInit\(\);/.test(gateBlock));
}

// ============ S2: guarded 2-second onQuestaFirstSyncRound callback ============
{
  const body = stripComments(P.syncInit);
  assert('S2a syncInit schedules exactly one 2000 ms boot timer',
    (body.match(/,\s*2000\s*\)/g) || []).length === 1);
  assert('S2b sync.js guards the callback with typeof === "function"',
    /typeof\s+onQuestaFirstSyncRound\s*===\s*["']function["']/.test(syncSrc));
  assert('S2c the fire is attached as BOTH promise handlers (.then(fire, fire))',
    /\.then\(\s*fire\s*,\s*fire\s*\)/.test(syncSrc));
  assert('S2d the fire is try/caught so a broken app.js never breaks sync.js',
    /try\s*\{\s*if\s*\(\s*typeof\s+onQuestaFirstSyncRound/.test(syncSrc));
  assert('S2e the guarded callback lives inside the 2000 ms timer in syncInit',
    /setTimeout\(\(\)\s*=>\s*\{[\s\S]*?onQuestaFirstSyncRound[\s\S]*?\},\s*2000\)/.test(P.syncInit));
}

// ============ A1: boot exits route through _runDayRollover() ============
{
  const bootBare = stripComments(P.bootStartDay);
  const firstBare = stripComments(P.firstRound);
  const runnerBare = stripComments(P.runner);
  assert('A1a bootStartDay() reaches the runner on every branch',
    (bootBare.match(/_runDayRollover/g) || []).length >= 3);
  assert('A1b bootStartDay() never calls startDay() directly -- only via the runner',
    !/(?<![A-Za-z_$])startDay\(\)/.test(bootBare));
  assert('A1c onQuestaFirstSyncRound() routes through the runner (no direct startDay())',
    /_runDayRollover\(\)/.test(firstBare) && !/(?<![A-Za-z_$])startDay\(\)/.test(firstBare));
  assert('A1d the runner calls startDay() exactly once',
    (runnerBare.match(/(?<![A-Za-z_$])startDay\(\)/g) || []).length === 1);
  const appBare = stripComments(appSrc);
  assert('A1e no top-level startDay(); boot call remains',
    (appBare.match(/^startDay\(\);/gm) || []).length === 0);
}

// ============ A2: commitYesterCheck() save() before runCron() ============
{
  const body = stripComments(P.commit);
  const saveIdx = body.search(/(?<![A-Za-z_$])save\(\)/);
  const cronIdx = body.search(/(?<![A-Za-z_$])runCron\(\)/);
  assert('A2a commitYesterCheck() calls save()', saveIdx !== -1);
  assert('A2b commitYesterCheck() calls runCron()', cronIdx !== -1);
  assert('A2c commitYesterCheck() persists before finalizing (save() precedes runCron())',
    saveIdx !== -1 && cronIdx !== -1 && saveIdx < cronIdx);
}

// ============ A3: runner startDay() before guarded quick-log drain ============
{
  const body = stripComments(P.runner);
  const startIdx = body.search(/(?<![A-Za-z_$])startDay\(\)/);
  const drainIdx = body.search(/_drainPendingQuickLog/);
  assert('A3a _runDayRollover() calls startDay()', startIdx !== -1);
  assert('A3b _runDayRollover() drains the stashed quick-log', drainIdx !== -1);
  assert('A3c drain runs AFTER startDay() (deep-link log applies on post-rollover state)',
    startIdx !== -1 && drainIdx !== -1 && startIdx < drainIdx);
  assert('A3d drain is typeof-guarded so a missing quick-log build never breaks boot',
    /typeof\s+_drainPendingQuickLog\s*===\s*["']function["']/.test(P.runner));
  assert('A3e drain is try/caught (a throwing drain never blocks the gate release)',
    /try\s*\{\s*if\s*\(\s*typeof\s+_drainPendingQuickLog/.test(P.runner));
}

// ============ A4: render() gate banner + body class ============
{
  const body = stripComments(P.render);
  assert('A4a render() prepends the gate banner at its single v.innerHTML assignment',
    /v\.innerHTML\s*=\s*_bootGateBanner\(\)/.test(body));
  assert('A4b render() toggles the body bootSyncing class from _bootRolloverPending',
    /classList\.toggle\(\s*['"]bootSyncing['"]\s*,\s*_bootRolloverPending\s*\)/.test(body));
}

// ============ H1/H2: index.html hooks ============
{
  assert('H1 index.html contains the body.bootSyncing .task CSS hook',
    /body\.bootSyncing\s+\.task\s*\{[^}]*pointer-events\s*:\s*none/.test(htmlSrc));
  const scripts = htmlSrc.match(/<script\s+src="[^"]*"><\/script>/g) || [];
  assert('H2a index.html has exactly two shipped scripts (app.js then sync.js)',
    scripts.length === 2 &&
    scripts[0] === '<script src="app.js"></script>' &&
    scripts[1] === '<script src="sync.js"></script>');
  assert('H2b app.js script precedes sync.js script (boot order: app runs first)',
    htmlSrc.indexOf('<script src="app.js"></script>') !== -1 &&
    htmlSrc.indexOf('<script src="app.js"></script>') < htmlSrc.indexOf('<script src="sync.js"></script>'));
  assert('H2c index.html ends with </body></html>',
    htmlSrc.trim().replace(/\r\n/g, '\n').endsWith('</body>\n</html>') ||
    htmlSrc.trim().replace(/\r\n/g, '\n').endsWith('</body></html>'));
}

// ============ R1: run.js demands assertion evidence ============
{
  assert('R1a tests/run.js requires [PASS]/PASS evidence, not exit code alone',
    /\[PASS\]/.test(runSrc) && /\^PASS/.test(runSrc));
  assert('R1b tests/run.js fails a file that ran zero assertions',
    /no assertions ran/.test(runSrc));
  assert('R1c tests/run.js still gates on ALL TEST FILES PASSED',
    /ALL TEST FILES PASSED/.test(runSrc));
}

// ============ V1/V2: version pins (todo 5 already bumped -- DO NOT bump) ============
{
  const ver = (appSrc.match(/const APP_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '';
  assert('V1a APP_VERSION has format vYYYY.MM.DD-HHMM (got "' + ver + '")',
    /^v\d{4}\.\d{2}\.\d{2}-\d{4}$/.test(ver));
  // 2026-09-24: relaxed from an exact pin to "todo-5 stamp or later". The exact pin
  // guarded this plan's own steps against a double-bump; the next feature
  // (new-day reload + refresh button) MUST bump again per AGENTS.md section 3, and an
  // exact pin would turn that mandatory bump into a red suite. Going BACKWARDS is
  // still caught.
  assert('V1b APP_VERSION is the todo-5 stamp v2026.09.24-1221 or later (got "' + ver + '")',
    ver >= 'v2026.09.24-1221');
  const cache = (swSrc.match(/const CACHE\s*=\s*"([^"]+)"/) || [])[1] || '';
  const cacheN = parseInt((cache.match(/^questa-v(\d+)$/) || [])[1] || '0', 10);
  assert('V2 sw.js CACHE is questa-v238 or later (got "' + cache + '")',
    cacheN >= 238);
}

// ============ summary ============
if (failures) {
  console.error('\nFAILED: ' + failures + ' morning-rollover-contract assertion(s)');
  process.exit(1);
}
console.log('\nALL MORNING-ROLLOVER-CONTRACT TESTS PASSED');
process.exit(0);
