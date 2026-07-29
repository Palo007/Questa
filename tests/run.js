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
    process.stdout.write(cp.execFileSync('node', [f], { encoding: 'utf8' }));
    pass++;
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
