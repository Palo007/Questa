// run.js -- one-command test runner for the whole project.
// Runs every *.test.js in tests/ and every *-tests.js in archive/tests/,
// aggregates PASS/FAIL, exits non-zero if any file fails.
//
//   node tests/run.js         (or: npm test)
//
// Run this at the end of every implementation touching app.js / sync.js.
const fs = require('fs'), path = require('path'), cp = require('child_process');

const root = __dirname; // .../tests
const searchDirs = [ root, path.join(root, '../archive/tests') ];
const isTest = f => (/\.test\.js$/.test(f) || /-tests\.js$/.test(f))
  && !f.startsWith('_') && f !== 'run.js' && !/probe/i.test(f) && !/_tmp/i.test(f);

let files = [];
for(const d of searchDirs){
  if(!fs.existsSync(d)) continue;
  for(const f of fs.readdirSync(d)) if(isTest(f)) files.push(path.join(d, f));
}
files.sort();

let pass = 0, fail = 0; const failed = [];
for(const f of files){
  const rel = path.relative(path.join(root,'..'), f);
  process.stdout.write('\n=== ' + rel + ' ===\n');
  try {
    const out = cp.execFileSync('node', [f], { encoding: 'utf8' });
    process.stdout.write(out);
    // 2026-09-19 (round 3, item 15): exit 0 used to BE the pass. A file whose
    // assertions had all been deleted, or which returned before reaching the
    // first one, was indistinguishable from a green run -- debug-pager.test.js
    // sat in this suite asserting nothing and was counted as a passing file.
    // Every test here prints evidence per assertion: tests/*.test.js use
    // "[PASS] ", the older archive/tests/*-tests.js use a bare "PASS " line.
    // Demand at least one. A new test that prints neither is a bug in that
    // test, not a reason to loosen this check.
    if(!/\[PASS\]|^PASS[ \t]/m.test(out)){
      process.stdout.write('\n[RUNNER] no assertions ran in ' + rel + ' -- exit 0 is not a pass\n');
      fail++; failed.push(rel + '  (no assertions ran)');
    } else {
      pass++;
    }
  } catch(e){
    process.stdout.write((e.stdout||'') + (e.stderr||''));
    fail++; failed.push(rel);
  }
}
console.log('\n================ SUITE SUMMARY ================');
console.log('test files: ' + files.length + '   passed: ' + pass + '   failed: ' + fail);
if(fail){ console.log('FAILED:\n  ' + failed.join('\n  ')); process.exit(1); }
console.log('ALL TEST FILES PASSED');
process.exit(0);
