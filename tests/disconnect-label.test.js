// disconnect-label.test.js -- regression for the "Device <label>" text shown
// above the Disconnect button in Settings -> Sync.
//
// Requirement: that label must show the 6-char device ID of the device running
// the app, NEVER the friendly name the user typed into the "Device name" input
// box (which still drives the input value + event-log display).
//
// Run: node tests/disconnect-label.test.js   (also run by `node tests/run.js`)

const fs = require('fs'), path = require('path');

const appJsPath = path.join(__dirname, '../app.js');
const code = fs.readFileSync(appJsPath, 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// ---------------------------------------------------------------------------
// 1. Structural guards on app.js (the actual shipped source)
// ---------------------------------------------------------------------------
assert('disconnect label uses esc(devShort) (short device id)',
  /devDisconnectLbl">Device '\+esc\(devShort\)/.test(code));

assert('disconnect label does NOT use esc(myDevLabel) (user-entered name)',
  !/esc\(myDevLabel\)/.test(code));

assert('myDevLabel variable no longer defined',
  !/const myDevLabel=/.test(code));

// The friendly-name helper must remain wired into the event log, so we did not
// accidentally break cross-device name display when fixing the disconnect label.
// T7: now uses getCachedDeviceName which internally calls deviceDisplayName
assert('deviceDisplayName still used by the event log (via getCachedDeviceName)',
  /getCachedDeviceName\(e\.dev\)/.test(code));

// ---------------------------------------------------------------------------
// 2. Behavioral: render the real sync-panel block and inspect the label
// ---------------------------------------------------------------------------
// Extract the exact HTML-building block for the devNameWrap (the only place that
// emits devDisconnectLbl). It is executed with real `esc` + the variables the
// block references, so this is a faithful render of the shipped code.
const m = code.match(/h\+='<div class="devNameWrap">'([\s\S]*?)'<\/div>';/);
if (!m) {
  console.error('FAIL: could not extract sync-panel block from app.js');
  process.exit(1);
}
// Embed m[1] as RAW JS source (it contains the string-concatenation statements
// that reference esc/devShort/etc.) so it is actually evaluated, not appended
// as inert text.
const block = "var h=''; h+='<div class=\"devNameWrap\">'+\n" + m[1] + "\n+'</div>'; return h;";

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const devId = 'abcdef1234567890';
const devShort = devId.slice(0, 6);        // "abcdef"
const myDevName = 'My Friendly Phone';     // a user-entered device name
const scfg = { deviceId: devId, lastSyncAt: Date.now(), lastError: null };
const rel = 'just now';

let html;
try {
  const builder = new Function('esc', 'rel', 'scfg', 'devShort', 'myDevName', block);
  html = builder(esc, rel, scfg, devShort, myDevName);
} catch (e) {
  console.error('FAIL: error rendering sync-panel block:', e);
  process.exit(1);
}

const lblMatch = html.match(/<div class="devDisconnectLbl">([\s\S]*?)<\/div>/);
assert('disconnect label div is present in rendered HTML', !!lblMatch);

if (lblMatch) {
  const lblText = lblMatch[1]; // e.g. "Device abcdef"
  assert('disconnect label contains the short device id ("' + devShort + '")',
    lblText.includes(devShort));
  assert('disconnect label does NOT contain the user-entered name ("' + myDevName + '")',
    !lblText.includes(myDevName));
  // Sanity: the short id is the device id, not some unrelated string.
  assert('disconnect label equals "Device <shortId>"',
    lblText === 'Device ' + devShort);
}

// The friendly name must still be usable elsewhere (the input value), proving we
// only re-targeted the disconnect label, not the whole device-name feature.
assert('friendly name still shown in the Device name input value',
  html.includes('value="' + esc(myDevName) + '"'));

if (failures) {
  console.error(failures + ' disconnect-label assertion(s) FAILED');
  process.exit(1);
}
console.log('disconnect-label.test.js: all assertions passed');
process.exit(0);
