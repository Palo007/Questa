// xss-tag-color.test.js -- PWA-22 root 2: synced tag colour in style="".
// A tag colour arrives through sync/import and is concatenated raw into
// style="background:..." in the Analytics lists (zero-click: rendered on open).
// cssColor() must allow only hex / var(--x) / plain colour names and fall back
// to var(--muted) for anything else.
//   COL1 anListHTML     COL2 anRowLegend     COL3 anTagSummaryBody
//   COL4 tagChips hardening (no url() in --tc)
//   COL5 non-regression: every TAG_COLORS value and var(--muted) pass unchanged
//
// Run: node tests/xss-tag-color.test.js   (also run by `node tests/run.js`)
const path = require('path');
const { readSource, extractFunction, extractLine } = require('./_extract');

const src = readSource(path.join(__dirname, '../app.js'));
const escSrc = extractFunction(src, /^function esc\(/, 'esc');
// cssColor does not exist before the fix: soft lookup, so an unfixed build
// fails at an assertion instead of at extraction.
const cssSrc = /^function cssColor\(/m.test(src)
  ? extractFunction(src, /^function cssColor\(/, 'cssColor')
  : 'function cssColor(c){ return c; }';
const listSrc = extractFunction(src, /^function anListHTML\(/, 'anListHTML');
const legSrc = extractFunction(src, /^function anRowLegend\(/, 'anRowLegend');
const sumSrc = extractFunction(src, /^function anTagSummaryBody\(/, 'anTagSummaryBody');
const chipSrc = extractFunction(src, /^function tagChips\(/, 'tagChips');
const tagColorsLine = extractLine(src, /^const TAG_COLORS=\[/, 'TAG_COLORS');

global.S = { tags: [], tasks: [] };
const api = new Function(
  'function ensureTags(){}\n' +
  'function taskTags(t){ return t.tags||[]; }\n' +
  'function tagById(id){ return S.tags.find(g=>g.id===id)||null; }\n' +
  'function createdMs(t){ return 0; }\n' +
  'function svgBars(){ return ""; }\n' +
  escSrc + '\n' + cssSrc + '\n' + listSrc + '\n' + legSrc + '\n' + sumSrc + '\n' + chipSrc + '\n' +
  tagColorsLine + '\n' +
  'return { cssColor, anListHTML, anRowLegend, anTagSummaryBody, tagChips, TAG_COLORS };'
)();

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

const HOSTILE = ['red;background:url(javascript:alert(1))', 'red"><img src=x onerror=alert(1)>'];
const clean = h => h.indexOf('<img') < 0 && h.indexOf('url(') < 0;

HOSTILE.forEach((c, i) => {
  const rows = [{ label: 'W', v: 1, color: c }];
  const a = api.anListHTML(rows);
  assert('COL1.' + i + ' anListHTML neutralises hostile colour', clean(a) && a.indexOf('background:var(--muted)') >= 0);
  const b = api.anRowLegend(rows);
  assert('COL2.' + i + ' anRowLegend neutralises hostile colour', clean(b) && b.indexOf('background:var(--muted)') >= 0);
  S.tags = [{ id: 't1', name: 'W', color: c }]; S.tasks = [];
  const s = api.anTagSummaryBody(0, Infinity);
  assert('COL3.' + i + ' anTagSummaryBody neutralises hostile colour', clean(s) && s.indexOf('background:var(--muted)') >= 0);
  const k = api.tagChips({ tags: ['t1'] });
  assert('COL4.' + i + ' tagChips has no url() / live tag in --tc', clean(k));
});

// An explicit '#000' fallback, so var(--muted) must pass the allowlist itself, not win by fallback.
const legit = api.TAG_COLORS.concat(['var(--muted)']);
assert('COL5 every TAG_COLORS value and var(--muted) pass unchanged',
  legit.length === 11 && legit.every(c => api.cssColor(c, '#000') === c));

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
