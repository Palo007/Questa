// missed-reminders.test.js -- PWA-01 (cross-day missed reminders) + PWA-17
// (per-slot notification tag). Design: fix-plans/pwa/design_D6_missed-reminders.md.
//
// A PWA cannot wake itself once closed. The same-day "Missed at HH:MM" path in
// checkReminders() covers slots that passed earlier TODAY; slots from earlier
// days were lost. findMissedReminderSlots() lists them, in-app only (never the
// Notification API / SW -- the Android DelegationService keys a "Missed at" body
// on TODAY's date, so a cross-day system notification would suppress today's
// real native alarm).
//
// Run: node tests/missed-reminders.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract.js');

let failures = 0;
function assert(desc, cond) { if (cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
function attempt(desc, fn) {
  try { fn(); }
  catch (e) { assert(desc + ' (threw: ' + (e && e.message || e) + ')', false); }
}

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const helpers = appSrc.match(/\/\* BEGIN_REMINDER_HELPERS \*\/([\s\S]*?)\/\* END_REMINDER_HELPERS \*\//)[0];
function tryExtract(re, name) { try { return extractFunction(appSrc, re, name); } catch (e) { return ''; } }

const H = { Date };
vm.createContext(H);
vm.runInContext(helpers, H);

const DAY = 86400000;
const ALL = [true, true, true, true, true, true, true];
// Fixed local calendar: "today" is Thu 2026-09-24.
const at = (d, hh, mm) => new Date(2026, 8, d, hh, mm || 0).getTime();
const daily = (id, time, extra) => Object.assign({ id, type: 'daily', title: 'Pills ' + id,
  reminders: [{ id: 'r' + id, enabled: true, kind: 'weekly', time, days: ALL, lastFiredKey: '' }] }, extra || {});
const find = (...a) => H.findMissedReminderSlots(...a);

attempt('MR1', () => {
  const out = find([daily('a', '21:00')], at(23, 20), at(24, 7), false);
  assert('MR1: cross-day slot yesterday 21:00 is listed exactly once', out.length === 1);
  assert('MR1: item is {k, taskId, title, date, time}', out[0].k === 'a|2026-09-23|21:00'
    && out[0].taskId === 'a' && out[0].title === 'Pills a' && out[0].date === '2026-09-23' && out[0].time === '21:00');
});

attempt('MR2', () => {
  const t = daily('a', '21:00');
  t.reminders[0].lastFiredKey = H.reminderFireKey(t.reminders[0], new Date(at(23, 21)));
  assert('MR2: slot already fired (lastFiredKey) is not listed', find([t], at(23, 20), at(24, 7), false).length === 0);
});

attempt('MR3', () => {
  assert('MR3: slot before the last-check stamp is not listed', find([daily('a', '21:00')], at(23, 22), at(24, 7), false).length === 0);
});

attempt('MR4', () => {
  const out = find([daily('a', '21:00')], at(24, 7) - 30 * DAY, at(24, 7), false);
  assert('MR4: window capped at 7 days (got ' + out.length + ')', out.length > 0 && out.length <= 7);
});

attempt('MR5', () => {
  const t = [daily('a', '21:00')];
  assert('MR5: no stamp -> []', find(t, NaN, at(24, 7), false).length === 0);
  assert('MR5: null stamp -> []', find(t, null, at(24, 7), false).length === 0);
  assert('MR5: stamp in the future (clock moved back) -> []', find(t, at(25, 7), at(24, 7), false).length === 0);
});

attempt('MR6', () => {
  // 2026-09-22 is a Tuesday (getDay 2), 2026-09-23 a Wednesday (3).
  const weekdayOnlyTue = { id: 'w', type: 'habit', title: 'Tue only',
    reminders: [{ id: 'rw', enabled: true, kind: 'weekly', time: '10:00', days: [false, false, true, false, false, false, false], lastFiredKey: '' }] };
  const doneTodo = { id: 'd', type: 'todo', done: true, title: 'Done',
    reminders: [{ id: 'rd', enabled: true, kind: 'once', time: '10:00', date: '2026-09-23', lastFiredKey: '' }] };
  const onceTodo = { id: 'o', type: 'todo', done: false, title: 'Once',
    reminders: [{ id: 'ro', enabled: true, kind: 'once', time: '10:00', date: '2026-09-23', lastFiredKey: '' }] };
  const dailyRepeat = { id: 'p', type: 'daily', title: 'Rep', repeat: [false, false, false, true, false, false, false],
    reminders: [{ id: 'rp', enabled: true, kind: 'weekly', time: '10:00', lastFiredKey: '' }] };
  const disabled = daily('x', '10:00'); disabled.reminders[0].enabled = false;
  const out = find([weekdayOnlyTue, doneTodo, onceTodo, dailyRepeat, disabled], at(21, 12), at(24, 7), false);
  const keys = out.map(x => x.k).join(',');
  assert('MR6: weekday gate, done to-do, once-date, daily repeat, disabled honoured (got ' + keys + ')',
    keys === 'w|2026-09-22|10:00,o|2026-09-23|10:00,p|2026-09-23|10:00');
});

attempt('MR7', () => {
  const t = [daily('a', '06:00')];
  assert('MR7: includeToday=false excludes today 06:00', find(t, at(24, 5), at(24, 7), false).length === 0);
  const inc = find(t, at(24, 5), at(24, 7), true);
  assert('MR7: includeToday=true includes today 06:00', inc.length === 1 && inc[0].date === '2026-09-24');
  assert('MR7: slot later today is never listed', find([daily('b', '09:00')], at(24, 5), at(24, 7), true).length === 0);
});

attempt('MR-pure', () => {
  const t = [daily('a', '21:00')];
  const before = JSON.stringify(t);
  find(t, at(20, 20), at(24, 7), true);
  assert('MR-pure: findMissedReminderSlots does not mutate tasks', JSON.stringify(t) === before);
  const fnSrc = tryExtract(/^function findMissedReminderSlots\(/, 'findMissedReminderSlots');
  assert('MR-pure: no now() dependency', fnSrc && !/\bnow\(\)/.test(fnSrc));
  const multi = find([daily('b', '08:00'), daily('a', '21:00')], at(22, 12), at(24, 7), false);
  assert('MR-pure: sorted by date then time', multi.map(x => x.date + ' ' + x.time).join(',') ===
    '2026-09-22 21:00,2026-09-23 08:00,2026-09-23 21:00');
});

// ---- MR8 (PWA-17): per-slot tag in checkReminders ----
attempt('MR8', () => {
  const nativeSrc = extractFunction(appSrc, /^function nativeRemindersActive\(\)\{/, 'nativeRemindersActive');
  const checkSrc = extractFunction(appSrc, /^function checkReminders\(\) \{/, 'checkReminders');
  function run(useSw) {
    const posts = [];
    const RealDate = Date;
    const fixedNow = new RealDate(2026, 8, 24, 14, 0);
    function FixedDate(...a) { return a.length ? new RealDate(...a) : new RealDate(fixedNow.getTime()); }
    FixedDate.now = () => fixedNow.getTime();
    const task = { id: 'abc123', type: 'habit', title: 'Water', reminders: [
      { id: 'r1', enabled: true, kind: 'weekly', time: '08:00', days: ALL, lastFiredKey: '' },
      { id: 'r2', enabled: true, kind: 'weekly', time: '12:00', days: ALL, lastFiredKey: '' }] };
    const sb = {
      Date: FixedDate, sessionStorage: { getItem: () => null },
      Notification: Object.assign(function (title, o) { posts.push({ title, body: o.body, tag: o.tag }); }, { permission: 'granted' }),
      navigator: useSw ? { serviceWorker: { controller: { postMessage: m => posts.push(m) } } } : {},
      S: { prefs: { notificationsEnabled: true }, tasks: [task] }, save() {}, console
    };
    vm.createContext(sb);
    vm.runInContext(helpers + '\n' + nativeSrc + '\n' + checkSrc, sb);
    sb.checkReminders();
    return posts;
  }
  for (const useSw of [false, true]) {
    const p = run(useSw), lbl = useSw ? ' (SW path)' : ' (Notification path)';
    assert('MR8: two posts' + lbl, p.length === 2);
    assert('MR8: distinct per-slot tags questa-abc123-0800 / -1200' + lbl,
      p[0].tag === 'questa-abc123-0800' && p[1].tag === 'questa-abc123-1200');
    assert('MR8: bodies keep the "Missed at HH:MM - " prefix (TWA parseMissedTime)' + lbl,
      /^Missed at 08:00 - /.test(p[0].body) && /^Missed at 12:00 - /.test(p[1].body));
    assert('MR8: title unchanged' + lbl, p[0].title === 'Water' && p[1].title === 'Water');
  }
  assert('MR8: reminderNotificationTag helper', typeof H.reminderNotificationTag === 'function'
    && H.reminderNotificationTag({ id: 'q' }, { time: '07:05' }) === 'questa-q-0705');
});

// ---- runReminderPass glue ----
const passSrc = tryExtract(/^function runReminderPass\(\) \{/, 'runReminderPass');
const loadSrc = tryExtract(/^function loadMissedReminders\(\) \{/, 'loadMissedReminders');
const saveSrc = tryExtract(/^function saveMissedReminders\(list\) \{/, 'saveMissedReminders');
const dismissSrc = tryExtract(/^function dismissMissedReminder\(k\) \{/, 'dismissMissedReminder');
const dismissAllSrc = tryExtract(/^function dismissAllMissedReminders\(\) \{/, 'dismissAllMissedReminders');
const labelSrc = tryExtract(/^function missedReminderDayLabel\(date, nowMs\) \{/, 'missedReminderDayLabel');

function passCtx(opts) {
  const store = Object.assign({}, opts.store || {});
  const calls = { check: 0, render: 0, notif: 0 };
  const RealDate = Date;
  const fixedNow = opts.nowMs;
  function FixedDate(...a) { return a.length ? new RealDate(...a) : new RealDate(fixedNow); }
  FixedDate.now = () => fixedNow;
  const sb = {
    Date: FixedDate, console, JSON,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: k => (k === 'questa.nativeReminders' && opts.native ? '1' : null) },
    Notification: Object.assign(function () { calls.notif++; }, { permission: opts.permission || 'granted' }),
    navigator: {},
    S: { prefs: { notificationsEnabled: opts.enabled !== false }, tasks: opts.tasks },
    checkReminders() { calls.check++; }, renderMissedReminders() { calls.render++; }
  };
  vm.createContext(sb);
  vm.runInContext(helpers + '\n' + extractFunction(appSrc, /^function nativeRemindersActive\(\)\{/, 'nativeRemindersActive')
    + '\n' + loadSrc + '\n' + saveSrc + '\n' + dismissSrc + '\n' + dismissAllSrc + '\n' + passSrc, sb);
  return { sb, store, calls };
}
const LIST = 'questa.missedReminders.v1', STAMP = 'questa.reminderLastCheck';

attempt('MP1', () => {
  const c = passCtx({ tasks: [daily('a', '21:00')], nowMs: at(24, 7), store: { [STAMP]: String(at(23, 20)) } });
  c.sb.runReminderPass();
  const list = JSON.parse(c.store[LIST] || '[]');
  assert('MP1: cross-day slot stored in questa.missedReminders.v1', list.length === 1 && list[0].k === 'a|2026-09-23|21:00');
  assert('MP1: stamp advanced to now', c.store[STAMP] === String(at(24, 7)));
  assert('MP1: checkReminders still runs, render called', c.calls.check === 1 && c.calls.render >= 1);
  assert('MP1: no system notification for the cross-day item', c.calls.notif === 0);
  c.sb.runReminderPass();
  assert('MP1: second pass does not duplicate', JSON.parse(c.store[LIST]).length === 1);
});

attempt('MP2', () => {
  const c = passCtx({ native: true, tasks: [daily('a', '21:00')], nowMs: at(24, 7), store: { [STAMP]: String(at(23, 20)) } });
  c.sb.runReminderPass();
  assert('MP2: TWA (native alarms) -> scan skipped, nothing stored', !c.store[LIST]);
  assert('MP2: TWA -> stamp still advances and checkReminders runs', c.store[STAMP] === String(at(24, 7)) && c.calls.check === 1);
});

attempt('MP3', () => {
  const c = passCtx({ enabled: false, tasks: [daily('a', '21:00')], nowMs: at(24, 7), store: { [STAMP]: String(at(23, 20)) } });
  c.sb.runReminderPass();
  assert('MP3: notifications disabled -> nothing stored, stamp advances', !c.store[LIST] && c.store[STAMP] === String(at(24, 7)));
});

attempt('MP4', () => {
  const t = [daily('a', '06:00')];
  const g = passCtx({ tasks: t, nowMs: at(24, 7), store: { [STAMP]: String(at(24, 5)) } });
  g.sb.runReminderPass();
  assert('MP4: permission granted -> today slot left to the same-day Missed path', !g.store[LIST]);
  const d = passCtx({ permission: 'denied', tasks: t, nowMs: at(24, 7), store: { [STAMP]: String(at(24, 5)) } });
  d.sb.runReminderPass();
  assert('MP4: permission denied -> today slot listed in-app', JSON.parse(d.store[LIST] || '[]').length === 1);
});

attempt('MP5', () => {
  const c = passCtx({ tasks: [daily('a', '21:00')], nowMs: at(24, 7), store: {} });
  c.sb.runReminderPass();
  assert('MP5: first run after upgrade (no stamp) -> no flood, stamp written', !c.store[LIST] && c.store[STAMP] === String(at(24, 7)));
});

attempt('MP6', () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ k: 'x|2026-09-0' + (i % 9 + 1) + '|' + String(i).padStart(2, '0') + ':00', taskId: 'x', title: 'X', date: '2026-09-01', time: '00:00' });
  const c = passCtx({ tasks: [daily('a', '21:00')], nowMs: at(24, 7), store: { [STAMP]: String(at(23, 20)), [LIST]: JSON.stringify(many) } });
  c.sb.runReminderPass();
  const list = JSON.parse(c.store[LIST]);
  assert('MP6: list capped at 30 (got ' + list.length + ')', list.length === 30);
  assert('MP6: newest item kept when capping', list.some(x => x.k === 'a|2026-09-23|21:00'));
  c.sb.dismissMissedReminder('a|2026-09-23|21:00');
  assert('MP6: dismissMissedReminder removes one item', JSON.parse(c.store[LIST]).length === 29 && !c.store[LIST].includes('a|2026-09-23'));
  c.sb.dismissAllMissedReminders();
  assert('MP6: dismissAllMissedReminders clears the list', !c.store[LIST]);
  c.store[LIST] = '{not json';
  assert('MP6: corrupt storage reads as []', Array.isArray(c.sb.loadMissedReminders()) && c.sb.loadMissedReminders().length === 0);
});

attempt('MP7', () => {
  const sb = { Date }; vm.createContext(sb); vm.runInContext(labelSrc, sb);
  assert('MP7: today label', sb.missedReminderDayLabel('2026-09-24', at(24, 7)) === 'today');
  assert('MP7: yesterday label', sb.missedReminderDayLabel('2026-09-23', at(24, 7)) === 'yesterday');
  assert('MP7: older label is "Mon 21 Sep"', sb.missedReminderDayLabel('2026-09-21', at(24, 7)) === 'Mon 21 Sep');
});

// ---- MR9 guard pins / MR10 wiring (source regex) ----
attempt('MR9', () => {
  const payloadSrc = extractFunction(appSrc, /^function getReminderNotificationPayload\(t, r, missed\) \{/, 'getReminderNotificationPayload');
  assert('MR9: payload tag line unchanged (TWA guard)', payloadSrc.includes('tag: `questa-${t.id}`'));
  assert('MR9: payload keeps "Missed at " + r.time + " - " prefix', payloadSrc.includes("'Missed at ' + r.time + ' - '"));
  assert('MR9: runReminderPass never posts a system notification', passSrc && !/Notification\(|SHOW_NOTIFICATION|postMessage/.test(passSrc));
  assert('MR9: runReminderPass gates on nativeRemindersActive()', /nativeRemindersActive\(\)/.test(passSrc));
  const renderSrc = tryExtract(/^function renderMissedReminders\(\) \{/, 'renderMissedReminders');
  assert('MR9: renderMissedReminders uses textContent, not innerHTML', renderSrc && /textContent/.test(renderSrc) && !/innerHTML/.test(renderSrc));
});

attempt('MR10', () => {
  const sched = extractFunction(appSrc, /^function startReminderScheduler\(\) \{/, 'startReminderScheduler');
  assert('MR10: startReminderScheduler uses runReminderPass (both refs)',
    (sched.match(/runReminderPass/g) || []).length === 2 && !/checkReminders/.test(sched));
  const vis = appSrc.match(/document\.addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState === 'visible'\) \{[\s\S]*?\}\s*\}\);/);
  assert('MR10: visible listener calls runReminderPass', vis && /runReminderPass\(\)/.test(vis[0]) && !/checkReminders\(\)/.test(vis[0]));
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert('MR10: index.html has #missedReminders container', /<div id="missedReminders"[^>]*hidden/.test(html));
});

console.log(failures ? ('\nFAILED: ' + failures + ' assertion(s)') : '\nALL PASSED');
process.exit(failures ? 1 : 0);
