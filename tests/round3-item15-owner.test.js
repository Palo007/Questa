// round3-item15-owner.test.js -- round 3, item 15 (owner review): three fixes
// landed together in app.js, exercised here as a single owner-focused pass.
//
//   (A) deviceRegisteredName(devices, devId) -- split out of deviceDisplayName
//       so a caller can ask "is there a REGISTERED name?" without the
//       truncated-id fallback swallowing every other precedence rung.
//       deviceDisplayName() itself is UNCHANGED in behaviour and stays
//       self-contained (see app.js's own comment at its definition -- several
//       tests extract it alone by name via tests/_extract.js). The event-feed
//       call site (renderEventDetail's getCachedDeviceName) now starts the
//       chain with deviceRegisteredName(...), not deviceDisplayName(...) --
//       A9 below pins that exact call-site line at the source level.
//   (B) _stateIsNewer(cand, cur) -- compares __seq first; on a tie compares
//       __savedAt; equal on both returns false. Backstops the storage-event
//       listener and reconcileDurableState() adoption sites.
//   (C) Avatar de-duplication -- writeSnapshot() parks a large char.faceImg in
//       the syncmeta IndexedDB store (avatarPut/avatarGet) instead of
//       inlining it in every snapshot payload, pruning to AVATAR_KEEP_MAX and
//       NEVER touching the unrelated 'base' key (the last-synced sync
//       baseline -- deleting it would be a real bug, not a cosmetic one).
//
// (A) and (B) are pure functions extracted by anchor (tests/_extract.js) and
// evaluated in isolation -- no IDB needed. (C) needs a syncmeta IndexedDB
// mock, written in the spirit of tests/snapshot-gfs.test.js's store mock but
// scoped to get/put/getAllKeys/getAll/delete on a single "syncmeta" store.
//
// Every extraction below is guarded (try/catch, or a typeof check inside the
// built function) so that running this file against the PRE-fix app.js does
// not crash before printing which specific assertions fail -- see the
// red/green gate procedure in the round-3 item-15 owner task notes.
//
// Run: node tests/round3-item15-owner.test.js  (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
const FAILED = Symbol('call-failed');
function safeCall(fn) { try { return fn(); } catch (e) { return FAILED; } }
async function safeAsync(fn) { try { return await fn(); } catch (e) { return FAILED; } }

// =====================================================================
// (A) deviceRegisteredName / deviceDisplayName
// =====================================================================
const devHelperMatch = appSrc.match(/\/\* BEGIN_DEVICENAME_HELPERS \*\/([\s\S]*?)\/\* END_DEVICENAME_HELPERS \*\//);
const devHelperCode = devHelperMatch ? devHelperMatch[1] : '';
const devHelperFactory = new Function(devHelperCode +
  "\nreturn { deviceRegisteredName: (typeof deviceRegisteredName==='function'?deviceRegisteredName:undefined)," +
  " deviceDisplayName: (typeof deviceDisplayName==='function'?deviceDisplayName:undefined) };");
const { deviceRegisteredName, deviceDisplayName } = devHelperFactory();

assert('A0: BEGIN/END_DEVICENAME_HELPERS block found in app.js', !!devHelperMatch);

const devices = [
  { id: 'd1', name: 'Kitchen Tablet', updatedAt: 1000 },
  { id: 'd2', name: '   ', updatedAt: 1000 },   // whitespace-only name
  { id: 'd3', name: '', updatedAt: 1000 },      // explicitly cleared name
];

assert('A1: deviceRegisteredName returns the trimmed registered name for a known device',
  safeCall(() => deviceRegisteredName(devices, 'd1')) === 'Kitchen Tablet');
assert('A2: deviceRegisteredName returns "" for an unknown device id',
  safeCall(() => deviceRegisteredName(devices, 'unknownDeviceXYZ')) === '');
assert('A3: deviceRegisteredName returns "" for a whitespace-only name',
  safeCall(() => deviceRegisteredName(devices, 'd2')) === '');
assert('A4: deviceRegisteredName returns "" for an explicitly empty name',
  safeCall(() => deviceRegisteredName(devices, 'd3')) === '');
assert('A5: deviceRegisteredName returns "" for a falsy devId',
  safeCall(() => deviceRegisteredName(devices, null)) === '' &&
  safeCall(() => deviceRegisteredName(devices, '')) === '');
assert('A6: deviceDisplayName is unchanged -- still returns the registered name for a known device',
  safeCall(() => deviceDisplayName(devices, 'd1')) === 'Kitchen Tablet');
assert('A7: deviceDisplayName is unchanged -- still falls back to the 6-char truncated id for an unknown device',
  safeCall(() => deviceDisplayName(devices, 'unknownDeviceXYZ')) === 'unknow');
assert('A8: deviceDisplayName is unchanged -- still falls back to the truncated id for a whitespace-only name',
  safeCall(() => deviceDisplayName(devices, 'd2')) === 'd2');

// A9: source-level pin -- the event-feed call site must resolve the name by
// asking deviceRegisteredName() first, NOT deviceDisplayName(). Whichever
// starts the chain matters: deviceDisplayName()'s own
// `|| String(devId).slice(0,6)` fallback is never falsy for a truthy devId,
// so a later `|| devNameFromEvents[devId]` rung could never run if it were
// still the first call -- exactly the bug item 15 fixed.
let callSiteLine = null;
try {
  callSiteLine = extractLine(appSrc, /const name = deviceRegisteredName\(S\.devices, devId\)/, 'event-feed devName callsite');
} catch (e) { /* leaves callSiteLine null -- asserted below */ }
assert('A9: event-feed devName resolution starts with deviceRegisteredName(...), not deviceDisplayName(...)',
  !!callSiteLine &&
  callSiteLine.indexOf('deviceRegisteredName(S.devices, devId) || devNameFromEvents[devId]') !== -1 &&
  callSiteLine.indexOf('deviceDisplayName(') === -1);

// =====================================================================
// (B) _stateIsNewer(cand, cur)
// =====================================================================
let stateIsNewerSrc = null;
try {
  stateIsNewerSrc = extractFunction(appSrc, /^function _stateIsNewer\(cand, cur\)\{/, '_stateIsNewer');
} catch (e) { /* leaves stateIsNewerSrc null -- assertions below fail cleanly */ }
const _stateIsNewer = stateIsNewerSrc ? new Function(stateIsNewerSrc + '\nreturn _stateIsNewer;')() : undefined;

assert('B0: _stateIsNewer found in app.js', typeof _stateIsNewer === 'function');
assert('B1: higher __seq wins regardless of __savedAt',
  safeCall(() => _stateIsNewer({ __seq: 5, __savedAt: 0 }, { __seq: 3, __savedAt: 9999999999 })) === true);
assert('B2: lower __seq loses even with a much higher __savedAt',
  safeCall(() => _stateIsNewer({ __seq: 2, __savedAt: 9999999999 }, { __seq: 5, __savedAt: 0 })) === false);
assert('B3: equal __seq -- higher __savedAt wins the tiebreak',
  safeCall(() => _stateIsNewer({ __seq: 5, __savedAt: 200 }, { __seq: 5, __savedAt: 100 })) === true);
assert('B4: equal __seq -- lower __savedAt loses the tiebreak',
  safeCall(() => _stateIsNewer({ __seq: 5, __savedAt: 100 }, { __seq: 5, __savedAt: 200 })) === false);
assert('B5: equal __seq AND equal __savedAt returns false (indistinguishable, not adopted)',
  safeCall(() => _stateIsNewer({ __seq: 5, __savedAt: 100 }, { __seq: 5, __savedAt: 100 })) === false);
assert('B6: missing fields on both sides coerce to 0 without throwing (tie -> false)',
  safeCall(() => _stateIsNewer({}, {})) === false);
assert('B7: null/undefined candidate and current coerce to 0 without throwing',
  safeCall(() => _stateIsNewer(null, undefined)) === false);
assert('B8: a non-numeric __seq coerces to 0 (not NaN) -- ties with a real 0, so __savedAt still decides',
  safeCall(() => _stateIsNewer({ __seq: 'not-a-number', __savedAt: 50 }, { __seq: 0, __savedAt: 10 })) === true);

// =====================================================================
// (C) Avatar de-duplication: avatarPut / avatarGet against a syncmeta mock
// =====================================================================
let avatarConstsSrc = null, avatarPutSrc = null, avatarGetSrc = null;
try {
  const keyPrefixLine = extractLine(appSrc, /^const AVATAR_KEY_PREFIX = /, 'AVATAR_KEY_PREFIX');
  const keepMaxLine = extractLine(appSrc, /^const AVATAR_KEEP_MAX = /, 'AVATAR_KEEP_MAX');
  avatarConstsSrc = keyPrefixLine + '\n' + keepMaxLine;
  avatarPutSrc = extractFunction(appSrc, /^async function avatarPut\(hash, dataUrl\)\{/, 'avatarPut');
  avatarGetSrc = extractFunction(appSrc, /^async function avatarGet\(hash\)\{/, 'avatarGet');
} catch (e) { /* leaves the *Src vars null -- C0 below reports it */ }

assert('C0: avatarPut/avatarGet and their AVATAR_* consts were found in app.js',
  !!avatarConstsSrc && !!avatarPutSrc && !!avatarGetSrc);

// Minimal in-memory mock of IDBDatabase scoped to a single "syncmeta" store,
// supporting exactly the operations avatarPut/avatarGet use: get, put,
// getAllKeys, getAll, delete, plus a readwrite tx's oncomplete/onerror/onabort.
// Modeled after tests/snapshot-gfs.test.js's store mock.
function makeSyncmetaDb(data) {
  function makeReq() { return { result: undefined, onsuccess: null, onerror: null }; }
  function resolveAsync(req, value) {
    Promise.resolve().then(function () {
      req.result = value;
      if (typeof req.onsuccess === 'function') req.onsuccess();
    });
  }
  function makeStore() {
    return {
      put: function (value, key) { data[key] = value; return makeReq(); },
      get: function (key) { const req = makeReq(); resolveAsync(req, data[key]); return req; },
      getAllKeys: function () { const req = makeReq(); resolveAsync(req, Object.keys(data)); return req; },
      // getAll() must return values in the SAME order as getAllKeys(), because
      // avatarPut pairs them by index -- it issues both reads in one synchronous
      // turn rather than awaiting getAllKeys() and then doing a get() per key,
      // which is the shape that meets TransactionInactiveError in a real browser.
      getAll: function () { const req = makeReq(); resolveAsync(req, Object.keys(data).map(function(k){ return data[k]; })); return req; },
      delete: function (key) { delete data[key]; return makeReq(); }
    };
  }
  return {
    transaction: function (storeName) {
      if (storeName !== 'syncmeta') throw new Error('unexpected object store: ' + storeName);
      const store = makeStore();
      const tx = { objectStore: function () { return store; }, onerror: null, onabort: null };
      let _oc = null, fired = false;
      Object.defineProperty(tx, 'oncomplete', {
        get: function () { return _oc; },
        set: function (fn) {
          _oc = fn;
          if (fn && !fired) { fired = true; Promise.resolve().then(function () { if (_oc) _oc(); }); }
        },
        configurable: true
      });
      return tx;
    }
  };
}

// Builds fresh avatarPut/avatarGet bound to a given idbOpen implementation.
// Returns undefined functions (never throws) if extraction failed above.
function buildAvatarFns(idbOpenImpl) {
  if (!avatarConstsSrc || !avatarPutSrc || !avatarGetSrc) return { avatarPut: undefined, avatarGet: undefined };
  const factory = new Function('idbOpen',
    avatarConstsSrc + '\n' + avatarPutSrc + '\n' + avatarGetSrc +
    '\nreturn { avatarPut: avatarPut, avatarGet: avatarGet };');
  return factory(idbOpenImpl);
}

async function runAvatarTests() {
  // 'base' pre-seeded: the last-synced sync baseline, which prune must never
  // touch even though it lives in the very same object store.
  const data = { base: { some: 'baseline-sync-data', notAnAvatar: true } };
  const idbOpenOk = function () { return Promise.resolve(makeSyncmetaDb(data)); };
  const { avatarPut, avatarGet } = buildAvatarFns(idbOpenOk);

  const ok1 = await safeAsync(() => avatarPut('h1', 'data:img1'));
  assert('C1: avatarPut resolves true on success', ok1 === true);

  const got1 = await safeAsync(() => avatarGet('h1'));
  assert('C2: avatarGet round-trips the stored dataUrl', got1 === 'data:img1');

  const missing = await safeAsync(() => avatarGet('does-not-exist'));
  assert('C3: avatarGet of an unknown hash returns null', missing === null);

  // Put 6 more avatars (h2..h7, 7 total) -- AVATAR_KEEP_MAX is 5, so this must
  // prune down to the 5 most recently written, without ever touching 'base'.
  for (let i = 2; i <= 7; i++) {
    await safeAsync(() => avatarPut('h' + i, 'data:img' + i));
  }
  const avatarKeys = Object.keys(data).filter(k => typeof k === 'string' && k.indexOf('avatar:') === 0);
  assert('C4: prune keeps at most AVATAR_KEEP_MAX(5) avatar keys after 7 puts', avatarKeys.length === 5);

  assert('C5: prune never touches the unrelated "base" baseline key',
    Object.prototype.hasOwnProperty.call(data, 'base') && data.base.some === 'baseline-sync-data');

  const oldest = await safeAsync(() => avatarGet('h1'));
  assert('C6: the oldest pruned avatar (h1) is gone after 7 puts with AVATAR_KEEP_MAX=5', oldest === null);

  const newest = await safeAsync(() => avatarGet('h7'));
  assert('C7: the newest avatar (h7) survived the prune', newest === 'data:img7');

  // Failure paths: both functions must degrade to false/null, never throw.
  const { avatarPut: putReject, avatarGet: getReject } =
    buildAvatarFns(function () { return Promise.reject(new Error('idb unavailable')); });
  const putResReject = await safeAsync(() => putReject('hX', 'dataX'));
  assert('C8: avatarPut returns false (not throw) when idbOpen rejects', putResReject === false);
  const getResReject = await safeAsync(() => getReject('hX'));
  assert('C9: avatarGet returns null (not throw) when idbOpen rejects', getResReject === null);

  const { avatarPut: putNull, avatarGet: getNull } =
    buildAvatarFns(function () { return Promise.resolve(null); });
  const putResNull = await safeAsync(() => putNull('hY', 'dataY'));
  assert('C10: avatarPut returns false when idbOpen resolves with no db', putResNull === false);
  const getResNull = await safeAsync(() => getNull('hY'));
  assert('C11: avatarGet returns null when idbOpen resolves with no db', getResNull === null);
}

runAvatarTests().catch(function (e) {
  console.error('Unhandled in runAvatarTests:', e && e.stack || e);
  failures++;
}).then(function () {
  if (failures) {
    console.error('\n' + failures + ' round3-item15-owner assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nround3-item15-owner.test.js: all assertions passed');
  process.exit(0);
});
