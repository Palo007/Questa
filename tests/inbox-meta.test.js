// inbox-meta.test.js -- TDD red gate for syncInboxWriteMeta() (contract:
// .omo/plans/android-inbox-step1.md, 2026-09-24 spec).
//
// syncInboxWriteMeta does not exist in sync.js yet. This file is expected to
// FAIL every case below, for that reason (function missing), not a
// syntax/setup error.
//
// Run: node tests/inbox-meta.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

let failures = 0;
function assert(desc, cond) { if (cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
async function attempt(desc, fn) {
  try { await fn(); }
  catch (e) { assert(desc + ' (threw: ' + (e && e.message || e) + ')', false); }
}

const noop = function () {};

function makeCtx() {
  const store = {};
  const uploads = []; // {path, text}

  const S = {
    tasks: [
      { id: 'h1', type: 'habit', title: 'Water', quickLog: true },
      { id: 'h2', type: 'habit', title: 'Stretch', quickLog: false },
      { id: 'd1', type: 'daily', title: 'Standup' },   // non-habit: must be ignored
      { id: 't1', type: 'todo', title: 'Buy milk' },    // non-habit: must be ignored
    ]
  };

  const sandbox = {
    window: {}, navigator: { onLine: true },
    document: { addEventListener: noop, getElementById: () => null,
      createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop, click: noop }),
      body: { appendChild: noop, removeChild: noop } },
    localStorage: {
      getItem: k => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }, key: () => null, length: 0
    },
    history: { replaceState: noop },
    location: { search: '', origin: 'https://test.example', pathname: '/', href: '' },
    crypto: { getRandomValues: arr => { for (let i = 0; i < arr.length; i++) arr[i] = i % 256; return arr; },
      subtle: { digest: async () => new ArrayBuffer(32) } },
    setTimeout: (fn, ms) => setTimeout(fn, 0), clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console, JSON, Math, Date, Map, Set, WeakSet, Array, Object, Number, String, Boolean, Promise,
    URLSearchParams, TextEncoder, Buffer, Uint8Array, ArrayBuffer, Error, isFinite, isNaN, parseInt, RegExp,
    logEvent: noop, toast: noop, render: noop, esc: x => x, save: noop, uid: () => 'test-device-1',
    idbOpen: () => Promise.resolve(null), getEvents: () => Promise.resolve([]),
    confirmDialog: () => Promise.resolve(true),
    S: S,
    dbxUploadText: async function (p, text) { uploads.push({ path: p, text: text }); return { rev: 'r' + uploads.length }; },
    fetch: async function () { return { ok: true, status: 200, json: async () => ({}), text: async () => '', headers: { get: () => null } }; }
  };
  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  try { vm.runInContext(src, sandbox); }
  catch (e) { console.error('FAIL: sync.js eval threw:', e); process.exit(1); }
  // Harness: seed a connected cfg, and install the base mocks AFTER sync.js ran --
  // its own function declarations replace any same-named sandbox property.
  store['questa.sync.v1'] = JSON.stringify({ enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'tok',
    accessExpiresAt: Date.now() + 3600000, deviceId: 'test-device-1', lastRev: null, lastError: null,
    evtLastUploadTs: 0, evtFileRevs: {}, evtFileCounts: {}, evtPushBlocked: {} });
  sandbox.dbxUploadText = async function (p, text) { uploads.push({ path: p, text: text }); return { rev: 'r' + uploads.length }; };

  return { sandbox, store, uploads, S };
}

// ===========================================================================
// Symbol presence.
// ===========================================================================
(function checkSymbolExists() {
  const { sandbox } = makeCtx();
  assert('sync.js exports syncInboxWriteMeta', typeof sandbox.syncInboxWriteMeta === 'function');
})();

// ===========================================================================
// 1. First call uploads once with {v:1, habits:[...]} containing only habit
//    tasks and their quickLog boolean.
// ===========================================================================
let firstUploadedHabits = null;
attempt('meta-1: first call uploads once with habit-only payload', async () => {
  const c = makeCtx();
  const changed = await c.sandbox.syncInboxWriteMeta();
  assert('meta-1: returns true (a change happened)', changed === true);
  assert('meta-1: exactly one dbxUploadText call', c.uploads.length === 1);
  assert('meta-1: uploaded to /inbox-meta/habits.json', c.uploads.length === 1 && c.uploads[0].path === '/inbox-meta/habits.json');
  let body = null;
  try { body = JSON.parse(c.uploads[0].text); } catch (e) {}
  assert('meta-1: payload has v:1', body && body.v === 1);
  assert('meta-1: payload.habits has exactly the 2 habit tasks', body && Array.isArray(body.habits) && body.habits.length === 2);
  assert('meta-1: payload.habits carries id/title/quickLog only for habits',
    body && body.habits && body.habits.every(h => 'id' in h && 'title' in h && 'quickLog' in h)
    && body.habits.some(h => h.id === 'h1' && h.quickLog === true)
    && body.habits.some(h => h.id === 'h2' && h.quickLog === false));
  firstUploadedHabits = body && body.habits;
}).then(() => {

// ===========================================================================
// 2. Non-habit tasks (daily/todo) are ignored entirely.
// ===========================================================================
return attempt('meta-2: non-habit tasks never appear in the payload', async () => {
  const c = makeCtx();
  await c.sandbox.syncInboxWriteMeta();
  let body = null;
  try { body = JSON.parse(c.uploads[0].text); } catch (e) {}
  assert('meta-2: no daily/todo ids leak into habits[]', body && body.habits && !body.habits.some(h => h.id === 'd1' || h.id === 't1'));
});

}).then(() => {

// ===========================================================================
// 3. Second call with no change -> no upload, returns false.
// ===========================================================================
return attempt('meta-3: unchanged habit set -> no second upload, returns false', async () => {
  const c = makeCtx();
  const first = await c.sandbox.syncInboxWriteMeta();
  assert('meta-3: first call uploads', first === true && c.uploads.length === 1);
  const second = await c.sandbox.syncInboxWriteMeta();
  assert('meta-3: second call with no change returns false', second === false);
  assert('meta-3: second call makes no additional upload', c.uploads.length === 1);
});

}).then(() => {

// ===========================================================================
// 4. Changing a habit title triggers exactly one more upload.
// ===========================================================================
return attempt('meta-4: a habit title change triggers exactly one more upload', async () => {
  const c = makeCtx();
  await c.sandbox.syncInboxWriteMeta();
  assert('meta-4: baseline upload happened', c.uploads.length === 1);
  const h1 = c.S.tasks.find(t => t.id === 'h1');
  h1.title = 'Drink water';
  const changed = await c.sandbox.syncInboxWriteMeta();
  assert('meta-4: title change is detected (returns true)', changed === true);
  assert('meta-4: exactly one additional upload (2 total)', c.uploads.length === 2);
});

}).then(() => {

console.log(failures ? ('\nFAILED: ' + failures + ' assertion(s)') : '\nALL PASSED');
process.exit(failures ? 1 : 0);

});
