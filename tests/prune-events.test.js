// prune-events.test.js -- the event-log pruning path, closing the oldest entry
// in AGENTS.md's "Known coverage gaps": pruneEvents() / schedulePrune() had ZERO
// references in any test file.
//
// This is the function that DELETES event history, and it ran unverified while
// carrying a real data-loss bug for months (round-1 REVIEW-2026-09-18.md finding 9:
// store.count() was queued on the same transaction as the age-delete cursor, so it
// returned the PRE-prune total and the hard-cap backstop then deleted that many MORE
// records -- 250k events of which 100k were old ended at 100k instead of 150k).
// P3 below is the standing guard for exactly that, and it is the reason this file
// exists rather than a happy-path smoke test.
//
//   P0  the real app.js constants are sane (the behavioural cases override them)
//   P1  the age pass deletes records older than the cutoff and keeps the rest
//   P2  a record sitting EXACTLY on the cutoff is KEPT (upperBound is exclusive)
//   P3  FINDING 9 GUARD: when the age pass alone brings the store under the cap,
//       the backstop deletes NOTHING -- the count must be taken after that pass
//   P4  the backstop does fire when the store is still over the cap
//   P5  ...and it drops the OLDEST first, leaving the newest survivors
//   P6  a store exactly at the cap loses nothing (`over <= 0`, not `over < 0`)
//   P7  a transaction that cannot be opened returns quietly, store untouched
//   P8  a missing "ts" index does not throw out of pruneEvents
//   P9  schedulePrune() runs the prune once and latches, even with a fresh db
//
// Run: node tests/prune-events.test.js   (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const pruneEventsFn = extractFunction(appSrc, /^function pruneEvents\(db\)\{/, 'pruneEvents');
const schedulePruneFn = extractFunction(appSrc, /^function schedulePrune\(db\)\{/, 'schedulePrune');
const ageLimitLine = extractLine(appSrc, /^const EVENT_AGE_LIMIT_MS\s*=/, 'EVENT_AGE_LIMIT_MS');
const hardCapLine = extractLine(appSrc, /^const EVENT_HARD_CAP\s*=/, 'EVENT_HARD_CAP');

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}
function uids(list){ return list.map(function(r){ return r.uid; }).join(','); }

// Let every queued request settle. pruneEvents chains two transactions and the
// second is only opened from the first's oncomplete, so this needs headroom --
// same multi-round pattern as tests/no-republish-imported.test.js.
function flush(rounds){
  return new Promise(function(resolve){
    let n = 0;
    (function tick(){
      n++;
      if(n >= (rounds || 60)){ resolve(); return; }
      setTimeout(tick, 0);
    })();
  });
}

// ---------------------------------------------------------------------------
// A fake IndexedDB that models the ONE property this finding turns on: requests
// run in the order they were placed, one per macrotask, and a cursor's
// continue() places its next step at the BACK of that queue. That is why the old
// code was wrong -- a count() queued right after openCursor() ran when the cursor
// had deleted only its first record, so it measured a store that had barely been
// pruned. A fake that answered count() from the final state could not express
// the bug at all.
//
// tx.oncomplete fires once the queue drains, which is what the fixed code hangs
// the backstop off.
// ---------------------------------------------------------------------------
function makeDb(records, opts){
  opts = opts || {};
  const db = { records: records, txOpened: 0 };
  db.transaction = function(){
    if(opts.throwOnTransaction) throw new Error('transaction unavailable');
    db.txOpened++;
    const tx = { oncomplete: null, onerror: null, onabort: null };
    const queue = [];
    let draining = false;
    function pump(){
      if(draining) return;
      draining = true;
      setTimeout(function step(){
        const job = queue.shift();
        if(job){ job(); setTimeout(step, 0); return; }
        draining = false;
        if(tx.oncomplete) tx.oncomplete();
      }, 0);
    }
    function inRange(ts, range){
      if(!range) return true;
      if(range.upper === undefined) return true;
      return range.upperOpen ? (ts < range.upper) : (ts <= range.upper);
    }
    const store = {
      count: function(){
        const req = { onsuccess: null, result: 0 };
        queue.push(function(){ req.result = db.records.length; if(req.onsuccess) req.onsuccess(); });
        pump();
        return req;
      },
      index: function(name){
        if(opts.noTsIndex) throw new Error('no such index: ' + name);
        // Failure-only: printing a PASS per cursor would bury the real assertions.
        if(name !== 'ts'){ console.error('[FAIL] (fake) the prune must read the "ts" index, got ' + name); failures++; }
        return {
          openCursor: function(range){
            const req = { onsuccess: null, onerror: null, result: null };
            // Snapshot in ts order at open time, like a real index cursor.
            const walk = db.records
              .filter(function(r){ return inRange(r.ts, range); })
              .sort(function(a, b){ return a.ts - b.ts; });
            let i = 0;
            function stepOnce(){
              if(i >= walk.length){ req.result = null; if(req.onsuccess) req.onsuccess(); return; }
              const rec = walk[i];
              req.result = {
                value: rec,
                delete: function(){
                  const at = db.records.indexOf(rec);
                  if(at !== -1) db.records.splice(at, 1);
                },
                continue: function(){ i++; queue.push(stepOnce); pump(); }
              };
              if(req.onsuccess) req.onsuccess();
            }
            queue.push(stepOnce);
            pump();
            return req;
          }
        };
      }
    };
    tx.objectStore = function(){ return store; };
    return tx;
  };
  return db;
}

// IDBKeyRange stub: only upperBound is used by pruneEvents.
const IDBKeyRangeStub = {
  upperBound: function(v, open){ return { upper: v, upperOpen: !!open }; }
};

const NOW = Date.now();
const DAY = 86400000;
const AGE_LIMIT = 30 * DAY; // test-local: the cutoff maths is what is under test

function makeCtx(records, opts){
  opts = opts || {};
  const db = makeDb(records, opts);
  const sandbox = {
    console: console, Math: Math, Promise: Promise, Object: Object, Array: Array,
    // Frozen clock. pruneEvents derives `cutoff = Date.now() - EVENT_AGE_LIMIT_MS`
    // at CALL time, so with the real clock a fixture built at module load is
    // already a few milliseconds "older" than intended and the on-the-cutoff case
    // (P2) is off by exactly that drift. Date.now() is the only Date use here.
    Date: { now: function(){ return NOW; } },
    setTimeout: setTimeout,
    EVENTS_STORE: 'events',
    EVENT_AGE_LIMIT_MS: AGE_LIMIT,
    // The real cap is 200000, far past what a test can build. The behaviour under
    // test is the arithmetic and the ordering, not the literal -- P0 guards the
    // literal separately.
    EVENT_HARD_CAP: (opts.cap === undefined) ? 1000 : opts.cap,
    IDBKeyRange: IDBKeyRangeStub,
    _idbPruned: false
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext([schedulePruneFn, pruneEventsFn].join('\n'), sandbox); }
  catch(e){ console.error('FAIL: extracted app.js source threw during eval:', e); process.exit(1); }
  return { sandbox: sandbox, db: db };
}

function rec(uid, ageDays){ return { uid: uid, ts: NOW - (ageDays * DAY) }; }

async function main(){
  // =====================================================================
  // P0 -- the behavioural cases below override both constants, so pin the real
  // ones here. A cap of 0 or a negative age limit would delete the whole log.
  // =====================================================================
  {
    const probe = { EVENT_AGE_LIMIT_MS: null, EVENT_HARD_CAP: null };
    vm.createContext(probe);
    vm.runInContext(ageLimitLine.replace(/^const /, 'globalThis.') + '\n' +
                    hardCapLine.replace(/^const /, 'globalThis.'), probe);
    assert('P0a EVENT_AGE_LIMIT_MS is a positive number of ms',
      typeof probe.EVENT_AGE_LIMIT_MS === 'number' && probe.EVENT_AGE_LIMIT_MS > 0);
    assert('P0b ...and is at least a year, so pruning cannot eat recent history',
      probe.EVENT_AGE_LIMIT_MS >= 365 * DAY);
    assert('P0c EVENT_HARD_CAP is a large positive integer',
      typeof probe.EVENT_HARD_CAP === 'number' && probe.EVENT_HARD_CAP >= 10000);
  }

  // =====================================================================
  // P1 -- the age pass.
  // =====================================================================
  {
    const list = [rec('old-1', 100), rec('old-2', 40), rec('new-1', 5), rec('new-2', 1)];
    const ctx = makeCtx(list);
    ctx.sandbox.pruneEvents(ctx.db);
    await flush();
    assertEq('P1 records older than the cutoff are deleted, newer ones kept',
      uids(ctx.db.records), 'new-1,new-2');
  }

  // =====================================================================
  // P2 -- the boundary. upperBound(cutoff, true) is EXCLUSIVE, so a record whose
  // ts is exactly the cutoff survives. Flipping that `true` to `false` silently
  // deletes one more day's worth of history on every run.
  // =====================================================================
  {
    const onCutoff = { uid: 'edge', ts: NOW - AGE_LIMIT };
    const justUnder = { uid: 'gone', ts: NOW - AGE_LIMIT - 1 };
    const ctx = makeCtx([justUnder, onCutoff]);
    ctx.sandbox.pruneEvents(ctx.db);
    await flush();
    assertEq('P2 a record exactly on the cutoff is kept; one millisecond older is not',
      uids(ctx.db.records), 'edge');
  }

  // =====================================================================
  // P3 -- THE FINDING 9 GUARD. Six old records, four recent, cap 8. The age pass
  // leaves 4, which is already under the cap, so the backstop must delete NOTHING.
  // The old code counted before that pass finished, computed a positive `over`,
  // and destroyed in-window history on top of the legitimate prune.
  // =====================================================================
  {
    const list = [
      rec('old-1', 100), rec('old-2', 90), rec('old-3', 80),
      rec('old-4', 70), rec('old-5', 60), rec('old-6', 50),
      rec('keep-1', 20), rec('keep-2', 10), rec('keep-3', 5), rec('keep-4', 1)
    ];
    const ctx = makeCtx(list, { cap: 8 });
    ctx.sandbox.pruneEvents(ctx.db);
    await flush();
    assertEq('P3a the four in-window records all survive the age prune', ctx.db.records.length, 4);
    assertEq('P3b ...and the backstop removed none of them (count is taken AFTER the age pass)',
      uids(ctx.db.records), 'keep-1,keep-2,keep-3,keep-4');
    assertEq('P3c the backstop did open its own second transaction', ctx.db.txOpened, 2);
  }

  // =====================================================================
  // P4/P5 -- the backstop when it genuinely applies: nothing is old enough to
  // prune, the store is over the cap, and the OLDEST must go first.
  // =====================================================================
  {
    const list = [
      rec('a', 9), rec('b', 8), rec('c', 7), rec('d', 6),
      rec('e', 5), rec('f', 4), rec('g', 3), rec('h', 2), rec('i', 1)
    ];
    const ctx = makeCtx(list, { cap: 6 });
    ctx.sandbox.pruneEvents(ctx.db);
    await flush();
    assertEq('P4 the backstop trims the store down to the cap', ctx.db.records.length, 6);
    assertEq('P5 ...by dropping the OLDEST first, so the newest six remain',
      uids(ctx.db.records.slice().sort(function(x, y){ return x.ts - y.ts; })), 'd,e,f,g,h,i');
  }

  // =====================================================================
  // P6 -- exactly at the cap. `over` is 0, and the guard is `<= 0`.
  // =====================================================================
  {
    const list = [rec('a', 6), rec('b', 5), rec('c', 4), rec('d', 3), rec('e', 2), rec('f', 1)];
    const ctx = makeCtx(list, { cap: 6 });
    ctx.sandbox.pruneEvents(ctx.db);
    await flush();
    assertEq('P6 a store exactly at the cap loses nothing', uids(ctx.db.records), 'a,b,c,d,e,f');
  }

  // =====================================================================
  // P7 -- the store cannot be opened at all. pruneEvents must return, not throw:
  // it is called from a setTimeout in schedulePrune, so a throw here is an
  // unhandled error on every boot with a busy or blocked database.
  // =====================================================================
  {
    const list = [rec('a', 100), rec('b', 1)];
    const ctx = makeCtx(list, { throwOnTransaction: true });
    let threw = null;
    try { ctx.sandbox.pruneEvents(ctx.db); } catch(e){ threw = e; }
    await flush(10);
    assert('P7a a failed transaction() does not throw out of pruneEvents', threw === null);
    assertEq('P7b ...and nothing is deleted', uids(ctx.db.records), 'a,b');
  }

  // =====================================================================
  // P8 -- no "ts" index (an older database, or an upgrade that did not finish).
  // Both passes are wrapped in try/catch; neither may escape.
  // =====================================================================
  {
    const list = [rec('a', 100), rec('b', 1)];
    const ctx = makeCtx(list, { noTsIndex: true, cap: 1 });
    let threw = null;
    try { ctx.sandbox.pruneEvents(ctx.db); } catch(e){ threw = e; }
    await flush();
    assert('P8a a missing ts index does not throw out of pruneEvents', threw === null);
    assertEq('P8b ...and nothing is deleted rather than guessed at', uids(ctx.db.records), 'a,b');
  }

  // =====================================================================
  // P9 -- schedulePrune's once-per-session latch. It runs off idbOpen's resolve,
  // which can be reached more than once, and a second full prune pass per boot
  // would be pure waste on a large store.
  // =====================================================================
  {
    const list = [rec('old-1', 100), rec('new-1', 1)];
    const ctx = makeCtx(list);
    ctx.sandbox.schedulePrune(ctx.db);
    await flush();
    assertEq('P9a schedulePrune runs the prune', uids(ctx.db.records), 'new-1');
    assertEq('P9b ...and it latched', ctx.sandbox._idbPruned, true);

    const opened = ctx.db.txOpened;
    const second = makeDb([rec('old-2', 100), rec('new-2', 1)]);
    ctx.sandbox.schedulePrune(second);
    await flush();
    assertEq('P9c a second call opens no transaction at all', second.txOpened, 0);
    assertEq('P9d ...and the second store is untouched', uids(second.records), 'old-2,new-2');
    assertEq('P9e ...and the first store is not re-walked either', ctx.db.txOpened, opened);
  }

  console.log('\n--- prune-events.test.js summary ---');
  if(failures){ console.error(failures + ' assertion(s) FAILED'); process.exit(1); }
  console.log('prune-events.test.js: all assertions passed');
  process.exit(0);
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
