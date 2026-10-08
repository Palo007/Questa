// task-attachments.test.js -- CR-KT-015: image attachments on tasks.
//
//   A  mergeAttachments: the 4 shared-fixture cases, plus order/idempotence/no-clamp
//   B  mergeCollection splices: both-changed keeps the union, GUARD 1 = pure union,
//      one side without the key keeps the other side's images, empty result OMITS the key,
//      a retry re-merge is idempotent
//   C  upload step: blobs go up full-then-thumb with mode add, 409 conflict = success,
//      any other error throws; a full sync round uploads blobs BEFORE state.json and a
//      blob failure means NO state upload
//   D  app.js pure helpers: attFitSize, attReconcileSave, row/editor markup
//   E  the tokenized export round-trips `attachments` byte-equal, and no field-map
//      code was added for it
//
// Run: node tests/task-attachments.test.js   (also run by `node tests/run.js`)
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

let failures = 0;
function assert(desc, cond){ if(cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
const J = function(x){ return JSON.stringify(x); };
const ids = function(a){ return J((a || []).map(function(x){ return x.id; })); };

// ---------- sync.js sandbox ----------
let syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
syncSrc = syncSrc.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');
const noop = function(){};
const inMem = {};
const seedConfig = {
  enabled: true, appKey: 'k', refreshToken: 'rt', accessToken: 'at', accessExpiresAt: Date.now() + 3600000,
  lastRev: null, lastSyncAt: null, lastError: null, deviceId: 'dev-local',
  evtLastUploadTs: 0, evtFileRevs: {}, evtLastPullAt: 0
};
inMem['questa.sync.v1'] = J(seedConfig);
const sandbox = {
  window: {}, navigator: { onLine: true },
  document: { addEventListener: noop, getElementById: function(){ return null; },
    createElement: function(){ return { style:{}, appendChild: noop, setAttribute: noop, click: noop }; },
    body: { appendChild: noop, removeChild: noop } },
  localStorage: {
    getItem: function(k){ return Object.prototype.hasOwnProperty.call(inMem, k) ? inMem[k] : null; },
    setItem: function(k, v){ inMem[k] = String(v); }, removeItem: function(k){ delete inMem[k]; },
    key: function(){ return null; }, length: 0
  },
  indexedDB: { open: function(){ return {}; } },
  setTimeout: function(fn){ return fn; }, clearTimeout: noop, setInterval: function(){ return 0; }, clearInterval: noop,
  console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, WeakSet: WeakSet, Array: Array, Object: Object,
  Number: Number, String: String, Boolean: Boolean, Promise: Promise, RegExp: RegExp, Error: Error,
  logEvent: noop, toast: noop, render: noop, esc: function(x){ return x; }, save: noop,
  uid: function(){ return 'test-uid'; },
  idbOpen: function(){ return Promise.resolve(null); }
};
sandbox.self = sandbox.window; sandbox.globalThis = sandbox;
sandbox.S = {
  char: { name: 'T', lvl: 1, updatedAt: 1000 },
  tasks: [], rewards: [], tags: [], devices: [], an: { views: [], metrics: [] },
  history: [], charHistory: [], monthlyBackups: [], lastCron: 0, deletions: []
};
vm.createContext(sandbox);
try { vm.runInContext(syncSrc, sandbox); } catch(e) {}
const Q = sandbox.window.QuestaSync;
if(!Q){ console.error('FAIL: QuestaSync not found'); process.exit(1); }

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'CR-KT-015', 'task_attachments.json'), 'utf8'));

// ===== A: mergeAttachments =====
fx.merge_cases.forEach(function(c, i){
  const out = Q.mergeAttachments(c.base, c.local, c.remote);
  assert('A' + (i + 1) + ': fixture "' + c.name.slice(0, 50) + '" -> ' + J(c.expected_ids), ids(out) === J(c.expected_ids));
});
{
  const mk = function(id, t){ return { id: id, sha: id, mime: 'image/jpeg', w: 1, h: 1, bytes: 1, addedAt: t }; };
  const a = mk('A', 10), b = mk('B', 10), c = mk('C', 5);
  assert('A5: equal addedAt ties break by id (string compare)', ids(Q.mergeAttachments(null, [b, a], [])) === J(['A', 'B']));
  assert('A6: addedAt ascending wins over id', ids(Q.mergeAttachments(null, [a], [c])) === J(['C', 'A']));
  const lo = Object.assign({}, a, { w: 99 });
  const both = Q.mergeAttachments(null, [lo], [a]);
  assert('A7: an id on both sides keeps the LOCAL item', both.length === 1 && both[0].w === 99);
  const once = Q.mergeAttachments([a], [a, c], [a, b]);
  const twice = Q.mergeAttachments([a], once, [a, b]);
  assert('A8: idempotent (re-merge of the result with the same remote is unchanged)', J(once) === J(twice));
  assert('A9: missing/garbage input -> []', J(Q.mergeAttachments(undefined, undefined, null)) === '[]' && J(Q.mergeAttachments(null, [null, {}], 'x')) === '[]');
  assert('A10: a far-future addedAt is NOT clamped away (sorts last, item kept)',
    ids(Q.mergeAttachments(null, [mk('F', 9e15)], [a])) === J(['A', 'F']));
  assert('A11: undefined base is a pure union (no removals)', ids(Q.mergeAttachments(undefined, [], [a])) === J(['A']));
}

// ===== B: mergeCollection splices =====
const img = function(id, t){ return { id: id, sha: id.repeat(64).slice(0, 64).toLowerCase(), mime: 'image/jpeg', w: 10, h: 10, bytes: 5, addedAt: t }; };
const task = function(o){ return Object.assign({ id: 't1', type: 'todo', title: 'x', updatedAt: 100 }, o); };
const merge = function(b, l, r){ return Q.mergeCollection(b ? [b] : [], l ? [l] : [], r ? [r] : [], Date.now(), Date.now(), new Map(), 'dev-remote'); };
{
  const A = img('a', 1), C = img('c', 3), D = img('d', 4);
  // B1: both changed -> whole-object winner (remote, newer) + union of the images
  const base = task({ attachments: [A] });
  const local = task({ title: 'local', updatedAt: 200, attachments: [A, C] });
  const remote = task({ title: 'remote', updatedAt: 300, attachments: [A, D] });
  let out = merge(base, local, remote)[0];
  assert('B1: both-changed keeps the union of both sides\' images', ids(out.attachments) === J(['a', 'c', 'd']));
  assert('B1b: the winner\'s other fields are unchanged by the splice', out.title === 'remote');
  // B2: retry re-merge with the same inputs is stable
  const again = merge(base, Object.assign({}, out), remote)[0];
  assert('B2: re-merge (conflict retry) is idempotent', ids(again.attachments) === J(['a', 'c', 'd']));
  // B3: one side has no `attachments` key at all
  out = merge(task(), task({ title: 'L', updatedAt: 200 }), task({ title: 'R', updatedAt: 300, attachments: [C] }))[0];
  assert('B3: local without the key keeps the remote\'s images', ids(out.attachments) === J(['c']));
  out = merge(task(), task({ title: 'L', updatedAt: 200, attachments: [C] }), task({ title: 'R', updatedAt: 300 }))[0];
  assert('B3b: remote without the key keeps the local images (remote won the task)', ids(out.attachments) === J(['c']));
  // B4: removal on one side + base evidence
  out = merge(task({ attachments: [A, C] }), task({ title: 'L', updatedAt: 200, attachments: [C] }), task({ title: 'R', updatedAt: 300, attachments: [A, C, D] }))[0];
  assert('B4: local removed A (in base) -> A stays removed, D kept', ids(out.attachments) === J(['c', 'd']));
  // B5: everything removed -> the key is OMITTED, never []
  out = merge(task({ attachments: [A] }), task({ title: 'L', updatedAt: 200, attachments: [] }), task({ title: 'R', updatedAt: 300, attachments: [] }))[0];
  assert('B5: empty result omits the key', !('attachments' in out));
  // B6: GUARD 1 (local untouched vs base, remote changed but OLDER) -> pure union, base = null
  const g1base = task({ updatedAt: 500, attachments: [A] });
  const g1local = Object.assign({}, g1base);
  const g1remote = task({ updatedAt: 100, title: 'older remote', attachments: [C] });
  out = merge(g1base, g1local, g1remote)[0];
  assert('B6: GUARD 1 keeps the newer local task', out.title === 'x');
  assert('B6b: GUARD 1 path = pure union (A not treated as removed by the remote)', ids(out.attachments) === J(['a', 'c']));
  assert('B6c: GUARD 1 does not mutate its input', J(g1local.attachments) === J([A]));
  // B7: neither side has the key -> nothing is added
  out = merge(task(), task({ title: 'L', updatedAt: 200 }), task({ title: 'R', updatedAt: 300 }))[0];
  assert('B7: no side has attachments -> no key', !('attachments' in out));
  // B8: cron-echo does not apply (the normal splice always runs); a daily keeps both sides' images
  out = merge(task({ type: 'daily', attachments: [A] }), task({ type: 'daily', title: 'L', updatedAt: 200, attachments: [A, C] }),
              task({ type: 'daily', title: 'R', updatedAt: 300, attachments: [A, D] }))[0];
  assert('B8: a daily also unions images', ids(out.attachments) === J(['a', 'c', 'd']));
}

// ===== C: upload step =====
function installFetch(handler){
  const calls = [];
  sandbox.fetch = async function(url, opts){
    const h = (opts && opts.headers) || {};
    let arg = null; try{ arg = h['Dropbox-API-Arg'] ? JSON.parse(h['Dropbox-API-Arg']) : null; }catch(e){}
    const call = { url: url, path: arg && arg.path, mode: arg && arg.mode && arg.mode['.tag'], body: opts && opts.body };
    calls.push(call);
    return handler(call);
  };
  return calls;
}
const okRes = function(){ return { status: 200, ok: true, json: async function(){ return {}; }, text: async function(){ return '{}'; }, headers: { get: function(){ return null; } } }; };
const errRes = function(status, summary){ return { status: status, ok: false, json: async function(){ return { error_summary: summary }; }, text: async function(){ return summary; }, headers: { get: function(){ return null; } } }; };
const SHA1 = 'a'.repeat(64), SHA2 = 'b'.repeat(64);
const blobOf = function(s){ return { size: s.length, tag: s }; };
let uploadedMarks = [];
function installBlobStore(pendingKeys){
  uploadedMarks = [];
  sandbox.attPendingForShas = async function(shas){
    const out = [];
    shas.forEach(function(sha){
      ['full', 'thumb'].forEach(function(kind){ if(pendingKeys.indexOf(sha + ':' + kind) !== -1) out.push({ sha: sha, kind: kind, blob: blobOf(sha + kind) }); });
    });
    return out;
  };
  sandbox.attMarkUploaded = async function(sha, kind){ uploadedMarks.push(sha.slice(0, 1) + ':' + kind); };
}
const stateWith = function(shas){ return { tasks: [{ id: 't1', attachments: shas.map(function(s, i){ return { id: 'i' + i, sha: s, mime: 'image/jpeg', w: 1, h: 1, bytes: 1, addedAt: i }; }) }] }; };

(async function(){
  // C1: order + mode add + paths
  {
    installBlobStore([SHA1 + ':full', SHA1 + ':thumb', SHA2 + ':full', SHA2 + ':thumb']);
    const calls = installFetch(function(){ return okRes(); });
    await Q.uploadPendingAttachments(stateWith([SHA1, SHA2]));
    assert('C1: four uploads, full before thumb per sha',
      J(calls.map(function(c){ return c.path; })) === J(['/attachments/' + SHA1 + '.jpg', '/attachments/' + SHA1 + '_t.jpg', '/attachments/' + SHA2 + '.jpg', '/attachments/' + SHA2 + '_t.jpg']));
    assert('C1b: mode add (never overwrite)', calls.every(function(c){ return c.mode === 'add'; }));
    assert('C1c: each blob marked uploaded after its upload', J(uploadedMarks) === J(['a:full', 'a:thumb', 'b:full', 'b:thumb']));
  }
  // C2: 409 path/conflict = already there = success
  {
    installBlobStore([SHA1 + ':full', SHA1 + ':thumb']);
    installFetch(function(){ return errRes(409, 'path/conflict/file/..'); });
    let threw = false; try{ await Q.uploadPendingAttachments(stateWith([SHA1])); }catch(e){ threw = true; }
    assert('C2: 409 path/conflict counts as success (no throw)', !threw);
    assert('C2b: and the blob is marked uploaded', J(uploadedMarks) === J(['a:full', 'a:thumb']));
  }
  // C3: other errors throw and are NOT marked uploaded
  {
    installBlobStore([SHA1 + ':full', SHA1 + ':thumb']);
    const calls = installFetch(function(){ return errRes(500, 'internal'); });
    let threw = false; try{ await Q.uploadPendingAttachments(stateWith([SHA1])); }catch(e){ threw = true; }
    assert('C3: a 500 throws', threw);
    assert('C3b: nothing marked uploaded, thumbnail not attempted after the full failed', uploadedMarks.length === 0 && calls.length === 1);
    installFetch(function(){ return errRes(409, 'path/no_write_permission'); });
    threw = false; try{ await Q.uploadPendingAttachments(stateWith([SHA1])); }catch(e){ threw = true; }
    assert('C3c: a non-conflict 409 throws too', threw);
  }
  // C4: only blobs NAMED by a task are uploaded; nothing pending -> no fetch
  {
    installBlobStore([SHA2 + ':full']);
    const calls = installFetch(function(){ return okRes(); });
    await Q.uploadPendingAttachments(stateWith([SHA1]));
    assert('C4: a pending blob no task names is not uploaded', calls.length === 0);
    await Q.uploadPendingAttachments({ tasks: [{ id: 'x' }] });
    assert('C4b: no attachments anywhere -> no fetch', calls.length === 0);
  }
  // C5: a full sync round -- blobs before state.json; blob failure = no state upload
  {
    const mkState = function(){
      sandbox.S.tasks = [{ id: 't1', type: 'todo', title: 'x', updatedAt: 100, attachments: [{ id: 'i0', sha: SHA1, mime: 'image/jpeg', w: 1, h: 1, bytes: 1, addedAt: 1 }] }];
    };
    mkState();
    inMem['questa.sync.v1'] = J(seedConfig);
    installBlobStore([SHA1 + ':full', SHA1 + ':thumb']);
    let calls = installFetch(function(c){
      if(c.url.indexOf('/files/download') !== -1) return errRes(409, 'path/not_found/..');
      return okRes();
    });
    // upload response must carry a rev for the base bookkeeping
    const realOk = okRes;
    calls = installFetch(function(c){
      if(c.url.indexOf('/files/download') !== -1) return errRes(409, 'path/not_found/..');
      const r = realOk(); r.json = async function(){ return { rev: 'r9' }; }; return r;
    });
    try{ await Q.now(); }catch(e){ console.log('  (sync round threw: ' + (e && e.message) + ')'); }
    const paths = calls.filter(function(c){ return c.url.indexOf('/files/upload') !== -1; }).map(function(c){ return c.path; });
    const iState = paths.indexOf('/state.json');
    assert('C5: the round uploaded the blobs AND state.json', iState !== -1 && paths.length === 3);
    assert('C5b: both blob uploads happen BEFORE the state.json upload', iState === 2 && paths[0] === '/attachments/' + SHA1 + '.jpg' && paths[1] === '/attachments/' + SHA1 + '_t.jpg');

    mkState();
    inMem['questa.sync.v1'] = J(seedConfig);
    installBlobStore([SHA1 + ':full', SHA1 + ':thumb']);
    calls = installFetch(function(c){
      if(c.url.indexOf('/files/download') !== -1) return errRes(409, 'path/not_found/..');
      if(c.path && c.path.indexOf('/attachments/') === 0) return errRes(403, 'insufficient');
      const r = realOk(); r.json = async function(){ return { rev: 'r9' }; }; return r;
    });
    let threw = false; try{ await Q.now(); }catch(e){ threw = true; }
    const up2 = calls.filter(function(c){ return c.url.indexOf('/files/upload') !== -1 && c.path === '/state.json'; });
    assert('C5c: a failed blob upload means state.json is NOT uploaded', up2.length === 0);
    assert('C5d: and the failure surfaces (round fails, retried next sync)', threw || J(sandbox.window.QuestaSync.cfg().lastError || '').length > 2);
  }

  // ===== D: app.js helpers =====
  const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const bi = appSrc.indexOf('/* BEGIN_ATTACH_HELPERS */'), ei = appSrc.indexOf('/* END_ATTACH_HELPERS */');
  assert('D0: BEGIN/END_ATTACH_HELPERS markers present', bi > 0 && ei > bi);
  const asb = { console: console, Math: Math, JSON: JSON, Array: Array, Set: Set, Map: Map, Number: Number, String: String, Object: Object, Date: Date, Promise: Promise,
    uid: function(){ return 'u'; } };
  vm.createContext(asb);
  vm.runInContext(extractFunction(appSrc, /^function esc\(s\)\{/, 'esc'), asb);
  vm.runInContext(extractFunction(appSrc, /^function jsq\(s\)\{/, 'jsq'), asb);
  vm.runInContext(appSrc.slice(bi, ei), asb);
  const fit = asb.attFitSize;
  assert('D1: attFitSize 4000x3000 @1600 -> 1600x1200', J(fit(4000, 3000, 1600)) === J({ w: 1600, h: 1200 }));
  assert('D2: attFitSize portrait 3000x4000 @256 -> 192x256', J(fit(3000, 4000, 256)) === J({ w: 192, h: 256 }));
  assert('D3: attFitSize never upscales', J(fit(800, 600, 1600)) === J({ w: 800, h: 600 }));
  assert('D4: attFitSize exact edge is unchanged', J(fit(1600, 900, 1600)) === J({ w: 1600, h: 900 }));
  assert('D5: attFitSize garbage -> 0x0', J(fit(0, 10, 256)) === J({ w: 0, h: 0 }) && J(fit('x', 10, 256)) === J({ w: 0, h: 0 }));
  assert('D6: attFitSize never returns a 0 side for a very thin image', fit(10000, 1, 256).h === 1);

  const rec = asb.attReconcileSave;
  const x1 = { id: '1' }, x2 = { id: '2' }, x3 = { id: '3' };
  assert('D7: user adds one -> live + new', ids(rec([x1], [x1, x2], [x1])) === J(['1', '2']));
  assert('D8: a peer image merged in while the sheet was open survives', ids(rec([x1], [x1, x2], [x1, x3])) === J(['1', '3', '2']));
  assert('D9: user removes one, peer added another meanwhile', ids(rec([x1, x2], [x2], [x1, x2, x3])) === J(['2', '3']));
  assert('D10: untouched sheet leaves the live list as is', ids(rec([x1], [x1], [x1, x3])) === J(['1', '3']));
  assert('D11: user removes the last image -> []', J(rec([x1], [], [x1])) === '[]');
  assert('D12: new task (no base, no live)', ids(rec(undefined, [x1], undefined)) === J(['1']));

  const t5 = { id: 'T', attachments: [1, 2, 3, 4, 5].map(function(n){ return { id: 'i' + n, sha: String(n).repeat(64), mime: 'image/jpeg' }; }) };
  const t2 = { id: 'T', attachments: t5.attachments.slice(0, 2) };
  assert('D13: editor "Add image" is disabled at 5 and shows the note', /disabled/.test(asb.attEditorBlock(t5)) && /Up to 5 images/.test(asb.attEditorBlock(t5)));
  assert('D14: editor "Add image" is enabled below 5', !/disabled/.test(asb.attEditorBlock(t2)));
  assert('D15: editor has a hidden image file input', /type="file" id="eAttFile" accept="image\/\*"/.test(asb.attEditorBlock(t2)));
  const row = asb.attRailItem(t2);
  assert('D16: row shows ONE thumbnail with "+1" for two images', (row.match(/<img /g) || []).length === 1 && /\+1/.test(row));
  assert('D17: the row tap stops propagation (no toggle / editor / drag)', /onclick="event\.stopPropagation\(\);attOpenViewer\(/.test(row));
  assert('D18: no attachments -> no row markup', asb.attRailItem({ id: 'T' }) === '' && asb.attRailItem({ id: 'T', attachments: [] }) === '');
  assert('D19: thumbnails request the _t blob', row.indexOf('data-attkey="' + t2.attachments[0].sha + '_t"') !== -1);

  // ===== E: tokenized export round-trip =====
  const tsb = { console: console, JSON: JSON, Math: Math, Date: Date, Map: Map, Set: Set, Array: Array, Object: Object, Number: Number, String: String, Boolean: Boolean, Promise: Promise,
    syncDeviceId: function(){ return 'd'; } };
  vm.createContext(tsb);
  const a = appSrc.indexOf('const _EXPORT_FIELD_MAP'), b = appSrc.indexOf('async function buildBackupFile(');
  vm.runInContext(appSrc.slice(a, b), tsb);
  const snap = { tasks: [Object.assign({ id: 't1', type: 'todo', title: 'x', updatedAt: 5 }, { attachments: fx.taskWithAttachments.attachments })], rewards: [], tags: [] };
  const tok = tsb._tokenizeSnapshot(snap);
  const back = tsb._detokenizeSnapshot({ S: tok.S, FM: tok.FM });
  assert('E1: snapshot with attachments round-trips byte-identically', J(back) === J(snap));
  assert('E2: attachments items are byte-equal after the round trip', J(back.tasks[0].attachments) === J(fx.taskWithAttachments.attachments));
  const mapSrc = appSrc.slice(a, appSrc.indexOf('};', a));
  assert('E3: no _EXPORT_FIELD_MAP code was added for attachments', !/attachments/.test(mapSrc));

  // F: Activity log. Adding / removing an image in the editor writes an 'edit' event
  // change {field:'attachments', added, removed} (user report 2026-10-08: nothing logged).
  const fsb = vm.createContext({});
  vm.runInContext(extractFunction(appSrc, /^function attUserDelta\(/, 'attUserDelta'), fsb);
  const ud = function(b, e){ return J(vm.runInContext('attUserDelta(' + J(b) + ',' + J(e) + ')', fsb)); };
  assert('F1: one image added', ud([{id:'A'}], [{id:'A'},{id:'B'}]) === J({added:1, removed:0}));
  assert('F2: one image removed', ud([{id:'A'},{id:'B'}], [{id:'B'}]) === J({added:0, removed:1}));
  assert('F3: missing key on both sides = no change', ud(undefined, undefined) === J({added:0, removed:0}));
  assert('F4: removed the last image (key deleted) counts as removed', ud([{id:'A'}], undefined) === J({added:0, removed:1}));
  // The delta is taken in saveTask and used in the change list: the declaration's block
  // must still be open where it is used (a ReferenceError there is swallowed by try{}).
  const st = extractFunction(appSrc, /^function saveTask\(/, 'saveTask');
  const di = st.indexOf('const _attDelta'), ui = st.indexOf("field:'attachments'");
  let depth = 0, minDepth = 0;
  for(let i = di; i < ui && di >= 0; i++){ if(st[i] === '{') depth++; else if(st[i] === '}'){ depth--; if(depth < minDepth) minDepth = depth; } }
  assert('F5: saveTask declares _attDelta before the edit-event change list, in an enclosing block', di >= 0 && ui > di && minDepth >= 0);
  assert('F6: Activity feed renders the attachments change as "images"', /c\.field==='attachments'[\s\S]{0,200}'images'/.test(appSrc));

  if(failures){ console.error('\n' + failures + ' FAILED'); process.exit(1); }
  console.log('\nAll task-attachments tests passed.');
})().catch(function(e){ console.error('[FAIL] test crashed: ' + (e && e.stack || e)); process.exit(1); });
