// none-tag-filter.test.js
// Regression test for the reserved 'none' tag filter.
//   N1: applyTagFilter with 'none' keeps only tasks with empty tag arrays
//   N2: applyTagFilter with 'none' + a real tag uses OR semantics
//   N3: applyTagFilter with a real tag excludes untagged tasks
//   N4: tagFilterBar renders the "None" button when tags exist
//   N5: tagFilterBar returns '' (no None button) when S.tags is empty
//
// Run: node tests/none-tag-filter.test.js   (also run by `node tests/run.js`)
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Extract the standalone helpers + the two functions under test.
function extract(re, label) {
  const m = code.match(re);
  if (!m) { console.error('FAIL: could not extract ' + label); process.exit(1); }
  return m[0];
}

const escSrc     = extract(/function esc\([\s\S]*?\r?\n\}/, 'esc');
const taskTagsSrc= extract(/function taskTags\(t\)\{[\s\S]*?\r?\n\}/, 'taskTags');
const ensureSrc  = extract(/function ensureTags\(\)\{[\s\S]*?\r?\n\}/, 'ensureTags');
const applySrc   = extract(/function applyTagFilter\(list,tab\)\{[\s\S]*?\r?\n\}/, 'applyTagFilter');
const barSrc     = extract(/function tagFilterBar\(tab\)\{[\s\S]*?\n\}/, 'tagFilterBar');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Build a context exposing only what the extracted functions touch.
const factory = new Function(
  'escSrc', 'taskTagsSrc', 'ensureSrc', 'applySrc', 'barSrc',
  escSrc + '\n' + taskTagsSrc + '\n' + ensureSrc + '\n' + applySrc + '\n' + barSrc + `
  return { esc, taskTags, ensureTags, applyTagFilter, tagFilterBar };
`
);
const { taskTags, applyTagFilter, tagFilterBar } = factory(escSrc, taskTagsSrc, ensureSrc, applySrc, barSrc);

// Minimal global stubs the functions read (define before invoking).
global.S = { tags: [] };
global.TAGFILTER = { todos: [] };
global.FILTEROPEN = true;

const untagged = { id: 'a', tags: [] };
const tagged   = { id: 'b', tags: ['t1'] };
const bothList = [untagged, tagged];

// N1: only 'none' selected -> keep untagged, drop tagged
global.TAGFILTER = { todos: ['none'] };
let r1 = applyTagFilter(bothList, 'todos');
assert('N1: none filter keeps untagged task', r1.length === 1 && r1[0].id === 'a');
assert('N1: none filter drops tagged task', !r1.some(t => t.id === 'b'));

// N2: 'none' + real tag -> OR (untagged OR has t1)
global.TAGFILTER = { todos: ['none', 't1'] };
let r2 = applyTagFilter(bothList, 'todos');
assert('N2: none + real tag keeps BOTH untagged and tagged', r2.length === 2);

// N3: real tag only -> excludes untagged
global.TAGFILTER = { todos: ['t1'] };
let r3 = applyTagFilter(bothList, 'todos');
assert('N3: real tag keeps tagged, excludes untagged', r3.length === 1 && r3[0].id === 'b');

// N4: tags exist -> None button rendered and marked active when selected
global.S.tags = [{ id: 't1', name: 'Work', color: '#fff' }];
global.TAGFILTER = { todos: ['none'] };
const htmlWith = tagFilterBar('todos');
assert('N4: None button present when tags exist', /onclick="toggleTagFilter\('todos','none'\)"/.test(htmlWith));
assert('N4: None button marked active when selected', /<button class="tagBtn on"[^>]*toggleTagFilter\('todos','none'\)/.test(htmlWith));
assert('N4: real tag button also present', /toggleTagFilter\('todos','t1'\)/.test(htmlWith));

// N5: no tags -> returns '' so None button is hidden
global.S.tags = [];
global.TAGFILTER = { todos: [] };
const htmlNone = tagFilterBar('todos');
assert('N5: tagFilterBar returns empty string when no tags', htmlNone === '');
assert('N5: no None button when no tags', htmlNone.indexOf("'none'") === -1);

if (failures) { console.error('\n' + failures + ' assertion(s) FAILED'); process.exit(1); }
console.log('\nALL NONE-TAG-FILTER TESTS PASSED');
