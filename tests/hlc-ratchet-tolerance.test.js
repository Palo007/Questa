// hlc-ratchet-tolerance.test.js -- F7 regression: ratchetHlc() (app.js) tolerates
// a full HOUR of future clock skew while the merge-arbitration clamp (_ua/_ca in
// sync.js, via MAX_FUTURE_SKEW_MS) tolerates only 2 minutes. A remote timestamp
// between 2min and 1h ahead therefore LOSES every merge arbitration (clamped to
// 0 by _ua) yet STILL ratchets the local logical clock and persists to
// S.__hlcLast, surviving reload -- and because _ua measures its threshold
// against _hlcNow(), a ratcheted clock raises its own tolerance, compounding
// the error. Rejecting a value for merging while accepting it for the clock is
// incoherent; both should agree on one tolerance.
//
// Fix shape under test (landed):
//   - app.js declares `const HLC_RATCHET_TOLERANCE_MS = 120000;` before
//     ratchetHlc(), and ratchetHlc()'s guard uses it instead of the literal
//     3600000.
//   - sync.js's `MAX_FUTURE_SKEW_MS` derives from that constant (mirroring the
//     existing EVENT_AGE_LIMIT_MS cross-file derive pattern), falling back to
//     the same literal 120000 when the app.js constant isn't in scope.
//
// Strategy: extract ratchetHlc() out of app.js by anchor (tests/_extract.js;
// see tests/feed-hide-sync.test.js for the canonical usage pattern) and eval
// it in a fresh vm sandbox per test, with `lastIssued`, `S` and `logEvent`
// declared as sandbox globals so their post-call state is directly readable
// off the sandbox object. ratchetHlc()'s guard references
// HLC_RATCHET_TOLERANCE_MS by name, so the sandbox script also extracts and
// prepends app.js's actual declaration line for that constant -- never a
// hardcoded 120000 -- so the test always exercises the real shipped value and
// a future change to the number can't make it silently test a stale figure.
// If that declaration line can't be found (0 or >1 matches), sandbox creation
// throws a descriptive Error that every call site below catches and turns
// into a labelled [FAIL], never an uncaught ReferenceError/crash.
//
// Fixture timestamps are computed relative to Date.now() so the file can't
// rot on a date change. Sections 5-6 read app.js / sync.js as plain text (and,
// for 6, eval short extracted snippets in their own throwaway sandboxes) to
// check the cross-file constant shape itself -- no full app.js/sync.js load
// is ever needed.
//
// Run: node tests/hlc-ratchet-tolerance.test.js  (NOT part of tests/run.js yet)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

const ratchetHlcSrc = extractFunction(appSrc, /^function ratchetHlc\(maxRemoteTs\)\{/, 'ratchetHlc');

// Single source of truth for the app.js HLC_RATCHET_TOLERANCE_MS declaration
// line, reused by both the sandbox builder below (so ratchetHlc actually runs
// against the real shipped value, never a hardcoded stand-in) and assertions
// 5b/6a (so the cross-file consistency checks and the sandbox-construction
// extraction can never quietly diverge). Exactly one match is required; zero
// or more-than-one both yield null, which every call site below treats as a
// hard, labelled [FAIL] rather than an uncaught crash.
const hlcToleranceDeclMatches = appSrc.match(/^const HLC_RATCHET_TOLERANCE_MS\s*=\s*\d+\s*;.*$/gm) || [];
const hlcToleranceDeclLine = hlcToleranceDeclMatches.length === 1 ? hlcToleranceDeclMatches[0] : null;

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Fresh sandbox per call: `lastIssued` and `S` are declared as sandbox
// globals (via `var`/object literal at top level of the vm script), so
// ratchetHlc's free-variable references to them resolve to -- and mutate --
// sandbox.lastIssued / sandbox.S directly, observable after the call without
// any return value or spy. logEvent is a plain host closure recording calls
// into `calls` (cross-realm closures work fine across vm.createContext).
// ratchetHlc's guard references HLC_RATCHET_TOLERANCE_MS by name, so the real
// app.js declaration line is prepended to the script run in the sandbox; if
// it can't be found (see hlcToleranceDeclLine above) this throws a
// descriptive Error instead of letting the sandbox call fail with a bare
// ReferenceError, and every call site below catches that and records it as a
// labelled [FAIL].
function makeSandbox(initialLastIssued, initialHlcLast) {
  if (!hlcToleranceDeclLine) {
    throw new Error(
      'HLC_RATCHET_TOLERANCE_MS declaration not found (or not unique) in app.js -- ' +
      hlcToleranceDeclMatches.length + ' match(es); cannot build ratchetHlc sandbox'
    );
  }
  const calls = [];
  const sandbox = {
    Date: Date, Math: Math, console: console,
    lastIssued: initialLastIssued,
    S: { __hlcLast: initialHlcLast },
    logEvent: function (e) { calls.push(e); },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    hlcToleranceDeclLine + '\n' +
    'var lastIssued = ' + initialLastIssued + ';\n' +
    ratchetHlcSrc,
    sandbox
  );
  return { sandbox: sandbox, calls: calls };
}

// =====================================================================
// 1. ACCEPTED JUST INSIDE TOLERANCE -- GREEN on HEAD by design (well inside
//    both the old 1h window and the new 120000ms window).
// =====================================================================
(function () {
  try {
    const now = Date.now();
    const baseline = now - 999999;
    const remoteTs = now + 60000; // 60s ahead: inside 120000ms tolerance
    const { sandbox } = makeSandbox(baseline, baseline);
    sandbox.ratchetHlc(remoteTs);
    assert(
      '1 accepted just inside tolerance (+60s): S.__hlcLast advances to remoteTs',
      sandbox.S.__hlcLast === remoteTs && sandbox.lastIssued === remoteTs
    );
  } catch (e) {
    assert('1 accepted just inside tolerance (+60s): S.__hlcLast advances to remoteTs (ERROR: ' + e.message + ')', false);
  }
})();

// =====================================================================
// 2. REFUSED JUST OUTSIDE TOLERANCE -- RED on HEAD (core F7 test): today
//    +5min is well inside the 1h window and DOES ratchet; after the fix it
//    must be refused and leave lastIssued/S.__hlcLast unchanged.
// =====================================================================
(function () {
  try {
    const now = Date.now();
    const baseline = now - 999999;
    const remoteTs = now + 300000; // 5min ahead: outside 120000ms, inside 3600000ms
    const { sandbox } = makeSandbox(baseline, baseline);
    sandbox.ratchetHlc(remoteTs);
    assert(
      '2 refused just outside tolerance (+5min): lastIssued/S.__hlcLast UNCHANGED',
      sandbox.lastIssued === baseline && sandbox.S.__hlcLast === baseline
    );
  } catch (e) {
    assert('2 refused just outside tolerance (+5min): lastIssued/S.__hlcLast UNCHANGED (ERROR: ' + e.message + ')', false);
  }
})();

// =====================================================================
// 3. REFUSED AT +2h -- GREEN on HEAD by design (already outside the old 1h
//    window; must stay refused after the fix too).
// =====================================================================
(function () {
  try {
    const now = Date.now();
    const baseline = now - 999999;
    const remoteTs = now + 7200000; // 2h ahead: outside both windows
    const { sandbox } = makeSandbox(baseline, baseline);
    sandbox.ratchetHlc(remoteTs);
    assert(
      '3 refused at +2h: lastIssued/S.__hlcLast UNCHANGED',
      sandbox.lastIssued === baseline && sandbox.S.__hlcLast === baseline
    );
  } catch (e) {
    assert('3 refused at +2h: lastIssued/S.__hlcLast UNCHANGED (ERROR: ' + e.message + ')', false);
  }
})();

// =====================================================================
// 4. REFUSED CASES STILL RECORD THE SKEW -- 4a is RED on HEAD (no event is
//    logged today at +5min because the value ratchets instead of being
//    refused); 4b is GREEN on HEAD (already refused-and-logged today).
// =====================================================================
(function () {
  try {
    const now = Date.now();
    const baseline = now - 999999;
    const remoteTs = now + 300000; // 5min ahead
    const { sandbox, calls } = makeSandbox(baseline, baseline);
    sandbox.ratchetHlc(remoteTs);
    const evt = calls[0];
    assert(
      '4a clockSkew event recorded on refusal at +5min',
      !!evt && evt.kind === 'clockSkew' && evt.remoteTs === remoteTs && typeof evt.localTs === 'number'
    );
  } catch (e) {
    assert('4a clockSkew event recorded on refusal at +5min (ERROR: ' + e.message + ')', false);
  }
})();

(function () {
  try {
    const now = Date.now();
    const baseline = now - 999999;
    const remoteTs = now + 7200000; // 2h ahead
    const { sandbox, calls } = makeSandbox(baseline, baseline);
    sandbox.ratchetHlc(remoteTs);
    const evt = calls[0];
    assert(
      '4b clockSkew event recorded on refusal at +2h',
      !!evt && evt.kind === 'clockSkew' && evt.remoteTs === remoteTs && typeof evt.localTs === 'number'
    );
  } catch (e) {
    assert('4b clockSkew event recorded on refusal at +2h (ERROR: ' + e.message + ')', false);
  }
})();

// =====================================================================
// 5. ONE TOLERANCE ACROSS BOTH FILES (plain-text checks; no full-file load
//    needed).
// =====================================================================
(function () {
  assert(
    "5a ratchetHlc's body no longer contains the literal 3600000",
    ratchetHlcSrc.indexOf('3600000') === -1
  );
})();

(function () {
  assert(
    '5b app.js declares exactly one HLC_RATCHET_TOLERANCE_MS',
    hlcToleranceDeclMatches.length === 1
  );
})();

(function () {
  const deriveLineMatch = syncSrc.match(/^const MAX_FUTURE_SKEW_MS\s*=.*$/m);
  const deriveLine = deriveLineMatch ? deriveLineMatch[0] : '';
  assert(
    "5c sync.js's MAX_FUTURE_SKEW_MS line references HLC_RATCHET_TOLERANCE_MS",
    deriveLine.indexOf('HLC_RATCHET_TOLERANCE_MS') !== -1
  );
})();

// ---------------------------------------------------------------------------
// 5e -- ADDED 2026-08-19 by J2 finding 6 (plan todo 19). TEST-ONLY.
//
// The gap: nothing pinned sync.js's FALLBACK literal to app.js's DECLARED value.
// 5c only asserts the derive line *mentions* HLC_RATCHET_TOLERANCE_MS (which is
// the same weakness finding 6 calls out -- asserting on source text rather than a
// parsed value). 6a compares app.js's constant against the value sync.js DERIVES
// when app.js is present, and 6b compares the standalone fallback against a
// hardcoded 120000.
//
// So change app.js's declared value to, say, 90000 and the whole suite stays
// GREEN: 6a still matches (sync derives from app in the browser), and 6b still
// matches its own hardcoded literal. Meanwhile the browser uses 90000 while every
// test sandbox -- which has no app.js -- uses the stale 120000, and the suite
// validates a tolerance production does not use.
//
// This assertion compares the two PARSED NUMBERS, so changing either literal
// alone turns the suite red. Verified by temporarily editing each one.
// ---------------------------------------------------------------------------
(function () {
  const appDeclMatch = appSrc.match(/^const HLC_RATCHET_TOLERANCE_MS\s*=\s*(\d+)\s*;/m);
  // The fallback is the number after the ternary's `:` on the derive line.
  const deriveLineMatch = syncSrc.match(/^const MAX_FUTURE_SKEW_MS\s*=.*$/m);
  const fallbackMatch = deriveLineMatch ? deriveLineMatch[0].match(/:\s*(\d+)\s*;/) : null;
  if (!appDeclMatch || !fallbackMatch) {
    assert(
      '5e app.js HLC_RATCHET_TOLERANCE_MS literal and sync.js MAX_FUTURE_SKEW_MS fallback literal both parseable',
      false
    );
  } else {
    const appValue = Number(appDeclMatch[1]);
    const fallbackValue = Number(fallbackMatch[1]);
    assert(
      '5e app.js HLC_RATCHET_TOLERANCE_MS (' + appValue + ') === sync.js MAX_FUTURE_SKEW_MS fallback (' +
        fallbackValue + ') -- the two numeric LITERALS, not the source text',
      appValue === fallbackValue
    );
  }
})();

(function () {
  assert(
    "5d sync.js's unrelated EVT_FULL_SCAN_INTERVAL_MS 3600000 literal is still present",
    /EVT_FULL_SCAN_INTERVAL_MS\s*=\s*24\s*\*\s*3600000/.test(syncSrc)
  );
})();

// =====================================================================
// 6. RESOLVED VALUE AGREES. 6a reuses the same hlcToleranceDeclLine
//    extraction as the sandbox builder above (single source of truth). 6b
//    evaluates the sync.js derive line in total isolation (constant
//    undeclared) and checks that the literal fallback branch alone still
//    reads 120000 -- a direct check on the exact fallback text, not a
//    before/after-fix discriminator (the fallback branch's value never
//    changes).
// =====================================================================
(function () {
  try {
    if (!hlcToleranceDeclLine) {
      throw new Error(
        'HLC_RATCHET_TOLERANCE_MS declaration not found (or not unique) in app.js -- ' +
        hlcToleranceDeclMatches.length + ' match(es)'
      );
    }
    const deriveMatch = syncSrc.match(/^const MAX_FUTURE_SKEW_MS\s*=.*$/m);
    if (!deriveMatch) throw new Error('MAX_FUTURE_SKEW_MS line not found in sync.js');

    const sb = {};
    vm.createContext(sb);
    vm.runInContext(
      hlcToleranceDeclLine + '\n' + deriveMatch[0] +
      '\nvar __appConst = HLC_RATCHET_TOLERANCE_MS;\nvar __syncDerived = MAX_FUTURE_SKEW_MS;',
      sb
    );
    assert(
      '6a app.js HLC_RATCHET_TOLERANCE_MS and sync.js derived MAX_FUTURE_SKEW_MS are the same number',
      sb.__appConst === sb.__syncDerived
    );
  } catch (e) {
    assert('6a app.js HLC_RATCHET_TOLERANCE_MS and sync.js derived MAX_FUTURE_SKEW_MS are the same number (ERROR: ' + e.message + ')', false);
  }
})();

(function () {
  try {
    const deriveMatch = syncSrc.match(/^const MAX_FUTURE_SKEW_MS\s*=.*$/m);
    if (!deriveMatch) throw new Error('MAX_FUTURE_SKEW_MS line not found in sync.js');
    const sb2 = {};
    vm.createContext(sb2);
    // Evaluate the derive line completely alone: HLC_RATCHET_TOLERANCE_MS is
    // not declared in this sandbox at all, so `typeof ... !== "undefined"`
    // must fall through to the literal fallback.
    vm.runInContext(deriveMatch[0] + '\nvar __fallback = MAX_FUTURE_SKEW_MS;', sb2);
    assert(
      "6b sync.js's derive line, evaluated with HLC_RATCHET_TOLERANCE_MS absent, still yields 120000",
      sb2.__fallback === 120000
    );
  } catch (e) {
    assert("6b sync.js's derive line, evaluated with HLC_RATCHET_TOLERANCE_MS absent, still yields 120000 (" + e.message + ')', false);
  }
})();

console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
