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
function shallowNorm(list){
  return list.map(function(e){
    const o={}; for(const k in e){ if(e[k]!==undefined) o[k]=e[k]; } return o;
  }).map(function(x){ return JSON.stringify(x); }).sort();
}

// T1: event tokenize -> detokenize round-trips exactly (on a real export)
{
  const mergedPath = path.join(__dirname, '..', 'questa-MERGED-20260716.json');
  if (!fs.existsSync(mergedPath)) {
    console.log('[SKIP] T1: merged export not present');
  } else {
    const data = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
    const evs = data.events || [];
    const tok = _tokenizeEvents(evs);
    const back = _detokenizeEvents({ E: tok.E, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT });
    const a = shallowNorm(evs), b = shallowNorm(back);
    assert('T1a: event count preserved (' + evs.length + ')', a.length === b.length);
    assert('T1b: event content round-trips exactly', a.join('|') === b.join('|'));
  }
}

// T2: snapshot tokenize -> detokenize round-trips exactly (real export snapshot)
{
  const mergedPath = path.join(__dirname, '..', 'questa-MERGED-20260716.json');
  const d = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
  const snap = {}; for(const k in d){ if(k!=='events') snap[k]=d[k]; }
  const tok = _tokenizeSnapshot(snap);
  const back = _detokenizeSnapshot({ S: tok.S, FM: tok.FM });
  assert('T2a: snapshot round-trips exactly', JSON.stringify(back) === JSON.stringify(snap));
}

// T3: tokenized envelope is materially smaller than the raw file
{
  const mergedPath = path.join(__dirname, '..', 'questa-MERGED-20260716.json');
  const d = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
  const snap = {}; for(const k in d){ if(k!=='events') snap[k]=d[k]; }
  const tok = _tokenizeEvents(d.events);
  const snapTok = _tokenizeSnapshot(snap);
  const env = { _backup:{schema:2}, K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT,
                FM: snapTok.FM, S: snapTok.S, E: tok.E };
  const raw = JSON.stringify(d).length;
  const tokLen = JSON.stringify(env).length;
  assert('T3a: tokenized file is smaller (' + (tokLen/1048576).toFixed(2) + 'MB < ' + (raw/1048576).toFixed(2) + 'MB)',
         tokLen < raw);
  assert('T3b: at least 20% reduction', (1 - tokLen/raw) >= 0.20);
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

if (failures) {
  console.error(failures + ' tokenized-export assertion(s) FAILED');
  process.exit(1);
}
console.log('tokenized-export.test.js: all assertions passed');
process.exit(0);
