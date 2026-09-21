const fs = require('fs');
const path = require('path');

// 1. Read app.js
const appJsPath = path.join(__dirname, '../app.js');
const code = fs.readFileSync(appJsPath, 'utf8');

// 2. Extract the reminder logic block
const match = code.match(/\/\* BEGIN_REMINDER_HELPERS \*\/([\s\S]*?)\/\* END_REMINDER_HELPERS \*\//);
if (!match) {
  console.error("FAIL: Could not find reminder helper block in app.js");
  process.exit(1);
}

// 3. Eval the helpers in the local test scope
const helperCode = match[1];

let mockGlobals = {
  dayStamp: function(d) { return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
};

// Create a context or evaluate in the test context
const contextEval = new Function('globals', 
  "const dayStamp = globals.dayStamp;\n" +
  helperCode + "\n" +
  "return { normalizeTaskReminders, isReminderDue, isReminderMissed, getReminderNotificationPayload };"
);

const { normalizeTaskReminders, isReminderDue, isReminderMissed, getReminderNotificationPayload } = contextEval(mockGlobals);

// Now write the assertions
let failures = 0;
function assert(desc, cond) {
  if (cond) {
    console.log("[PASS] " + desc);
  } else {
    console.error("[FAIL] " + desc);
    failures++;
  }
}

// Test 1: legacy tasks normalize to reminders: []
{
  const t = { id: "1", type: "todo", title: "Legacy" };
  normalizeTaskReminders(t);
  assert("legacy task normalization", Array.isArray(t.reminders) && t.reminders.length === 0);
}

// Test 2: daily reminders use daily repeat days
{
  const t = {
    id: "2",
    type: "daily",
    repeat: [false, true, false, false, false, false, false], // only Monday
    reminders: [{
      id: "r1",
      enabled: true,
      kind: "daily",
      time: "09:00",
      lastFiredKey: ""
    }]
  };
  
  // A Sunday (getDay() = 0)
  const sunday = new Date(2026, 6, 5, 9, 0); // July 5, 2026 is Sunday
  assert("daily reminder not due on Sunday", isReminderDue(t, t.reminders[0], sunday) === false);
  
  // A Monday (getDay() = 1)
  const monday = new Date(2026, 6, 6, 9, 0); // July 6, 2026 is Monday
  assert("daily reminder due on Monday", isReminderDue(t, t.reminders[0], monday) === true);
}

// Test 3: completed to-dos do not fire
{
  const t = {
    id: "3",
    type: "todo",
    done: true,
    reminders: [{
      id: "r2",
      enabled: true,
      kind: "once",
      date: "2026-07-09",
      time: "09:00",
      lastFiredKey: ""
    }]
  };
  const now = new Date(2026, 6, 9, 9, 0); // July 9, 2026 is Thursday
  assert("completed to-do reminder does not fire", isReminderDue(t, t.reminders[0], now) === false);
}

// Test 4: a due reminder fires once per day/time key
{
  const t = {
    id: "4",
    type: "habit",
    reminders: [{
      id: "r3",
      enabled: true,
      kind: "weekly",
      days: [true, true, true, true, true, true, true],
      time: "09:00",
      lastFiredKey: ""
    }]
  };
  const now = new Date(2026, 6, 9, 9, 0);
  
  // Should be due initially
  assert("reminder due initially", isReminderDue(t, t.reminders[0], now) === true);
  
  // Simulate firing: set lastFiredKey
  t.reminders[0].lastFiredKey = "20260709-09:00";
  
  // Should NOT be due anymore at the same date/time
  assert("reminder not due after firing (same time)", isReminderDue(t, t.reminders[0], now) === false);
  
  // Should still be due if date changes
  const tomorrow = new Date(2026, 6, 10, 9, 0);
  assert("reminder due on next day", isReminderDue(t, t.reminders[0], tomorrow) === true);
}

// --- Missed reminders: a PWA cannot fire while closed, so a passed slot is
// --- reported late, once, on the next open of the same day.
{
  const mkDaily = () => ({
    id: 'tm1', type: 'daily', title: 'Stretch',
    repeat: [true,true,true,true,true,true,true],
    reminders: [{ id: 'rm1', enabled: true, kind: 'daily', time: '09:00',
                  days: [true,true,true,true,true,true,true], lastFiredKey: '' }]
  });

  const t = mkDaily();
  const r = t.reminders[0];

  const before  = new Date(2026, 6, 9, 8, 0);   // 08:00, slot not reached
  const exact   = new Date(2026, 6, 9, 9, 0);   // 09:00, the slot itself
  const after   = new Date(2026, 6, 9, 11, 0);  // 11:00, slot passed unfired

  assert("M1 not missed before the slot", isReminderMissed(t, r, before) === false);
  assert("M2 not missed at the exact slot (that is 'due')", isReminderMissed(t, r, exact) === false);
  assert("M3 due at the exact slot", isReminderDue(t, r, exact) === true);
  assert("M4 missed once the slot has passed", isReminderMissed(t, r, after) === true);
  assert("M5 a missed slot is not also 'due'", isReminderDue(t, r, after) === false);

  // Firing it clears the missed state for that day only.
  r.lastFiredKey = '20260709-09:00';
  assert("M6 not missed after it fired", isReminderMissed(t, r, after) === false);
  const nextDay = new Date(2026, 6, 10, 11, 0);
  assert("M7 missed again the next day", isReminderMissed(t, r, nextDay) === true);

  // A completed to-do must stay quiet.
  const todo = { id: 'tm2', type: 'todo', title: 'Pay bill', done: true,
    reminders: [{ id: 'rm2', enabled: true, kind: 'once', time: '09:00',
                  date: '2026-07-09', lastFiredKey: '' }] };
  assert("M8 done to-do is never missed", isReminderMissed(todo, todo.reminders[0], after) === false);
  todo.done = false;
  assert("M9 open to-do dated today is missed", isReminderMissed(todo, todo.reminders[0], after) === true);

  // A stale one-off from an earlier day must not fire late.
  todo.reminders[0].date = '2026-07-08';
  assert("M10 one-off from a previous day is not missed", isReminderMissed(todo, todo.reminders[0], after) === false);

  // A weekly reminder switched off for today stays quiet.
  const weekly = { id: 'tm3', type: 'habit', title: 'Gym',
    reminders: [{ id: 'rm3', enabled: true, kind: 'weekly', time: '09:00',
                  days: [false,false,false,false,true,false,false], lastFiredKey: '' }] };
  // 2026-07-09 is a Thursday (day 4), so day 4 true = active today.
  assert("M11 weekly active today is missed", isReminderMissed(weekly, weekly.reminders[0], after) === true);
  weekly.reminders[0].days = [false,false,false,false,false,false,false];
  assert("M12 weekly inactive today is not missed", isReminderMissed(weekly, weekly.reminders[0], after) === false);

  // A disabled reminder never fires.
  const off = mkDaily();
  off.reminders[0].enabled = false;
  assert("M13 disabled reminder is not missed", isReminderMissed(off, off.reminders[0], after) === false);

  // The payload says it is late, and the old 2-arg call is unchanged.
  const late = getReminderNotificationPayload(t, r, true);
  const onTime = getReminderNotificationPayload(t, r);
  assert("M14 late payload is marked", late.body.indexOf('Missed at 09:00') === 0);
  assert("M15 on-time payload is unmarked", onTime.body.indexOf('Missed at') === -1);
  assert("M16 late payload keeps the same tag", late.tag === onTime.tag);
}

if (failures > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
  process.exit(0);
}