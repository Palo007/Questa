// new-day-reload.test.js -- 2026-09-24: a TWA kept in memory overnight must show the
// morning screen when it is brought back after midnight, and the header refresh
// button must save and reload.
//
// The day rollover runs once per page load (_runDayRollover is once-only), so the fix
// reloads the page on a foregrounding that crosses a local-day boundary instead of
// re-entering startDay() in a live page.
//
//   R1  shouldReloadForNewDay: a later local day reloads
//   R2  same day does not reload
//   R3  clock rewind (earlier day) does not reload -- matches runCron's `<=` guard
//   R4  an open sheet defers the reload (unsaved edit-sheet typing is kept)
//   R5  reloadApp('newDay') saves BEFORE it reloads, and reloads exactly once
//   R6  reloadApp('button') asks the service worker for an update, then reloads once
//   R7  reloadApp('button') still reloads when the SW update never settles (3 s cap)
//   R8  wiring: index.html has the refresh button beside the gear, calling reloadApp
//   R9  wiring: a visibilitychange listener calls shouldReloadForNewDay -> reloadApp
//
// Run: node tests/new-day-reload.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name); }
}

const shouldFn = extractFunction(appSrc, /^function shouldReloadForNewDay\(/, 'shouldReloadForNewDay');
const reloadFn = extractFunction(appSrc, /^function reloadApp\(/, 'reloadApp');

// --- R1-R4: pure decision ---------------------------------------------------
const pure = {};
vm.createContext(pure);
vm.runInContext(shouldFn, pure);
ok(pure.shouldReloadForNewDay(20260923, 20260924, false) === true,  'R1 next local day reloads');
ok(pure.shouldReloadForNewDay(20260924, 20260924, false) === false, 'R2 same day does not reload');
ok(pure.shouldReloadForNewDay(20260924, 20260923, false) === false, 'R3 clock rewind does not reload');
ok(pure.shouldReloadForNewDay(20260923, 20260924, true)  === false, 'R4 open sheet defers the reload');

// --- R5-R7: reloadApp with a recorded boundary --------------------------------
function makeCtx(swMode){
  const log = [];
  const timers = [];
  const ctx = {
    log,
    timers,
    saveScroll(){ log.push('saveScroll'); },
    save(){ log.push('save'); },
    logEvent(){},
    location: { reload(){ log.push('reload'); } },
    setTimeout(fn, ms){ timers.push({ fn, ms }); return timers.length; },
    navigator: {},
  };
  if(swMode){
    ctx.navigator.serviceWorker = {
      getRegistration(){
        log.push('getRegistration');
        return Promise.resolve({ update(){
          log.push('update');
          return swMode === 'hang' ? new Promise(() => {}) : Promise.resolve();
        } });
      },
    };
  }
  vm.createContext(ctx);
  vm.runInContext(reloadFn, ctx);
  return ctx;
}

(async function(){
  const c5 = makeCtx(null);
  c5.reloadApp('newDay');
  ok(c5.log.join(',') === 'saveScroll,save,reload', 'R5 newDay: saves then reloads once (got ' + c5.log.join(',') + ')');

  const c6 = makeCtx('ok');
  c6.reloadApp('button');
  await new Promise(r => setImmediate(r));
  c6.timers.forEach(t => t.fn()); // the 3 s cap fires late: must be a no-op now
  const reloads6 = c6.log.filter(x => x === 'reload').length;
  ok(c6.log.indexOf('save') >= 0 && c6.log.indexOf('save') < c6.log.indexOf('update'), 'R6a button: saves before the SW update check');
  ok(c6.log.indexOf('update') >= 0 && c6.log.indexOf('update') < c6.log.indexOf('reload'), 'R6b button: SW update requested before reload');
  ok(reloads6 === 1, 'R6c button: exactly one reload even when the cap timer also fires (got ' + reloads6 + ')');

  const c7 = makeCtx('hang');
  c7.reloadApp('button');
  await new Promise(r => setImmediate(r));
  ok(c7.log.indexOf('reload') === -1, 'R7a hung SW update: no reload before the cap');
  const cap = c7.timers.find(t => t.ms === 3000);
  ok(!!cap, 'R7b a 3000 ms cap timer is scheduled');
  if(cap) cap.fn();
  ok(c7.log.filter(x => x === 'reload').length === 1, 'R7c hung SW update: the cap reloads once');

  // --- R8-R9: wiring ----------------------------------------------------------
  const refreshIdx = htmlSrc.indexOf('id="refreshBtn"');
  const gearIdx = htmlSrc.indexOf('id="gearBtn"');
  ok(refreshIdx > 0 && gearIdx > refreshIdx && gearIdx - refreshIdx < 200, 'R8a refresh button sits right before the gear');
  ok(/id="refreshBtn"[^>]*onclick="reloadApp\('button'\)"/.test(htmlSrc), "R8b refresh button calls reloadApp('button')");
  ok(/#gearBtn,#refreshBtn\{/.test(htmlSrc), 'R8c refresh button shares the gear styling');
  ok(/document\.addEventListener\('visibilitychange'[\s\S]{0,300}shouldReloadForNewDay\(_loadDayStamp, dayStamp\(new Date\(\)\)[\s\S]{0,120}reloadApp\('newDay'\)/.test(appSrc),
     'R9 visibilitychange listener checks the day and calls reloadApp');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
