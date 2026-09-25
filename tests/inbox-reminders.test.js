// inbox-reminders.test.js -- Phase 1C todo 15/16
// (.cline/plans/android-inbox-step1.md).
//
// Part A: syncInboxWriteReminders() in sync.js -- publishes the reminder
// schedule to /inbox-meta/reminders.json, mirroring syncInboxWriteMeta's
// hash/upload-only-on-change pattern (see tests/inbox-meta.test.js).
//
// Part B: checkReminders() in app.js must still fire DUE reminders when this
// session is flagged as having native alarms ready (nativeRemindersActive()),
// but must skip firing MISSED ones (native AlarmManager already covered them
// while the page was closed) -- and must fire both due and missed without the
// flag. Also covers parseNativeRemindersParam(), the pure helper that reads the
// Android launcher's ?nr=1 boot param.
//
// Run: node tests/inbox-reminders.test.js

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract.js');

let failures = 0;
function assert(desc, cond) { if (cond) console.log('[PASS] ' + desc); else { console.error('[FAIL] ' + desc); failures++; } }
async function attempt(desc, fn) {
  try { await fn(); }
  catch (e) { assert(desc + ' (threw: ' + (e && e.message || e) + ')', false); }
}

const noop = function () {};

// ===========================================================================
// Part A: syncInboxWriteReminders()
// ===========================================================================

let syncSrc = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
syncSrc = syncSrc.replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const appHelpers = extractFunction(appSrc, /^function quickLogMode\(t\)\{/, 'quickLogMode') + ';\n'
  + extractFunction(appSrc, /^function quickLogDirs\(t\)\{/, 'quickLogDirs') + ';\n'
  + extractFunction(appSrc, /^function getReminderNotificationPayload\(t, r, missed\) \{/, 'getReminderNotificationPayload');

function makeCtx(tasks) {
  const store = {};
  const uploads = [];

  const S = { tasks: tasks };

  const sandbox = {
    window: {}, navigator: { onLine: true },
    document: { addEventListener: noop, getElementById: () => null,
      createElement: () => ({ style: {}, appendChild: noop, setAttribute: noop, click: noop }),
      body: { appendChild: noop, removeChild: noop } },
    localStorage: {
      getItem: k => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }, key: () => null, length: 0
    },
    history: { replaceState: noop },
    location: { search: '', origin: 'https://test.example', pathname: '/', href: '' },
    crypto: { getRandomValues: arr => { for (let i = 0; i < arr.length; i++) arr[i] = i % 256; return arr; },
      subtle: { digest: async () => new ArrayBuffer(32) } },
    setTimeout: (fn, ms) => setTimeout(fn, 0), clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console, JSON, Math, Date, Map, Set, WeakSet, Array, Object, Number, String, Boolean, Promise,
    URLSearchParams, TextEncoder, Buffer, Uint8Array, ArrayBuffer, Error, isFinite, isNaN, parseInt, RegExp,
    logEvent: noop, toast: noop, render: noop, esc: x => x, save: noop, uid: () => 'test-device-1',
    idbOpen: () => Promise.resolve(null), getEvents: () => Promise.resolve([]),
    confirmDialog: () => Promise.resolve(true),
    S: S,
    dbxUploadText: async function (p, text) { uploads.push({ path: p, text: text }); return { rev: 'r' + uploads.length }; },
    fetch: async function () { return { ok: true, status: 200, json: async () => ({}), text: async () => '', headers: { get: () => null } }; }
  };
  sandbox.window.addEventListener = noop;
  sandbox.self = sandbox.window; sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(appHelpers, sandbox);
  try { vm.runInContext(syncSrc, sandbox); }
  catch (e) { console.error('FAIL: sync.js eval threw:', e); process.exit(1); }
  store['questa.sync.v1'] = JSON.stringify({ enabled: true, appKey: 'test-key', refreshToken: 'rt', accessToken: 'tok',
    accessExpiresAt: Date.now() + 3600000, deviceId: 'test-device-1', lastRev: null, lastError: null,
    evtLastUploadTs: 0, evtFileRevs: {}, evtFileCounts: {}, evtPushBlocked: {} });
  sandbox.dbxUploadText = async function (p, text) { uploads.push({ path: p, text: text }); return { rev: 'r' + uploads.length }; };

  return { sandbox, store, uploads, S };
}

function mkHabit(id, time, days) {
  return { id: id, type: 'habit', title: 'Habit ' + id,
    reminders: [{ id: 'r-' + id, enabled: true, kind: 'weekly', time: time, days: days, lastFiredKey: '' }] };
}

(function checkSymbolExists() {
  const { sandbox } = makeCtx([]);
  assert('sync.js exports syncInboxWriteReminders', typeof sandbox.syncInboxWriteReminders === 'function');
})();

attempt('rem-1: first call uploads once to /inbox-meta/reminders.json', async () => {
  const c = makeCtx([mkHabit('h1', '09:00', [true, true, true, true, true, true, true])]);
  const changed = await c.sandbox.syncInboxWriteReminders();
  assert('rem-1: returns true', changed === true);
  assert('rem-1: exactly one upload', c.uploads.length === 1);
  assert('rem-1: path is /inbox-meta/reminders.json', c.uploads[0].path === '/inbox-meta/reminders.json');
  const body = JSON.parse(c.uploads[0].text);
  assert('rem-1: payload has v:1', body.v === 1);
  assert('rem-1: one item, keyed <taskId>#<index>', Array.isArray(body.items) && body.items.length === 1 && body.items[0].key === 'h1#0');
  assert('rem-1: item carries title/body/time', body.items[0].title === 'Habit h1' && typeof body.items[0].body === 'string' && body.items[0].time === '09:00');
}).then(() => attempt('rem-2: unchanged schedule -> no second upload, returns false', async () => {
  const tasks = [mkHabit('h1', '09:00', [true, true, true, true, true, true, true])];
  const c = makeCtx(tasks);
  const first = await c.sandbox.syncInboxWriteReminders();
  assert('rem-2: first call uploads', first === true && c.uploads.length === 1);
  const second = await c.sandbox.syncInboxWriteReminders();
  assert('rem-2: second call unchanged returns false', second === false);
  assert('rem-2: no additional upload', c.uploads.length === 1);
})).then(() => attempt('rem-3: changed reminder time -> exactly one more upload', async () => {
  const tasks = [mkHabit('h1', '09:00', [true, true, true, true, true, true, true])];
  const c = makeCtx(tasks);
  await c.sandbox.syncInboxWriteReminders();
  tasks[0].reminders[0].time = '10:00';
  const changed = await c.sandbox.syncInboxWriteReminders();
  assert('rem-3: change detected', changed === true);
  assert('rem-3: exactly 2 uploads total', c.uploads.length === 2);
  const body = JSON.parse(c.uploads[1].text);
  assert('rem-3: new time is reflected', body.items[0].time === '10:00');
})).then(() => attempt('rem-4: daily task uses t.repeat, not r.days', async () => {
  const daily = { id: 'd1', type: 'daily', title: 'Standup', repeat: [false, true, false, false, false, false, false],
    reminders: [{ id: 'rd1', enabled: true, kind: 'daily', time: '08:00', days: [true, true, true, true, true, true, true], lastFiredKey: '' }] };
  const c = makeCtx([daily]);
  await c.sandbox.syncInboxWriteReminders();
  const body = JSON.parse(c.uploads[0].text);
  assert('rem-4: days mirrors t.repeat, not r.days', JSON.stringify(body.items[0].days) === JSON.stringify([false, true, false, false, false, false, false]));
  assert('rem-4: type is daily', body.items[0].type === 'daily');
})).then(() => attempt('rem-5: a done todo is excluded entirely', async () => {
  const todo = { id: 't1', type: 'todo', title: 'Pay bill', done: true,
    reminders: [{ id: 'rt1', enabled: true, kind: 'once', time: '09:00', date: '2026-09-30', lastFiredKey: '' }] };
  const habit = mkHabit('h1', '09:00', [true, true, true, true, true, true, true]);
  const c = makeCtx([todo, habit]);
  await c.sandbox.syncInboxWriteReminders();
  const body = JSON.parse(c.uploads[0].text);
  assert('rem-5: only the habit item is present', body.items.length === 1 && body.items[0].taskId === 'h1');
})).then(() => attempt('rem-6: a disabled reminder is excluded', async () => {
  const habit = mkHabit('h1', '09:00', [true, true, true, true, true, true, true]);
  habit.reminders[0].enabled = false;
  const c = makeCtx([habit]);
  const changed = await c.sandbox.syncInboxWriteReminders();
  assert('rem-6: nothing to upload -> no upload at all (empty list is still a change from unset, so upload happens with empty items)', c.uploads.length <= 1);
  const body = JSON.parse(c.uploads[0].text);
  assert('rem-6: items list is empty', Array.isArray(body.items) && body.items.length === 0);
})).then(() => attempt('rem-7: a once reminder carries date and null days', async () => {
  const todo = { id: 't2', type: 'todo', title: 'Renew passport', done: false,
    reminders: [{ id: 'rt2', enabled: true, kind: 'once', time: '09:00', date: '2026-10-01', lastFiredKey: '' }] };
  const c = makeCtx([todo]);
  await c.sandbox.syncInboxWriteReminders();
  const body = JSON.parse(c.uploads[0].text);
  assert('rem-7: date is set', body.items[0].date === '2026-10-01');
  assert('rem-7: days is null for a once reminder', body.items[0].days === null);
  assert('rem-7: type is todo', body.items[0].type === 'todo');
})).then(() => attempt('rem-8: an undated once reminder is not emitted (CR-PWA-001)', async () => {
  const todo = { id: 't3', type: 'todo', title: 'Call dentist', done: false,
    reminders: [
      { id: 'rt3', enabled: true, kind: 'once', time: '09:00', lastFiredKey: '' },
      { id: 'rt4', enabled: true, kind: 'weekly', time: '10:00', days: [true, true, true, true, true, true, true], lastFiredKey: '' }
    ] };
  const c = makeCtx([todo, mkHabit('h1', '09:00', [true, true, true, true, true, true, true])]);
  await c.sandbox.syncInboxWriteReminders();
  const body = JSON.parse(c.uploads[0].text);
  assert('rem-8: no t3 item with date:null and days:null', !body.items.some(it => it.taskId === 't3' && it.days === null && it.date === null));
  assert('rem-8: exactly 2 items', body.items.length === 2);
  assert('rem-8: weekly sibling keeps key t3#1', body.items.some(it => it.taskId === 't3' && it.key === 't3#1'));
})).then(() => attempt('rem-9: golden fixture CR-PWA-001', async () => {
  const fxDir = path.join(__dirname, 'fixtures', 'CR-PWA-001');
  const input = JSON.parse(fs.readFileSync(path.join(fxDir, 'input_state_once_no_date.json'), 'utf8'));
  const expected = JSON.parse(fs.readFileSync(path.join(fxDir, 'expected_reminders.json'), 'utf8'));
  const c = makeCtx(input.tasks);
  await c.sandbox.syncInboxWriteReminders();
  const body = JSON.parse(c.uploads[0].text);
  assert('rem-9: v is 1', body.v === 1);
  assert('rem-9: items match expected_reminders.json', JSON.stringify(body.items) === JSON.stringify(expected.items));
  const hash = JSON.parse(c.store['questa.sync.v1']).inboxRemindersHash;
  assert('rem-9: inboxRemindersHash is 781f046d:348 (got ' + hash + ')', hash === '781f046d:348');
})).then(() => {

  // =========================================================================
  // Part B: checkReminders() -- due always fires; missed only fires without
  // native alarms; native flag comes from ?nr=1 via parseNativeRemindersParam.
  // =========================================================================

  const reminderHelpers = appSrc.match(/\/\* BEGIN_REMINDER_HELPERS \*\/([\s\S]*?)\/\* END_REMINDER_HELPERS \*\//)[0];
  const nativeRemindersActiveSrc = extractFunction(appSrc, /^function nativeRemindersActive\(\)\{/, 'nativeRemindersActive');
  const checkRemindersSrc = extractFunction(appSrc, /^function checkReminders\(\) \{/, 'checkReminders');
  const parseNativeRemindersParamSrc = extractFunction(appSrc, /^function parseNativeRemindersParam\(search\)\{/, 'parseNativeRemindersParam');

  function makeAppCtx(nativeFlag) {
    const sessionStore = {};
    if (nativeFlag) sessionStore['questa.nativeReminders'] = '1';
    const notifications = [];
    let saved = 0;

    // Every-day weekly reminders, so the fixed "now" below matches regardless
    // of which real weekday this test happens to run on. h1 is due exactly at
    // "now" (09:00); h2's slot (08:00) already passed, i.e. missed.
    const dueHabit = { id: 'h1', type: 'habit', title: 'Water',
      reminders: [{ id: 'r1', enabled: true, kind: 'weekly', time: '09:00', days: [true, true, true, true, true, true, true], lastFiredKey: '' }] };
    const missedHabit = { id: 'h2', type: 'habit', title: 'Stretch',
      reminders: [{ id: 'r2', enabled: true, kind: 'weekly', time: '08:00', days: [true, true, true, true, true, true, true], lastFiredKey: '' }] };

    // A fixed "now" local to this sandbox only -- it must not leak into the
    // real global Date used by the rest of the suite (a vm.createContext
    // sandbox has its own Date, so this never touches node's global Date).
    const RealDate = Date;
    const fixedNow = new RealDate(2026, 8, 24, 9, 0);
    function FixedDate(...args) {
      if (args.length === 0) return new RealDate(fixedNow.getTime());
      return new RealDate(...args);
    }
    FixedDate.now = () => fixedNow.getTime();

    const sandbox = {
      Date: FixedDate,
      sessionStorage: {
        getItem: k => Object.prototype.hasOwnProperty.call(sessionStore, k) ? sessionStore[k] : null,
        setItem: (k, v) => { sessionStore[k] = String(v); }
      },
      Notification: Object.assign(function (title, opts) { notifications.push({ title: title, body: opts && opts.body }); }, { permission: 'granted' }),
      navigator: {},
      S: { prefs: { notificationsEnabled: true }, tasks: [dueHabit, missedHabit] },
      save: function () { saved++; },
      console
    };
    vm.createContext(sandbox);
    vm.runInContext(reminderHelpers + '\n' + nativeRemindersActiveSrc + '\n' + checkRemindersSrc, sandbox);
    return { sandbox, notifications, saved: () => saved, dueHabit, missedHabit };
  }

  const native = makeAppCtx(true);
  native.sandbox.checkReminders();
  // 2026-09-24: the phone's schedule can be stale, so the web fires both; the
  // Android DelegationService drops a slot the native alarm already showed.
  assert('nr-1: with native alarms active, due and missed both still fire', native.notifications.length === 2);
  assert('nr-2: missed slot is marked fired', native.missedHabit.reminders[0].lastFiredKey !== '');

  const plain = makeAppCtx(false);
  plain.sandbox.checkReminders();
  assert('nr-3: without native alarms, due and missed both fire', plain.notifications.length === 2);

  // ---- parseNativeRemindersParam() ----
  const sandbox2 = { URLSearchParams };
  vm.createContext(sandbox2);
  vm.runInContext(parseNativeRemindersParamSrc, sandbox2);

  const r1 = sandbox2.parseNativeRemindersParam('?nr=1&tab=habits');
  assert('nr-4: nr=1 with other params -> active true', r1.active === true);
  assert('nr-4: only nr is stripped, tab survives', r1.cleanedSearch === '?tab=habits');

  const r2 = sandbox2.parseNativeRemindersParam('?nr=1');
  assert('nr-5: nr=1 alone -> cleanedSearch is empty', r2.active === true && r2.cleanedSearch === '');

  const r3 = sandbox2.parseNativeRemindersParam('?tab=dailies');
  assert('nr-6: no nr param -> inactive, other params untouched', r3.active === false && r3.cleanedSearch === '?tab=dailies');

  const r4 = sandbox2.parseNativeRemindersParam('');
  assert('nr-7: empty search -> inactive, no crash', r4.active === false && r4.cleanedSearch === '');

  console.log(failures ? ('\nFAILED: ' + failures + ' assertion(s)') : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
});
