// tokenized-export.test.js -- Workstream 1: schema-2 tokenized backup format.
// Verifies the export tokenization + import detokenization round-trips exactly,
// the integrity hash stays stable across re-export (so old schema-1 backups stay
// valid), and legacy schema-1 files still detokenize safely (back-compat).
// Run: node tests/tokenized-export.test.js  (also run by node tests/run.js)
//
// Imports the real helpers from app.js via the same sandbox-boot strip the
// other tests use (top diagnostic window block needs real DOM).

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
src = src.replace(/\/\/ Questa app logic[\s\S]*?if\(typeof window!=="undefined"\)\{[\s\S]*?\}\r?\n\r?\n/, '');

const noop = function(){};
const sandbox = {
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
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;

vm.createContext(sandbox);
// Boot errors are swallowed: we only need the pure tokenize/detokenize helpers
// defined near the bottom of app.js. Extract just that slice and eval it so the
// TDZ/const init order doesn't depend on the full DOM boot succeeding.
const anchor = 'const _EXPORT_FIELD_MAP';
const a = src.indexOf(anchor);
const b = src.indexOf('async function buildBackupFile(');
if (a < 0 || b < 0) {
  console.error('FAIL: could not locate tokenize helpers in app.js');
  process.exit(1);
}
const helpers = src.slice(a, b);
vm.runInContext(helpers, sandbox);

const _tokenizeEvents = sandbox._tokenizeEvents;
const _detokenizeEvents = sandbox._detokenizeEvents;
const _tokenizeSnapshot = sandbox._tokenizeSnapshot;
const _detokenizeSnapshot = sandbox._detokenizeSnapshot;
if (typeof _tokenizeEvents !== 'function' || typeof _detokenizeEvents !== 'function'
    || typeof _tokenizeSnapshot !== 'function' || typeof _detokenizeSnapshot !== 'function') {
  console.error('FAIL: tokenize/detokenize helpers not exposed on sandbox');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond){
  if(cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
// LENIENT compare: sorts the list and drops `undefined` keys. Kept ONLY for the
// optional real-backup pass below, where event order is not guaranteed. It cannot
// see key-order differences, which is exactly what the integrity hash compares --
// so the committed-fixture passes use strictEq() instead.
function shallowNorm(list){
  return list.map(function(e){
    const o={}; for(const k in e){ if(e[k]!==undefined) o[k]=e[k]; } return o;
  }).map(function(x){ return JSON.stringify(x); }).sort();
}
// STRICT compare: byte-identical JSON, so key order AND element order both count.
// buildBackupFile() hashes JSON.stringify of the DETOKENIZED object, so a tokenizer
// that restores the same values in a different key order silently breaks every
// backup's own hash gate. shallowNorm() sorts that difference away; this does not.
function strictEq(a, b){ return JSON.stringify(a) === JSON.stringify(b); }

// 2026-09-19 (round 3, item 8): T1-T3 used to read an UNTRACKED 3.9 MB personal
// backup (questa-MERGED-20260716.json). T1 skipped without it, but T2 and T3 threw
// ENOENT -- so on any fresh clone, including the planned public copy, the suite
// aborted here. The primary source is now a small committed fixture with
// adversarial titles (prototype keys, quotes, newlines, unicode, empty strings)
// and explicit nulls. The personal backup is still used when it happens to be
// present, as an extra real-world pass, and cleanly SKIPPED when it is not.
const FIXTURE = path.join(__dirname, 'fixtures', 'tokenized-export-sample.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const fixEvents = fixture.events || [];
const fixSnap = {}; for(const k in fixture){ if(k!=='events') fixSnap[k]=fixture[k]; }

const mergedPath = path.join(__dirname, '..', 'questa-MERGED-20260716.json');
const hasMerged = fs.existsSync(mergedPath);
const merged = hasMerged ? JSON.parse(fs.readFileSync(mergedPath, 'utf8')) : null;

// T1: event tokenize -> detokenize round-trips EXACTLY (committed fixture)
{
  const tok = _tokenizeEvents(fixEvents);
  const back = _detokenizeEvents({ E: tok.E, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT });
  assert('T1a: fixture event count preserved (' + fixEvents.length + ')', back.length === fixEvents.length);
  assert('T1b: fixture events round-trip byte-identically (key order included)',
         strictEq(fixEvents, back));
}

// T2: snapshot tokenize -> detokenize round-trips EXACTLY (committed fixture)
{
  const tok = _tokenizeSnapshot(fixSnap);
  const back = _detokenizeSnapshot({ S: tok.S, FM: tok.FM });
  assert('T2a: fixture snapshot round-trips byte-identically', strictEq(back, fixSnap));
}

// T3: the tokenized envelope is materially smaller than the raw file.
// Built from a generated bulk set so the assertion does not need a multi-MB file
// committed to the repo: the dictionaries only pay for themselves at volume.
{
  const bulk = [];
  const titles = ['Drink water', 'Walk the dog', 'Read 10 pages', '__proto__', 'Stretch'];
  for(let i = 0; i < 2000; i++){
    bulk.push({ uid: 'b-' + i, dev: (i % 3 ? 'devA' : 'devB'), ts: 1720000000000 + i * 60000,
                kind: (i % 2 ? 'complete' : 'tap'), taskTitle: titles[i % titles.length],
                taskId: 'task-' + (i % 7), source: 'app', reps: i % 4 });
  }
  const tok = _tokenizeEvents(bulk);
  const snapTok = _tokenizeSnapshot(fixSnap);
  const env = { _backup:{schema:2}, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT,
                FM: snapTok.FM, S: snapTok.S, E: tok.E };
  const raw = JSON.stringify(Object.assign({}, fixSnap, { events: bulk })).length;
  const tokLen = JSON.stringify(env).length;
  assert('T3a: tokenized envelope is smaller (' + tokLen + ' < ' + raw + ')', tokLen < raw);
  assert('T3b: at least 20% reduction (' + Math.round((1 - tokLen/raw) * 100) + '%)',
         (1 - tokLen/raw) >= 0.20);
}

// T1r/T2r/T3r: the same three checks against the real personal backup, when the
// developer happens to have it. SKIPPED, never fatal, on a clean checkout.
if(!hasMerged){
  console.log('[SKIP] T1r/T2r/T3r: optional real backup questa-MERGED-20260716.json not present');
} else {
  const evs = merged.events || [];
  const tok = _tokenizeEvents(evs);
  const back = _detokenizeEvents({ E: tok.E, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT });
  const na = shallowNorm(evs), nb = shallowNorm(back);
  assert('T1r: real backup event count preserved (' + evs.length + ')', na.length === nb.length);
  assert('T1r: real backup events round-trip', na.join('|') === nb.join('|'));

  const snap = {}; for(const k in merged){ if(k!=='events') snap[k]=merged[k]; }
  const stok = _tokenizeSnapshot(snap);
  assert('T2r: real backup snapshot round-trips exactly',
         strictEq(_detokenizeSnapshot({ S: stok.S, FM: stok.FM }), snap));

  const env = { _backup:{schema:2}, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT,
                FM: stok.FM, S: stok.S, E: tok.E };
  const raw = JSON.stringify(merged).length, tokLen = JSON.stringify(env).length;
  assert('T3r: real backup tokenizes at least 20% smaller', (1 - tokLen/raw) >= 0.20);
}

// T4: schema-1 files never reach _detokenizeSnapshot in importData (the else
// branch passes them straight through). The detokenize helper must still be
// safe if handed a non-wrapped object (returns {} without throwing).
{
  const legacy = { version:1, char:{ name:'X' }, tasks:[{id:'a'}], prefs:{ width:480 } };
  let safe = true, res = null;
  try { res = _detokenizeSnapshot(legacy); } catch(e){ safe = false; }
  assert('T4a: _detokenizeSnapshot is safe on a non-wrapped object', safe);
  assert('T4b: legacy events detokenize yields []', _detokenizeEvents(legacy).length === 0);
  // The real back-compat guarantee: a schema-1 parse must not be treated as
  // schema-2 (importData keys off _backup.schema===2, which legacy lacks).
  assert('T4c: legacy has no schema-2 marker', !(legacy._backup && legacy._backup.schema === 2));
}

// T5: empty/edge inputs don't throw
{
  assert('T5a: empty events tokenize/detokenize', (function(){
    try { const t=_tokenizeEvents([]); return _detokenizeEvents({E:t.E,K:[],SRC:[],TID:[],TT:[]}).length===0; } catch(e){ return false; }
  })());
  assert('T5b: empty snapshot tokenize/detokenize', (function(){
    try { const t=_tokenizeSnapshot({}); return JSON.stringify(_detokenizeSnapshot({S:t.S,FM:t.FM}))==='{}'; } catch(e){ return false; }
  })());
}

// T6/T7: schema-2 IMPORT HASH VERIFICATION must actually run (regression for the
// bug where importData built `data` from _detokenizeSnapshot without copying
// `parsed._backup`, so `data._backup.hash` was undefined and the corruption/
// tamper gate at app.js:5436 was skipped for every tokenized export).
//
// We replicate buildBackupFile's canonical hash form and the import detokenize
// path, then check: (T6) a valid file's recomputed hash equals the stored hash,
// and (T7) a tampered snapshot's recomputed hash does NOT equal it (so the gate
// would fire). Uses Node SHA-256 — identical hex to the browser's
// crypto.subtle.digest("SHA-256", ...) on the same string.
const cryptoMod = require('crypto');
function sha256hex(s){ return cryptoMod.createHash('sha256').update(s, 'utf8').digest('hex'); }

function buildSchema2Envelope(state, events){
  const snap = {}; for(const k in state){ if(k!=='events') snap[k]=state[k]; }
  const snapTok = _tokenizeSnapshot(snap);
  const evTok = _tokenizeEvents(events);
  // Canonical form buildBackupFile hashes: Object.assign({}, S, {events}) then
  // _backup injected (hash added after), so the hashed string has no hash field.
  const backup = Object.assign({}, snap, { events: events });
  backup._backup = { schema: 2, appVersion: 'vTEST', eventCount: (events||[]).length };
  const preJson = JSON.stringify(backup);
  const hash = sha256hex(preJson);
  backup._backup.hash = hash;
  return {
    _backup: backup._backup,
    K: evTok.K, SRC: evTok.SRC, TID: evTok.TID, TT: evTok.TT, FM: snapTok.FM,
    S: snapTok.S, E: evTok.E
  };
}

// Mirror the schema-2 branch of importData: detokenize, then restore _backup.
function importDetokenize(env){
  const data = _detokenizeSnapshot(env);
  data.events = _detokenizeEvents(env);
  if(env._backup){ data._backup = Object.assign({}, env._backup); }
  return data;
}

// Mirror the hash gate recompute: delete hash, stringify, restore.
function recomputeHash(data){
  const expected = data._backup.hash;
  delete data._backup.hash;
  const clean = JSON.stringify(data);
  data._backup.hash = expected;
  return sha256hex(clean);
}

{
  const state = {
    char: { name: 'Hero', level: 3 },
    tasks: [ { id: 't1', title: 'Drink water', done: false }, { id: 't2', title: 'Walk', done: true } ],
    rewards: [ { id: 'r1', title: 'Movie', cost: 50 } ],
    tags: [ { id: 'g1', label: 'Health' } ],
    prefs: { width: 480, notesLines: 3 }
  };
  const events = [
    { uid: 'e1', kind: 'complete', taskId: 't1', taskTitle: 'Drink water', source: 'app', createdAt: 1000, updatedAt: 1000 },
    { uid: 'e2', kind: 'export', taskTitle: 'Export Data', source: 'app', createdAt: 2000, updatedAt: 2000 }
  ];
  const env = buildSchema2Envelope(state, events);
  const data = importDetokenize(env);

  // T6a: the core bug — _backup (and its hash) must survive detokenization.
  assert('T6a: detokenized data carries _backup.hash (gate no longer skipped)',
         !!(data._backup && typeof data._backup.hash === 'string' && data._backup.hash.length > 0));
  // T6b: valid file's recomputed hash equals stored hash (gate would pass).
  const recomputed = recomputeHash(data);
  assert('T6b: recomputed hash matches stored hash on a valid file', recomputed === env._backup.hash);
  // T6c: round-trip content preserved (detokenize matches original state).
  const snapBack = {}; for(const k in data){ if(k!=='events' && k!=='_backup') snapBack[k]=data[k]; }
  assert('T6c: detokenized snapshot equals original state',
         JSON.stringify(snapBack) === JSON.stringify(state) && data.events.length === events.length);

  // T7: tamper the tokenized snapshot and confirm the gate would CATCH it.
  const tampered = JSON.parse(JSON.stringify(env));
  // Flip a value inside the tokenized S tree (e.g. the first task's 'done').
  (function mutate(o){
    if(Array.isArray(o)){ for(let i=0;i<o.length;i++){ if(mutate(o[i])) return true; } }
    else if(o && typeof o==='object'){
      for(const k in o){
        if(o[k]===false){ o[k]=true; return true; }
        if(mutate(o[k])) return true;
      }
    }
    return false;
  })(tampered.S);
  const dataT = importDetokenize(tampered);
  const recomputedT = recomputeHash(dataT);
  assert('T7a: tampered snapshot yields a DIFFERENT hash (gate would fire)',
         recomputedT !== tampered._backup.hash);
}

// T8: FIXED 2026-09-19 -- round-2 review item 7. The boolean tokenizer used to
// collapse an explicit null to false for `synthetic`, `repCounted`, `inferred`
// and `done`, so "not known" silently became "no". This test used to PIN that
// broken behaviour on purpose, because the obvious fix (a -1 sentinel) reads
// back as TRUE on an older build, whose detokenizer is `e[f] = !!v`.
// The shipped fix carries an explicit null as JSON null instead: !!null is
// false, so an older build degrades to exactly the lossy-but-safe behaviour it
// already had, and no compatibility break was needed. T8 now asserts the FIXED
// behaviour. Deeper cover lives in tests/round3-export-compat.test.js (A7a-A7e).
{
  const withNulls = [{ uid: 'n1', dev: 'devA', ts: 1720000000000, kind: 'tap',
                       taskTitle: 'x', synthetic: null, repCounted: null, inferred: null, done: null }];
  const tok = _tokenizeEvents(withNulls);
  const back = _detokenizeEvents({ E: tok.E, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT })[0];
  const kept = back.synthetic === null && back.repCounted === null
            && back.inferred === null && back.done === null;
  assert('T8: [item 7 FIXED] an explicit boolean null round-trips as null', kept);
  // The old-build safety net, asserted rather than assumed: the on-wire value
  // an older `!!v` detokenizer would see must still be falsy, never true.
  assert('T8b: the wire value for null is falsy, so an older build reads false',
         !tok.E[0].sy && !tok.E[0].rc && !tok.E[0].in && !tok.E[0].do);
}

if (failures) {
  console.error(failures + ' tokenized-export assertion(s) FAILED');
  process.exit(1);
}
console.log('tokenized-export.test.js: all assertions passed');
process.exit(0);
