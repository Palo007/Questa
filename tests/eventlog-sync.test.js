const fs = require('fs');
const path = require('path');

// 1. Read sync.js
const syncJsPath = path.join(__dirname, '../sync.js');
const code = fs.readFileSync(syncJsPath, 'utf8');

// 2. Extract the event-log-sync helper block
const match = code.match(/\/\* BEGIN_EVTSYNC_HELPERS \*\/([\s\S]*?)\/\* END_EVTSYNC_HELPERS \*\//);
if (!match) {
  console.error("FAIL: Could not find event-log-sync helper block in sync.js");
  process.exit(1);
}

// 3. Eval the helpers in the local test scope — self-contained, no outside globals needed
const helperCode = match[1];

const contextEval = new Function(
  helperCode + "\n" +
  "return { evtMonthKey, evtMonthRange, evtParseFileName, evtUploadable, evtOwnMonthRecords, evtIncomingFilter, evtMonthOlderThan };"
);

const { evtMonthKey, evtMonthRange, evtParseFileName, evtUploadable, evtOwnMonthRecords, evtIncomingFilter, evtMonthOlderThan } = contextEval();

let failures = 0;
function assert(desc, cond) {
  if (cond) {
    console.log("[PASS] " + desc);
  } else {
    console.error("[FAIL] " + desc);
    failures++;
  }
}

// Test 1: evtMonthKey UTC boundary
{
  assert("evtMonthKey(Jul 1 2026 UTC) === 202607", evtMonthKey(Date.UTC(2026, 6, 1)) === "202607");
  assert("evtMonthKey(Jul 1 2026 UTC - 1ms) === 202606", evtMonthKey(Date.UTC(2026, 6, 1) - 1) === "202606");
}

// Test 2: evtMonthRange round-trips
{
  const r = evtMonthRange("202602");
  assert("evtMonthRange from -> evtMonthKey round-trips to 202602", evtMonthKey(r.from) === "202602");
  assert("evtMonthRange to -> evtMonthKey round-trips to 202602", evtMonthKey(r.to) === "202602");
  const march1 = new Date(r.to + 1);
  assert("evtMonthRange.to + 1 is March 1 UTC", march1.getUTCMonth() === 2 && march1.getUTCDate() === 1);
}

// Test 3: evtParseFileName
{
  const a = evtParseFileName("k3j9x2abc-202607.json");
  assert("evtParseFileName standard dev id", a && a.dev === "k3j9x2abc" && a.month === "202607");

  const b = evtParseFileName("a-1-202607.json");
  assert("evtParseFileName dev id containing a hyphen", b && b.dev === "a-1" && b.month === "202607");

  assert("evtParseFileName('state.json') === null", evtParseFileName("state.json") === null);
  assert("evtParseFileName('x-202607.txt') === null", evtParseFileName("x-202607.txt") === null);
}

// Test 4: evtUploadable
{
  const since = 1000;
  const events = [
    { uid: "d1-a", dev: "d1", ts: 2000, kind: "tap" },                          // valid, keep
    { uid: "d1-b", dev: "d1", ts: 2000, kind: "tap", synthetic: true },         // synthetic -> drop
    { uid: "d2-c", dev: "d2", ts: 2000, kind: "tap" },                          // other-dev -> drop
    { dev: "d1", ts: 2000, kind: "tap" },                                      // missing uid -> drop
    { uid: "d1-e", dev: "d1", ts: "2000", kind: "tap" },                        // non-numeric ts -> drop
    { uid: "d1-f", dev: "d1", ts: 500, kind: "tap" }                            // ts <= since -> drop
  ];
  const result = evtUploadable(events, "d1", since);
  assert("evtUploadable keeps exactly the one valid record", result.length === 1 && result[0].uid === "d1-a");
}

// Test 5: evtIncomingFilter
{
  const myDev = "me";
  const now = 1000000000;
  const ageLimit = 18 * 30 * 86400000;
  const existing = new Set(["already-1"]);
  const records = [
    { uid: "keep-1", dev: "other", ts: now - 1000, kind: "tap", id: 42 },       // valid, keep, id stripped
    { uid: "own-1", dev: myDev, ts: now - 1000, kind: "tap" },                  // own-dev -> drop
    { uid: "syn-1", dev: "other", ts: now - 1000, kind: "tap", synthetic: true }, // synthetic -> drop
    { dev: "other", ts: now - 1000, kind: "tap" },                              // no uid -> drop
    { uid: "old-1", dev: "other", ts: now - ageLimit - 1000, kind: "tap" },     // older than limit -> drop
    { uid: "already-1", dev: "other", ts: now - 1000, kind: "tap" },            // already present -> drop
    { uid: "dup-1", dev: "other", ts: now - 1000, kind: "tap" },                // dup within batch -> keep once
    { uid: "dup-1", dev: "other", ts: now - 900, kind: "tap" }                  // dup of dup-1 -> dropped
  ];
  const result = evtIncomingFilter(records, existing, myDev, now, ageLimit);
  const uids = result.map(r => r.uid).sort();
  assert("evtIncomingFilter keeps keep-1 and dup-1 only", JSON.stringify(uids) === JSON.stringify(["dup-1", "keep-1"]));
  const keep1 = result.find(r => r.uid === "keep-1");
  assert("evtIncomingFilter strips id from kept record", keep1 && !("id" in keep1));
}

// Test 6: evtMonthOlderThan
{
  const ageLimit = 18 * 30 * 86400000;
  const now = Date.UTC(2026, 6, 10); // 2026-07-10
  const monthKey24AgoDate = new Date(now);
  monthKey24AgoDate.setUTCMonth(monthKey24AgoDate.getUTCMonth() - 24);
  const monthKey24Ago = evtMonthKey(monthKey24AgoDate.getTime());
  assert("evtMonthOlderThan: 24 months ago is older than the limit", evtMonthOlderThan(monthKey24Ago, now, ageLimit) === true);

  const lastMonthDate = new Date(now);
  lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonthKey = evtMonthKey(lastMonthDate.getTime());
  assert("evtMonthOlderThan: last month is NOT older than the limit", evtMonthOlderThan(lastMonthKey, now, ageLimit) === false);
}

if (failures > 0) {
  console.error(failures + " test(s) failed.");
  process.exit(1);
} else {
  console.log("All tests passed!");
  process.exit(0);
}
