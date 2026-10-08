// activity-tab.test.js -- CR-KT-012 / RE-PWA-010: the event feed moved out of
// Analytics into its own 6th bottom-nav tab "Activity".
//
// Covers: TABS order, nav button, evDayLabel (local calendar days, DST-safe),
// range chips -> [from,to], task filter, diagnostics footer (count + flip),
// row detail HTML (raw JSON, escaped), day headers, HH:MM:SS row time, and the
// Analytics side (no anEventDetails block, "See activity" link).
//
// Strategy: same as tests/feed-hide-sync.test.js. The feed block (from
// `let _evWin=null;` through the end of renderEventDetail) is extracted from the
// real app.js and eval'd in a vm with a stubbed S/document/getEvents.
//
// Run: node tests/activity-tab.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractLine, extractFunction, extractSpan, functionEndLineIndex } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

const diagnosticKindsLine = extractLine(appSrc, /^var DIAGNOSTIC_KINDS\s*=\s*\[/, 'DIAGNOSTIC_KINDS declaration');
const renderBlock = extractSpan(
  appSrc,
  /^let _evWin=null;/,
  functionEndLineIndex(/^function renderEventDetail\(from,to\)\{/, 'renderEventDetail'),
  'feed render helper block (_evWin..renderEventDetail end)'
);
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');
const jsqFn = extractFunction(appSrc, /^function jsq\(s\)\{/, 'jsq');
const tabsLine = extractLine(appSrc, /^const TABS=/, 'TABS declaration');
const refreshAnalyticsSrc = extractFunction(appSrc, /^function refreshAnalytics\(\)\{/, 'refreshAnalytics');
const renderFnSrc = extractFunction(appSrc, /^function render\(\)\{/, 'render');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
const tick = () => new Promise(r => setTimeout(r, 30));

// ---- static checks ---------------------------------------------------------
const TABS = new vm.Script('(function(){' + tabsLine + '; return TABS;})()').runInNewContext({});
assert('TABS has 6 entries', TABS.length === 6);
assert("TABS ends with 'activity' (after rewards)", TABS[5] === 'activity' && TABS[4] === 'rewards');
assert('index.html nav has the activity button after rewards',
  /data-tab="rewards"[^\n]*\n\s*<button data-tab="activity"[^>]*>[\s\S]*?Activity<\/button>/.test(htmlSrc));
assert('refreshAnalytics no longer renders the anEventDetails block', refreshAnalyticsSrc.indexOf('anEventDetails') < 0);
assert('refreshAnalytics no longer calls renderEventDetail', refreshAnalyticsSrc.indexOf('renderEventDetail') < 0);
assert('refreshAnalytics has the "See activity for this period" link -> evOpenActivityRange',
  refreshAnalyticsSrc.indexOf('See activity for this period') >= 0 && refreshAnalyticsSrc.indexOf('evOpenActivityRange') >= 0);
assert('render() dispatches the activity tab', /TAB==='activity'\s*\?\s*viewActivity\(\)/.test(renderFnSrc));
assert('render() skips drag reorder on activity', /TAB!=='analytics'\s*&&\s*TAB!=='activity'/.test(renderFnSrc));
assert('openEdit has a History button wired to evOpenTaskHistory',
  /\(t\.id\?'<button class="btn ghost" onclick="evOpenTaskHistory[^\n]*>History<\/button>'/.test(appSrc));
assert('feed asks getEvents for diagnostics (includeDiag:true)', /getEvents\(\{[^}]*includeDiag:\s*true/.test(renderBlock));

// ---- sandbox ---------------------------------------------------------------
function makeEl(id) {
  return { _id: id, innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {} },
    querySelector() { return null; }, querySelectorAll() { return []; }, getAttribute() { return null; } };
}

function build(events, opts) {
  opts = opts || {};
  const store = {};
  const doc = {
    getElementById(id) { if (!store[id]) store[id] = makeEl(id); return store[id]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const S = { prefs: { hideSyncDiag: opts.hideDiag !== false, hideConflictDecisions: false }, tasks: opts.tasks || [], devices: {} };
  const rec = { saves: 0, switched: [], renders: 0, dialogs: [], getEventsOpts: [], toasts: [], closed: 0, copied: [] };
  const stubs =
    'var _evFilterType="all", _evPage=0, _evSearchQuery="";\n' +
    'var TAB=' + JSON.stringify(opts.tab || 'rewards') + ', EDIT=' + (opts.edit ? JSON.stringify(opts.edit) : 'null') + ';\n' +
    'function save(){ rec.saves++; }\n' +
    'function render(){ rec.renders++; }\n' +
    'function switchTab(t,d){ rec.switched.push([t,d]); TAB=t; }\n' +
    'function closeSheet(){ rec.closed++; }\n' +
    'function toast(m){ rec.toasts.push(m); }\n' +
    'function alertDialog(t,x,h){ rec.dialogs.push([t,x,h]); return Promise.resolve(); }\n' +
    'function deviceRegisteredName(){ return ""; }\n' +
    'function missDamage(){ return 0; }\n' +
    'function getEvents(o){ rec.getEventsOpts.push(o); return Promise.resolve(EVENTS.slice().sort(function(a,b){return a.ts-b.ts;})); }\n';
  const code = diagnosticKindsLine + '\n' + stubs + renderBlock + '\n' + escFn + '\n' + jsqFn + '\n' +
    'return { renderEventDetail, evDayLabel, evRangeFor, evRangeBounds, evSetRange, evOpenActivityRange, evOpenTaskHistory,\n' +
    '  evClearTask, evClearCustom, evToggleDiag, evOpenDetail, evCopyDetail, evRowDetailHtml, viewActivity,\n' +
    '  evDiagFooterHtml, evSetFilter, getState: function(){ return { range:_evRange, custom:_evCustom, taskId:_evTaskId, taskTitle:_evTaskTitle, page:_evPage, pageEvents:_evPageEvents, search:_evSearchQuery }; } };';
  const fn = new vm.Script('(function(S, document, window, navigator, console, rec, EVENTS, setTimeout, clearTimeout){ "use strict";\n' + code + '\n})')
    .runInNewContext({});
  const nav = opts.clipboard ? { clipboard: { writeText: function (t) { rec.copied.push(t); return Promise.resolve(); } } } : {};
  const api = fn(S, doc, {}, nav, console, rec, events, setTimeout, clearTimeout);
  return { api, S, doc, rec, feed: () => doc.getElementById('evFeedContent').innerHTML };
}
const countRows = h => (h.match(/class="evRow"/g) || []).length;
const countHdr = h => (h.match(/class="evDayHdr"/g) || []).length;

(async function main() {
  // ---- evDayLabel ----------------------------------------------------------
  {
    const { api } = build([]);
    const L = api.evDayLabel;
    const now = new Date(2026, 9, 8, 12, 0, 0).getTime();
    assert('evDayLabel: same day -> Today', L(new Date(2026, 9, 8, 0, 0, 1).getTime(), now) === 'Today');
    assert('evDayLabel: 23:59 the day before -> Yesterday', L(new Date(2026, 9, 7, 23, 59, 59).getTime(), now) === 'Yesterday');
    const older = new Date(2026, 9, 1, 9, 0, 0).getTime();
    assert('evDayLabel: older same-year -> weekday/day/month, no year',
      L(older, now) === new Date(older).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
    const other = new Date(2025, 11, 31, 9, 0, 0).getTime();
    assert('evDayLabel: other year -> includes year',
      L(other, now) === new Date(other).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      && L(other, now).indexOf('2025') >= 0);
    // DST: calendar days are compared by y/m/d, never by subtracting 86400000.
    // Dates are built from local calendar fields, so these hit the real DST days
    // of whatever TZ the runner uses (EU 2026-03-29 / 10-25, US 2026-03-08 / 11-01).
    [[2026, 2, 29], [2026, 9, 25], [2026, 2, 8], [2026, 10, 1]].forEach(function (d) {
      const nowD = new Date(d[0], d[1], d[2], 0, 30, 0).getTime();       // just after local midnight
      const prev = new Date(d[0], d[1], d[2] - 1, 23, 30, 0).getTime();  // 1h earlier on the calendar
      assert('evDayLabel DST ' + d.join('-') + ': 23:30 previous day -> Yesterday', L(prev, nowD) === 'Yesterday');
      const nowN = new Date(d[0], d[1], d[2], 23, 30, 0).getTime();
      const early = new Date(d[0], d[1], d[2], 0, 15, 0).getTime();
      assert('evDayLabel DST ' + d.join('-') + ': same calendar day -> Today', L(early, nowN) === 'Today');
    });
  }

  // ---- range chips ---------------------------------------------------------
  {
    const { api, rec } = build([], { tab: 'rewards' });
    const now = 1.8e12, D = 86400000, MAXT = 8.64e15;
    const R = api.evRangeFor;
    assert('range: 7d -> [now-7d, max]', JSON.stringify(R('7d', now)) === JSON.stringify([now - 7 * D, MAXT]));
    assert('range: 30d', R('30d', now)[0] === now - 30 * D);
    assert('range: 90d', R('90d', now)[0] === now - 90 * D);
    assert('range: 180d', R('180d', now)[0] === now - 180 * D);
    assert('range: 1y = 365d', R('1y', now)[0] === now - 365 * D);
    assert('range: All -> [0, 8.64e15]', JSON.stringify(R('all', now)) === JSON.stringify([0, MAXT]));
    assert('range: default is All', api.getState().range === 'all' && api.evRangeBounds(now)[0] === 0);
    api.evSetRange('7d');
    assert('evSetRange sets the chip, resets page and re-renders',
      api.getState().range === '7d' && api.getState().page === 0 && rec.renders === 1);
    assert('evRangeBounds follows the chip', Math.abs(api.evRangeBounds(now)[0] - (now - 7 * D)) < 1);
    api.evOpenActivityRange(1000, 2000);
    assert('evOpenActivityRange stores the custom range', JSON.stringify(api.getState().custom) === '[1000,2000]');
    assert('evOpenActivityRange switches to the activity tab', JSON.stringify(rec.switched[0]) === '["activity",0]');
    assert('custom range wins over the chip in evRangeBounds', JSON.stringify(api.evRangeBounds(now)) === '[1000,2000]');
    const v = api.viewActivity();
    assert('viewActivity keeps id="anEventDetail" class="anCard full"', v.indexOf('id="anEventDetail" class="anCard full"') >= 0);
    assert('viewActivity has all six range chips', ['7d', '30d', '90d', '180d', '1y', 'All'].every(l => v.indexOf('>' + l + '<') >= 0));
    assert('viewActivity shows the removable "Analytics period" chip when set', v.indexOf('Analytics period') >= 0 && v.indexOf('evClearCustom') >= 0);
    api.evClearCustom();
    assert('evClearCustom removes the custom range', api.getState().custom === null);
    assert('viewActivity hides the Analytics-period chip once cleared', api.viewActivity().indexOf('Analytics period') < 0);
    api.evSetRange('all');
  }

  // ---- task filter + History entry ------------------------------------------
  {
    const evs = [
      { ts: 1000, kind: 'complete', taskType: 'daily', taskTitle: 'Alpha <b>', taskId: 'a1' },
      { ts: 2000, kind: 'complete', taskType: 'daily', taskTitle: 'Beta', taskId: 'b2' },
      { ts: 3000, kind: 'complete', taskType: 'daily', taskTitle: 'Alpha <b>', taskId: 'a1' },
    ];
    const b = build(evs, { tab: 'rewards', tasks: [{ id: 'a1', title: 'Alpha <b>' }], edit: { id: 'a1', title: 'Alpha <b>' } });
    b.api.renderEventDetail(0, 1e15); await tick();
    assert('task filter off: all 3 rows', countRows(b.feed()) === 3);
    b.api.evOpenTaskHistory('a1');
    assert('evOpenTaskHistory closes the sheet', b.rec.closed === 1);
    assert('evOpenTaskHistory sets filter id + title and resets page',
      b.api.getState().taskId === 'a1' && b.api.getState().taskTitle === 'Alpha <b>' && b.api.getState().page === 0);
    assert('evOpenTaskHistory from another tab -> switchTab(activity,0)', JSON.stringify(b.rec.switched[0]) === '["activity",0]');
    b.api.renderEventDetail(0, 1e15); await tick();
    assert('task filter on: only that task\'s 2 rows', countRows(b.feed()) === 2 && b.feed().indexOf('Beta') < 0);
    const v = b.api.viewActivity();
    assert('viewActivity shows "Task: <title> x" chip with the title escaped',
      v.indexOf('Task: Alpha &lt;b&gt;') >= 0 && v.indexOf('Alpha <b>') < 0 && v.indexOf('evClearTask') >= 0);
    b.api.evClearTask();
    assert('evClearTask clears the filter', b.api.getState().taskId === null);
    b.api.renderEventDetail(0, 1e15); await tick();
    assert('task filter cleared: all rows again', countRows(b.feed()) === 3);
    const c = build(evs, { tab: 'activity', tasks: [{ id: 'a1', title: 'Alpha' }] });
    c.api.evOpenTaskHistory('a1');
    assert('evOpenTaskHistory while already on activity re-renders instead of switching',
      c.rec.switched.length === 0 && c.rec.renders === 1);
  }

  // ---- diagnostics footer ----------------------------------------------------
  {
    const evs = [
      { ts: 1000, kind: 'habitTap', taskType: 'habit', taskTitle: 'Real', taskId: 'h1' },
      { ts: 2000, kind: 'storagePersist', granted: true },
      { ts: 3000, kind: 'lifecycle', notes: 'boot' },
    ];
    const b = build(evs, { tab: 'activity', hideDiag: true });
    b.api.renderEventDetail(0, 1e15); await tick();
    assert('diag: getEvents called with includeDiag:true', b.rec.getEventsOpts.length === 1 && b.rec.getEventsOpts[0].includeDiag === true);
    assert('diag hidden: only the real row is shown', countRows(b.feed()) === 1);
    assert('diag hidden: footer "2 hidden (diagnostics) · Show"', /2 hidden \(diagnostics\)[^<]*(<[^>]*>)?[^<]*Show/.test(b.feed()) || (b.feed().indexOf('2 hidden (diagnostics)') >= 0 && b.feed().indexOf('Show') >= 0));
    b.api.evToggleDiag(false);
    assert('Show flips S.prefs.hideSyncDiag to false and saves', b.S.prefs.hideSyncDiag === false && b.rec.saves === 1);
    await tick();
    assert('diag shown: all 3 rows', countRows(b.feed()) === 3);
    assert('diag shown: footer "Diagnostics shown · Hide"', b.feed().indexOf('Diagnostics shown') >= 0 && b.feed().indexOf('Hide') >= 0);
    b.api.evToggleDiag(true);
    await tick();
    assert('Hide flips it back to true and saves', b.S.prefs.hideSyncDiag === true && b.rec.saves === 2 && countRows(b.feed()) === 1);
    const none = build([evs[0]], { tab: 'activity', hideDiag: true });
    none.api.renderEventDetail(0, 1e15); await tick();
    assert('no diagnostic rows at all: no footer', none.feed().indexOf('hidden (diagnostics)') < 0 && none.feed().indexOf('Diagnostics shown') < 0);
    assert('evDiagFooterHtml: hidden>0 with pref on', build([]).api.evDiagFooterHtml(4, 0, true).indexOf('4 hidden (diagnostics)') >= 0);
    assert('evDiagFooterHtml: pref off and shown>0', build([]).api.evDiagFooterHtml(0, 3, false).indexOf('Diagnostics shown') >= 0);
    assert('evDiagFooterHtml: nothing to say -> empty', build([]).api.evDiagFooterHtml(0, 0, true) === '' && build([]).api.evDiagFooterHtml(0, 0, false) === '');
  }

  // ---- day headers, row time, tap target --------------------------------------
  {
    const nowTs = Date.now();
    const yest = new Date(); yest.setDate(yest.getDate() - 1); yest.setHours(12, 0, 0, 0);
    const old = new Date(2020, 0, 15, 8, 5, 9).getTime();
    const evs = [
      { ts: old, kind: 'habitTap', taskType: 'habit', taskTitle: 'Old <i>one</i>', taskId: 'o1', dir: 1 },
      { ts: yest.getTime(), kind: 'complete', taskType: 'daily', taskTitle: 'Yday', taskId: 'y1' },
      { ts: nowTs - 1, kind: 'complete', taskType: 'daily', taskTitle: 'Now A', taskId: 'n1' },
      { ts: nowTs - 2, kind: 'complete', taskType: 'daily', taskTitle: 'Now B', taskId: 'n2' },
    ];
    const b = build(evs, { tab: 'activity' });
    b.api.renderEventDetail(0, 1e15); await tick();
    const h = b.feed();
    assert('rows: 4 rendered', countRows(h) === 4);
    // two "Now" rows may straddle midnight only in a 1ms window; accept 3 or 4 headers then.
    const hdrs = countHdr(h);
    assert('one day header per local day (Today, Yesterday, 2020)', hdrs === 3 || hdrs === 4);
    assert('header "Today" present', h.indexOf('>Today<') >= 0);
    assert('header "Yesterday" present', h.indexOf('>Yesterday<') >= 0);
    assert('2020 header carries the year', /class="evDayHdr">[^<]*2020[^<]*</.test(h));
    assert('header comes before its first row', h.indexOf('evDayHdr') < h.indexOf('class="evRow"'));
    assert('row time is HH:MM:SS (08:05:09 for the 2020 event)', h.indexOf('08:05:09') >= 0);
    assert('rows no longer carry the per-row date ("@")', h.indexOf(' @ ') < 0);
    assert('title click stops propagation (does not open the detail)', h.indexOf('event.stopPropagation()') >= 0 && h.indexOf('evSetSearch') >= 0);
    assert('rows are tappable with a page index', /class="evRow"[^>]*onclick="evOpenDetail\(\d+\)"/.test(h));
    assert('page events are kept in a module var (newest first)', b.api.getState().pageEvents.length === 4 && b.api.getState().pageEvents[3].ts === old);
  }

  // ---- row detail -----------------------------------------------------------
  {
    const e = { ts: new Date(2026, 4, 3, 14, 5, 7).getTime(), kind: 'edit', taskType: 'todo', taskTitle: '<script>alert(1)</script> & "q"',
      taskId: 't9', notes: "it's <b>bold</b>", amount: 0, nothing: null, dev: 'dev1' };
    const b = build([e], { tab: 'activity', clipboard: true });
    b.api.renderEventDetail(0, 1e15); await tick();
    const html = b.api.evRowDetailHtml(e, 0);
    assert('detail: no unescaped < from synced strings', html.indexOf('<script>') < 0 && html.indexOf('<b>bold') < 0);
    assert('detail: contains the escaped raw JSON pre block',
      html.indexOf('<pre') >= 0 && html.indexOf(JSON.stringify(e, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')) >= 0);
    assert('detail: shows kind, title, type', html.indexOf('edit') >= 0 && html.indexOf('&lt;script&gt;') >= 0 && html.indexOf('todo') >= 0);
    assert('detail: local time with seconds (14:05:07)', html.indexOf('14:05:07') >= 0);
    assert('detail: lists non-null fields incl. 0, omits null (field list)', html.indexOf('amount') >= 0 && html.indexOf('t9') >= 0 && !/>nothing</.test(html));
    assert('detail: Copy button', html.indexOf('>Copy<') >= 0 && html.indexOf('evCopyDetail(0)') >= 0);
    b.api.evOpenDetail(0);
    assert("evOpenDetail opens alertDialog('Event detail','',html)", b.rec.dialogs.length === 1 && b.rec.dialogs[0][0] === 'Event detail' && b.rec.dialogs[0][1] === '' && b.rec.dialogs[0][2].indexOf('<pre') >= 0);
    b.api.evOpenDetail(99);
    assert('evOpenDetail ignores an out-of-range index', b.rec.dialogs.length === 1);
    b.api.evCopyDetail(0); await tick();
    assert('Copy writes the pretty JSON to the clipboard and toasts', b.rec.copied.length === 1 && b.rec.copied[0] === JSON.stringify(e, null, 2) && b.rec.toasts.indexOf('Copied') >= 0);
  }

  if (failures) { console.error('\nFAILED: ' + failures + ' assertion(s)'); process.exit(1); }
  console.log('\nALL ACTIVITY-TAB TESTS PASSED');
  process.exit(0);
})().catch(function (e) { console.error('\nERROR: ' + (e && e.stack || e)); process.exit(1); });

setTimeout(function () { console.error('\nTIMEOUT'); process.exit(1); }, 15000);
