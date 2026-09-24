// inbox-consume.test.js -- TDD red gate for the Android-shortcut inbox feature
// (contract: .omo/plans/android-inbox-step1.md, 2026-09-24 spec handed to Claude).
//
// NONE of syncInboxConsume / syncInboxFinish / syncInboxWriteMeta / dbxMove /
// inboxParseRecord exist in sync.js yet. This file is expected to FAIL every
// case below -- for that reason, not a syntax/setup error. Once the feature
// lands, un-skip nothing (there is nothing to un-skip); the same assertions
// should start passing.
//
// Cases mirror the contract's own labels (2a..2g) plus extras called out in
// the spec (throttle, boot-gate short-circuit, watermark lowering, dbxMove
// status-code matrix, inboxParseRecord unit checks).
//
// Run: node tests/inbox-consume.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');

let src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
src = src.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

let failures = 0;
function assert(desc, cond) { if (cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
// Every scenario below reaches into functions the contract says will exist
// but don't yet -- wrap each one so a missing function is a labelled [FAIL],
// not an uncaught-exception process crash (matches the boot-gate-inert-cards
// pattern in this same tests/ dir).
async function attempt(desc, fn) {
  try { await fn(); }
  catch (e) { assert(desc + ' (threw: ' + (e && e.message || e) + ')', false); }
}

const noop = function () {};
const pending = []; // every top-level case IIFE below pushes its promise here

// ---------------------------------------------------------------------------
// Fake Dropbox: an in-memory Map path -> {text, rev}. Mirrors the real
// dbx* helpers' observable behavior (list/move/download/delete/upload) so
// syncInboxConsume/syncInboxFinish can run against it once implemented.
// ---------------------------------------------------------------------------
function makeFakeDropbox() {
  const files = new Map(); // path -> {text, rev}
  let revCounter = 0;
  return {
    files,
    put(p, text) { files.set(p, { text, rev: 'r' + (++revCounter) }); },
    // list direct children of `dir` (dir must end without trailing slash)
    listChildren(dir) {
      const prefix = dir.replace(/\/$/, '') + '/';
      const out = [];
      for (const p of files.keys()) {
        if (p.startsWith(prefix) && p.slice(prefix.length).indexOf('/') === -1) {
          out.push({ '.tag': 'file', name: p.slice(prefix.length) });
        }
      }
      return out;
    },
    move(from, to) {
      if (!files.has(from)) return false;
      files.set(to, files.get(from));
      files.delete(from);
      return true;
    },
    del(p) { files.delete(p); }
  };
}

function makeCtx(opts) {
  opts = opts || {};
  const store = {};
  const dbx = makeFakeDropbox();
  const diag = [];
  const qDiagPush = function (kind, data) { diag.push({ kind, data }); };

  const S = { tasks: [{ id: 'h1', title: 'Water', type: 'habit', cUp: 0, cDown: 0, quickLog: true }] };

  const fakeEventUids = new Set();
  const applyInboxLogCalls = [];
  const fakeApplyInboxLog = function (rec, nowMs) {
    applyInboxLogCalls.push({ rec, nowMs });
    const t = S.tasks.find(x => x.id === rec.habitId);
    if (!t) return 'unknown';
    if (rec.dir > 0) t.cUp = (t.cUp || 0) + 1; else t.cDown = (t.cDown || 0) + 1;
    fakeEventUids.add('inbox-' + rec.id);
    return 'applied';
  };
  const fakeEvtHasUid = function (uid) { return Promise.resolve(fakeEventUids.has(uid)); };

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
    // Contract stubs -- syncInboxConsume is specced to no-op unless BOTH exist.
    applyInboxLog: opts.noApplyInboxLog ? undefined : fakeApplyInboxLog,
    evtHasUid: opts.noEvtHasUid ? undefined : fakeEvtHasUid,
    bootGateBlocksInput: () => !!opts.gated,
    _qDiagPush: qDiagPush,
    // fetch backs dbxMove (and anything else the real dbx* helpers call).
    fetch: async function (url, init) {
      if (opts.fetchOverride) { const r = opts.fetchOverride(url, init); if (r) return r; }
      const body = init && init.body ? JSON.parse(init.body) : {};
      if (String(url).indexOf('/files/move_v2') !== -1) {
        const ok = dbx.move(body.from_path, body.to_path);
        if (ok) return { ok: true, status: 200, json: async () => ({}), text: async () => '', headers: { get: () => null } };
        return { ok: false, status: 409, json: async () => ({ error_summary: 'path_lookup/not_found/from_lookup/...' }),
          text: async () => 'not_found', headers: { get: () => null } };
      }
      if (String(url).indexOf('/files/list_folder') !== -1) {
        const entries = dbx.listChildren(body.path);
        return { ok: true, status: 200, json: async () => ({ entries, has_more: false }), text: async () => '', headers: { get: () => null } };
      }
      if (String(url).indexOf('/files/download') !== -1) {
        const p = JSON.parse(init.headers['Dropbox-API-Arg']).path;
        const rec = dbx.files.get(p);
        if (!rec) return { ok: false, status: 409, json: async () => ({ error_summary: 'not_found' }), text: async () => 'not_found', headers: { get: () => null } };
        return { ok: true, status: 200, text: async () => rec.text, headers: { get: h => h.toLowerCase() === 'dropbox-api-result' ? JSON.stringify({ rev: rec.rev }) : null } };
      }
      if (String(url).indexOf('/files/delete_v2') !== -1) {
        dbx.del(body.path);
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', headers: { get: () => null } };
      }
      if (String(url).indexOf('/files/upload') !== -1) {
        // The state upload: record the body so tests assert on what was UPLOADED.
        const p = JSON.parse(init.headers['Dropbox-API-Arg']).path;
        dbx.put(p, String(init.body));
        return { ok: true, status: 200, json: async () => ({ rev: 'r-up' }), text: async () => '', headers: { get: () => null } };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'unhandled fetch: ' + url, headers: { get: () => null } };
    },
    // Base/remote-state plumbing _syncNowAttempt needs; not exercised by the
    // direct syncInboxConsume/syncInboxFinish calls below.
    syncBaseGet: () => Promise.resolve(null),
    syncBasePut: () => Promise.resolve(true)
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
  sandbox.syncBaseGet = () => Promise.resolve(null);
  sandbox.syncBasePut = () => Promise.resolve(true);

  return { sandbox, dbx, store, diag, S, applyInboxLogCalls, fakeEventUids };
}

// ===========================================================================
// Contract-symbol presence -- the direct, unambiguous "not implemented yet"
// signal. All five are expected to be missing right now.
// ===========================================================================
(function checkSymbolsExist() {
  const { sandbox } = makeCtx();
  assert('sync.js exports syncInboxConsume', typeof sandbox.syncInboxConsume === 'function');
  assert('sync.js exports syncInboxFinish', typeof sandbox.syncInboxFinish === 'function');
  assert('sync.js exports syncInboxWriteMeta', typeof sandbox.syncInboxWriteMeta === 'function');
  assert('sync.js exports dbxMove', typeof sandbox.dbxMove === 'function');
  assert('sync.js exports inboxParseRecord', typeof sandbox.inboxParseRecord === 'function');
  assert('sync.js exports _inboxLastRunAt', typeof sandbox._inboxLastRunAt !== 'undefined');
})();

function goodRecordJson(id, habitId, ts) {
  return JSON.stringify({ v: 1, id: id, kind: 'habit', habitId: habitId, dir: 1, ts: ts || Date.now(),
    tzOffsetMin: -120, src: 'android-shortcut' });
}

// ===========================================================================
// 2a -- one inbox file, apply once, upload cUp:1, claimed file deleted.
// ===========================================================================
pending.push((async function case2a() {
  const c = makeCtx();
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  c.dbx.put('/inbox/' + id + '.json', goodRecordJson(id, 'h1'));
  await attempt('2a: one inbox file applied once, claim deleted after upload', async () => {
    await c.sandbox._syncNowAttempt(0);
    assert('2a: applyInboxLog called exactly once', c.applyInboxLogCalls.length === 1);
    assert('2a: habit cUp incremented to 1', c.S.tasks[0].cUp === 1);
    const claimedPath = '/inbox-claimed/test-device-1/' + id + '.json';
    assert('2a: claimed file removed after successful upload', !c.dbx.files.has(claimedPath));
    assert('2a: /inbox is empty', c.dbx.listChildren('/inbox').length === 0);
    const upState = JSON.parse((c.dbx.files.get('/state.json') || {}).text || 'null');
    const upH1 = upState && upState.state && (upState.state.tasks || []).find(t => t.id === 'h1');
    assert('2a: UPLOADED state carries the credit (cUp 1)', !!upH1 && upH1.cUp === 1);
  });
})());

// ===========================================================================
// 2b -- retry: same id resurfaces in claimed dir (lost delete) -> applied once total.
// ===========================================================================
pending.push((async function case2b() {
  const c = makeCtx();
  const id = 'bbbbbbbb-1111-2222-3333-444444444444';
  // Simulate: claim happened, delete was lost -- file still sits in claimed dir,
  // NOT in /inbox any more.
  c.dbx.put('/inbox-claimed/test-device-1/' + id + '.json', goodRecordJson(id, 'h1'));
  await attempt('2b: recovered claimed-dir work item applied exactly once', async () => {
    await c.sandbox._syncNowAttempt(0);
    assert('2b: applyInboxLog called exactly once (not twice)', c.applyInboxLogCalls.length === 1);
    assert('2b: claimed file eventually deleted', !c.dbx.files.has('/inbox-claimed/test-device-1/' + id + '.json'));
  });
})());

// ===========================================================================
// 2c -- race: dbxMove returns false (lost race) -> applyInboxLog not called, nothing deleted.
// ===========================================================================
pending.push((async function case2c() {
  const c = makeCtx({
    fetchOverride: (url) => {
      if (String(url).indexOf('/files/move_v2') !== -1) {
        return { ok: false, status: 409, json: async () => ({ error_summary: 'path/conflict/from_lookup/not_found/...' }),
          text: async () => 'lost race', headers: { get: () => null } };
      }
      return null;
    }
  });
  const id = 'cccccccc-1111-2222-3333-444444444444';
  c.dbx.put('/inbox/' + id + '.json', goodRecordJson(id, 'h1'));
  await attempt('2c: lost move race -> not applied, not deleted', async () => {
    await c.sandbox._syncNowAttempt(0);
    assert('2c: applyInboxLog not called when the claim move is lost', c.applyInboxLogCalls.length === 0);
    assert('2c: source file still present (nothing moved/deleted)', c.dbx.files.has('/inbox/' + id + '.json'));
  });
})());

// ===========================================================================
// 2d -- crash after claim, before upload: file already in claimed dir only,
// credited once; plus uid-already-applied -> not re-applied, file deleted.
// ===========================================================================
pending.push((async function case2d() {
  const c = makeCtx();
  const id = 'dddddddd-1111-2222-3333-444444444444';
  c.dbx.put('/inbox-claimed/test-device-1/' + id + '.json', goodRecordJson(id, 'h1'));
  await attempt('2d: post-claim-crash recovery credited once', async () => {
    await c.sandbox._syncNowAttempt(0);
    assert('2d: credited exactly once from recovered claim', c.S.tasks[0].cUp === 1);
  });

  const c2 = makeCtx();
  const id2 = 'dddddddd-5555-6666-7777-888888888888';
  c2.fakeEventUids.add('inbox-' + id2); // uid already recorded (evtHasUid -> true)
  c2.dbx.put('/inbox-claimed/test-device-1/' + id2 + '.json', goodRecordJson(id2, 'h1'));
  await attempt('2d: dup uid not re-applied but claim still finished', async () => {
    await c2.sandbox._syncNowAttempt(0);
    assert('2d-dup: applyInboxLog NOT called for an already-applied uid', c2.applyInboxLogCalls.length === 0);
    assert('2d-dup: claimed file still deleted (finish-only path)', !c2.dbx.files.has('/inbox-claimed/test-device-1/' + id2 + '.json'));
  });
})());

// ===========================================================================
// 2f -- unknown habitId, and a v:2 file -> rejected, diag entry logged.
// Extra: habit present only in remoteState.tasks -> deferred, not rejected.
// ===========================================================================
pending.push((async function case2f() {
  const c = makeCtx();
  const id = 'ffffffff-1111-2222-3333-444444444444';
  c.dbx.put('/inbox/' + id + '.json', JSON.stringify({ v: 1, id: id, kind: 'habit', habitId: 'no-such-habit',
    dir: 1, ts: Date.now(), tzOffsetMin: 0, src: 'android-shortcut' }));
  const id2 = 'ffffffff-5555-6666-7777-888888888888';
  c.dbx.put('/inbox/' + id2 + '.json', JSON.stringify({ v: 2, id: id2, kind: 'habit', habitId: 'h1',
    dir: 1, ts: Date.now(), tzOffsetMin: 0, src: 'android-shortcut' }));
  await attempt('2f: unknown habitId and v:2 both rejected with a diag entry', async () => {
    await c.sandbox._syncNowAttempt(0);
    assert('2f: unknown-habit file moved to /inbox-rejected/', c.dbx.files.has('/inbox-rejected/' + id + '.json'));
    assert('2f: v:2 file moved to /inbox-rejected/', c.dbx.files.has('/inbox-rejected/' + id2 + '.json'));
    assert('2f: _qDiagPush recorded an inboxRejected entry', c.diag.some(d => d.kind === 'inboxRejected'));
    assert('2f: neither rejected file was applied', c.applyInboxLogCalls.length === 0);
  });

  const c3 = makeCtx();
  const id3 = 'ffffffff-9999-aaaa-bbbb-cccccccccccc';
  c3.dbx.put('/inbox/' + id3 + '.json', goodRecordJson(id3, 'remote-only-habit'));
  await attempt('2f-extra: habit known only via remoteState is deferred, not rejected', async () => {
    // The remote copy (pulled at the top of _syncNowAttempt) knows the habit; local S does not yet.
    const remoteState = JSON.parse(JSON.stringify(c3.S));
    remoteState.tasks = remoteState.tasks.concat([{ id: 'remote-only-habit', title: 'R', type: 'habit', updatedAt: 2000 }]);
    c3.dbx.put('/state.json', JSON.stringify({ state: remoteState, savedAt: 2000, deviceId: 'other-dev' }));
    await c3.sandbox._syncNowAttempt(0);
    assert('2f-extra: file NOT moved to /inbox-rejected/', !c3.dbx.files.has('/inbox-rejected/' + id3 + '.json'));
    const claimedPath = '/inbox-claimed/test-device-1/' + id3 + '.json';
    assert('2f-extra: file stays claimed (deferred, not finished)', c3.dbx.files.has(claimedPath));
  });
})());

// ===========================================================================
// 2g -- upload throws -> claimed file kept. Upload ok -> deleted. Terminal
// conflict (ConflictError past the retry limit) -> kept.
// ===========================================================================
pending.push((async function case2g() {
  const c = makeCtx({
    fetchOverride: (url) => {
      if (String(url).indexOf('/files/upload') !== -1) {
        return { ok: false, status: 400, json: async () => ({ error_summary: 'malformed_path/.' }),
          text: async () => 'bad upload', headers: { get: () => null } };
      }
      return null;
    }
  });
  const id = 'gggggggg-1111-2222-3333-444444444444';
  c.dbx.put('/inbox/' + id + '.json', goodRecordJson(id, 'h1'));
  await attempt('2g: upload throws -> claimed file kept (no finish)', async () => {
    await c.sandbox._syncNowAttempt(0).catch(() => {});
    const claimedPath = '/inbox-claimed/test-device-1/' + id + '.json';
    assert('2g: claimed file NOT deleted when upload fails', c.dbx.files.has(claimedPath));
  });

  const c2 = makeCtx({
    fetchOverride: (url) => {
      if (String(url).indexOf('/files/upload') !== -1) {
        return { ok: false, status: 409, json: async () => ({ error_summary: 'path/conflict/' }),
          text: async () => 'conflict', headers: { get: () => null } };
      }
      return null;
    }
  });
  const id2 = 'gggggggg-5555-6666-7777-888888888888';
  c2.dbx.put('/inbox/' + id2 + '.json', goodRecordJson(id2, 'h1'));
  await attempt('2g: terminal conflict (retry limit exhausted) -> claimed file kept', async () => {
    // 409 alone doesn't prove ConflictError without the real dbxUpload; this
    // exercises _syncNowAttempt end-to-end once _pushWithConflictRetry exists
    // and returns false on terminal conflict, per contract.
    await c2.sandbox._syncNowAttempt(0).catch(() => {});
    const claimedPath = '/inbox-claimed/test-device-1/' + id2 + '.json';
    assert('2g-conflict: claimed file kept on terminal conflict', c2.dbx.files.has(claimedPath));
  });
})());

// ===========================================================================
// Extras
// ===========================================================================
pending.push((async function extras() {
  // Boot gate blocks input -> no Dropbox call at all (no list_folder).
  await attempt('extra: boot-gated run makes no dbxListFolder call', async () => {
    let listCalled = false;
    const c = makeCtx({ gated: true, fetchOverride: (url) => {
      if (String(url).indexOf('/files/list_folder') !== -1) listCalled = true;
      return null;
    } });
    await c.sandbox._syncNowAttempt(0).catch(() => {});
    assert('extra: gated run never lists /inbox', !listCalled);
  });

  // Throttle: a second consume within 60s makes no list call.
  await attempt('extra: throttled second run within 60s makes no list call', async () => {
    const c = makeCtx();
    c.sandbox._inboxLastRunAt = Date.now();
    let listCalled = false;
    c.sandbox.fetch = async function (url, init) {
      if (String(url).indexOf('/files/list_folder') !== -1) { listCalled = true; }
      return { ok: true, status: 200, json: async () => ({ entries: [], has_more: false }), text: async () => '', headers: { get: () => null } };
    };
    await c.sandbox.syncInboxConsume(null);
    assert('extra: throttled window skips the list call', !listCalled);
  });

  // evtLastUploadTs lowered to rec.ts-1 after apply, never raised.
  await attempt('extra: evtLastUploadTs lowered to ts-1, never raised past it', async () => {
    const c = makeCtx();
    const id = 'watermark-0000-1111-2222-333333333333';
    const ts = 5000;
    c.store['questa.sync.v1'] = JSON.stringify(Object.assign(JSON.parse(c.store['questa.sync.v1']), { evtLastUploadTs: 999999999 }));
    c.dbx.put('/inbox/' + id + '.json', goodRecordJson(id, 'h1', ts));
    await c.sandbox._syncNowAttempt(0);
    const cfg = JSON.parse(c.store['questa.sync.v1'] || '{}');
    assert('extra: evtLastUploadTs lowered to rec.ts-1', cfg.evtLastUploadTs === ts - 1);
  });

  // inboxParseRecord unit checks.
  await attempt('extra: inboxParseRecord good record parses', async () => {
    const id = 'unit0000-1111-2222-3333-444444444444';
    const rec = c_inboxParseRecord(goodRecordJson(id, 'h1', 1000), id + '.json');
    assert('inboxParseRecord: good record -> normalized object', rec && rec.id === id && rec.habitId === 'h1' && rec.dir === 1);
  });
  await attempt('extra: inboxParseRecord bad JSON -> null', async () => {
    const rec = c_inboxParseRecord('not json', 'x.json');
    assert('inboxParseRecord: bad JSON -> null', rec === null);
  });
  await attempt('extra: inboxParseRecord filename mismatch -> null', async () => {
    const id = 'unit1111-1111-2222-3333-444444444444';
    const rec = c_inboxParseRecord(goodRecordJson(id, 'h1'), 'wrong-name.json');
    assert('inboxParseRecord: filename != id -> null', rec === null);
  });
  await attempt('extra: inboxParseRecord dir 0 -> null', async () => {
    const id = 'unit2222-1111-2222-3333-444444444444';
    const rec = c_inboxParseRecord(JSON.stringify({ v: 1, id: id, kind: 'habit', habitId: 'h1', dir: 0, ts: 1000, tzOffsetMin: 0, src: 'x' }), id + '.json');
    assert('inboxParseRecord: dir 0 -> null', rec === null);
  });
  await attempt('extra: inboxParseRecord ts 0 -> null', async () => {
    const id = 'unit3333-1111-2222-3333-444444444444';
    const rec = c_inboxParseRecord(JSON.stringify({ v: 1, id: id, kind: 'habit', habitId: 'h1', dir: 1, ts: 0, tzOffsetMin: 0, src: 'x' }), id + '.json');
    assert('inboxParseRecord: ts 0 -> null', rec === null);
  });

  // dbxMove status-code matrix via mocked fetch.
  await attempt('extra: dbxMove 200 -> true', async () => {
    const c = makeCtx({ fetchOverride: () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '', headers: { get: () => null } }) });
    const ok = await c.sandbox.dbxMove('/inbox/a.json', '/inbox-claimed/d/a.json');
    assert('dbxMove: 200 -> true', ok === true);
  });
  await attempt('extra: dbxMove 409 from_lookup/not_found -> false', async () => {
    const c = makeCtx({ fetchOverride: () => ({ ok: false, status: 409, json: async () => ({ error_summary: 'path/conflict/from_lookup/not_found/...' }), text: async () => '', headers: { get: () => null } }) });
    const ok = await c.sandbox.dbxMove('/inbox/a.json', '/inbox-claimed/d/a.json');
    assert('dbxMove: 409 from_lookup/not_found -> false', ok === false);
  });
  await attempt('extra: dbxMove 409 other -> throws', async () => {
    const c = makeCtx({ fetchOverride: () => ({ ok: false, status: 409, json: async () => ({ error_summary: 'path/conflict/other_reason' }), text: async () => 'x', headers: { get: () => null } }) });
    let threw = false, isHttpError = false;
    try { await c.sandbox.dbxMove('/inbox/a.json', '/inbox-claimed/d/a.json'); }
    catch (e) { threw = true; isHttpError = e && e.status === 409 && /^move failed: 409/.test(String(e.message)); }
    assert('dbxMove: 409 non-lookup -> throws an HttpError (not just any error)', threw === true && isHttpError === true);
  });

  function c_inboxParseRecord(text, name) {
    const c = makeCtx();
    return c.sandbox.inboxParseRecord(text, name);
  }
})());

Promise.all(pending).then(() => {
  console.log(failures ? ('\nFAILED: ' + failures + ' assertion(s)') : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
