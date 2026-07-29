// archive/tests/lifecycle-event-filter-tests.js — run: node archive/tests/lifecycle-event-filter-tests.js
// Regression tests for the 2026-07-11 lifecycle-log-spam fix: Phase C's
// diagnostic 'lifecycle' events (see .omo/plans/2026-07-11-persistence-loss-fix-plan.md)
// leaked into the user-facing Activity Feed ("System action" rows) and would
// have synced to Dropbox, spamming every device. Fix: getEvents() excludes
// kind:'lifecycle' by default; evtUploadable/evtOwnMonthRecords/evtIncomingFilter
// exclude it from the Dropbox event-log channel; clearLifecycleEvents() purges
// any already-written ones; save() no longer logs on every call (the actual
// volume source -- it fires on a 400ms-debounced scroll-driven save() too).
const fs = require('fs'), path = require('path');

const appCode = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
const eventsMatch = appCode.match(/\/\* BEGIN_EVENTS_HELPERS \*\/([\s\S]*?)\/\* END_EVENTS_HELPERS \*\//);
if(!eventsMatch){ console.error('FAIL: could not find BEGIN/END_EVENTS_HELPERS block in app.js'); process.exit(1); }
const durableMatch = appCode.match(/\/\* BEGIN_DURABLE_STATE_HELPERS \*\/([\s\S]*?)\/\* END_DURABLE_STATE_HELPERS \*\//);
if(!durableMatch){ console.error('FAIL: could not find BEGIN/END_DURABLE_STATE_HELPERS block in app.js'); process.exit(1); }

const syncCode = fs.readFileSync(path.join(__dirname, '..', '..', 'sync.js'), 'utf8');
const evtsyncMatch = syncCode.match(/\/\* BEGIN_EVTSYNC_HELPERS \*\/([\s\S]*?)\/\* END_EVTSYNC_HELPERS \*\//);
if(!evtsyncMatch){ console.error('FAIL: could not find BEGIN/END_EVTSYNC_HELPERS block in sync.js'); process.exit(1); }

let fails = 0;
function assert(name, cond){
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if(!cond) fails++;
}

// ---- fake IndexedDB shared by the getEvents()/clearLifecycleEvents() tests.
// Minimal cursor + "ts" index support (getEvents ranges over the ts index;
// clearSyntheticEvents/clearLifecycleEvents do a plain unindexed cursor).
function makeFakeDb(records){
  // records: array of {id, ...fields}, already sorted by ts for simplicity.
  // Iteration walks a fixed SNAPSHOT (so an in-loop delete() can't shift
  // indices out from under the cursor); delete() removes from the live
  // `records` array by identity so the caller observes the mutation. When a
  // `tx` is supplied, oncomplete fires exactly when iteration naturally ends
  // (cursor result null) -- deterministic, no arbitrary timing budget.
  function makeCursor(liveArr, tx){
    const snapshot = liveArr.slice();
    let i = 0;
    const req = { result: null, onsuccess: null, onerror: null };
    function step(){
      if(i >= snapshot.length){
        req.result = null;
        if(req.onsuccess) req.onsuccess();
        if(tx && tx.oncomplete) tx.oncomplete();
        return;
      }
      const rec = snapshot[i];
      req.result = {
        value: rec,
        continue(){ i++; setTimeout(step, 0); },
        delete(){ const idx = liveArr.indexOf(rec); if(idx >= 0) liveArr.splice(idx, 1); }
      };
      if(req.onsuccess) req.onsuccess();
    }
    setTimeout(step, 0);
    return req;
  }
  return {
    transaction(){
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = function(){
        return {
          index(){ return { openCursor(){ return makeCursor(records.slice(), null); } }; }, // getEvents() has no oncomplete dependency
          openCursor(){ return makeCursor(records, tx); } // mutated in place so deletes stick; drives tx.oncomplete
        };
      };
      return tx;
    }
  };
}

function loadEventsHelpers(records){
  const db = makeFakeDb(records);
  const body =
    'const EVENTS_STORE = "events";\n' +
    'const idbOpen = () => Promise.resolve(globals.db);\n' +
    'const IDBKeyRange = { bound: () => null, lowerBound: () => null, upperBound: () => null };\n' +
    eventsMatch[1] + '\n' +
    'return { getEvents, clearSyntheticEvents, clearLifecycleEvents };';
  const fn = new Function('globals', body);
  return fn({ db });
}

(async function(){

  // ---- T1: getEvents() excludes kind:'lifecycle' by default. --------------
  {
    const records = [
      { id: 1, ts: 100, kind: 'habitTap', taskId: 'h1' },
      { id: 2, ts: 200, kind: 'lifecycle', detail: 'flushState' },
      { id: 3, ts: 300, kind: 'complete', taskId: 't1' }
    ];
    const helpers = loadEventsHelpers(records);
    const all = await helpers.getEvents({});
    assert('T1 getEvents() with no kind filter excludes lifecycle events', all.length === 2 && !all.some(e => e.kind === 'lifecycle'));
  }

  // ---- T2: getEvents({kind:'lifecycle'}) explicitly still returns them
  // (opt-in path, e.g. a future diagnostics view). ---------------------------
  {
    const records = [
      { id: 1, ts: 100, kind: 'habitTap', taskId: 'h1' },
      { id: 2, ts: 200, kind: 'lifecycle', detail: 'flushState' }
    ];
    const helpers = loadEventsHelpers(records);
    const only = await helpers.getEvents({ kind: 'lifecycle' });
    assert('T2 getEvents({kind:"lifecycle"}) explicitly opts back in', only.length === 1 && only[0].detail === 'flushState');
  }

  // ---- T3: clearLifecycleEvents() removes only lifecycle-kind records,
  // leaves everything else untouched. ----------------------------------------
  {
    const records = [
      { id: 1, ts: 100, kind: 'habitTap' },
      { id: 2, ts: 200, kind: 'lifecycle' },
      { id: 3, ts: 300, kind: 'lifecycle' },
      { id: 4, ts: 400, kind: 'complete' }
    ];
    const helpers = loadEventsHelpers(records);
    const removed = await helpers.clearLifecycleEvents();
    assert('T3a clearLifecycleEvents() reports 2 removed', removed === 2);
    assert('T3b non-lifecycle records survive', records.length === 2 && records.every(r => r.kind !== 'lifecycle'));
  }

  // ---- T4: save() no longer calls logEvent at all (the actual spam source --
  // save() fires on nearly every interaction, including a debounced
  // scroll-driven save()). ----------------------------------------------------
  {
    let logCalls = 0;
    const body =
      'let S = globals.S;\n' +
      'let IS_DIRTY = false;\n' +
      'const STORE_KEY = "questa.save.v1";\n' +
      'const localStorage = { _m:{}, getItem(k){return this._m[k]||null;}, setItem(k,v){this._m[k]=String(v);} };\n' +
      'const idbOpen = () => Promise.resolve({ transaction(){ const tx={oncomplete:null}; tx.objectStore=()=>({put(){setTimeout(()=>{ if(tx.oncomplete) tx.oncomplete(); },0);}}); return tx; } });\n' +
      'const migrate = x => x;\n' +
      'const render = () => {};\n' +
      'const logEvent = globals.logEvent;\n' +
      'const syncIsApplying = () => false;\n' +
      'const scheduleSync = () => {};\n' +
      'const now = globals.now || Date.now;\n' +
      'let _prevCharSig = null;\n' +
      'function _charSig(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } }\n' +
      durableMatch[1] + '\n' +
      'return { save };';
    const fn = new Function('globals', body);
    const helpers = fn({ S: { tasks: [], char: {} }, logEvent: () => { logCalls++; } });
    helpers.save();
    helpers.save();
    helpers.save();
    assert('T4 save() calls logEvent zero times (spam source removed)', logCalls === 0);
  }

  // ---- T5: evtUploadable() / evtOwnMonthRecords() never include a
  // kind:'lifecycle' record, even if it is fully stamped (uid/dev/ts). -------
  {
    const evtBody = evtsyncMatch[1] + '\nreturn { evtUploadable, evtOwnMonthRecords, evtIncomingFilter };';
    const evt = new Function(evtBody)();
    const events = [
      { uid: 'a', dev: 'dev1', ts: 1000, kind: 'habitTap' },
      { uid: 'b', dev: 'dev1', ts: 2000, kind: 'lifecycle', detail: 'flushState' }
    ];
    const uploadable = evt.evtUploadable(events, 'dev1', 0);
    const ownMonth = evt.evtOwnMonthRecords(events, 'dev1');
    assert('T5a evtUploadable excludes kind:lifecycle', uploadable.length === 1 && uploadable[0].kind === 'habitTap');
    assert('T5b evtOwnMonthRecords excludes kind:lifecycle', ownMonth.length === 1 && ownMonth[0].kind === 'habitTap');
  }

  // ---- T6: evtIncomingFilter() rejects an incoming kind:'lifecycle' record
  // even if a stale/misbehaving peer device still uploaded one. --------------
  {
    const evtBody = evtsyncMatch[1] + '\nreturn { evtIncomingFilter };';
    const evt = new Function(evtBody)();
    const incoming = [
      { uid: 'x', dev: 'dev2', ts: Date.now(), kind: 'habitTap' },
      { uid: 'y', dev: 'dev2', ts: Date.now(), kind: 'lifecycle' }
    ];
    const filtered = evt.evtIncomingFilter(incoming, new Set(), 'dev1', Date.now(), 365 * 86400000);
    assert('T6 evtIncomingFilter rejects an incoming lifecycle record', filtered.length === 1 && filtered[0].kind === 'habitTap');
  }

  console.log(fails ? ('\n' + fails + ' FAILURE(S)') : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})();
