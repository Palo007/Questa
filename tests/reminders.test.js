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
  "return { normalizeTaskReminders, isReminderDue, getReminderNotificationPayload };"
);

const { normalizeTaskReminders, isReminderDue, getReminderNotificationPayload } = contextEval(mockGlobals);

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

if (failures > 0) {
  process.exit(1);
} else {
  console.log("All tests passed!");
  process.exit(0);
}