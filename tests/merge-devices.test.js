const fs = require('fs');
const path = require('path');

// Load sync.js into a sandbox and grab the device-merge helpers.
const src = fs.readFileSync(path.join(__dirname, '../sync.js'), 'utf8');
// Strip the boot gate (which calls syncInit() and touches window/DOM) plus any
// trailing bare syncInit(); so the module loads headless in Node.
const stripped = src
  .replace(/\/\* BEGIN_BOOT_GATE \*\/[\s\S]*?\/\* END_BOOT_GATE \*\//, '/* boot gate stripped for test */')
  .replace(/\nsyncInit\(\);\s*$/, '\n');
const get = new Function(stripped + '\nreturn { mergeDevices: (typeof mergeDevices!=="undefined")?mergeDevices:null, cleanDevices: (typeof cleanDevices!=="undefined")?cleanDevices:null };');
const { mergeDevices, cleanDevices } = get();
if (typeof mergeDevices !== 'function' || typeof cleanDevices !== 'function') {
  console.error('FAIL: mergeDevices/cleanDevices not found in sync.js');
  process.exit(1);
}

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

const real = { id: 'm1', name: 'localhost', updatedAt: 5000 };
const blank = { id: 'm1', name: '', updatedAt: 0 }; // junk placeholder
const blankRecent = { id: 'm1', name: '', updatedAt: 9000 }; // deliberate clear

// Fix 1: a stale blank (updatedAt:0) must NOT clobber a real name on the remote,
// even when the local side is unchanged (the reported revert scenario).
assert('remote blank (updatedAt:0) does not overwrite local real name',
  JSON.stringify(mergeDevices([real], [real], [blank])) === JSON.stringify([real]));
assert('local blank (updatedAt:0) does not overwrite remote real name',
  JSON.stringify(mergeDevices([real], [blank], [real])) === JSON.stringify([real]));

// A deliberate clear (updatedAt>0) propagates over an older real name.
assert('deliberate clear (newer, updatedAt>0) wins over older real name',
  JSON.stringify(mergeDevices([real], [blankRecent], [real])) === JSON.stringify([blankRecent]));

// Real name beats an equal-timestamp blank.
assert('real name beats equal-timestamp blank',
  JSON.stringify(mergeDevices([blank], [blank], [real])) === JSON.stringify([real]));

// Both real, remote newer -> remote wins.
assert('newer real name wins (remote)',
  JSON.stringify(mergeDevices([real], [real], [{ id: 'm1', name: 'Laptop', updatedAt: 9999 }]))
    === JSON.stringify([{ id: 'm1', name: 'Laptop', updatedAt: 9999 }]));

// cleanDevices strips junk placeholders and dedupes by id.
assert('cleanDevices drops junk placeholder',
  JSON.stringify(cleanDevices([real, blank])) === JSON.stringify([real]));
assert('cleanDevices dedupes keeping the real entry',
  JSON.stringify(cleanDevices([blank, real])) === JSON.stringify([real]));

if (failures > 0) { console.error(failures + ' test(s) failed.'); process.exit(1); }
console.log('All merge-devices tests passed!');
process.exit(0);
