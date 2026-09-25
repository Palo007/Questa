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
// 2026-09-18: applyTagFilter now resolves each id through tagById before counting,
// so a DANGLING tag id (left behind when one device deletes a tag while another
// edits a task still carrying it) counts as untagged in the None filter, exactly as
// tagChips already treats it. The helper has to come along into the sandbox.
const tagByIdSrc = extract(/function tagById\(id\)\{[\s\S]*?\r?\n?\}/, 'tagById');
const applySrc   = extract(/function applyTagFilter\(list,tab\)\{[\s\S]*?\r?\n\}/, 'applyTagFilter');
const barSrc     = extract(/function tagFilterBar\(tab\)\{[\s\S]*?\n\}/, 'tagFilterBar');
// 2026-09-25 (PWA-22): tagFilterBar passes the tag colour through cssColor().
const cssColorSrc = extract(/function cssColor\([\s\S]*?\r?\n\}/, 'cssColor');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// Build a context exposing only what the extracted functions touch.
const factory = new Function(
  'escSrc', 'taskTagsSrc', 'ensureSrc', 'tagByIdSrc', 'applySrc', 'barSrc',
  escSrc + '\n' + taskTagsSrc + '\n' + ensureSrc + '\n' + tagByIdSrc + '\n' + applySrc + '\n' + barSrc + '\n' + cssColorSrc + `
  return { esc, taskTags, ensureTags, tagById, applyTagFilter, tagFilterBar };
`
);
const { taskTags, applyTagFilter, tagFilterBar } = factory(escSrc, taskTagsSrc, ensureSrc, tagByIdSrc, applySrc, barSrc);

// Minimal global stubs the functions read (define before invoking).
// 2026-09-18: S.tags now has to hold the tag the fixture references. applyTagFilter
// resolves each id through tagById() before counting, so with an empty registry
// 't1' would be a DANGLING id and `tagged` would correctly count as untagged. The
// old fixture left S.tags empty and only happened to pass because the filter looked
// at the raw array length. The dangling case is asserted explicitly in N6 below.
global.S = { tags: [{ id: 't1', name: 'Work', color: '#fff' }] };
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

// N6 (2026-09-18): a task whose only tags are DANGLING ids renders no tag chips,
// so the None filter must keep it. Reachable by an ordinary merge: device A deletes
// tag 't1' while device B edits a task still carrying it, and the task survives with
// a reference to a tag that no longer exists. Before the fix that task was hidden by
// the None filter AND by every real tag button, i.e. unreachable from any filter.
const dangling = { id: 'c', tags: ['GONE'] };
global.TAGFILTER = { todos: ['none'] };
const rDang = applyTagFilter([untagged, tagged, dangling], 'todos');
assert('N6: none filter keeps a task whose only tags are dangling ids',
  rDang.some(t => t.id === 'c'));
assert('N6: ...and still keeps the genuinely untagged task', rDang.some(t => t.id === 'a'));
assert('N6: ...and still drops the really-tagged task', !rDang.some(t => t.id === 'b'));
global.TAGFILTER = { todos: ['t1'] };
assert('N6: a real tag filter does not match a dangling id',
  !applyTagFilter([dangling], 'todos').length);

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
