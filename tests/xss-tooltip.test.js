// xss-tooltip.test.js -- PWA-22 root 1: tooltip double-decode.
// data-tip values are esc()-ed at write, but the browser decodes them back
// through el.dataset.tip, and showTip() then assigns tipHTML(text) to
// innerHTML. tipHTML must escape again, or a synced tag / metric name such as
// <img src=x onerror=alert(1)> runs script on hover.
//   TIP1 title line is escaped
//   TIP2 body line is escaped
//   TIP3 end-to-end: svgBars data-tip -> dataset decode -> tipHTML
//   TIP4 non-regression: plain lines keep the ttTitle/ttBody/<br> shape
//
// Run: node tests/xss-tooltip.test.js   (also run by `node tests/run.js`)
const path = require('path');
const { readSource, extractFunction } = require('./_extract');

const src = readSource(path.join(__dirname, '../app.js'));
const escSrc = extractFunction(src, /^function esc\(/, 'esc');
const tipSrc = extractFunction(src, /^function tipHTML\(/, 'tipHTML');
const barsSrc = extractFunction(src, /^function svgBars\(/, 'svgBars');

const { tipHTML, svgBars } = new Function(
  escSrc + '\n' + tipSrc + '\n' + barsSrc + '\nreturn { esc, tipHTML, svgBars };'
)();

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// What el.dataset does to an attribute value (entity decode).
function decodeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const HOSTILE = '<img src=x onerror=alert(1)>';

const t1 = tipHTML('\u{1F4CA} ' + HOSTILE);
assert('TIP1 hostile title line has no live <img', t1.indexOf('<img') < 0 && t1.indexOf('&lt;img') >= 0);

const t2 = tipHTML('title\n\u{1F4C8} ' + HOSTILE);
assert('TIP2 hostile body line has no live <img', t2.indexOf('<img') < 0 && t2.indexOf('&lt;img') >= 0);

const svg = svgBars([{ label: HOSTILE, v: 1 }], 'var(--accent)');
const m = svg.match(/data-tip="([^"]*)"/);
const t3 = m ? tipHTML(decodeAttr(m[1])) : '<img';
assert('TIP3 svgBars tag-name tip -> dataset -> tipHTML has no live <img', !!m && t3.indexOf('<img') < 0);

assert('TIP4a plain lines keep the title/body/<br> shape',
  tipHTML('a\nb\nc') === '<div class="ttTitle">a</div><div class="ttBody">b<br>c</div>');
assert('TIP4b "&" in a tip is encoded (renders the same)',
  tipHTML('Backup & transfer') === '<div class="ttTitle">Backup &amp; transfer</div>');

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
