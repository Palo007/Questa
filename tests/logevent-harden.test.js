// logevent-harden.test.js -- W2.4: logEvent()'s IndexedDB write path was
// fire-and-forget with a synchronous try/catch that swallowed the error and
// NO tx.onabort/tx.onerror handlers at all, so an async transaction failure
// was completely invisible. This hardens it (app.js ~657, function logEvent):
//   - the existing sync try/catch now pushes a 'logEventSync' diag entry
//     instead of silently swallowing
//   - tx.onabort retries EXACTLY ONCE on a fresh transaction with the same
//     record (abort is a definitive "did not commit" signal, so the retry
//     cannot double-write)
//   - tx.onerror pushes a 'logEventTxError' diag entry (kind, taskId, msg)
//   - if the retry transaction ALSO aborts, a 'logEventRetryFailed' diag
//     entry is pushed and there is no second retry
//   - the diag sink (_qDiagPush) is guarded with typeof, so a missing sink
//     never throws
//
// Note on the mock sink below: the real _qDiagPush(kind, data) does
// Object.assign({t, kind:kind}, data) -- so if `data` itself carries a
// `kind` field (it does here: {kind: rec.kind, taskId, msg}), that
// OVERWRITES the diagnostic-type label with the record's own kind. That
// collision is a pre-existing property of the already-shipped sink (app.js
// ~4-12) and out of scope here. So this mock records the sink call's two
// arguments SEPARATELY (diagKind = the first arg, e.g. 'logEventTxError';
// data = the second arg, e.g. {kind: rec.kind, ...}) so assertions can check
// unambiguously what logEvent() actually called the sink with, independent
// of how the real sink happens to merge them.
//
// This is defensive hardening against a failure mode that has not been
// observed (see the comment in app.js for the 2026-07-28 event-gap context)
// -- these tests only verify the retry/diag plumbing behaves as designed.
//
// Run: node tests/logevent-harden.test.js (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js. Do NOT reintroduce hardcoded line-number slicing.
const logEventFn = extractFunction(appSrc, /^function logEvent\(ev\)\{/, 'logEvent');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Fake object store / transaction. Each db.transaction() call records a new
// tx (so tests can assert exactly how many transactions were opened) and
// returns an object whose .onabort/.onerror the extracted logEvent() source
// assigns; tests trigger them manually to simulate IDB failure modes.
function makeFakeDb() {
  const txs = [];
  const db = {
    transaction: function (storeName, mode) {
      const adds = [];
      const tx = {
        storeName: storeName, mode: mode, adds: adds,
        objectStore: function (name) {
          return { add: function (rec) { adds.push(rec); } };
        }
      };
      txs.push(tx);
      return tx;
    }
  };
  return { db: db, txs: txs };
}

function makeCtx(opts) {
  opts = opts || {};
  const calls = []; // {diagKind, data} -- see file header note on why kept separate
  const sandbox = {
    console: console,
    EVENTS_STORE: 'events',
    idbOpen: opts.idbOpen,
    // No sync device/uid helpers wired -- logEvent falls back to its
    // ts-only rec branch (typeof-guarded, exactly like the shipped code).
    _qDiagPush: (opts.withDiagSink === false) ? undefined : function (kind, data) {
      calls.push({ diagKind: kind, data: data });
      if (calls.length > 50) calls.shift(); // mirrors the real ring's cap-50 eviction
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(logEventFn, sandbox);
  return { sandbox: sandbox, calls: calls };
}

async function main() {
  // -----------------------------------------------------------------------
  // H1: happy path -- writes exactly once, no retry, nothing pushed to the ring.
  // -----------------------------------------------------------------------
  {
    const fake = makeFakeDb();
    const ctx = makeCtx({ idbOpen: function () { return Promise.resolve(fake.db); } });
    ctx.sandbox.logEvent({ kind: 'tap', taskId: 't1' });
    await flush();
    assertEq('H1a: exactly one transaction opened', fake.txs.length, 1);
    assertEq('H1b: the record was added to the store', fake.txs[0].adds.length, 1);
    assertEq('H1c: nothing pushed to the diag ring on the happy path', ctx.calls.length, 0);
  }

  // -----------------------------------------------------------------------
  // H2: first transaction aborts -> exactly ONE retry on a fresh transaction
  // with the same record. If the retry is then simply never aborted/errored
  // (i.e. succeeds), nothing is pushed to the ring for it.
  // -----------------------------------------------------------------------
  {
    const fake = makeFakeDb();
    const ctx = makeCtx({ idbOpen: function () { return Promise.resolve(fake.db); } });
    ctx.sandbox.logEvent({ kind: 'miss', taskId: 't2' });
    await flush();
    assertEq('H2a: one transaction before any failure', fake.txs.length, 1);
    fake.txs[0].onabort(); // simulate the first transaction aborting
    assertEq('H2b: exactly one retry transaction was opened (total 2, not 3+)', fake.txs.length, 2);
    assertEq('H2c: retry transaction carries the SAME record (taskId)', fake.txs[1].adds[0].taskId, 't2');
    assertEq('H2d: retry transaction carries the SAME record (kind)', fake.txs[1].adds[0].kind, 'miss');
    assertEq('H2e: the successful retry itself pushes nothing', ctx.calls.length, 0);
  }

  // -----------------------------------------------------------------------
  // H3: both the original AND the retry abort -> logEventRetryFailed pushed,
  // and there is no third transaction (no second retry -- no loop).
  // -----------------------------------------------------------------------
  {
    const fake = makeFakeDb();
    const ctx = makeCtx({ idbOpen: function () { return Promise.resolve(fake.db); } });
    ctx.sandbox.logEvent({ kind: 'purchase', taskId: 't3' });
    await flush();
    fake.txs[0].onabort(); // original aborts -> triggers the one retry
    assertEq('H3a: retry transaction opened after first abort', fake.txs.length, 2);
    fake.txs[1].onabort(); // retry ALSO aborts
    assertEq('H3b: still exactly 2 transactions -- no second retry (no loop)', fake.txs.length, 2);
    const rf = ctx.calls.filter(function (c) { return c.diagKind === 'logEventRetryFailed'; });
    assertEq('H3c: exactly one logEventRetryFailed entry', rf.length, 1);
    assertEq('H3d: it carries the record kind', rf[0].data.kind, 'purchase');
    assertEq('H3e: it carries the record taskId', rf[0].data.taskId, 't3');
  }

  // -----------------------------------------------------------------------
  // H4: tx.onerror fires -> logEventTxError entry carrying kind + taskId.
  // -----------------------------------------------------------------------
  {
    const fake = makeFakeDb();
    const ctx = makeCtx({ idbOpen: function () { return Promise.resolve(fake.db); } });
    ctx.sandbox.logEvent({ kind: 'lifecycle', taskId: 't4' });
    await flush();
    fake.txs[0].error = new Error('boom');
    fake.txs[0].onerror();
    const te = ctx.calls.filter(function (c) { return c.diagKind === 'logEventTxError'; });
    assertEq('H4a: exactly one logEventTxError entry', te.length, 1);
    assertEq('H4b: entry carries the record kind', te[0].data.kind, 'lifecycle');
    assertEq('H4c: entry carries the record taskId', te[0].data.taskId, 't4');
    assert('H4d: entry carries a msg field', typeof te[0].data.msg === 'string' && te[0].data.msg.length > 0);
  }

  // -----------------------------------------------------------------------
  // H5: a synchronous throw (e.g. db.transaction() itself throws) produces a
  // logEventSync entry rather than being silently swallowed.
  // -----------------------------------------------------------------------
  {
    const db = { transaction: function () { throw new Error('sync boom'); } };
    const ctx = makeCtx({ idbOpen: function () { return Promise.resolve(db); } });
    ctx.sandbox.logEvent({ kind: 'tap', taskId: 't5' });
    await flush();
    const se = ctx.calls.filter(function (c) { return c.diagKind === 'logEventSync'; });
    assertEq('H5a: exactly one logEventSync entry on synchronous throw', se.length, 1);
    assertEq('H5b: entry carries the record taskId', se[0].data.taskId, 't5');
  }

  // -----------------------------------------------------------------------
  // H6: the ring is capped at 50, oldest evicted first (mirrors the shipped
  // window.__qDiag ring's own cap/shift behavior at app.js:4-12; this test
  // just confirms logEvent's pushes go through a sink that honors it).
  // -----------------------------------------------------------------------
  {
    const db = { transaction: function () { throw new Error('boom'); } };
    const ctx = makeCtx({ idbOpen: function () { return Promise.resolve(db); } });
    for (let i = 0; i < 55; i++) {
      ctx.sandbox.logEvent({ kind: 'tap', taskId: 't-' + i });
    }
    await flush();
    assertEq('H6a: ring capped at 50 entries', ctx.calls.length, 50);
    assert('H6b: oldest entries evicted first (t-0 gone)', ctx.calls.every(function (c) { return c.data.taskId !== 't-0'; }));
    assert('H6c: newest entry retained (t-54 present)', ctx.calls.some(function (c) { return c.data.taskId === 't-54'; }));
  }

  // -----------------------------------------------------------------------
  // H7: missing _qDiagPush degrades gracefully -- no throw, even through a
  // sync failure, a tx.onerror, and a double-abort retry-failure path.
  // -----------------------------------------------------------------------
  {
    const fake = makeFakeDb();
    const ctx = makeCtx({ idbOpen: function () { return Promise.resolve(fake.db); }, withDiagSink: false });
    let threw = false;
    try {
      ctx.sandbox.logEvent({ kind: 'tap', taskId: 't6' });
      await flush();
      fake.txs[0].onabort();
      fake.txs[1].onabort();
      fake.txs[0].error = new Error('boom');
      fake.txs[0].onerror();
    } catch (e) { threw = true; }
    assert('H7a: no throw across sync/abort/retry-failure/error path with no diag sink', !threw);
  }

  if (failures) {
    console.error('\n' + failures + ' logevent-harden assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL LOGEVENT-HARDEN TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
