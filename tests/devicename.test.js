const fs = require('fs');
const path = require('path');

// 1. Read app.js
const appJsPath = path.join(__dirname, '../app.js');
const code = fs.readFileSync(appJsPath, 'utf8');

// 2. Extract the device-name helper block
const match = code.match(/\/\* BEGIN_DEVICENAME_HELPERS \*\/([\s\S]*?)\/\* END_DEVICENAME_HELPERS \*\//);
if (!match) {
  console.error("FAIL: Could not find device-name helper block in app.js");
  process.exit(1);
}

// 3. Eval the helper in the local test scope — self-contained, no outside globals needed
const helperCode = match[1];
const contextEval = new Function(helperCode + "\nreturn { deviceDisplayName };");
const { deviceDisplayName } = contextEval();

let failures = 0;
function assert(desc, cond) {
  if (cond) {
    console.log("[PASS] " + desc);
  } else {
    console.error("[FAIL] " + desc);
    failures++;
  }
}

const devices = [
  { id: "d1", name: "Phone", updatedAt: 1000 },
  { id: "d2", name: "   ", updatedAt: 1000 },   // whitespace-only name
  { id: "d3", name: "", updatedAt: 1000 }        // explicitly cleared name
];

assert("named device returns its name", deviceDisplayName(devices, "d1") === "Phone");
assert("whitespace-only name falls back to truncated id", deviceDisplayName(devices, "d2") === "d2");
assert("empty-string name falls back to truncated id", deviceDisplayName(devices, "d3") === "d3");
assert("unknown device id falls back to truncated id", deviceDisplayName(devices, "unknownDevice123") === "unknow");
assert("no devId returns empty string", deviceDisplayName(devices, null) === "" && deviceDisplayName(devices, "") === "");
assert("empty devices array still falls back to truncated id", deviceDisplayName([], "k3j9x2abc") === "k3j9x2");
assert("undefined devices array still falls back to truncated id", deviceDisplayName(undefined, "k3j9x2abc") === "k3j9x2");

if (failures > 0) {
  console.error(failures + " test(s) failed.");
  process.exit(1);
} else {
  console.log("All tests passed!");
  process.exit(0);
}
