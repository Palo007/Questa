// divergence-readout.test.js -- W6.16: per-device event divergence readout in
// showSyncDebugOverlay(). Added after the 2026-07-28 outage where
// /events/ms5tzgmpcu4ph-202607.json sat in Dropbox holding 3,379 events for a
// full month while the other device pulled zero of them -- state sync had
// converged so nothing in the UI hinted at it. This block surfaces that
// exact shape (a device with ZERO local events for a `dev` whose event file
// IS in the cached Dropbox listing) with an unmistakable visual marker,
// without any network I/O of its own (it only reads already-cached cfg +
// a one-pass local IndexedDB histogram).
//
// Functions under test (all in app.js, extracted by anchor -- see
// tests/_extract.js):
//   _qDivFileDev(name)              "<dev>-<YYYYMM>.json" -> dev | null
//   _qDivTs(ts)                     cfg timestamp -> display string
//   _qDivergenceHtml(devices, localHist, cfg)   pure HTML builder (the core
//                                    logic under test -- no IDB/network)
//   evtDevHistogram()                one-pass IndexedDB cursor -> {dev:count}
//   showSyncDebugOverlay()          full overlay wiring (integration checks)
//
// Run: node tests/divergence-readout.test.js (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js. Do NOT reintroduce hardcoded line-number slicing.
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
const deviceDisplayNameFn = extractFunction(appSrc, /^function deviceDisplayName\(devices, devId\)\{/, 'deviceDisplayName');
const qDivFileDevFn = extractFunction(appSrc, /^function _qDivFileDev\(name\)\{/, '_qDivFileDev');
const qDivTsFn = extractFunction(appSrc, /^function _qDivTs\(ts\)\{/, '_qDivTs');
const qDivergenceHtmlFn = extractFunction(appSrc, /^function _qDivergenceHtml\(devices, localHist, cfg\)\{/, '_qDivergenceHtml');
const evtDevHistogramFn = extractFunction(appSrc, /^function evtDevHistogram\(\)\{/, 'evtDevHistogram');
const qDiagErrorsHtmlFn = extractFunction(appSrc, /^function _qDiagErrorsHtml\(\)\{/, '_qDiagErrorsHtml');
const showSyncDebugOverlayFn = extractFunction(appSrc, /^function showSyncDebugOverlay\(\)\{/, 'showSyncDebugOverlay');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// ---------------------------------------------------------------------------
// Pure-function sandbox: esc + deviceDisplayName + the three _qDiv* helpers.
// No DOM, no IndexedDB -- these are plain string-in/string-out functions.
// ---------------------------------------------------------------------------
function makePureCtx() {
  const sandbox = { console: console, Date: Date, JSON: JSON, Object: Object, Array: Array };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = [escFn, deviceDisplayNameFn, qDivFileDevFn, qDivTsFn, qDivergenceHtmlFn].join('\n');
  vm.runInContext(src, sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// Fake IndexedDB for evtDevHistogram(): a fake `idbOpen()` (app.js's own
// async wrapper, which evtDevHistogram calls directly) resolving to a fake
// db whose events.openCursor() walks a given record array asynchronously,
// like the real IndexedDB cursor API.
// ---------------------------------------------------------------------------
function makeFakeEventsDb(records) {
  return {
    transaction: function (storeName) {
      if (storeName !== 'events') throw new Error('unexpected store: ' + storeName);
      return {
        objectStore: function () {
          return {
            openCursor: function () {
              let idx = 0;
              const cur = { onsuccess: null, onerror: null, result: null };
              function step() {
                if (idx < records.length) {
                  const rec = records[idx];
                  cur.result = { value: rec, continue: function () { idx++; Promise.resolve().then(step); } };
                } else {
                  cur.result = null;
                }
                if (typeof cur.onsuccess === 'function') cur.onsuccess();
              }
              Promise.resolve().then(step);
              return cur;
            },
          };
        },
      };
    },
  };
}

function makeHistogramCtx(records, opts) {
  opts = opts || {};
  const sandbox = {
    console: console, Date: Date, JSON: JSON, Object: Object, Array: Array, Promise: Promise,
    EVENTS_STORE: 'events',
    idbOpen: opts.idbUnavailable
      ? function () { return Promise.reject(new Error('idb unavailable')); }
      : function () { return Promise.resolve(makeFakeEventsDb(records)); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(evtDevHistogramFn, sandbox);
  return sandbox;
}

// ---------------------------------------------------------------------------
// Full-overlay integration sandbox (fake DOM + fake indexedDB.open for the
// base lookup + fake idbOpen for the events histogram), modeled on
// tests/backfill-ui-wiring.test.js's makeFakeDocument()/makeFakeIndexedDB().
// ---------------------------------------------------------------------------
function makeFakeDocument() {
  const body = { children: [], appendChild: function (c) { this.children.push(c); } };
  function makeEl(tag) {
    return {
      tagName: tag, style: {}, children: [],
      appendChild: function (c) { this.children.push(c); },
      focus: function () {}, select: function () {}, remove: function () {},
      addEventListener: function () {},
    };
  }
  return {
    body: body,
    createElement: function (tag) { return makeEl(tag); },
    execCommand: function () { return true; },
  };
}

// Fake indexedDB.open("questa") for the syncmeta/base lookup, independent of
// the fake idbOpen() used for the events histogram (the real code uses two
// different access paths -- see showSyncDebugOverlay()/evtDevHistogram()).
function makeFakeIndexedDB(opts) {
  opts = opts || {};
  return {
    open: function () {
      const req = { onsuccess: null, onerror: null, result: null };
      if (opts.openFails) {
        Promise.resolve().then(function () { if (req.onerror) req.onerror(); });
        return req;
      }
      req.result = {
        transaction: function () {
          return {
            objectStore: function () {
              return {
                get: function () {
                  const g = { onsuccess: null, onerror: null, result: opts.baseResult };
                  Promise.resolve().then(function () { if (g.onsuccess) g.onsuccess(); });
                  return g;
                },
              };
            },
          };
        },
      };
      Promise.resolve().then(function () { if (req.onsuccess) req.onsuccess(); });
      return req;
    },
  };
}

function flush() {
  return new Promise(function (resolve) {
    let rounds = 0;
    (function tick() { rounds++; if (rounds >= 8) { resolve(); return; } setTimeout(tick, 0); })();
  });
}

function makeOverlayCtx(cfgObj, eventRecords, opts) {
  opts = opts || {};
  const netCalls = { dbxListFolder: 0, dbxDownloadRaw: 0, fetch: 0 };
  const sandbox = {
    console: console, JSON: JSON, Date: Date, Object: Object, Array: Array, Promise: Promise,
    document: makeFakeDocument(),
    indexedDB: makeFakeIndexedDB({ openFails: opts.openFails, baseResult: opts.baseResult }),
    localStorage: { getItem: function () { return cfgObj === null ? null : JSON.stringify(cfgObj); } },
    navigator: {},
    window: {},
    APP_VERSION: 'vTEST',
    EVENTS_STORE: 'events',
    idbOpen: opts.idbUnavailable
      ? function () { return Promise.reject(new Error('idb unavailable')); }
      : function () { return Promise.resolve(makeFakeEventsDb(eventRecords || [])); },
    S: opts.S !== undefined ? opts.S : { devices: [] },
    downloadFullDiagnostic: function () {},
    // Spies proving the overlay never triggers network I/O to populate itself.
    dbxListFolder: function () { netCalls.dbxListFolder++; return Promise.resolve([]); },
    dbxDownloadRaw: function () { netCalls.dbxDownloadRaw++; return Promise.resolve(null); },
    fetch: function () { netCalls.fetch++; return Promise.reject(new Error('network disabled in test')); },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = [escFn, deviceDisplayNameFn, qDivFileDevFn, qDivTsFn, qDivergenceHtmlFn, evtDevHistogramFn, qDiagErrorsHtmlFn, showSyncDebugOverlayFn].join('\n');
  try { vm.runInContext(src, sandbox); }
  catch (e) { console.error('FAIL: extracted source threw during eval:', e); process.exit(1); }
  return { sandbox: sandbox, netCalls: netCalls };
}

function getDivBoxHtml(ctx) {
  const bodyChildren = ctx.sandbox.document.body.children;
  const ov = bodyChildren[bodyChildren.length - 1];
  // Order appended in app.js: ta, errBox, divBox, backfillBox, btnRow.
  return ov.children[2].innerHTML;
}

async function main() {
  // -------------------------------------------------------------------
  // 1) Renders with sync DISCONNECTED without throwing (explicit
  //    acceptance criterion). No questa.sync.v1 key at all (localStorage
  //    returns null -> cfg = {}), IDB base-lookup also unavailable.
  // -------------------------------------------------------------------
  {
    let threw = false;
    const ctx = makeOverlayCtx(null, [], { openFails: true, idbUnavailable: true });
    try { ctx.sandbox.showSyncDebugOverlay(); await flush(); }
    catch (e) { threw = true; console.error(e); }
    assert('1a: showSyncDebugOverlay() does not throw when sync is fully disconnected', !threw);
    let html = '';
    try { html = getDivBoxHtml(ctx); } catch (e) { threw = true; }
    assert('1b: divergence block rendered some content while disconnected', !threw && typeof html === 'string' && html.length > 0);
    assert('1c: shows "not connected" rather than failing/crashing', /not connected/.test(html));
  }

  // -------------------------------------------------------------------
  // 2) Renders with an EMPTY event store without throwing.
  // -------------------------------------------------------------------
  {
    let threw = false;
    const ctx = makeOverlayCtx({ enabled: true, refreshToken: 'tok', deviceId: 'devMe' }, [], { baseResult: undefined, S: { devices: [] } });
    try { ctx.sandbox.showSyncDebugOverlay(); await flush(); }
    catch (e) { threw = true; console.error(e); }
    assert('2a: showSyncDebugOverlay() does not throw with an empty event store', !threw);
    const html = getDivBoxHtml(ctx);
    assert('2b: degrades to "No known devices" with nothing to show', /No known devices/.test(html));
  }

  // -------------------------------------------------------------------
  // 3) THE MOST IMPORTANT ASSERTION: zero local events for a `dev` whose
  //    file exists in the cached Dropbox listing (cfg.evtFileRevs) must be
  //    flagged, unmistakably, as the July 28 signature.
  // -------------------------------------------------------------------
  {
    const sandbox = makePureCtx();
    const devices = [{ id: 'ms5tzgmpcu4ph', name: 'Old Phone' }];
    const localHist = {}; // zero local events for this dev
    const cfg = { evtFileRevs: { 'ms5tzgmpcu4ph-202607.json': 'abc123rev' }, evtBadRevs: {} };
    const html = sandbox._qDivergenceHtml(devices, localHist, cfg);
    assert('3a: the zero-local/remote-exists row is flagged with the DIVERGENCE marker', /DIVERGENCE/.test(html));
    assert('3b: the flagged device name is present', /Old Phone/.test(html));
    assert('3c: local count of 0 is shown for the flagged device', /local events: 0/.test(html));
    assert('3d: the cached remote rev is surfaced', /abc123rev/.test(html));
  }

  // -------------------------------------------------------------------
  // 4) DISCRIMINATION: a device with healthy counts on BOTH sides must NOT
  //    be flagged -- proves the signal isn't just always-on.
  // -------------------------------------------------------------------
  {
    const sandbox = makePureCtx();
    const devices = [{ id: 'devHealthy', name: 'Healthy Tablet' }];
    const localHist = { devHealthy: 42 };
    const cfg = { evtFileRevs: { 'devHealthy-202607.json': 'rev999' } };
    const html = sandbox._qDivergenceHtml(devices, localHist, cfg);
    assert('4a: a device with local>0 and a remote file present is NOT flagged', !/DIVERGENCE/.test(html));
    assert('4b: its local count is shown correctly', /local events: 42/.test(html));

    // Also: zero-local AND no remote file cached at all (a device that has
    // simply never synced) must NOT be flagged -- only "remote exists but
    // local is zero" is the failure signature, not "both are empty".
    const devices2 = [{ id: 'devNeverSynced', name: 'Brand New' }];
    const html2 = sandbox._qDivergenceHtml(devices2, {}, { evtFileRevs: {} });
    assert('4c: zero-local with NO remote file cached is NOT flagged (not the failure signature)', !/DIVERGENCE/.test(html2));
  }

  // -------------------------------------------------------------------
  // 5) Per-`dev` local counts are correct for a mixed store, via
  //    evtDevHistogram() -- one cursor pass, not a scan per device.
  // -------------------------------------------------------------------
  {
    const records = [
      { dev: 'devA', ts: 1 }, { dev: 'devA', ts: 2 }, { dev: 'devA', ts: 3 },
      { dev: 'devB', ts: 4 }, { dev: 'devB', ts: 5 },
      { dev: 'devC', ts: 6 },
      { ts: 7 }, // no dev field at all -- must not throw or vanish silently
    ];
    const sandbox = makeHistogramCtx(records);
    const hist = await sandbox.evtDevHistogram();
    assert('5a: devA counted correctly (3)', hist.devA === 3);
    assert('5b: devB counted correctly (2)', hist.devB === 2);
    assert('5c: devC counted correctly (1)', hist.devC === 1);
    assert('5d: a record with no dev field is bucketed, not dropped', hist['(no dev)'] === 1);
    const total = Object.keys(hist).reduce(function (s, k) { return s + hist[k]; }, 0);
    assert('5e: total counted equals total records (7)', total === 7);
  }

  // evtDevHistogram must also resolve gracefully (not throw/reject) if IDB
  // is unavailable -- same "degrade, don't fail" requirement as the overlay.
  {
    const sandbox = makeHistogramCtx([], { idbUnavailable: true });
    let threw = false, hist = null;
    try { hist = await sandbox.evtDevHistogram(); } catch (e) { threw = true; }
    assert('5f: evtDevHistogram() does not throw/reject when IDB is unavailable', !threw);
    assert('5g: evtDevHistogram() resolves to an empty object on failure', hist && Object.keys(hist).length === 0);
  }

  // -------------------------------------------------------------------
  // 6) Device names containing HTML metacharacters are escaped -- device
  //    names are user-supplied, filenames come from Dropbox; both must be
  //    esc()'d before landing in innerHTML.
  // -------------------------------------------------------------------
  {
    const sandbox = makePureCtx();
    const payload = '<img src=x onerror=alert(1)>';
    const devices = [{ id: 'devEvil', name: payload }];
    const cfg = { evtFileRevs: {} };
    const html = sandbox._qDivergenceHtml(devices, { devEvil: 5 }, cfg);
    assert('6a: raw "<img" does not appear unescaped for a malicious device name', html.indexOf('<img') === -1);
    assert('6b: the escaped form is present instead', html.indexOf('&lt;img') !== -1);

    // Filename-derived dev id containing metacharacters (simulates a dev id
    // seen only via a Dropbox filename, never registered in S.devices).
    const cfg2 = { evtFileRevs: {} };
    cfg2.evtFileRevs['<script>x</script>-202607.json'] = 'rev1';
    const html2 = sandbox._qDivergenceHtml([], {}, cfg2);
    assert('6c: a metacharacter-bearing dev id/filename is escaped, not raw', html2.indexOf('<script>') === -1);
    assert('6d: the escaped filename form is present', /&lt;script&gt;/.test(html2));
    // And this exact case (remote file listed, zero local) must still flag.
    assert('6e: the escaped, flagged row still carries the DIVERGENCE marker', /DIVERGENCE/.test(html2));
  }

  // -------------------------------------------------------------------
  // 7) No network call is attempted while the overlay renders itself.
  // -------------------------------------------------------------------
  {
    const ctx = makeOverlayCtx(
      { enabled: true, refreshToken: 'tok', deviceId: 'devMe', evtFileRevs: { 'devOther-202607.json': 'rev1' } },
      [{ dev: 'devMe', ts: 1 }],
      { S: { devices: [{ id: 'devMe', name: 'This Phone' }, { id: 'devOther', name: 'Other Phone' }] } }
    );
    ctx.sandbox.showSyncDebugOverlay();
    await flush();
    assert('7a: dbxListFolder was never called', ctx.netCalls.dbxListFolder === 0);
    assert('7b: dbxDownloadRaw was never called', ctx.netCalls.dbxDownloadRaw === 0);
    assert('7c: fetch was never called', ctx.netCalls.fetch === 0);
    // Sanity: with this setup devOther should be flagged (0 local, file cached).
    const html = getDivBoxHtml(ctx);
    assert('7d: sanity -- devOther (0 local, remote file cached) is flagged', /DIVERGENCE/.test(html) && /Other Phone/.test(html));
    assert('7e: sanity -- devMe (1 local, no remote file) is NOT flagged', (function () {
      const idx = html.indexOf('This Phone');
      if (idx === -1) return false;
      const rowStart = html.lastIndexOf('<div', idx);
      const rowSlice = html.slice(Math.max(0, rowStart - 200), idx + 200);
      return !/DIVERGENCE/.test(rowSlice) || html.indexOf('DIVERGENCE') > html.indexOf('Other Phone');
    })());
  }

  if (failures) {
    console.error('\n' + failures + ' divergence-readout assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL DIVERGENCE-READOUT TESTS PASSED');
  process.exit(0);
}

main().catch(function (e) {
  console.error('Unhandled:', e && e.stack || e);
  process.exit(1);
});
