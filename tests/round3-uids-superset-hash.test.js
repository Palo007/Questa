// round3-uids-superset-hash.test.js
// Round-1 REVIEW-2026-09-18.md Part 2 finding 10: uidsAreSuperset()'s hash branch
// compared a PROMISE to a string. `uidHash` is async and the branch called it
// without `await`, so `localHash === knownHash` was a Promise === string test --
// always false. The branch could never return true, no matter what was stored.
//
// It erred SAFE (a false "not a superset" only ever BLOCKS a push, never allows a
// bad one), which is why it survived two review rounds. But the guard it was
// supposed to be did not exist: for any month whose stored entry predates the F8
// uid-array change (2026-08-18) and therefore has no `known.uids`, the shrink guard
// had no way at all to recognise a local set that genuinely still holds everything.
//
// The fix hands the function the hash the CALLER already awaited one line earlier
// (`const localHash = await uidHash(recs);`), rather than making the function async.
// Two reasons, both about the failure mode:
//   * an async uidsAreSuperset() returns a Promise, and a caller that forgot the
//     `await` would get a TRUTHY value -- `!isSuperset` false -- which UNBLOCKS a
//     shrinking push. That is the data-losing direction.
//   * a caller that forgets the new argument gets `undefined === knownHash`, i.e.
//     false, i.e. exactly today's safe behaviour.
// It also removes a wasted SHA-256 per month per push: the caller was already
// computing the same digest for the diagnostic record.
//
// Red gate against pre-fix sync.js: exit 1.
//
// Run: node tests/round3-uids-superset-hash.test.js  (also run by tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const nodeCrypto = require('crypto');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const CFG = 'questa.sync.v1';
const MY_DEV = 'dev-me';
const NOW = Date.now();

function makeGetEvents(records){
  return function(opts){
    opts = opts || {};
    const from = Object.prototype.hasOwnProperty.call(opts, 'from') ? opts.from : -Infinity;
    const to = Object.prototype.hasOwnProperty.call(opts, 'to') ? opts.to : Infinity;
    return Promise.resolve(records.filter(function(e){ return e.ts >= from && e.ts <= to; }));
  };
}

// Same scaffolding as tests/evtpush-shrink-guard.test.js, with ONE deliberate
// difference: `crypto.subtle` is Node's REAL WebCrypto, not the stub that returns
// a fixed 32-byte buffer. A constant digest cannot tell a matching hash from a
// mismatching one, and that is the whole subject of this file.
function makeCtx(opts){
  opts = opts || {};
  const store = {};
  const uploads = [];
  const noop = function(){};
  const sandbox = {
    window: {}, navigator: { onLine: true },
    document: { addEventListener: noop, getElementById: function(){ return null; },
      createElement: function(){ return { style: {}, appendChild: noop, setAttribute: noop, click: noop }; },
      body: { appendChild: noop, removeChild: noop } },
    localStorage: {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function(k, v){ store[k] = String(v); },
      removeItem: function(k){ delete store[k]; },
      key: function(){ return null; }, length: 0
    },
    history: { replaceState: noop },
    location: { search: '', origin: 'https://test.example', pathname: '/', href: '' },
    crypto: nodeCrypto.webcrypto,
    indexedDB: { open: function(){ return {}; } },
    setTimeout: function(){ return 0; }, clearTimeout: noop,
    setInterval: function(){ return 0; }, clearInterval: noop,
    console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    isNaN: isNaN, URLSearchParams: URLSearchParams, TextEncoder: TextEncoder, Buffer: Buffer,
    Uint8Array: Uint8Array, ArrayBuffer: ArrayBuffer, fetch: null,
    logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; },
    save: noop, uid: function(){ return MY_DEV; },
    idbOpen: function(){ return Promise.resolve(null); }
  };
  sandbox.getEvents = makeGetEvents(opts.records || []);
  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
  sandbox.S = {
    char: { name: 'Test', lvl: 1, updatedAt: 1000 },
    tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
    history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
  };
  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch(e){ console.error('FAIL: sync.js eval threw:', e); process.exit(1); }

  store[CFG] = JSON.stringify(Object.assign({
    enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'at',
    accessExpiresAt: Date.now() + 3600000, lastRev: null, lastSyncAt: null, lastError: null,
    deviceId: MY_DEV, evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0,
    evtFullPushAt: 0, evtFileCounts: {}, evtPushBlocked: {}
  }, opts.cfg || {}));

  sandbox.dbxUploadText = function(p, text){
    uploads.push({ path: String(p), text: text });
    return Promise.resolve({ rev: 'test-rev' });
  };
  return { sandbox: sandbox, store: store, uploads: uploads };
}

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function assertEq(desc, got, want){
  if(got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}
async function push(ctx, opts){ return ctx.sandbox.window.QuestaSync.eventsPush(opts); }

async function main(){
  const helperCtx = makeCtx();
  const H = helperCtx.sandbox.window.QuestaSync.evtHelpers;
  if(typeof H.uidsAreSuperset !== 'function' || typeof H.uidHash !== 'function'){
    console.error('FAIL: uidsAreSuperset / uidHash not exposed'); process.exit(1);
  }

  const recs = [{ uid: 'a', ts: 1 }, { uid: 'b', ts: 2 }, { uid: 'c', ts: 3 }];
  const realHash = await H.uidHash(recs);
  assert('U0a the sandbox digest is real, not the fixed-buffer stub',
    typeof realHash === 'string' && realHash.slice(0, 9) !== 'fallback-');
  assert('U0b ...and it is input-dependent',
    realHash !== await H.uidHash([{ uid: 'z', ts: 1 }]));

  // =======================================================================
  // U1 -- the reported bug. No known.uids, so the hash branch is the only one
  // left; with the caller's awaited hash it must now be able to say TRUE.
  // Pre-fix this returned false for every possible input.
  // =======================================================================
  assertEq('U1 a matching hash is recognised as a superset',
    H.uidsAreSuperset(recs, realHash, null, realHash), true);

  // U2 -- and the guard is not weakened: a genuine mismatch is still false.
  (function(){
    const otherHash = 'ffffffffffffffff';
    assertEq('U2 a mismatching hash is still not a superset',
      H.uidsAreSuperset(recs, otherHash, null, realHash), false);
  })();

  // =======================================================================
  // U3 -- the signature change itself. Pre-fix arity was 3, and a call that
  // omits the hash must degrade to the OLD safe answer, never to true.
  // =======================================================================
  assertEq('U3a uidsAreSuperset takes the caller local hash as a 4th argument',
    H.uidsAreSuperset.length, 4);
  assertEq('U3b omitting it errs safe (false), it does not open the guard',
    H.uidsAreSuperset(recs, realHash, null), false);
  assertEq('U3c a non-string local hash errs safe too',
    H.uidsAreSuperset(recs, realHash, null, Promise.resolve(realHash)), false);

  // U4 -- the function stays synchronous. If it ever becomes async, an existing
  // caller's `!isSuperset` silently flips to "never block", which is the
  // data-losing direction. This assertion is the guard against that refactor.
  (function(){
    const out = H.uidsAreSuperset(recs, realHash, null, realHash);
    assert('U4 the return value is a boolean, not a Promise', typeof out === 'boolean');
  })();

  // =======================================================================
  // U5/U6 -- the uid-array fast path keeps precedence over the hash, in BOTH
  // directions, so making the hash branch live cannot change the normal path.
  // (tests/evtpush-uids-array.test.js T2 covers the array shape itself.)
  // =======================================================================
  assertEq('U5 a covered uid list wins even when the hashes disagree',
    H.uidsAreSuperset(recs, 'wrong-hash', ['a', 'b'], realHash), true);
  assertEq('U6 a uid list with a missing uid loses even when the hashes agree',
    H.uidsAreSuperset(recs, realHash, ['a', 'b', 'zzz'], realHash), false);

  // =======================================================================
  // U7 -- the crypto-less fallback is a 32-bit string hash. Two different uid
  // lists can collide in it, and a false TRUE here overwrites a fuller remote
  // file. The branch is deliberately refused for `fallback-` hashes: that
  // leaves a plain-HTTP device exactly where it was (blocked, safe) instead of
  // trusting 32 bits with the one answer that loses data.
  // =======================================================================
  assertEq('U7 two equal fallback- hashes are still refused',
    H.uidsAreSuperset(recs, 'fallback-0000abcd', null, 'fallback-0000abcd'), false);

  // =======================================================================
  // U8/U9 -- the wiring. The bug was as much the CALL SITE (it never handed the
  // hash over) as the function, so this drives the real syncEventsPush().
  // A current month, so evtMonthRange(mk).from is AFTER the prune cutoff and
  // isLegitimateShrink is false -- isSuperset is then the only thing that can
  // let the push through.
  // =======================================================================
  const mk = H.evtMonthKey(NOW);
  const fname = MY_DEV + '-' + mk + '.json';
  const uploadPath = '/events/' + fname;
  const liveRecs = [{ uid: 'u-live-1', dev: MY_DEV, ts: NOW - 1000, kind: 'tap' }];
  const liveHash = await H.uidHash(liveRecs);

  {
    // U8: known.hash matches what is actually here, known.count is higher, and
    // there is no known.uids. Pre-fix the push was blocked forever.
    const c = makeCtx({
      records: liveRecs,
      cfg: { evtFileCounts: { [fname]: { count: 3, hash: liveHash } } }
    });
    await push(c);
    const savedCfg = JSON.parse(c.store[CFG]);
    assert('U8a a shrunk month whose hash proves the local set is complete IS uploaded',
      c.uploads.some(function(u){ return u.path === uploadPath; }));
    assert('U8b ...and it is not recorded as blocked',
      !savedCfg.evtPushBlocked || !savedCfg.evtPushBlocked[fname]);
  }

  {
    // U9: identical, except the stored hash does not match. Must stay blocked --
    // this is the assertion that proves U8 is not just "the guard stopped working".
    const c = makeCtx({
      records: liveRecs,
      cfg: { evtFileCounts: { [fname]: { count: 3, hash: 'ffffffffffffffff' } } }
    });
    await push(c);
    const savedCfg = JSON.parse(c.store[CFG]);
    assert('U9a a shrunk month with a mismatching hash is NOT uploaded',
      !c.uploads.some(function(u){ return u.path === uploadPath; }));
    assert('U9b ...and it IS recorded as blocked',
      !!(savedCfg.evtPushBlocked && savedCfg.evtPushBlocked[fname]));
  }

  console.log('\n--- round3-uids-superset-hash.test.js summary ---');
  if(failures){ console.error(failures + ' assertion(s) FAILED'); process.exit(1); }
  console.log('round3-uids-superset-hash.test.js: all assertions passed');
  process.exit(0);
}

main().catch(function(e){ console.error('Unhandled:', e); process.exit(1); });
