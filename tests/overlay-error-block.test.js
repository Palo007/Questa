// overlay-error-block.test.js -- W2.5: showSyncDebugOverlay() gained a
// read-only "Recent errors (last 50)" block rendering window.__qDiag.errors
// (the bounded ring hardened in W2.4 -- see logevent-harden.test.js -- and
// fed by sync.js's syncEventsPull() evtPullSkip/evtPullOk pushes) so a phone
// with no console can see recent failures without exporting the full
// diagnostic dump.
//
// The rendering logic lives in its own function, _qDiagErrorsHtml() (app.js,
// just above showSyncDebugOverlay), specifically so it can be extracted and
// tested in isolation without mocking IndexedDB/document for the whole
// overlay. It:
//   - reads window.__qDiag.errors (tolerating window.__qDiag being entirely
//     absent, or the ring being empty) and renders newest-first;
//   - escapes every interpolated value with esc() -- entries can carry
//     arbitrary strings (exception messages, Dropbox filenames), so raw
//     interpolation into the overlay's innerHTML would be an injection
//     vector;
//   - renders unknown/differing entry shapes generically (every own key
//     except t/kind, skipping undefined/null) so an unrecognized shape still
//     shows useful fields instead of the literal string "undefined";
//   - never mutates window.__qDiag.errors (copies via slice()/reverse()).
//
// Run: node tests/overlay-error-block.test.js (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Anchor-based extraction (see tests/_extract.js) -- survives line shifts
// elsewhere in app.js. Do NOT reintroduce hardcoded line-number slicing.
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
const blockFn = extractFunction(appSrc, /^function _qDiagErrorsHtml\(\)\{/, '_qDiagErrorsHtml');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Builds a fresh sandbox with real esc()/_qDiagErrorsHtml() extracted from
// the live app.js, plus a controllable `window.__qDiag`. `windowVal` lets a
// test simulate window.__qDiag being entirely absent (undefined) vs present.
function makeCtx(qDiag) {
  const sandbox = {
    console: console,
    Date: Date,
    JSON: JSON,
    window: (qDiag === undefined) ? {} : { __qDiag: qDiag },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(escFn, sandbox);
  vm.runInContext(blockFn, sandbox);
  return sandbox;
}

function main() {
  // -----------------------------------------------------------------------
  // T1: empty ring -- must not throw, and must show a graceful placeholder.
  // -----------------------------------------------------------------------
  {
    const sandbox = makeCtx({ errors: [] });
    let threw = false, html = '';
    try { html = sandbox._qDiagErrorsHtml(); } catch (e) { threw = true; }
    assert('T1a: does not throw with an empty ring', !threw);
    assert('T1b: shows "No errors recorded" for an empty ring', /No errors recorded/.test(html));
    assert('T1c: still shows the block header', /Recent errors \(last 50\)/.test(html));
  }

  // -----------------------------------------------------------------------
  // T2: window.__qDiag entirely absent -- must not throw.
  // -----------------------------------------------------------------------
  {
    const sandbox = makeCtx(undefined); // sandbox.window = {} -- no __qDiag at all
    let threw = false, html = '';
    try { html = sandbox._qDiagErrorsHtml(); } catch (e) { threw = true; }
    assert('T2a: does not throw when window.__qDiag is absent', !threw);
    assert('T2b: falls back to "No errors recorded"', /No errors recorded/.test(html));
  }

  // -----------------------------------------------------------------------
  // T3: newest-first ordering.
  // -----------------------------------------------------------------------
  {
    const errors = [
      { t: 1000, kind: 'first', taskId: 'a' },
      { t: 2000, kind: 'second', taskId: 'b' },
      { t: 3000, kind: 'third', taskId: 'c' },
    ];
    const sandbox = makeCtx({ errors: errors });
    const html = sandbox._qDiagErrorsHtml();
    const iFirst = html.indexOf('first');
    const iSecond = html.indexOf('second');
    const iThird = html.indexOf('third');
    assert('T3a: all three entries present', iFirst !== -1 && iSecond !== -1 && iThird !== -1);
    assert('T3b: newest (third) appears before second', iThird < iSecond);
    assert('T3c: second appears before oldest (first)', iSecond < iFirst);
  }

  // -----------------------------------------------------------------------
  // T4: HTML metacharacters in a message must be escaped -- the assertion
  // that matters most (injection vector into the overlay's innerHTML).
  // -----------------------------------------------------------------------
  {
    const payload = '<img src=x onerror=alert(1)>';
    const errors = [
      { t: Date.now(), kind: 'logEventTxError', taskId: 't1', msg: payload },
    ];
    const sandbox = makeCtx({ errors: errors });
    const html = sandbox._qDiagErrorsHtml();
    assert('T4a: raw "<img" does not appear unescaped in the output', html.indexOf('<img') === -1);
    assert('T4b: the escaped form (&lt;img) is present instead', html.indexOf('&lt;img') !== -1);
    assert('T4c: the onerror payload text still made it through (just escaped)', html.indexOf('onerror=alert(1)') !== -1);
  }

  // -----------------------------------------------------------------------
  // T5: differing entry shapes all render without leaking "undefined".
  // logEventTxError: kind/taskId/msg. evtPullSkip: name/reason. error (window
  // error listener): message/src/line/col. An entry with no extra fields at
  // all (just t/kind) must also render cleanly.
  // -----------------------------------------------------------------------
  {
    const errors = [
      { t: Date.now(), kind: 'logEventTxError', taskId: 't9', msg: 'tx aborted' },
      { t: Date.now(), kind: 'evtPullSkip', name: 'device-abc.json', reason: 'tooOld' },
      { t: Date.now(), kind: 'error', message: 'boom', src: 'app.js', line: 42, col: 7 },
      { t: Date.now(), kind: 'evtPullSkip', name: null, reason: 'missingDeps' }, // null field
      { t: Date.now(), kind: 'bareEntry' }, // no extra fields at all
    ];
    const sandbox = makeCtx({ errors: errors });
    const html = sandbox._qDiagErrorsHtml();
    assert('T5a: does not leak the literal string "undefined"', html.indexOf('undefined') === -1);
    assert('T5b: logEventTxError fields present', /taskId=t9/.test(html) && /tx aborted/.test(html));
    assert('T5c: evtPullSkip fields present', /device-abc\.json/.test(html) && /tooOld/.test(html));
    assert('T5d: error-shape fields present', /line=42/.test(html) && /col=7/.test(html));
    assert('T5e: a null field (name:null) is simply omitted, not rendered as "null"', html.indexOf('name=null') === -1);
    assert('T5f: a bare entry (kind only) still renders its kind', /bareEntry/.test(html));
  }

  // -----------------------------------------------------------------------
  // T6: rendering must not mutate the ring (read-only diagnostic view).
  // -----------------------------------------------------------------------
  {
    const errors = [
      { t: 1, kind: 'a' },
      { t: 2, kind: 'b' },
      { t: 3, kind: 'c' },
    ];
    const snapshot = JSON.stringify(errors);
    const sandbox = makeCtx({ errors: errors });
    sandbox._qDiagErrorsHtml();
    assert('T6a: ring length unchanged after rendering', errors.length === 3);
    assert('T6b: ring contents unchanged after rendering (order + values)', JSON.stringify(errors) === snapshot);
  }

  if (failures) {
    console.error('\n' + failures + ' overlay-error-block assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL OVERLAY-ERROR-BLOCK TESTS PASSED');
  process.exit(0);
}

main();
