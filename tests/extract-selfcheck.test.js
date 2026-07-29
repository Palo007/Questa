// extract-selfcheck.test.js -- self-check for tests/_extract.js, the shared
// anchor-based source extraction helper used by feed-hide-sync.test.js and
// auto-backup-settings-ui.test.js in place of hardcoded line-number grabs.
//
// Verifies:
//   E1: the extractor finds a known, real function in app.js by anchor and
//       returns text that round-trips through node's own parser (Function
//       constructor) without a syntax error.
//   E2: a bogus/absent anchor throws (never returns an empty/wrong string).
//   E3: an anchor that matches MORE than once also throws (ambiguous anchor
//       is a hard failure, not a "pick the first one" silent guess).
//   E4: extraction is immune to line-number shifts -- inserting blank lines
//       above the target still finds the identical function text.
//   E5: extractBraceBody correctly isolates interior lines only (excludes
//       the opening/closing brace lines themselves).
//
// Run: node tests/extract-selfcheck.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path');
const { extractFunction, extractLine, extractBraceBody, extractSpan, functionEndLineIndex, findLineIndex } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertThrows(desc, fn) {
  try { fn(); console.error('[FAIL] ' + desc + ' (did not throw)'); failures++; }
  catch (e) { console.log('[PASS] ' + desc + ' (threw: ' + e.message.slice(0, 60) + '...)'); }
}

// =========================================================================
// E1: extractFunction finds a known real function (esc) and it is valid JS.
// =========================================================================
{
  const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
  assert('E1a: esc() extraction is non-empty', typeof escFn === 'string' && escFn.length > 10);
  assert('E1b: esc() extraction starts with the declaration', /^function esc\(s\)\{/.test(escFn));
  let parses = true;
  try { new Function(escFn + '\nreturn esc;'); } catch (e) { parses = false; }
  assert('E1c: extracted esc() parses as valid JS', parses);
}

// =========================================================================
// E2: a bogus anchor (matches nothing) throws with a clear message naming it.
// =========================================================================
assertThrows('E2: extractFunction throws on an anchor matching zero lines',
  () => extractFunction(appSrc, /^function thisFunctionDoesNotExistAnywhere_bogus123\(/, 'bogus-anchor'));

assertThrows('E2b: extractLine throws on an anchor matching zero lines',
  () => extractLine(appSrc, /^var THIS_VAR_DOES_NOT_EXIST_BOGUS_XYZ\s*=/, 'bogus-var'));

assertThrows('E2c: extractBraceBody throws on an anchor matching zero lines',
  () => extractBraceBody(appSrc, /this text does not appear anywhere in app\.js\{$/, 'bogus-brace'));

// The thrown message must name the anchor it looked for, not just fail silently.
{
  let msg = '';
  try { extractFunction(appSrc, /^function bogusFnXyz123\(/, 'my-bogus-label'); }
  catch (e) { msg = e.message; }
  assert('E2d: thrown message names the anchor label', msg.indexOf('my-bogus-label') >= 0);
  assert('E2e: thrown message mentions the match count (0)', /matched 0 lines/.test(msg));
}

// =========================================================================
// E3: an anchor matching MORE than once throws (ambiguous, never "first wins").
// =========================================================================
assertThrows('E3: findLineIndex throws when the pattern matches multiple lines',
  () => findLineIndex(['function a(){}', 'function b(){}'], /^function \w+\(\)\{\}$/, 'ambiguous'));

// =========================================================================
// E4: extraction survives line-number shifts (insertion-immunity).
// =========================================================================
{
  const lines = appSrc.split('\n');
  const shiftedSrc = lines.slice(0, 5).concat(new Array(40).fill(''), lines.slice(5)).join('\n');

  const before = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
  const after = extractFunction(shiftedSrc, /^function esc\(s\)\{/, 'esc');
  assert('E4a: esc() extraction identical after +40 blank lines inserted near top', before === after);

  const beforeSpan = extractSpan(appSrc, /^let _evWin=null;/,
    functionEndLineIndex(/^function renderEventDetail\(from,to\)\{/, 'renderEventDetail'), 'render block');
  const afterSpan = extractSpan(shiftedSrc, /^let _evWin=null;/,
    functionEndLineIndex(/^function renderEventDetail\(from,to\)\{/, 'renderEventDetail'), 'render block');
  assert('E4b: renderEventDetail block identical after +40 blank lines inserted near top', beforeSpan === afterSpan);
}

// =========================================================================
// E5: extractBraceBody returns ONLY the interior (excludes brace lines).
// =========================================================================
{
  const body = extractBraceBody(appSrc, /else if\(key==='autoBackup'\)\{\s*$/, 'openOpt autoBackup branch');
  assert('E5a: body does not include the opening "} else if(...)" line', !/else if\(key==='autoBackup'\)/.test(body));
  assert('E5b: body does not start/end with a bare brace line', !/^\s*\}\s*$/.test(body.split('\n')[0]) && !/^\s*\}\s*$/.test(body.split('\n')[body.split('\n').length - 1]));
  assert('E5c: body contains expected interior content', body.indexOf('Auto-backup to Dropbox') >= 0);
}

if (failures) {
  console.error('\nFAILED: ' + failures + ' assertion(s)');
  process.exit(1);
}
console.log('\nALL EXTRACT-SELFCHECK TESTS PASSED');
process.exit(0);
