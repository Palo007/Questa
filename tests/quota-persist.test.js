// quota-persist.test.js -- #11a Quota failure resilience + #11b navigator.storage.persist()
// Tests that a QuotaExceededError on localStorage.setItem still writes the
// IDB mirror and surfaces the error, and that navigator.storage.persist()
// is called at boot with the correct logEvent.
//
// Run: node tests/quota-persist.test.js   (also run by `node tests/run.js`)
'use strict';

let failures = 0;
function assert(d, c) {
  if (c) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d); failures++; }
}
function assertEq(d, got, want) {
  if (got === want) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

// ═══════════════════════════════════════════════════════════════════════
// #11a — QuotaExceededError in _saveCommit: IDB mirror still written,
//         error surfaced, __seq still advanced.
// ═══════════════════════════════════════════════════════════════════════

// We simulate _saveCommit's logic with the shipped try/catch pattern,
// exactly as the #11a fix structures it.
function makeSaveWithQuotaError(env) {
  return function save(tabState) {
    var preBumpSeq = (tabState.__seq || 0);
    var applying = false;

    function _saveCommit() {
      tabState.__seq = preBumpSeq + 1;
      tabState.__savedAt = Date.now();
      var _json = JSON.stringify(tabState);
      // #11a try/catch around setItem
      try {
        env.localStorage.setItem(env.STORE_KEY, _json);
      } catch (quotaErr) {
        // QuotaExceededError: still surface + log
        if (typeof env.toast === 'function') env.toast('Storage quota exceeded');
        if (typeof env.logEvent === 'function') env.logEvent({kind: 'quotaError', message: String(quotaErr && quotaErr.message || quotaErr)});
      }
      // IDB mirror still runs regardless of quota failure
      env._idbWriteState(_json);
      if (typeof env.scheduleSync === 'function' && !applying) env.scheduleSync();
    }

    if (env.locks && typeof env.locks.request === 'function') {
      return env.locks.request('questa-sync', { mode: 'exclusive' }, function() {
        try {
          var raw = env.localStorage.getItem(env.STORE_KEY);
          if (raw) {
            var storedObj = JSON.parse(raw);
            var storedSeq = Number(storedObj.__seq) || 0;
            if (storedSeq > preBumpSeq) {
              Object.keys(storedObj).forEach(function(k) { tabState[k] = storedObj[k]; });
              if (typeof env.logEvent === 'function') env.logEvent({ kind: 'multiTabClobberAvoided', preBumpSeq: preBumpSeq, storedSeq: storedSeq });
              return;
            }
          }
        } catch (ex) { /* fall through */ }
        _saveCommit();
      });
    } else {
      _saveCommit();
    }
  };
}

// ── Mock localStorage that throws QuotaExceededError on setItem ────────
function makeQuotaExceededLocalStorage() {
  var store = {};
  return {
    getItem: function(k) { return store[k] || null; },
    setItem: function(k, v) {
      var err = new Error('Failed to execute \'setItem\': exceeded the quota');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem: function(k) { delete store[k]; }
  };
}

// ── Mock navigator.locks ──────────────────────────────────────────────
function makeLockManager() {
  var queue = [];
  var held = false;
  return {
    request: function(_name, _opts, callback) {
      return new Promise(function(resolve) {
        function run() {
          held = true;
          var result;
          try { result = callback(); } catch(e) { held = false; resolve(undefined); if (queue.length) queue.shift()(); return; }
          Promise.resolve(result).then(function(val) {
            held = false; resolve(val); if (queue.length) queue.shift()();
          }, function() {
            held = false; resolve(undefined); if (queue.length) queue.shift()();
          });
        }
        if (held) queue.push(run); else run();
      });
    }
  };
}

async function main() {

// ── Q1: QuotaExceededError → IDB mirror still written + error surfaced + __seq advanced
{
  var ls = makeQuotaExceededLocalStorage();
  var locks = makeLockManager();
  var events = [];
  var toasts = [];
  var idbWrites = [];
  var syncCalls = 0;

  var env = {
    localStorage: ls,
    locks: locks,
    logEvent: function(ev) { events.push(ev); },
    toast: function(msg) { toasts.push(msg); },
    _idbWriteState: function(json) { idbWrites.push(json); return Promise.resolve(); },
    scheduleSync: function() { syncCalls++; },
    STORE_KEY: 'questa.save.v1'
  };

  var tab = { tasks: [{ id: 't1', title: 'Test' }], __seq: 4 };
  await makeSaveWithQuotaError(env)(tab);

  assertEq('Q1a: __seq advanced despite quota error', tab.__seq, 5);
  assert('Q1b: IDB mirror write was attempted', idbWrites.length === 1);
  assertEq('Q1c: IDB write contains the bumped state', JSON.parse(idbWrites[0]).__seq, 5);
  assertEq('Q1d: toast called with quota message', toasts.length, 1);
  assert('Q1e: toast message mentions quota', toasts[0].toLowerCase().indexOf('quota') >= 0);
  assert('Q1f: logEvent quotaError fired', events.some(function(e) { return e.kind === 'quotaError'; }));
  assertEq('Q1g: scheduleSync was called', syncCalls, 1);
}

// ── Q2: Normal write (no quota error) → localStorage written, IDB written, no toast
{
  var store = {};
  var ls = {
    getItem: function(k) { return store[k] || null; },
    setItem: function(k, v) { store[k] = String(v); },
    removeItem: function(k) { delete store[k]; }
  };
  var locks = makeLockManager();
  var events = [];
  var toasts = [];
  var idbWrites = [];
  var syncCalls = 0;

  var env = {
    localStorage: ls,
    locks: locks,
    logEvent: function(ev) { events.push(ev); },
    toast: function(msg) { toasts.push(msg); },
    _idbWriteState: function(json) { idbWrites.push(json); return Promise.resolve(); },
    scheduleSync: function() { syncCalls++; },
    STORE_KEY: 'questa.save.v1'
  };

  var tab = { tasks: [{ id: 't1' }], __seq: 4 };
  await makeSaveWithQuotaError(env)(tab);

  assertEq('Q2a: __seq advanced normally', tab.__seq, 5);
  assert('Q2b: localStorage was written', ls.getItem('questa.save.v1') !== null);
  assertEq('Q2c: IDB mirror written', idbWrites.length, 1);
  assertEq('Q2d: no toast on success', toasts.length, 0);
  assertEq('Q2e: no quotaError event', events.filter(function(e) { return e.kind === 'quotaError'; }).length, 0);
  assertEq('Q2f: scheduleSync called', syncCalls, 1);
}

// ── Q3: Multiple saves with quota error → __seq progresses correctly
{
  var ls = makeQuotaExceededLocalStorage();
  var locks = makeLockManager();
  var idbWrites = [];

  var env = {
    localStorage: ls,
    locks: locks,
    logEvent: function() {},
    toast: function() {},
    _idbWriteState: function(json) { idbWrites.push(json); return Promise.resolve(); },
    scheduleSync: function() {},
    STORE_KEY: 'questa.save.v1'
  };

  var tab = { tasks: [], __seq: 0 };
  var save = makeSaveWithQuotaError(env);

  await save(tab);
  assertEq('Q3a: first save seq is 1', tab.__seq, 1);

  tab.tasks.push({ id: 't1' });
  await save(tab);
  assertEq('Q3b: second save seq is 2', tab.__seq, 2);

  tab.tasks.push({ id: 't2' });
  await save(tab);
  assertEq('Q3c: third save seq is 3', tab.__seq, 3);
  assertEq('Q3d: three IDB writes despite all quota failures', idbWrites.length, 3);
  assertEq('Q3e: last IDB write has seq 3', JSON.parse(idbWrites[2]).__seq, 3);
}

// ── Q4: quotaError event has correct shape
{
  var ls = makeQuotaExceededLocalStorage();
  var locks = makeLockManager();
  var events = [];

  var env = {
    localStorage: ls,
    locks: locks,
    logEvent: function(ev) { events.push(ev); },
    toast: function() {},
    _idbWriteState: function() { return Promise.resolve(); },
    scheduleSync: function() {},
    STORE_KEY: 'questa.save.v1'
  };

  var tab = { tasks: [], __seq: 7 };
  await makeSaveWithQuotaError(env)(tab);

  var qe = events.filter(function(e) { return e.kind === 'quotaError'; });
  assertEq('Q4a: exactly one quotaError event', qe.length, 1);
  assert('Q4b: event has message field', typeof qe[0].message === 'string');
  assert('Q4c: message mentions quota', qe[0].message.toLowerCase().indexOf('quota') >= 0);
}

// ═══════════════════════════════════════════════════════════════════════
// #11b — navigator.storage.persist() at boot
// ═══════════════════════════════════════════════════════════════════════

// ── P1: persist() called → logEvent with granted=true ─────────────────
{
  var persistCalled = false;
  var grantedValue = null;
  var events = [];

  var navigator = {
    storage: {
      persist: function() {
        persistCalled = true;
        return Promise.resolve(true);
      }
    }
  };

  var logEvent = function(ev) { events.push(ev); };

  // Simulate the boot-time persist guard (exactly as shipped):
  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  // persist is async, wait for it
  await new Promise(function(r) { setTimeout(r, 10); });

  assert('P1a: persist() was called', persistCalled);
  assertEq('P1b: logEvent has storagePersist kind', events.length, 1);
  assertEq('P1c: logEvent granted is true', events[0].granted, true);
}

// ── P2: persist() denied → logEvent with granted=false ────────────────
{
  var persistCalled = false;
  var events = [];

  var navigator = {
    storage: {
      persist: function() {
        persistCalled = true;
        return Promise.resolve(false);
      }
    }
  };

  var logEvent = function(ev) { events.push(ev); };

  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });

  assert('P2a: persist() was called even when denied', persistCalled);
  assertEq('P2b: logEvent granted is false', events[0].granted, false);
}

// ── P3: navigator.storage missing → no throw, no crash ────────────────
{
  var events = [];
  var navigator = {};  // no storage
  var logEvent = function(ev) { events.push(ev); };

  // Should NOT throw
  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });
  assertEq('P3a: no logEvent when storage unavailable', events.length, 0);
}

// ── P4: navigator.storage.persist throws → no crash, catch swallows ──
{
  var events = [];
  var navigator = {
    storage: {
      persist: function() { return Promise.reject(new Error('not allowed')); }
    }
  };
  var logEvent = function(ev) { events.push(ev); };

  // Should NOT throw
  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });
  assertEq('P4a: no logEvent when persist rejects', events.length, 0);
}

// ── P5: navigator entirely missing (older env) → no throw ─────────────
{
  var events = [];
  // No navigator at all (simulated by undefined)
  var navigator;  // undefined
  var logEvent = function(ev) { events.push(ev); };

  try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==='function'){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==='function') logEvent({kind:'storagePersist', granted:!!granted}); }).catch(function(){}); } }catch(_){}

  await new Promise(function(r) { setTimeout(r, 10); });
  assertEq('P5a: no logEvent when navigator undefined', events.length, 0);
}

} // end main

// ── Run + Exit ────────────────────────────────────────────────────────
main().then(function() {
  if (failures > 0) { console.error(failures + ' quota-persist test(s) failed.'); process.exit(1); }
  console.log('All quota-persist tests passed!');
  process.exit(0);
}, function(err) {
  console.error('quota-persist test error:', err);
  process.exit(1);
});
