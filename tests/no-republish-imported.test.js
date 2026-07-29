// no-republish-imported.test.js -- W6.14: imported events must never be
// uploaded to Dropbox sync UNLESS explicitly opted back in.
//
// Background / the concrete harm (see reparentEventsForImport()'s header
// comment in app.js and evtUploadable()'s in sync.js): reparentEventsForImport()
// re-stamps an imported record's `dev` to THIS device and rehashes its `uid`.
// Before this fix, evtUploadable()/evtOwnMonthRecords() (sync.js) had no way
// to tell such a record apart from a real, locally-generated tap -- so this
// device would upload ANOTHER device's history as if it had generated it
// itself. Any device pulling both files then receives the same logical event
// twice under two different uids, and no uid-based dedup can collapse them
// (confirmed in production: ms5tzgmpcu4ph-202607.json is a re-badged copy of
// another device's events).
//
// The fix: reparentEventsForImport() already flags every reparented record
// `imported: true`. evtUploadable()/evtOwnMonthRecords() now exclude
// `imported` records the same way they have always excluded `synthetic` ones
// -- UNLESS the record also carries an explicit `republish: true` opt-in,
// set only via the new republishImportedEvents() action (behind a
// confirmDialog()).
//
//   N1  an `imported: true` record is never returned by evtUploadable()
//   N2  a locally generated (non-imported) record IS returned by
//       evtUploadable() -- proves the filter discriminates, not a blanket
//       exclusion
//   N3  same two assertions for evtOwnMonthRecords()
//   N4  a `synthetic` record is NEVER uploadable via evtUploadable(), even
//       with `republish: true` set -- the unconditional guarantee
//   N5  an `imported` record WITH `republish: true` becomes uploadable
//   N6  reparentEventsForImport() preserves origDev (the pre-reparenting
//       dev) for records it actually reparents, and does NOT add origDev to
//       records already owned by this device (left untouched)
//   N7  republishImportedEvents() sets `republish` only on imported records
//       OWNED BY THIS DEVICE, never touches non-imported or other-device
//       records, never touches a synthetic+imported record (defense in
//       depth, matching the sync.js guarantee), and reports the count via
//       toast()
//   N8  the opt-in requires confirmation -- declining it (confirmDialog
//       resolves false) leaves every record's `republish` flag untouched
//
// Run: node tests/no-republish-imported.test.js (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js/sync.js. Do NOT reintroduce hardcoded line-number slicing.
const eventUidOfFn = extractFunction(appSrc, /^function eventUidOf\(rec, idx\)\{/, 'eventUidOf');
const reparentEventsForImportFn = extractFunction(appSrc, /^function reparentEventsForImport\(list\)\{/, 'reparentEventsForImport');
const countRepublishEligibleFn = extractFunction(appSrc, /^function countRepublishEligible\(myDev\)\{/, 'countRepublishEligible');
const republishImportedEventsFn = extractFunction(appSrc, /^function republishImportedEvents\(\)\{/, 'republishImportedEvents');
const evtUploadableFn = extractFunction(syncSrc, /^function evtUploadable\(events, myDev, sinceTs\)\{/, 'evtUploadable');
const evtOwnMonthRecordsFn = extractFunction(syncSrc, /^function evtOwnMonthRecords\(events, myDev\)\{/, 'evtOwnMonthRecords');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function flush(rounds) {
  // Several macrotask hops: the fake cursor below advances one record per
  // setTimeout(0), and republishImportedEvents() chains countRepublishEligible
  // -> confirmDialog -> a second cursor pass, so this needs more headroom
  // than a single tick. Matches the multi-round flush() pattern used by
  // tests/evtpull-selfhealing.test.js and tests/backfill-ui-wiring.test.js.
  return new Promise(function (resolve) {
    let n = 0;
    (function tick() {
      n++;
      if (n >= (rounds || 40)) { resolve(); return; }
      setTimeout(tick, 0);
    })();
  });
}

// Minimal fake IndexedDB events store: a single in-memory array, iterated by
// a real (async, one-record-per-macrotask) cursor so openCursor()/continue()/
// update() behave like the real API closely enough for countRepublishEligible()
// / republishImportedEvents() (both cursor-scan the whole store).
function makeFakeDb(list) {
  return {
    transaction: function () {
      const tx = { oncomplete: null, onerror: null, onabort: null };
      tx.objectStore = function () {
        return {
          openCursor: function () {
            let idx = 0;
            const req = { onsuccess: null, onerror: null, result: null };
            function step() {
              if (idx >= list.length) {
                req.result = null;
                if (req.onsuccess) req.onsuccess();
                setTimeout(function () { if (tx.oncomplete) tx.oncomplete(); }, 0);
                return;
              }
              const rec = list[idx];
              const cursor = {
                value: rec,
                continue: function () { idx++; setTimeout(step, 0); },
                update: function (v) { list[idx] = v; },
                delete: function () { list.splice(idx, 1); },
              };
              req.result = cursor;
              if (req.onsuccess) req.onsuccess();
            }
            setTimeout(step, 0);
            return req;
          },
        };
      };
      return tx;
    },
  };
}

function makeCtx(list, opts) {
  opts = opts || {};
  const toasts = [];
  const confirmCalls = [];
  const sandbox = {
    console: console,
    EVENTS_STORE: 'events',
    idbOpen: function () { return Promise.resolve(makeFakeDb(list)); },
    syncDeviceId: function () { return opts.myDev || 'dev-me'; },
    confirmDialog: function (title, text) {
      confirmCalls.push({ title: title, text: text });
      return Promise.resolve(opts.confirm !== false);
    },
    toast: function (msg) { toasts.push(msg); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = [eventUidOfFn, reparentEventsForImportFn, countRepublishEligibleFn, republishImportedEventsFn].join('\n');
  try { vm.runInContext(src, sandbox); }
  catch (e) { console.error('FAIL: extracted app.js source threw during eval:', e); process.exit(1); }
  return { sandbox: sandbox, toasts: toasts, confirmCalls: confirmCalls };
}

function makeEvtSandbox() {
  const sandbox = { console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([evtUploadableFn, evtOwnMonthRecordsFn].join('\n'), sandbox);
  return sandbox;
}

async function main() {
  const MY_DEV = 'dev-me';

  // -------------------------------------------------------------------
  // N1/N2/N3: evtUploadable()/evtOwnMonthRecords() discriminate imported
  // vs. locally-generated records.
  // -------------------------------------------------------------------
  {
    const evt = makeEvtSandbox();
    const importedRec = { uid: 'imp-1', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't1', imported: true };
    const localRec = { uid: 'loc-1', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't2' };
    const all = [importedRec, localRec];

    const uploadable = evt.evtUploadable(all, MY_DEV, 0);
    assert('N1: an imported:true record is never returned by evtUploadable', !uploadable.some(function (e) { return e.uid === 'imp-1'; }));
    assert('N2: a locally generated (non-imported) record IS returned by evtUploadable (filter discriminates)', uploadable.some(function (e) { return e.uid === 'loc-1'; }));

    const ownMonth = evt.evtOwnMonthRecords(all, MY_DEV);
    assert('N3a: an imported:true record is never returned by evtOwnMonthRecords', !ownMonth.some(function (e) { return e.uid === 'imp-1'; }));
    assert('N3b: a locally generated record IS returned by evtOwnMonthRecords', ownMonth.some(function (e) { return e.uid === 'loc-1'; }));
  }

  // -------------------------------------------------------------------
  // N4: the unconditional guarantee -- a synthetic record is NEVER
  // uploadable, even with republish:true set.
  // -------------------------------------------------------------------
  {
    const evt = makeEvtSandbox();
    const syntheticRepublished = { uid: 'syn-1', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't3', synthetic: true, imported: true, republish: true };
    const uploadable = evt.evtUploadable([syntheticRepublished], MY_DEV, 0);
    assert('N4a: a synthetic record with republish:true is STILL never uploadable via evtUploadable', uploadable.length === 0);
    const ownMonth = evt.evtOwnMonthRecords([syntheticRepublished], MY_DEV);
    assert('N4b: a synthetic record with republish:true is STILL never returned by evtOwnMonthRecords', ownMonth.length === 0);
  }

  // -------------------------------------------------------------------
  // N5: an imported record WITH republish:true becomes uploadable.
  // -------------------------------------------------------------------
  {
    const evt = makeEvtSandbox();
    const republished = { uid: 'imp-2', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't4', imported: true, republish: true };
    const uploadable = evt.evtUploadable([republished], MY_DEV, 0);
    assert('N5a: an imported record with republish:true IS returned by evtUploadable', uploadable.some(function (e) { return e.uid === 'imp-2'; }));
    const ownMonth = evt.evtOwnMonthRecords([republished], MY_DEV);
    assert('N5b: an imported record with republish:true IS returned by evtOwnMonthRecords', ownMonth.some(function (e) { return e.uid === 'imp-2'; }));
  }

  // -------------------------------------------------------------------
  // N6: reparentEventsForImport() preserves origDev for reparented
  // records, and never adds it to already-owned records.
  // -------------------------------------------------------------------
  {
    const ctx = makeCtx([]);
    const otherDevRec = { ts: 3000, kind: 'tap', taskId: 't5', dev: 'dev-other', uid: 'dev-other-xyz', value: 2 };
    const noDevRec = { ts: 3100, kind: 'tap', taskId: 't6' };
    const ownedRec = { ts: 3200, kind: 'tap', taskId: 't7', dev: MY_DEV, uid: 'my-original-uid' };
    const list = [otherDevRec, noDevRec, ownedRec];
    const out = ctx.sandbox.reparentEventsForImport(list);

    assert('N6a: origDev preserves the original dev of a reparented other-device record', out[0].origDev === 'dev-other' && out[0].dev === MY_DEV);
    assert('N6b: origDev is set (undefined) for a record that had no dev at all', ('origDev' in out[1]) && out[1].origDev === undefined && out[1].dev === MY_DEV);
    assert('N6c: origDev is NOT added to a record already owned by this device', !('origDev' in out[2]));
  }

  // -------------------------------------------------------------------
  // N7: republishImportedEvents() sets republish only on imported records
  // owned by this device, skips everything else (including a
  // synthetic+imported record, defense in depth), and reports the count.
  // -------------------------------------------------------------------
  {
    const importedOwned = { id: 1, uid: 'imp-a', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't1', imported: true };
    const importedOther = { id: 2, uid: 'imp-b', dev: 'dev-other', ts: 1000, kind: 'tap', taskId: 't2', imported: true };
    const localOwned = { id: 3, uid: 'loc-a', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't3' };
    const syntheticImportedOwned = { id: 4, uid: 'syn-a', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't4', imported: true, synthetic: true };
    const alreadyRepublished = { id: 5, uid: 'imp-c', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't5', imported: true, republish: true };
    const list = [importedOwned, importedOther, localOwned, syntheticImportedOwned, alreadyRepublished];

    const ctx = makeCtx(list, { confirm: true });
    const updated = await ctx.sandbox.republishImportedEvents();
    await flush();

    assert('N7a: exactly one record was newly republished (importedOwned only)', updated === 1);
    assert('N7b: importedOwned now carries republish:true', importedOwned.republish === true);
    assert('N7c: importedOther (not owned by this device) is untouched', !importedOther.republish);
    assert('N7d: localOwned (not imported) is untouched', !localOwned.republish);
    assert('N7e: syntheticImportedOwned is NEVER set republish (defense in depth, matches sync.js guarantee)', !syntheticImportedOwned.republish);
    assert('N7f: alreadyRepublished is left as-is (still true, not double-counted)', alreadyRepublished.republish === true);
    assert('N7g: the confirm dialog stated the count and visibility to other devices', ctx.confirmCalls.length === 1 && /1 imported event/.test(ctx.confirmCalls[0].text) && /other devices/i.test(ctx.confirmCalls[0].text));
    assert('N7h: the result is reported via toast', ctx.toasts.some(function (t) { return /Republished 1 imported event/.test(t || ''); }));
  }

  // -------------------------------------------------------------------
  // N8: declining the confirmation leaves every record's republish flag
  // untouched.
  // -------------------------------------------------------------------
  {
    const importedOwned = { id: 1, uid: 'imp-a', dev: MY_DEV, ts: 1000, kind: 'tap', taskId: 't1', imported: true };
    const list = [importedOwned];
    const ctx = makeCtx(list, { confirm: false });
    const updated = await ctx.sandbox.republishImportedEvents();
    await flush();

    assert('N8a: declining confirmation reports 0 updated', updated === 0);
    assert('N8b: declining confirmation leaves the record untouched (no republish flag)', !importedOwned.republish);
    assert('N8c: a "cancelled" toast is shown, not a "Republished" one', ctx.toasts.some(function (t) { return /cancelled/i.test(t || ''); }) && !ctx.toasts.some(function (t) { return /Republished \d/.test(t || ''); }));
  }

  if (failures) {
    console.error('\n' + failures + ' no-republish-imported assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL NO-REPUBLISH-IMPORTED TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
