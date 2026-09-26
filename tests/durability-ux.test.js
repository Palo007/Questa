// durability-ux.test.js -- D5 durability UX (PWA-02, 03, 04, 06, 24-warning, EXTRA-1)
//
// Every part of D5 is a MITIGATION that makes a platform limit visible; none of it
// changes sync. These tests read the REAL app.js / index.html / sync.js source
// (marker blocks or extractFunction), never a hand copy:
//   - BEGIN/END_DURABLE_STATE_HELPERS  (save(): localEditAt stamp, size meter)
//   - BEGIN/END_DURABILITY_UX          (sync status, badge, nags, long-offline)
//   - BEGIN/END_STORAGE_PERSIST        (persist() ask, re-ask)
//   - exportSaveDevice                 (EXTRA-1: ask before clearing the nag)
//
// Run: node tests/durability-ux.test.js   (also run by `node tests/run.js`)
'use strict';
const fs = require('fs'), path = require('path');
const { extractFunction } = require('./_extract');

let failures = 0;
function assert(d, c) {
  if (c) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d); failures++; }
}
function assertEq(d, got, want) {
  if (got === want) console.log('[PASS] ' + d);
  else { console.error('[FAIL] ' + d + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}
// A missing block/function must be a counted FAIL, not a crash that hides the rest.
function attempt(label, fn) {
  try { return fn(); } catch (e) { console.error('[FAIL] ' + label + ' threw: ' + (e && e.message || e)); failures++; return undefined; }
}

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(ROOT, 'sync.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function block(name) {
  const re = new RegExp('\\/\\* BEGIN_' + name + ' \\*\\/([\\s\\S]*?)\\/\\* END_' + name + ' \\*\\/');
  const m = appSrc.match(re);
  return m ? m[1] : null;
}

function makeLocalStorage(initial) {
  var store = Object.assign({}, initial || {});
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _store: store
  };
}
function makeFakeIdbOpen() {
  return function () {
    return Promise.resolve({
      transaction: function () {
        var tx = { oncomplete: null, onerror: null, onabort: null };
        tx.objectStore = function () { return { put: function () { setTimeout(function () { if (tx.oncomplete) tx.oncomplete(); }, 0); } }; };
        return tx;
      }
    });
  };
}

// ── Loader A: the live durable block (same shape as tests/multi-tab.test.js) ──
function loadDurable(initialS, opts) {
  opts = opts || {};
  const src = block('DURABLE_STATE_HELPERS');
  if (!src) throw new Error('DURABLE_STATE_HELPERS block missing');
  var toasts = [], longs = [], alerts = [], badge = { n: 0 };
  var ls = opts.localStorage || makeLocalStorage();
  var body =
    'let S = globals.S;\n' +
    'let IS_DIRTY = false;\n' +
    'const STORE_KEY = "questa.save.v1";\n' +
    'const localStorage = globals.localStorage;\n' +
    'const window = { addEventListener: function(){} };\n' +
    'const migrate = function(x){ return x; };\n' +
    'const render = function(){};\n' +
    'const logEvent = function(){};\n' +
    'const toast = globals.toast;\n' +
    'const toastLong = globals.toastLong;\n' +
    'const alertDialog = globals.alertDialog;\n' +
    'const updateSyncBadge = globals.updateSyncBadge;\n' +
    'const syncIsApplying = globals.syncIsApplying;\n' +
    'const scheduleSync = function(){};\n' +
    'const idbOpen = globals.idbOpen;\n' +
    'const now = globals.now;\n' +
    'let _prevCharSig = null;\n' +
    'function _charSig(c){ return ""; }\n' +
    src + '\n' +
    'return { save: save, getS: function(){ return S; },\n' +
    '  getLocalEditAt: function(){ return (typeof localEditAt !== "undefined") ? localEditAt : undefined; },\n' +
    '  storageUsage: (typeof storageUsage === "function") ? storageUsage : null,\n' +
    '  noteSaveCommitted: (typeof _noteSaveCommitted === "function") ? _noteSaveCommitted : null };';
  var h = new Function('globals', body)({
    S: initialS, localStorage: ls,
    toast: function (m) { toasts.push(m); },
    // Long toast: the test decides when it counts as seen (tap / 10 s visible).
    toastLong: function (m, onSeen) { longs.push({ m: m, seen: onSeen }); },
    // Dialog: .then(cb) is held until the test "taps OK" via alerts[i].ok().
    alertDialog: function (t, x) {
      var rec = { t: t, x: x, cbs: [], ok: function () { rec.cbs.forEach(function (f) { f(); }); } };
      alerts.push(rec);
      return { then: function (f) { rec.cbs.push(f); } };
    },
    updateSyncBadge: function () { badge.n++; },
    syncIsApplying: opts.syncIsApplying || function () { return false; },
    idbOpen: makeFakeIdbOpen(),
    now: opts.now || function () { return Date.now(); }
  });
  h.toasts = toasts; h.longs = longs; h.alerts = alerts; h.badge = badge; h.localStorage = ls;
  return h;
}

// ── Loader B: the DURABILITY_UX block ─────────────────────────────────────
function makeEl() {
  var cls = new Set();
  return {
    hidden: true, title: '', textContent: '', attrs: {},
    classList: { add: function (c) { cls.add(c); }, remove: function (c) { cls.delete(c); }, contains: function (c) { return cls.has(c); } },
    setAttribute: function (k, v) { this.attrs[k] = String(v); },
    get className() { return Array.from(cls).join(' '); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(function (c) { cls.add(c); }); }
  };
}
function loadUx(g) {
  g = g || {};
  const src = block('DURABILITY_UX');
  if (!src) throw new Error('DURABILITY_UX block missing');
  var calls = { toast: [], long: [], alert: [], sync: 0, intervals: 0, cleared: 0, timeouts: [] };
  var els = g.els || {};
  var names = ['S', 'localStorage', 'document', 'toast', 'toastLong', 'alertDialog', 'syncCfg', 'setInterval', 'clearInterval',
    'setTimeout', 'syncNow', 'syncApply', 'syncCfgSave', 'scheduleSync', 'QuestaSync', 'confirmForcePull', 'navigator'];
  var syncSpy = function () { calls.sync++; };
  var doc = { getElementById: function (id) { return els[id] || null; }, visibilityState: g.visibility || 'visible' };
  var vals = {
    S: g.S || { prefs: {} },
    localStorage: g.localStorage || makeLocalStorage(),
    document: doc,
    toast: function (m) { calls.toast.push(m); },
    toastLong: function (m, onSeen) { calls.long.push({ m: m, seen: onSeen }); },
    alertDialog: function (t, x) { calls.alert.push([t, x]); return Promise.resolve(); },
    syncCfg: g.syncCfg,
    setInterval: function () { calls.intervals++; return 1; },
    clearInterval: function () { calls.cleared++; },
    // Fake timers: the test runs them one at a time with r.runNext().
    setTimeout: function (f, ms) { calls.timeouts.push({ f: f, ms: ms }); return calls.timeouts.length; },
    syncNow: syncSpy, syncApply: syncSpy, syncCfgSave: syncSpy, scheduleSync: syncSpy,
    QuestaSync: new Proxy({}, { get: function () { return syncSpy; } }),
    confirmForcePull: syncSpy,
    navigator: {}
  };
  var body = src + '\nreturn { syncStatusFrom: syncStatusFrom, staleSyncLabel: staleSyncLabel, readSyncStatus: readSyncStatus,\n' +
    ' updateSyncBadge: updateSyncBadge, maybeStorageNag: maybeStorageNag, isLongOffline: isLongOffline,\n' +
    ' longOfflineWarning: longOfflineWarning, bootSnap: _bootSyncSnap, durabilityRowsHtml: durabilityRowsHtml,\n' +
    ' lastOffDeviceCopy: lastOffDeviceCopy, LONG_OFFLINE_MS: LONG_OFFLINE_MS,\n' +
    ' maybeStaleSyncToast: maybeStaleSyncToast,\n' +
    ' scheduleStaleSyncCheck: (typeof scheduleStaleSyncCheck === "function") ? scheduleStaleSyncCheck : null };';
  var syncCfgVal = vals.syncCfg;
  var args = names.map(function (n) { return n === 'syncCfg' ? syncCfgVal : vals[n]; });
  if (typeof syncCfgVal === 'undefined') {
    // syncCfg absent (sync.js not loaded yet): pass undefined so `typeof syncCfg` is "undefined".
  }
  var fn = new Function(names.join(','), body);
  var r = fn.apply(null, args);
  r.calls = calls; r.localStorage = vals.localStorage; r.doc = doc;
  r.runNext = function () { var t = calls.timeouts.shift(); if (t) t.f(); return !!t; };
  return r;
}

// ── Loader C: the STORAGE_PERSIST block (one eval == one launch) ──────────
function loadPersist(nav, opts) {
  opts = opts || {};
  const src = block('STORAGE_PERSIST');
  if (!src) throw new Error('STORAGE_PERSIST block missing');
  var events = [], winListeners = {};
  var win = {
    addEventListener: function (t, f) { (winListeners[t] = winListeners[t] || []).push(f); },
    matchMedia: function (q) { return { matches: !!opts.standalone && q === '(display-mode: standalone)' }; }
  };
  var body = src + '\nreturn { state: (typeof storagePersistState === "function") ? storagePersistState : null,\n' +
    ' ask: (typeof requestStoragePersist === "function") ? requestStoragePersist : null };';
  var r = new Function('navigator', 'window', 'localStorage', 'logEvent', body)(
    nav, win, opts.localStorage || makeLocalStorage(), function (ev) { events.push(ev); });
  r.events = events; r.fire = function (t) { (winListeners[t] || []).forEach(function (f) { f({}); }); };
  return r;
}
function tick() { return new Promise(function (res) { setTimeout(res, 5); }); }

(async function main() {
  const T = 1790000000000;
  const H = 3600000, D = 86400000;

  // D5-T7 PWA-06: unsynced rule on this device's wall clocks only
  attempt('T7', function () {
    var u = loadUx();
    var f = u.syncStatusFrom;
    assertEq('T7a edit after lastSyncAt -> unsynced', f({ enabled: true, lastSyncAt: T }, T + 1, T + 2).unsynced, true);
    assertEq('T7b edit before lastSyncAt -> synced', f({ enabled: true, lastSyncAt: T }, T - 1, T + 2).unsynced, false);
    assertEq('T7c sync off -> never unsynced', f({ enabled: false, lastSyncAt: T }, T + 1, T + 2).unsynced, false);
    assertEq('T7d never synced + an edit -> unsynced', f({ enabled: true, lastSyncAt: null }, T, T + 2).unsynced, true);
    assertEq('T7e error surfaced', f({ enabled: true, lastSyncAt: T, lastError: 'boom' }, T + 1, T + 2).error, 'boom');
    assertEq('T7f stale after 1 h', f({ enabled: true, lastSyncAt: T }, null, T + 2 * H).stale, true);
    assertEq('T7g fresh within 1 h', f({ enabled: true, lastSyncAt: T }, null, T + 10 * 60000).stale, false);
  });

  // D5-T8 PWA-06 HLC trap: now() 100 s ahead must not keep the badge on
  attempt('T8', function () {
    var ahead = 100000;
    var h = loadDurable({ tasks: [], char: {}, __seq: 0 }, { now: function () { return Date.now() + ahead; } });
    var before = Date.now();
    h.save();
    var edit = h.getLocalEditAt();
    assert('T8a save stamps localEditAt with wall clock (not HLC)', typeof edit === 'number' && edit >= before && edit <= Date.now());
    var lastSyncAt = Date.now() + 10;
    assert('T8b premise: __savedAt is newer than lastSyncAt', h.getS().__savedAt > lastSyncAt);
    var u = loadUx();
    assertEq('T8c badge rule says synced', u.syncStatusFrom({ enabled: true, lastSyncAt: lastSyncAt }, edit, lastSyncAt + 1).unsynced, false);
    assertEq('T8d localEditAt persisted in its own key (not in S)', h.localStorage.getItem('questa.localEditAt.v1'), String(edit));
    assert('T8e localEditAt never enters S', !('localEditAt' in h.getS()));
  });

  // D5-T9 PWA-06 post-merge trap: a syncApply save is not a user edit
  attempt('T9', function () {
    var h = loadDurable({ tasks: [], char: {}, __seq: 0 }, { syncIsApplying: function () { return true; } });
    h.save();
    assert('T9a applying save leaves localEditAt unset', !h.getLocalEditAt());
    var h2 = loadDurable({ tasks: [], char: {}, __seq: 0 }, { syncIsApplying: function () { return false; } });
    h2.save();
    assert('T9b user save stamps localEditAt', typeof h2.getLocalEditAt() === 'number' && h2.getLocalEditAt() > 0);
  });

  // D5-T6 PWA-04: size meter + once-only 80/90 warnings
  attempt('T6', function () {
    var S = { tasks: [], char: {}, __seq: 0, pad: 'x'.repeat(4200000) };
    var h = loadDurable(S);
    h.save();
    var u = h.storageUsage && h.storageUsage();
    assert('T6a storageUsage().pct >= 80 at ~4.2 M chars', !!u && u.pct >= 80 && u.pct < 90);
    assertEq('T6b budget is 5,000,000 chars', u && u.budget, 5000000);
    // M1 (S3 review): the 80 % warning is a long toast, not the 2.4 s one.
    var warn = h.longs.filter(function (x) { return /8\d % full/.test(x.m); });
    assertEq('T6c exactly one 80 % warning (long toast)', warn.length, 1);
    assertEq('T6c2 not in the short 2.4 s toast', h.toasts.length, 0);
    assert('T6j M1 once-limit NOT used up before it was seen', h.localStorage.getItem('questa.storageWarn.v1') !== '80');
    h.save();
    assertEq('T6d second save at the same level -> no new warning this session', h.longs.length, 1);
    var reboot = loadDurable({ tasks: [], char: {}, __seq: 0, pad: 'x'.repeat(4200000) }, { localStorage: makeLocalStorage({ 'questa.storageWarn.v1': h.localStorage.getItem('questa.storageWarn.v1') || '0' }) });   // same device key, fresh save slot (no seq clash)
    reboot.save();
    assertEq('T6l M1 unseen 80 % warning comes back on the next launch', reboot.longs.length, 1);
    h.longs[0].seen();
    assertEq('T6j2 seen -> level 80 stored', h.localStorage.getItem('questa.storageWarn.v1'), '80');
    h.getS().pad = 'x'.repeat(4600000);
    h.save();
    assertEq('T6e ~4.6 M chars -> the 90 % warning is a dialog', h.alerts.length, 1);
    assert('T6f 90 % dialog text', /9\d % full/.test(h.alerts[0] ? h.alerts[0].x : '') && /Export a backup now/.test(h.alerts[0] ? h.alerts[0].x : ''));
    assertEq('T6k M1 90 % not stored before OK was tapped', h.localStorage.getItem('questa.storageWarn.v1'), '80');
    h.alerts[0].ok();
    assertEq('T6g warn level stored device-only after OK', h.localStorage.getItem('questa.storageWarn.v1'), '90');
    h.getS().pad = 'x'.repeat(1000);
    h.save();
    h.getS().pad = 'x'.repeat(4200000);
    h.save();
    assertEq('T6h re-armed after dropping below 70 %', h.longs.length, 2);
    // a late 'seen' of the 80 % toast must not overwrite a 90 % already stored
    var late = loadDurable({ tasks: [], char: {}, __seq: 0, pad: 'x'.repeat(4200000) });
    late.save();
    late.getS().pad = 'x'.repeat(4600000);
    late.save();
    late.alerts[0] && late.alerts[0].ok();
    late.longs[0] && late.longs[0].seen();
    assertEq('T6o late 80 % seen keeps the stored 90', late.localStorage.getItem('questa.storageWarn.v1'), '90');
    var small = loadDurable({ tasks: [], char: {}, __seq: 0 });
    small.save();
    assertEq('T6i small state -> no warning', small.toasts.length + small.longs.length + small.alerts.length, 0);
    // L2 mutant guards
    assertEq('T6m L2 badge updated after each save', small.badge.n, 1);
    small.save();
    assertEq('T6m2 L2 badge updated after the second save too', small.badge.n, 2);
    var q = loadDurable({ tasks: [], char: {}, __seq: 0 });
    q.noteSaveCommitted(4200000, false, true);
    assertEq('T6n L2 quota-hit save -> no size warning', q.longs.length + q.alerts.length + q.toasts.length, 0);
    q.noteSaveCommitted(4200000, false, false);
    assertEq('T6n2 premise: same size without quota hit warns', q.longs.length, 1);
  });

  // D5-T11 PWA-02: stale label
  attempt('T11', function () {
    var u = loadUx();
    assertEq('T11a 48 h -> "Last synced 2 days ago"', u.staleSyncLabel(T - 48 * H, T), 'Last synced 2 days ago');
    assertEq('T11b 30 min -> ""', u.staleSyncLabel(T - 30 * 60000, T), '');
    assertEq('T11c null -> "Never synced"', u.staleSyncLabel(null, T), 'Never synced');
    assertEq('T11d 2 h -> "Last synced 2 hours ago"', u.staleSyncLabel(T - 2 * H, T), 'Last synced 2 hours ago');
  });

  // D5-T10 PWA-06: badge element placement + rendering
  attempt('T10', function () {
    var iBadge = htmlSrc.indexOf('id="syncBadge"'), iRefresh = htmlSrc.indexOf('id="refreshBtn"');
    assert('T10a #syncBadge exists before #refreshBtn', iBadge > 0 && iBadge < iRefresh);
    var gear = htmlSrc.indexOf('id="gearBtn"');
    assert('T10b gear still within 200 chars after refresh (new-day-reload R8a)', gear > iRefresh && gear - iRefresh < 200);
    var badge = makeEl(), lbl = makeEl();
    var ls = makeLocalStorage({ 'questa.sync.v1': JSON.stringify({ enabled: true, lastSyncAt: Date.now() - 1000 }), 'questa.localEditAt.v1': String(Date.now()) });
    var u = loadUx({ localStorage: ls, els: { syncBadge: badge, syncBadgeLbl: lbl } });
    u.updateSyncBadge();
    assertEq('T10c unsynced -> badge shown', badge.hidden, false);
    assert('T10d unsynced -> "Not synced yet" label', /Not synced yet/.test(badge.title) && /Not synced yet/.test(badge.attrs['aria-label'] || ''));
    assert('T10e unsynced -> orange (unsynced) class', badge.classList.contains('unsynced'));
    ls.setItem('questa.localEditAt.v1', String(Date.now() - 5000));
    u.updateSyncBadge();
    assertEq('T10f synced + fresh -> hidden', badge.hidden, true);
    ls.setItem('questa.sync.v1', JSON.stringify({ enabled: true, lastSyncAt: Date.now() - 1000, lastError: 'x' }));
    ls.setItem('questa.localEditAt.v1', String(Date.now()));
    u.updateSyncBadge();
    assert('T10g error + unsynced -> red "Sync problem"', badge.classList.contains('err') && /Sync problem/.test(badge.title));
    ls.setItem('questa.sync.v1', JSON.stringify({ enabled: true, lastSyncAt: Date.now() - 48 * H }));
    ls.setItem('questa.localEditAt.v1', String(Date.now() - 49 * H));
    u.updateSyncBadge();
    assertEq('T10h stale -> muted text', lbl.textContent, 'Last synced 2 days ago');
    ls.setItem('questa.sync.v1', JSON.stringify({ enabled: false }));
    u.updateSyncBadge();
    assertEq('T10i sync off -> nothing at all', badge.hidden, true);
    // L2: the 5 s poll runs only while the page is visible
    var b2 = makeEl();
    var ls2 = makeLocalStorage({ 'questa.sync.v1': JSON.stringify({ enabled: true, lastSyncAt: Date.now() - 48 * H }) });
    var hid = loadUx({ localStorage: ls2, els: { syncBadge: b2 }, visibility: 'hidden' });
    hid.updateSyncBadge();
    assertEq('T10j L2 badge shown while hidden -> no 5 s poll started', hid.calls.intervals, 0);
    var vis = loadUx({ localStorage: ls2, els: { syncBadge: b2 } });
    vis.updateSyncBadge();
    assertEq('T10k premise: visible -> poll started', vis.calls.intervals, 1);
    vis.doc.visibilityState = 'hidden';
    vis.updateSyncBadge();
    assertEq('T10l L2 page hidden -> poll stopped', vis.calls.cleared, 1);
  });

  // D5-T12 PWA-24 long-offline rule, no sync calls, constant parity with sync.js
  attempt('T12', function () {
    var u = loadUx();
    var now = Date.now();
    assertEq('T12a 181 days -> warn', u.isLongOffline({ enabled: true, lastSyncAt: now - 181 * D }, now), true);
    assertEq('T12b 179 days -> no warn', u.isLongOffline({ enabled: true, lastSyncAt: now - 179 * D }, now), false);
    assertEq('T12c never synced -> no warn', u.isLongOffline({ enabled: true, lastSyncAt: null }, now), false);
    assertEq('T12d sync off -> no warn', u.isLongOffline({ enabled: false, lastSyncAt: now - 400 * D }, now), false);
    var ls = makeLocalStorage({ 'questa.sync.v1': JSON.stringify({ enabled: true, lastSyncAt: now - 200 * D }) });
    var w = loadUx({ localStorage: ls });
    assertEq('T12e warning shown', w.longOfflineWarning(now), true);
    assertEq('T12f one dialog', w.calls.alert.length, 1);
    assert('T12g dialog title', w.calls.alert[0] && w.calls.alert[0][0] === 'This device has not synced for more than 6 months.');
    assertEq('T12h the warning calls no sync function', w.calls.sync, 0);
    w.longOfflineWarning(now);
    assertEq('T12i once per boot', w.calls.alert.length, 1);
    // E2 follow-up: at most one dialog per 24 h across page loads (device-only stamp)
    var w2 = loadUx({ localStorage: ls });
    assertEq('T12k second boot 1 h later -> no second dialog', w2.longOfflineWarning(now + H), false);
    assertEq('T12l second boot shows nothing', w2.calls.alert.length, 0);
    var w3 = loadUx({ localStorage: ls });
    assertEq('T12m boot 25 h later -> dialog again', w3.longOfflineWarning(now + 25 * H), true);
    var tm = syncSrc.match(/const TOMBSTONE_MAX_AGE_MS = ([^;]+);/);
    var am = appSrc.match(/const LONG_OFFLINE_MS = ([^;]+);/);
    // eslint-disable-next-line no-new-func
    assert('T12j LONG_OFFLINE_MS equals sync.js TOMBSTONE_MAX_AGE_MS', !!tm && !!am && (new Function('return ' + tm[1]))() === (new Function('return ' + am[1]))());
  });

  // D5-T13 PWA-24 boot capture: first sync round overwrites lastSyncAt; the boot value must win
  attempt('T13', function () {
    var now = Date.now();
    var ls = makeLocalStorage({ 'questa.sync.v1': JSON.stringify({ enabled: true, lastSyncAt: now - 200 * D }) });
    var w = loadUx({ localStorage: ls });
    ls.setItem('questa.sync.v1', JSON.stringify({ enabled: true, lastSyncAt: now }));   // first round finished
    assertEq('T13a boot snapshot kept the old lastSyncAt', w.bootSnap.lastSyncAt, now - 200 * D);
    assertEq('T13b warning still fires from the boot value', w.longOfflineWarning(now), true);
  });

  // L2: the stale toast shows once per session
  attempt('T15', function () {
    var now = Date.now();
    var ls = makeLocalStorage({ 'questa.sync.v1': JSON.stringify({ enabled: true, lastSyncAt: now - 48 * H }) });
    var u = loadUx({ localStorage: ls });
    assertEq('T15a first call -> toast', u.maybeStaleSyncToast(now), true);
    assertEq('T15b second call -> none', u.maybeStaleSyncToast(now + 1000), false);
    assertEq('T15c one toast per session', u.calls.toast.length, 1);
  });

  // M2 (S3 review): the stale check waits for the first sync round
  attempt('T16', function () {
    var now = Date.now();
    var stale = JSON.stringify({ enabled: true, lastSyncAt: now - 48 * H });
    function boot() { var ls = makeLocalStorage({ 'questa.sync.v1': stale }); var u = loadUx({ localStorage: ls }); u.ls = ls; return u; }
    var a = boot();
    assert('T16a scheduleStaleSyncCheck exists and schedules', !!a.scheduleStaleSyncCheck && a.scheduleStaleSyncCheck() === true);
    assertEq('T16b no toast at boot, before the first round', a.calls.toast.length, 0);
    a.ls.setItem('questa.sync.v1', JSON.stringify({ enabled: true, lastSyncAt: now, lastError: null }));   // round succeeded
    while (a.runNext()) {}
    assertEq('T16c first round succeeded -> no toast at all', a.calls.toast.length, 0);
    var a2 = boot();
    a2.scheduleStaleSyncCheck && a2.scheduleStaleSyncCheck();
    a2.ls.setItem('questa.sync.v1', JSON.stringify({ enabled: true, lastSyncAt: now, lastError: null }));
    a2.runNext();
    assertEq('T16c2 polling stops as soon as the round succeeded', a2.calls.timeouts.length, 0);
    var b = boot();
    b.scheduleStaleSyncCheck && b.scheduleStaleSyncCheck();
    b.runNext();
    b.ls.setItem('questa.sync.v1', JSON.stringify({ enabled: true, lastSyncAt: now - 48 * H, lastError: 'offline' }));   // round failed
    b.runNext();
    assertEq('T16d first round failed -> toast right after it', b.calls.toast.length, 1);
    assert('T16d2 toast text', /Last synced 2 days ago\. What you see here may be out of date\./.test(b.calls.toast[0] || ''));
    var c = boot();
    c.scheduleStaleSyncCheck && c.scheduleStaleSyncCheck();
    var ms = 0, shownAt = -1;
    while (c.calls.timeouts.length) { ms += c.calls.timeouts[0].ms; c.runNext(); if (shownAt < 0 && c.calls.toast.length) shownAt = ms; }
    assert('T16e no round finished -> toast after about 15 s (got ' + shownAt + ' ms)', shownAt >= 10000 && shownAt <= 20000);
    var off = loadUx({ localStorage: makeLocalStorage({ 'questa.sync.v1': JSON.stringify({ enabled: false, lastSyncAt: now - 48 * H }) }) });
    assertEq('T16f sync off -> nothing scheduled', off.scheduleStaleSyncCheck ? off.scheduleStaleSyncCheck() : false, false);
    assertEq('T16f2 sync off -> no timer', off.calls.timeouts.length, 0);
    var bootSrc = (appSrc.split('// D5 PWA-06/PWA-02/PWA-24 boot')[1] || '').split('setTimeout(()=>{')[0];
    assert('T16g boot + visible paths use scheduleStaleSyncCheck, never the toast directly',
      bootSrc.length > 0 && (bootSrc.match(/scheduleStaleSyncCheck\(\)/g) || []).length === 2 && bootSrc.indexOf('maybeStaleSyncToast') < 0);
  });

  // M1: the long toast itself (the plain 2.4 s toast stays as it was)
  attempt('T17', function () {
    var src = extractFunction(appSrc, /^function toastLong\(msg, onSeen\)\{/, 'toastLong');
    var toastSrc = extractFunction(appSrc, /^function toast\(msg\)\{/, 'toast');
    assert('T17a plain toast still 2.4 s', /setTimeout\(\(\)=>e\.remove\(\),2400\)/.test(toastSrc));
    function run(visibility) {
      var timers = [], kids = [], seen = 0, el = null;
      var doc = {
        visibilityState: visibility,
        getElementById: function () { return { appendChild: function (e) { kids.push(e); } }; },
        createElement: function () {
          el = { listeners: {}, attrs: {}, removed: false, className: '', textContent: '',
            addEventListener: function (t, f) { this.listeners[t] = f; }, setAttribute: function (k, v) { this.attrs[k] = v; },
            remove: function () { this.removed = true; } };
          return el;
        }
      };
      var fn = new Function('document', 'setTimeout', src + '\nreturn toastLong;')(doc, function (f, ms) { timers.push({ f: f, ms: ms }); });
      fn('Long message', function () { seen++; });
      return { timers: timers, el: el, seen: function () { return seen; }, doc: doc };
    }
    var v = run('visible');
    assert('T17b long toast has its own class', /toastLong/.test(v.el.className));
    var minRemove = Math.min.apply(null, v.timers.map(function (t) { return t.ms; }));
    assert('T17c stays at least 10 s', minRemove >= 10000);
    v.timers.slice().sort(function (x, y) { return x.ms - y.ms; })[0].f();
    assertEq('T17d 10 s on a visible page -> counted as seen', v.seen(), 1);
    var hid = run('hidden');
    hid.timers.forEach(function (t) { t.f(); });
    assertEq('T17e page hidden the whole time -> not seen', hid.seen(), 0);
    var tap = run('visible');
    tap.el.listeners.click();
    assert('T17f tap -> seen and removed', tap.seen() === 1 && tap.el.removed);
    tap.timers.forEach(function (t) { t.f(); });
    assertEq('T17g seen is counted once', tap.seen(), 1);
  });

  // D5-T3 PWA-03 gentle nag
  attempt('T3', function () {
    var now = Date.now();
    var u = loadUx({ S: { prefs: { lastExportTs: now - 12 * D } } });
    assertEq('T3a not persisted + 12-day-old export -> nag', u.maybeStorageNag(false, now), true);
    assert('T3b nag text (long toast, M1)', u.calls.toast.length === 0 && u.calls.long.length === 1 && /not protected from browser cleanup/.test(u.calls.long[0].m) && /12 days ago/.test(u.calls.long[0].m));
    assertEq('T3j M1 stamp not written before the nag was seen', u.localStorage.getItem('questa.persistNagAt.v1'), null);
    var again = loadUx({ S: { prefs: { lastExportTs: now - 12 * D } }, localStorage: u.localStorage });
    assertEq('T3k M1 unseen nag comes back on the next launch', again.maybeStorageNag(false, now + H), true);
    u.calls.long[0].seen();
    assertEq('T3d nag stamp stored device-only once seen', u.localStorage.getItem('questa.persistNagAt.v1'), String(now));
    assertEq('T3c second call within 7 days -> none', u.maybeStorageNag(false, now + D), false);
    var y = loadUx({ S: { prefs: { lastExportTs: now - D } } });
    assertEq('T3e exported yesterday -> none', y.maybeStorageNag(false, now), false);
    var n = loadUx({ S: { prefs: {} } });
    assertEq('T3f persisted unknown (null) -> none', n.maybeStorageNag(null, now), false);
    assertEq('T3g persisted true -> none', n.maybeStorageNag(true, now), false);
    var ls = makeLocalStorage({ 'questa.sync.v1': JSON.stringify({ enabled: true, lastSyncAt: now - H }) });
    var s = loadUx({ S: { prefs: {} }, localStorage: ls });
    assertEq('T3h fresh Dropbox sync counts as an off-device copy -> none', s.maybeStorageNag(false, now), false);
  });

  // D5-T4 PWA-03 Settings rows + relabel
  attempt('T4', function () {
    var u = loadUx();
    var now = Date.now();
    var html = u.durabilityRowsHtml(false, { chars: 4100000, budget: 5000000, pct: 82 }, { ts: now - 3 * D, via: 'Dropbox sync' }, now);
    assert('T4a "Storage protected from browser cleanup: No"', html.indexOf('Storage protected from browser cleanup: No') >= 0);
    assert('T4b last off-device copy', html.indexOf('Last copy outside this device: 3 days ago (Dropbox sync)') >= 0);
    assert('T4c size meter', html.indexOf('Saved data: 4.1 MB of about 5 MB (82 %)') >= 0);
    // L1: element nesting. Every close tag matches its open tag, nothing is left open,
    // and the storage-estimate row sits inside the .durabilityRows wrapper.
    var stack = [], nestOk = true, estInside = false, re = /<(\/?)([a-z]+)\b([^>]*)>/g, mt;
    while ((mt = re.exec(html))) {
      if (mt[1]) { if (stack.pop() !== mt[2]) nestOk = false; }
      else { if (/id="storageEstimateRow"/.test(mt[3])) estInside = stack.length >= 1; stack.push(mt[2]); }
    }
    assert('T4c2 L1 tags balanced and correctly nested', nestOk && stack.length === 0);
    assert('T4c3 L1 storage-estimate row inside the wrapper', estInside);
    var h2 = u.durabilityRowsHtml(null, null, { ts: null, via: '' }, now);
    assert('T4d unknown + never', h2.indexOf('Unknown (this browser does not say)') >= 0 && h2.indexOf('Last copy outside this device: never') >= 0);
    assert('T4e local snapshot relabelled', appSrc.indexOf('Last local snapshot (on this device only)') >= 0 && appSrc.indexOf('Last full backup') < 0);
  });

  // D5-T1 / T2 PWA-03 persist block
  await (async function () {
    var r = attempt('T1 load', function () {
      return loadPersist({ storage: { persisted: function () { return Promise.resolve(false); }, persist: function () { return Promise.resolve(false); } } });
    });
    if (r) {
      await tick();
      assertEq('T1a storagePersistState() === false after denial', r.state && r.state(), false);
      assert('T1b logEvent storagePersist granted:false', r.events.length === 1 && r.events[0].kind === 'storagePersist' && r.events[0].granted === false);
    }
    var calls = 0;
    var nav = { storage: { persisted: function () { return Promise.resolve(false); }, persist: function () { calls++; return Promise.resolve(false); } } };
    var p = attempt('T2 load', function () { return loadPersist(nav); });
    if (p) {
      await tick();
      p.fire('appinstalled');
      await tick();
      assertEq('T2a appinstalled re-asks persist()', calls, 2);
    }
    var ls = makeLocalStorage(), c2 = 0;
    var nav2 = { storage: { persisted: function () { return Promise.resolve(false); }, persist: function () { c2++; return Promise.resolve(true); } } };
    var s1 = attempt('T2 standalone 1', function () { return loadPersist(nav2, { standalone: true, localStorage: ls }); });
    await tick();
    assertEq('T2b standalone first launch asks once', c2, 1);
    assertEq('T2c standalone flag set after the ask resolved', ls.getItem('questa.persistAskedStandalone.v1'), '1');
    assertEq('T2d granted -> state true', s1 && s1.state && s1.state(), true);
    c2 = 0;
    attempt('T2 standalone 2', function () { return loadPersist(nav2, { standalone: true, localStorage: ls }); });
    await tick();
    assertEq('T2e second standalone launch: no extra ask', c2, 1);
    var c3 = 0;
    var nav3 = { storage: { persisted: function () { return Promise.resolve(true); }, persist: function () { c3++; return Promise.resolve(true); } } };
    var q = attempt('T2 already persisted', function () { return loadPersist(nav3); });
    await tick();
    assertEq('T2f already persisted -> persist() not called', c3, 0);
    assertEq('T2g already persisted -> state true', q && q.state && q.state(), true);
    var none = attempt('T2 no storage API', function () { return loadPersist({}); });
    await tick();
    assertEq('T2h no API -> state null (unknown)', none && none.state && none.state(), null);
  })();

  // D5-T14 EXTRA-1: Save-to-device must not clear the nag without the user's word
  await (async function () {
    function runExport(answer) {
      var src = extractFunction(appSrc, /^function exportSaveDevice\(blob, filename, eventCount, opts\) \{/, 'exportSaveDevice') + '\n' +
        extractFunction(appSrc, /^function checkExportStaleness\(\)\{/, 'checkExportStaleness') + '\nreturn exportSaveDevice;';
      var gear = makeEl(); gear.classList.add('stale');
      var st = { toasts: [], confirms: [], saves: 0, S: { prefs: { lastExportTs: 1 } }, gear: gear };
      var doc = { createElement: function () { return { click: function () {} }; }, getElementById: function (id) { return id === 'gearBtn' ? gear : null; } };
      var fn = new Function('S', 'document', 'URL', 'setTimeout', 'save', 'toast', 'closeSheet', 'logEvent', 'confirmDialog', src)(
        st.S, doc, { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} }, function () {},
        function () { st.saves++; }, function (m) { st.toasts.push(m); }, function () {}, function () {},
        function (t, x) { st.confirms.push([t, x]); return Promise.resolve(answer); });
      fn({}, 'questa-backup-2026-09-26.json', 3, {});
      return st;
    }
    var no = attempt('T14 run(false)', function () { return runExport(false); });
    await tick();
    if (no) {
      assertEq('T14a Cancel -> lastExportTs unchanged', no.S.prefs.lastExportTs, 1);
      assert('T14b Cancel -> gear still stale', no.gear.classList.contains('stale'));
      assert('T14c asks "Did the backup file save?"', no.confirms.length === 1 && no.confirms[0][0] === 'Did the backup file save?');
      assert('T14d toast says the download only started', no.toasts.some(function (m) { return /Download started/.test(m); }));
    }
    var yes = attempt('T14 run(true)', function () { return runExport(true); });
    await tick();
    if (yes) {
      assert('T14e OK -> lastExportTs stamped', yes.S.prefs.lastExportTs > 1);
      assert('T14f OK -> stale removed', !yes.gear.classList.contains('stale'));
      assertEq('T14g OK -> save() once', yes.saves, 1);
    }
  })();

  if (failures > 0) { console.error(failures + ' durability-ux test(s) failed.'); process.exit(1); }
  console.log('All durability-ux tests passed!');
})().catch(function (e) { console.error('durability-ux test error:', e); process.exit(1); });
