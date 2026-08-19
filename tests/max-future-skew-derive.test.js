// max-future-skew-derive.test.js -- J3 (todo 20): sync.js's MAX_FUTURE_SKEW_MS
// derive must survive a THROWING lookup of app.js's HLC_RATCHET_TOLERANCE_MS and
// fall back, instead of taking all of sync.js down with it.
//
// Source: .omo/plans/REVIEW-CODE-D1D2D4-20260818.md finding 5.
//
// The derive WORKS TODAY -- verified -- because index.html loads app.js first and its
// top-level `const` lands in the shared global lexical environment, which the
// unqualified `typeof` resolves through. (`typeof globalThis.HLC_RATCHET_TOLERANCE_MS`
// would NOT work; the code correctly does not do that.)
//
// The gap versus the EVENT_AGE_LIMIT_MS pattern it cites: that one is evaluated INSIDE
// function bodies, long after app.js finished, while this derive runs at script-parse
// time. And `typeof` does NOT protect against the temporal dead zone -- the `const`
// binding is created when app.js is INSTANTIATED, so if app.js throws before reaching
// that declaration, the binding exists but is uninitialised and `typeof` throws a
// ReferenceError rather than yielding "undefined". That kills all of sync.js. Under the
// old plain literal, sync survived a broken app.js.
//
// Low value, near-zero risk. Worth doing because it is three lines, not because it is
// urgent. AGENTS.md S1 is the principle: a missing or broken app.js must never break
// the app -- and here it is sync.js that dies.
//
// T1 reproduces the REAL failure: a genuine temporal dead zone, by declaring
//    `let HLC_RATCHET_TOLERANCE_MS` AFTER the derive line in the SAME script. No
//    simulation, no getter tricks -- this is exactly the shape a throwing app.js
//    produces.
// T2 uses a poisoned getter on the global object, the other way a lookup can throw.
// T3 pins the shape the plan requires: still a single `const MAX_FUTURE_SKEW_MS`,
//    still resolving to app.js's value in the browser and to the fallback in a bare
//    sandbox, and both fallback literals on the line still agreeing with app.js.
//
// Run: node tests/max-future-skew-derive.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

const deriveMatch = syncSrc.match(/^const MAX_FUTURE_SKEW_MS\s*=.*$/m);
if (!deriveMatch) {
  console.error('[FAIL] the MAX_FUTURE_SKEW_MS derive line was not found in sync.js');
  process.exit(1);
}
const deriveLine = deriveMatch[0];

// ---------------------------------------------------------------------------
// T1 -- GENUINE TEMPORAL DEAD ZONE. `let` after the derive, same script.
// ---------------------------------------------------------------------------
{
  const sb = { console };
  sb.globalThis = sb;
  vm.createContext(sb);
  let threw = false, msg = '';
  try {
    vm.runInContext(
      deriveLine + '\nlet HLC_RATCHET_TOLERANCE_MS = 999;\nthis.__v = MAX_FUTURE_SKEW_MS;',
      sb
    );
  } catch (e) { threw = true; msg = String(e && e.message); }
  assert('T1a a TDZ lookup does not throw out of the derive (' + (threw ? msg : 'no throw') + ')',
    threw === false);
  assert('T1b the derive fell back to 120000 under TDZ', sb.__v === 120000);
}

// ---------------------------------------------------------------------------
// T2 -- POISONED GETTER: the other way the lookup can throw.
// ---------------------------------------------------------------------------
{
  const sb = { console };
  sb.globalThis = sb;
  vm.createContext(sb);
  Object.defineProperty(sb, 'HLC_RATCHET_TOLERANCE_MS', {
    configurable: true,
    get: function () { throw new Error('poisoned lookup'); },
  });
  let threw = false, msg = '';
  try {
    vm.runInContext(deriveLine + '\nthis.__v = MAX_FUTURE_SKEW_MS;', sb);
  } catch (e) { threw = true; msg = String(e && e.message); }
  assert('T2a a throwing getter does not escape the derive (' + (threw ? msg : 'no throw') + ')',
    threw === false);
  assert('T2b the derive fell back to 120000 with a poisoned getter', sb.__v === 120000);
}

// ---------------------------------------------------------------------------
// T3 -- the wrapper must not leak. Name, shape and both resolved values.
// ---------------------------------------------------------------------------
{
  assert('T3a still exactly one `const MAX_FUTURE_SKEW_MS` declaration in sync.js',
    (syncSrc.match(/^const MAX_FUTURE_SKEW_MS\s*=/gm) || []).length === 1);
  assert('T3b the derive still references HLC_RATCHET_TOLERANCE_MS by bare identifier',
    /(?<!\.)\bHLC_RATCHET_TOLERANCE_MS\b/.test(deriveLine));
  assert('T3c the derive does NOT use globalThis./window. qualification (which would not resolve)',
    !/(globalThis|window)\s*\.\s*HLC_RATCHET_TOLERANCE_MS/.test(deriveLine));
  assert('T3d the derive is guarded by a try', /\btry\b/.test(deriveLine));

  // Resolves to app.js's value when the constant IS present (the browser case).
  const appDecl = appSrc.match(/^const HLC_RATCHET_TOLERANCE_MS\s*=\s*(\d+)\s*;/m);
  assert('T3e app.js declares HLC_RATCHET_TOLERANCE_MS exactly once', !!appDecl &&
    (appSrc.match(/^const HLC_RATCHET_TOLERANCE_MS\s*=/gm) || []).length === 1);
  if (appDecl) {
    const appValue = Number(appDecl[1]);
    const sb = { console };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(appDecl[0] + '\n' + deriveLine + '\nthis.__v = MAX_FUTURE_SKEW_MS;', sb);
    assert('T3f with app.js\'s constant present the derive yields app.js\'s value (' + appValue + ')',
      sb.__v === appValue);

    // Bare sandbox: the fallback path, as every test sandbox uses it.
    const sb2 = { console };
    sb2.globalThis = sb2;
    vm.createContext(sb2);
    vm.runInContext(deriveLine + '\nthis.__v = MAX_FUTURE_SKEW_MS;', sb2);
    assert('T3g in a bare sandbox the derive yields the fallback', sb2.__v === 120000);

    // The try-guarded form necessarily repeats the fallback literal (the ternary's
    // else branch and the catch's return). Keeping the `: <N>;` shape is what lets
    // J2's assertion 5e in tests/hlc-ratchet-tolerance.test.js keep finding it
    // untouched -- so pin here that EVERY integer literal on the line agrees with
    // app.js, closing the duplication risk that shape introduces.
    const literals = (deriveLine.match(/\b\d{4,}\b/g) || []).map(Number);
    assert('T3h the derive line carries at least one fallback literal', literals.length >= 1);
    assert('T3i every fallback literal on the derive line equals app.js\'s value (' + appValue +
      ') -- found [' + literals.join(', ') + ']',
      literals.length >= 1 && literals.every(n => n === appValue));
  }
}

// ---------------------------------------------------------------------------
if (failures) {
  console.error('\nFAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\nALL MAX-FUTURE-SKEW-DERIVE TESTS PASSED');
process.exit(0);
