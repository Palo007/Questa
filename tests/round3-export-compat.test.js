// round3-export-compat.test.js -- round-2 review items 5, 6 and 7.
//
// Item 5: _detokenizeEvents must REJECT an unknown short field code instead of
//         silently passing it through as a literal key. Today it falls into
//         `const f = RM[sk] || sk; ... else e[f]=v;` and a code that isn't in
//         _EXPORT_FIELD_MAP (a future build's field, or a corrupted file)
//         becomes a bogus field on the live event object instead of raising.
//
// Item 7: an explicit `null` in synthetic/repCounted/inferred/done must round
//         trip as `null`, not collapse into `false`. Today _tokenizeEvents
//         encodes it as `(v?1:0)` -- null becomes 0 -- and _detokenizeEvents
//         reads it back with `!!v` -- 0 becomes false. The event silently
//         forgets it never recorded a real value for that field.
//
// Item 6: the SHA-256 integrity hash silently changes ALGORITHM depending on
//         whether Web Crypto is available in the current context (HTTPS vs
//         HTTP/insecure), with no record of which one produced a given
//         backup's hash. computeHash() must gain a `hashAlgoName()` sibling
//         that reports which algorithm this context would use, and a
//         `computeHashWith(str, algo)` that can be forced to either one (and
//         rejects with .code === 'QUESTA_HASH_ALGO_UNAVAILABLE' if asked for
//         sha256 where crypto.subtle does not exist) -- so a backup can record
//         its algorithm and be verified reproducibly regardless of which
//         context reads it back.
//
// This file targets fixes NOT YET APPLIED to app.js. It is expected to FAIL
// against the current app.js; that failure is the point of writing it now.
//
// Run: node tests/round3-export-compat.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }

// ===========================================================================
// Sandbox 1 -- tokenize/detokenize helpers (items 5 and 7).
// Same sandbox-boot strip and slice technique as tests/tokenized-export.test.js
// lines 1-60: strip the top diagnostic window block (needs a real DOM), then
// eval just the pure helper slice from _EXPORT_FIELD_MAP to buildBackupFile.
// ===========================================================================
let src1 = appSrc.replace(/\/\/ Questa app logic[\s\S]*?if\(typeof window!=="undefined"\)\{[\s\S]*?\}\r?\n\r?\n/, '');

const noop = function(){};
const sandbox1 = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: { getItem: noop, setItem: noop, removeItem: noop, key: noop, length: 0 },
  indexedDB: undefined,
  setTimeout: function(fn){ return fn; }, clearTimeout: noop,
  setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set,
  Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
  logEvent: noop, toast: noop, render: noop, save: noop, esc: function(x){ return x; },
  uid: function(){ return 'test-uid'; },
  syncDeviceId: function(){ return 'dev-test'; }
};
sandbox1.self = sandbox1.window; sandbox1.globalThis = sandbox1;

vm.createContext(sandbox1);
const anchorA = 'const _EXPORT_FIELD_MAP';
const anchorB = 'async function buildBackupFile(';
const idxA = src1.indexOf(anchorA);
const idxB = src1.indexOf(anchorB);
if (idxA < 0 || idxB < 0) {
  console.error('FAIL: could not locate tokenize helpers in app.js');
  process.exit(1);
}
vm.runInContext(src1.slice(idxA, idxB), sandbox1);

const _tokenizeEvents = sandbox1._tokenizeEvents;
const _detokenizeEvents = sandbox1._detokenizeEvents;
if (typeof _tokenizeEvents !== 'function' || typeof _detokenizeEvents !== 'function') {
  console.error('FAIL: tokenize/detokenize helpers not exposed on sandbox');
  process.exit(1);
}

// ===========================================================================
// Item 5 -- unknown field code must be REJECTED, not renamed.
// ===========================================================================
function testItem5(){
  // A5a/A5b/A5c: a short key that is neither a passthrough key nor a value in
  // _EXPORT_FIELD_MAP must throw a tagged error.
  let threw = false, err = null;
  try {
    _detokenizeEvents({ E: [{ u: 'x', d: 'devA', t: 1, zz: 5 }], K: [], SRC: [], TID: [], TT: [] });
  } catch(e) { threw = true; err = e; }
  assert('A5a: _detokenizeEvents throws on an unknown short field code', threw);
  assert('A5b: the thrown error has code === QUESTA_UNKNOWN_FIELD_CODE', !!err && err.code === 'QUESTA_UNKNOWN_FIELD_CODE');
  assert('A5c: the thrown error carries fieldCode === "zz"', !!err && err.fieldCode === 'zz');

  // A5d: guard against over-rejection -- a real, well-formed envelope built by
  // _tokenizeEvents itself must still detokenize cleanly.
  let threwGood = false;
  try {
    const goodEnv = _tokenizeEvents([{ uid: 'g1', dev: 'devA', id: 'gid1', ts: 1720000000000, kind: 'tap', taskTitle: 'hello' }]);
    _detokenizeEvents(goodEnv);
  } catch(e) { threwGood = true; }
  assert('A5d: a well-formed envelope of known codes does not throw', !threwGood);

  // A5e: the passthrough keys uid/dev/id are still accepted.
  let threwPassthrough = false;
  try {
    _detokenizeEvents({ E: [{ uid: 'u1', dev: 'd1', id: 'i1' }], K: [], SRC: [], TID: [], TT: [] });
  } catch(e) { threwPassthrough = true; }
  assert('A5e: passthrough keys uid/dev/id do not throw', !threwPassthrough);

  // A5f: _tokenizeEvents writes `o[f]=v` for any field _EXPORT_FIELD_MAP does
  // not cover, so a LONG field name is a legitimate key in E. `winnerDev` is a
  // real one (see tests/conflict-attribution.test.js). It must NOT be rejected:
  // only a key shaped like a short code can be "a code from a newer build".
  let threwLong = false, longBack = null;
  try {
    longBack = _detokenizeEvents({ E: [{ uid: 'u1', dev: 'd1', t: 5, winnerDev: 'devB' }],
                                   K: [], SRC: [], TID: [], TT: [] })[0];
  } catch(e) { threwLong = true; }
  assert('A5f: a long untokenized field name does not throw', !threwLong);
  assert('A5g: ...and it survives with its name and value intact',
         !!longBack && longBack.winnerDev === 'devB');
}

// ===========================================================================
// Item 7 -- explicit null must survive the round trip as null.
// ===========================================================================
function testItem7(){
  const base = { uid: 'n1', dev: 'devA', ts: 1720000000000, kind: 'tap', taskTitle: 'x' };

  // A7a/A7b: explicit null in all four boolean-ish fields.
  const evNull = Object.assign({}, base, { synthetic: null, repCounted: null, inferred: null, done: null });
  const tokNull = _tokenizeEvents([evNull]);
  const rowNull = tokNull.E[0];
  assert('A7a: tokenized synthetic is strictly null (not 0, not -1)', rowNull.sy === null);
  assert('A7a: tokenized repCounted is strictly null', rowNull.rc === null);
  assert('A7a: tokenized inferred is strictly null', rowNull.in === null);
  assert('A7a: tokenized done is strictly null', rowNull.do === null);

  const roundTripped = JSON.parse(JSON.stringify(tokNull));
  const backNull = _detokenizeEvents(roundTripped)[0];
  assert('A7b: synthetic survives a JSON round trip as null', backNull.synthetic === null);
  assert('A7b: repCounted survives a JSON round trip as null', backNull.repCounted === null);
  assert('A7b: inferred survives a JSON round trip as null', backNull.inferred === null);
  assert('A7b: done survives a JSON round trip as null', backNull.done === null);

  // A7c: false still round-trips to false.
  const evFalse = Object.assign({}, base, { synthetic: false, repCounted: false, inferred: false, done: false });
  const backFalse = _detokenizeEvents(JSON.parse(JSON.stringify(_tokenizeEvents([evFalse]))))[0];
  assert('A7c: synthetic false round-trips to strictly false', backFalse.synthetic === false);
  assert('A7c: repCounted false round-trips to strictly false', backFalse.repCounted === false);
  assert('A7c: inferred false round-trips to strictly false', backFalse.inferred === false);
  assert('A7c: done false round-trips to strictly false', backFalse.done === false);

  // A7d: true still round-trips to true.
  const evTrue = Object.assign({}, base, { synthetic: true, repCounted: true, inferred: true, done: true });
  const backTrue = _detokenizeEvents(JSON.parse(JSON.stringify(_tokenizeEvents([evTrue]))))[0];
  assert('A7d: synthetic true round-trips to strictly true', backTrue.synthetic === true);
  assert('A7d: repCounted true round-trips to strictly true', backTrue.repCounted === true);
  assert('A7d: inferred true round-trips to strictly true', backTrue.inferred === true);
  assert('A7d: done true round-trips to strictly true', backTrue.done === true);

  // A7e: the old-build compatibility proof. Whatever value the tokenizer uses
  // to encode an explicit null, `!!v` on it must be false -- that is what
  // lets an OLDER build (whose detokenizer is still `e[f] = !!v`) degrade
  // gracefully to today's lossy-but-safe `false` instead of flipping to
  // `true`, which is what a `-1` sentinel would have done.
  assert('A7e: !!(tokenized null) === false (old-build safety net)', !!(rowNull.sy) === false);
}

// ===========================================================================
// Item 6 -- the hash must record which algorithm it used.
// Second vm sandbox, second slice: from `async function computeHash(` to the
// `// --- Backup snapshot read/list` comment, run once with crypto present
// (Node's webcrypto) and once with crypto undefined.
// ===========================================================================
const hashAnchorA = 'async function computeHash(';
const hashAnchorB = '// --- Backup snapshot read/list';
const hIdxA = appSrc.indexOf(hashAnchorA);
const hIdxB = appSrc.indexOf(hashAnchorB);
if (hIdxA < 0 || hIdxB < 0) {
  console.error('FAIL: could not locate computeHash slice in app.js');
  process.exit(1);
}
const hashSlice = appSrc.slice(hIdxA, hIdxB);

function makeHashSandbox(withCrypto){
  const sb = {
    console: console, Math: Math, JSON: JSON,
    Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    Uint8Array: Uint8Array, TextEncoder: TextEncoder,
    crypto: withCrypto ? require('crypto').webcrypto : undefined
  };
  sb.self = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(hashSlice, sb);
  return sb;
}

const sbCrypto = makeHashSandbox(true);
const sbNoCrypto = makeHashSandbox(false);

async function testItem6(){
  assert('A6a: hashAlgoName is a function', typeof sbCrypto.hashAlgoName === 'function');

  let a6b;
  try { a6b = sbCrypto.hashAlgoName(); } catch(e) { a6b = undefined; }
  assert('A6b: hashAlgoName() === "sha256" when crypto.subtle is present', a6b === 'sha256');

  let a6c;
  try { a6c = sbNoCrypto.hashAlgoName(); } catch(e) { a6c = undefined; }
  assert('A6c: hashAlgoName() === "fallback32" when crypto is absent', a6c === 'fallback32');

  assert('A6d: computeHashWith is a function', typeof sbCrypto.computeHashWith === 'function');

  let a6e = false;
  try {
    if (typeof sbCrypto.computeHashWith === 'function') {
      const fb = await sbCrypto.computeHashWith('abc', 'fallback32');
      const sha = await sbCrypto.computeHashWith('abc', 'sha256');
      a6e = typeof fb === 'string' && fb.indexOf('fallback-') === 0 && fb !== sha;
    }
  } catch(e) { a6e = false; }
  assert('A6e: computeHashWith("abc","fallback32") differs from computeHashWith("abc","sha256") (crypto present)', a6e);

  let a6f = false;
  try {
    if (typeof sbNoCrypto.computeHashWith === 'function') {
      await sbNoCrypto.computeHashWith('abc', 'sha256');
      a6f = false; // should have rejected, did not
    }
  } catch(e) {
    a6f = !!(e && e.code === 'QUESTA_HASH_ALGO_UNAVAILABLE');
  }
  assert('A6f: computeHashWith("abc","sha256") rejects with QUESTA_HASH_ALGO_UNAVAILABLE when crypto is absent', a6f);

  let a6g = false;
  try {
    if (typeof sbCrypto.computeHashWith === 'function' && typeof sbNoCrypto.computeHash === 'function') {
      const fromCryptoSandbox = await sbCrypto.computeHashWith('abc', 'fallback32');
      const fromNoCryptoSandbox = await sbNoCrypto.computeHash('abc');
      a6g = fromCryptoSandbox === fromNoCryptoSandbox;
    }
  } catch(e) { a6g = false; }
  assert('A6g: fallback32 digest (crypto-present sandbox) matches computeHash (crypto-absent sandbox) -- HTTPS build can reproduce an HTTP build\'s digest', a6g);
}

(async function main(){
  try {
    testItem5();
    testItem7();
  } catch(e) {
    console.error('Unhandled (sync):', e && e.stack || e);
    failures++;
  }
  try {
    await testItem6();
  } catch(e) {
    console.error('Unhandled (async):', e && e.stack || e);
    failures++;
  }
  if (failures) { console.error(failures + ' round3-export-compat assertion(s) FAILED'); process.exit(1); }
  console.log('round3-export-compat.test.js: all assertions passed');
  process.exit(0);
})();
