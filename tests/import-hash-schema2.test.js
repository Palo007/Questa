// import-hash-schema2.test.js -- PWA-26: the integrity hash check must run on a
// real schema-2 (tokenized) backup when it goes through the REAL importData().
//
// Why this file exists: importData() detokenizes a schema-2 envelope into a
// fresh `data` object. _tokenizeSnapshot() never carries `_backup` (it lives on
// the envelope, not in S), so unless importData copies `parsed._backup` onto
// `data` the gate `if(data._backup && data._backup.hash)` is silently false and
// a tampered file imports without a word. tokenized-export.test.js T6/T7 test a
// hand copy of the import path; import-data-merge.test.js runs the real
// function but only on schema-1 files with no hash. Neither goes red if the
// `_backup` copy is removed. This one does.
//
//   H0  precondition: the app's own export yields schema 2, sha256, 64-hex hash, 3 events
//   H1  a valid schema-2 file is accepted, and the hash was checked exactly once
//   H2  one character changed in an event title (TT[0]) is rejected with the hard stop
//   H2b one character changed in a task title inside the snapshot is rejected too
//   H3  schema-1 with no hash: passes straight through, no hash check
//   H4  schema-1 with a hash: accepted when intact (H4a), rejected when one ts moves (H4b)
//   H5  shared golden fixture (tests/fixtures/golden_backup.json, a byte-identical
//       copy of Questa-Kotlin/fixtures/golden_backup.json, source SHA-256
//       df71d7a97c897a3e1ee2f5d4606b302e366c5c0e93dfde9163b4f65821bf1a70):
//       accepted, then rejected once TT[0] is tampered. It has no hashAlgo, so it
//       also exercises the prefix-inference branch.
//
// The picker (showImportSectionPicker) is a spy: it is the "accepted" signal.
// The apply path, IndexedDB, now() and the DOM are never reached; they are
// covered by import-data-merge.test.js. No now() slice is evald here.
//
// Run: node tests/import-hash-schema2.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

function sliceBetween(a, b, label) {
  const i = appSrc.indexOf(a), j = appSrc.indexOf(b);
  if (i < 0 || j < 0 || j <= i) {
    console.error('FAIL: could not locate ' + label + ' slice in app.js');
    process.exit(1);
  }
  return appSrc.slice(i, j);
}

// Slice T: tokenizer + detokenizer + the whole GRANULAR_IO_HELPERS block.
// Do NOT eval the granular helpers a second time (const IO_SECTIONS would clash).
const tokSlice = sliceBetween('const _EXPORT_FIELD_MAP', 'async function buildBackupFile(', 'tokenizer');
// Slice H: computeHash, _hashFallback32, hashAlgoName, computeHashWith.
const hashSlice = sliceBetween('async function computeHash(', '// --- Backup snapshot read/list', 'hash');
const buildBackupFileFn = extractFunction(appSrc, /^async function buildBackupFile\(eventsArr, sectionKeys\)\{/, 'buildBackupFile');
const importDataFn = extractFunction(appSrc, /^function importData\(ev\)\{/, 'importData');

const MISMATCH_TEXT = 'This file appears to be corrupted or tampered with (hash mismatch). Import cancelled.';

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Same fake as import-data-merge.test.js: readAsText resolves on a microtask.
function FakeFileReader() {}
FakeFileReader.prototype.readAsText = function (f) {
  const self = this;
  Promise.resolve().then(function () {
    self.result = f && f.__content;
    if (typeof self.onload === 'function') self.onload();
  });
};

function FakeBlob(parts, opts) { this.parts = parts; this.type = opts && opts.type; }

const noop = function () {};
const calls = { picker: [], alerts: [], hash: [] };

const sb = {
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set,
  Object: Object, Array: Array, Number: Number, String: String, Boolean: Boolean,
  Promise: Promise, Error: Error, TypeError: TypeError, RegExp: RegExp,
  Uint8Array: Uint8Array, TextEncoder: TextEncoder,
  crypto: require('crypto').webcrypto,
  APP_VERSION: 'test',
  _fileStamp: function () { return 'test'; },
  Blob: FakeBlob,
  FileReader: FakeFileReader,
  _qDiagPush: noop,
  alertDialog: function (title, text) { calls.alerts.push({ title: title, text: text }); },
  showImportSectionPicker: function (data, detected) { calls.picker.push({ data: data, detected: detected }); },
  S: null
};
sb.self = sb; sb.window = sb; sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(tokSlice + '\n' + hashSlice + '\n' + buildBackupFileFn + '\n' + importDataFn, sb);

// Counting spy around the real computeHashWith. importData resolves the global
// at call time, so the wrapper takes effect there.
const realHashWith = sb.computeHashWith;
sb.computeHashWith = function (str, algo) { calls.hash.push(algo); return realHashWith(str, algo); };

function reset() { calls.picker.length = 0; calls.alerts.length = 0; calls.hash.length = 0; }

function makeEv(text) { return { target: { files: [{ __content: text }], value: 'x' } }; }

// crypto.subtle.digest completes on the threadpool, not as a microtask, so poll.
function waitFor(pred, ms) {
  const t0 = Date.now();
  return new Promise(function (resolve) {
    (function tick() {
      if (pred() || Date.now() - t0 > ms) setTimeout(resolve, 0);
      else setTimeout(tick, 5);
    })();
  });
}

async function runImport(text) {
  reset();
  sb.importData(makeEv(text));
  await waitFor(function () { return calls.picker.length + calls.alerts.length >= 1; }, 2000);
}

// Cross-realm safe structural compare: sorted-key JSON.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }
  return JSON.stringify(v);
}
function same(a, b) { return canon(a) === canon(b); }

function bumpChar(s) {
  const c = s.charCodeAt(s.length - 1);
  return s.slice(0, -1) + String.fromCharCode(c === 122 ? 121 : c + 1);
}

function isRejected() {
  return calls.alerts.length === 1 && calls.alerts[0].title === 'Import Error' &&
    calls.alerts[0].text === MISMATCH_TEXT && calls.picker.length === 0;
}

(async function main() {
  // --- Fixture: generated by the app's own export ---------------------------
  const tasks = [
    { id: 't1', title: 'Task Alpha', type: 'habit', createdAt: 1700000000000, updatedAt: 1700000100000 },
    { id: 't2', title: 'Task Beta', type: 'daily', createdAt: 1700000200000, updatedAt: 1700000300000 }
  ];
  sb.S = {
    char: { name: 'Hash Test', lvl: 3 },
    tasks: tasks,
    rewards: [],
    tags: [],
    prefs: { an: { views: [] } }
  };
  const events = [
    { uid: 'u1', dev: 'd1', ts: 1700000400000, kind: 'tap', taskId: 't1', taskTitle: 'Task Alpha', dir: 1 },
    { uid: 'u2', dev: 'd1', ts: 1700000500000, kind: 'tap', taskId: 't2', taskTitle: 'Task Beta', dir: -1 },
    { uid: 'u3', dev: 'd1', ts: 1700000600000, kind: 'tap', taskId: 't1', taskTitle: 'Task Alpha', dir: 1 }
  ];
  const built = await sb.buildBackupFile(events);
  const envText = built.blob.parts[0];
  const env = JSON.parse(envText);

  // --- H0 --------------------------------------------------------------------
  assert('H0 envelope is schema 2', env._backup && env._backup.schema === 2);
  assert('H0 envelope hashAlgo is sha256', env._backup && env._backup.hashAlgo === 'sha256');
  assert('H0 envelope hash is 64 hex chars', env._backup && /^[0-9a-f]{64}$/.test(String(env._backup.hash)));
  assert('H0 envelope carries 3 tokenized events', Array.isArray(env.E) && env.E.length === 3);

  // --- H1 --------------------------------------------------------------------
  await runImport(envText);
  assert('H1 valid schema-2 file opens the picker once', calls.picker.length === 1);
  assert('H1 valid schema-2 file raises no alert', calls.alerts.length === 0);
  assert('H1 computeHashWith called exactly once, with sha256', calls.hash.length === 1 && calls.hash[0] === 'sha256');
  if (calls.picker.length === 1) {
    const p = calls.picker[0];
    assert('H1 picker.data.tasks equals S.tasks', same(p.data.tasks, tasks));
    assert('H1 picker.data.events equals the exported events', same(p.data.events, events));
    assert('H1 detected sections include events', Array.isArray(p.detected) && p.detected.indexOf('events') !== -1);
  }

  // --- H2: one event title character changed --------------------------------
  {
    const t = JSON.parse(envText);
    t.TT[0] = bumpChar(t.TT[0]);
    await runImport(JSON.stringify(t, null, 2));
    assert('H2 tampered event title is rejected with the hash-mismatch hard stop', isRejected());
    assert('H2 tampered event title never opens the picker', calls.picker.length === 0);
  }

  // --- H2b: one task title character changed inside the snapshot ------------
  {
    const t = JSON.parse(envText);
    const sText = JSON.stringify(t.S);
    assert('H2b precondition: snapshot holds "Task Beta"', sText.indexOf('"Task Beta"') !== -1);
    t.S = JSON.parse(sText.replace('"Task Beta"', '"Task Betb"'));
    await runImport(JSON.stringify(t, null, 2));
    assert('H2b tampered snapshot task title is rejected with the hash-mismatch hard stop', isRejected());
  }

  // --- H3: schema-1, no hash --------------------------------------------------
  {
    const legacy = { char: { name: 'Legacy', lvl: 1 }, tasks: tasks, events: events };
    await runImport(JSON.stringify(legacy));
    assert('H3 schema-1 without hash opens the picker once', calls.picker.length === 1);
    assert('H3 schema-1 without hash raises no alert', calls.alerts.length === 0);
    assert('H3 schema-1 without hash is never hash-checked', calls.hash.length === 0);
    assert('H3 picker.data equals the input (pass-through branch)', calls.picker.length === 1 && same(calls.picker[0].data, legacy));
  }

  // --- H4: schema-1 with a hash ------------------------------------------------
  {
    const obj = { char: { name: 'Legacy', lvl: 1 }, tasks: tasks, events: events, _backup: { schema: 1, hashAlgo: 'sha256' } };
    obj._backup.hash = await realHashWith(JSON.stringify(obj), 'sha256');
    const good = JSON.stringify(obj);
    await runImport(good);
    assert('H4a schema-1 with valid hash is accepted', calls.picker.length === 1 && calls.alerts.length === 0);
    assert('H4a schema-1 with valid hash is checked once', calls.hash.length === 1);
    const bad = JSON.parse(good);
    bad.events[0].ts += 1;
    await runImport(JSON.stringify(bad));
    assert('H4b schema-1 with one ts moved is rejected with the hash-mismatch hard stop', isRejected());
  }

  // --- H5: shared golden fixture ---------------------------------------------
  {
    const goldenText = fs.readFileSync(path.join(__dirname, 'fixtures', 'golden_backup.json'), 'utf8');
    const golden = JSON.parse(goldenText);
    assert('H5 precondition: golden fixture is schema 2 with no hashAlgo',
      golden._backup && golden._backup.schema === 2 && !('hashAlgo' in golden._backup));
    await runImport(goldenText);
    assert('H5 golden fixture is accepted', calls.picker.length === 1 && calls.alerts.length === 0);
    assert('H5 golden fixture is hash-checked once with inferred sha256', calls.hash.length === 1 && calls.hash[0] === 'sha256');
    golden.TT[0] = bumpChar(golden.TT[0]);
    await runImport(JSON.stringify(golden, null, 2));
    assert('H5 golden fixture with TT[0] tampered is rejected with the hash-mismatch hard stop', isRejected());
  }

  if (failures) {
    console.error('\n' + failures + ' assertion(s) failed.');
    process.exit(1);
  }
  console.log('\nAll import-hash-schema2 assertions passed.');
})().catch(function (e) {
  console.error('FAIL: unexpected error: ' + (e && e.stack || e));
  process.exit(1);
});
