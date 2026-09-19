// plain-export-csv-md.test.js -- the CSV / Markdown export branch.
//
// These files are for OTHER apps (Excel, Sheets, Todoist, Asana, Obsidian).
// They are lossy and cannot be imported back, so the two things that can
// actually hurt the user are covered first:
//
//   C1  a title carrying a comma, a double quote and a newline stays in ONE
//       cell -- the classic silent column shift that moves every later field
//       one column left and is invisible until someone reads the sheet
//   C7  the plain branch never stamps lastExportTs: a CSV must not silence
//       the "back up your data" nag, because it can restore nothing
//   C8  the backup path is untouched -- no _EXPORT_FIELD_MAP code was added
//       or moved (older builds must keep importing newer backups, and
//       tools/join_exports.py depends on that map not moving)
//
// Run: node tests/plain-export-csv-md.test.js (also run by node tests/run.js)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

// --- sandbox ------------------------------------------------------------
// Anchor-based extraction (see tests/_extract.js) -- survives line shifts.
const parts = [
  extractLine(appSrc, /^const PLAIN_TASK_SECTIONS = /, 'PLAIN_TASK_SECTIONS'),
  extractLine(appSrc, /^const _PLAIN_DAY_NAMES = /, '_PLAIN_DAY_NAMES'),
  extractFunction(appSrc, /^function ioHasTaskSection\(keys\)\{/, 'ioHasTaskSection'),
  extractFunction(appSrc, /^function _fileStamp\(d\)\{/, '_fileStamp'),
  extractFunction(appSrc, /^function _csvCell\(v\)\{/, '_csvCell'),
  extractFunction(appSrc, /^function _tagNames\(ids\)\{/, '_tagNames'),
  extractFunction(appSrc, /^function _repeatText\(t\)\{/, '_repeatText'),
  extractFunction(appSrc, /^function _reminderText\(t\)\{/, '_reminderText'),
  extractFunction(appSrc, /^function _checklistText\(t\)\{/, '_checklistText'),
  extractFunction(appSrc, /^function _priorityOf\(t\)\{/, '_priorityOf'),
  extractFunction(appSrc, /^function _listLabel\(t\)\{/, '_listLabel'),
  extractFunction(appSrc, /^function _isoOrEmpty\(ms\)\{/, '_isoOrEmpty'),
  extractFunction(appSrc, /^function _mdEsc\(s\)\{/, '_mdEsc'),
  extractFunction(appSrc, /^function _tasksOfType\(list, ty\)\{/, '_tasksOfType'),
  extractFunction(appSrc, /^function buildTasksCsv\(src\)\{/, 'buildTasksCsv'),
  extractFunction(appSrc, /^function buildTasksMarkdown\(src\)\{/, 'buildTasksMarkdown'),
];
const headersLine = appSrc.slice(appSrc.indexOf('const _CSV_HEADERS'));
parts.splice(12, 0, headersLine.slice(0, headersLine.indexOf('];') + 2));

const sandbox = {
  S: { tags: [ {id:'tg1', name:'errand'}, {id:'tg2', name:'home'} ] },
  ioSectionByKey: k => ({ todos:{label:'To-dos'}, dailies:{label:'Dailies'}, habits:{label:'Habits'} }[k] || null),
  console,
};
vm.createContext(sandbox);
vm.runInContext(parts.join('\n'), sandbox);

// --- fixture ------------------------------------------------------------
const NASTY = 'Buy milk, "2%"\nand bread';
const src = { tasks: [
  { id:'t1', type:'todo', title:NASTY, notes:'line one\nline two', difficulty:'hard',
    done:false, tags:['tg1','tg2','gone'], checklist:[{text:'small',done:true},{text:'big',done:false}],
    createdAt: 1758240000000 },
  { id:'t2', type:'todo', title:'Done thing [x] `code`', difficulty:'easy', done:true,
    createdAt: 1758240000000, completedAt: 1758326400000, tags:[] },
  { id:'t3', type:'daily', title:'Stretch', difficulty:'medium', done:false, streak:4,
    repeat:[false,true,false,true,false,true,false], tags:[],
    reminders:[{kind:'daily', time:'07:30'}] },
]};

// --- CSV ----------------------------------------------------------------
const csv = sandbox.buildTasksCsv(src);
const lines = csv.split('\r\n');

assert('C0 header row lists all 14 columns',
  lines[0] === '"title","notes","type","status","list","priority","tags","repeat","reminder","checklist","streak","created","completed","id"');

// C1: parse the CSV back with a real RFC 4180 reader. Counting commas would
// not catch the bug this test exists for.
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i+1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i+1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const rows = parseCsv(csv);
assert('C1 round-trips to 1 header + 3 data rows', rows.length === 4);
assert('C1 a title with comma, quote and newline survives in ONE cell', rows[1][0] === NASTY);
assert('C1 the row still has 14 fields (no column shift)', rows[1].length === 14);
assert('C1 the id column is still the id', rows[1][13] === 't1');

assert('C2 status uses importer-friendly words',
  rows[1][3] === 'needs action' && rows[2][3] === 'completed');
assert('C3 difficulty maps to a 1..4 priority', rows[1][5] === '1' && rows[3][5] === '2');
assert('C4 tags export as NAMES, not uids', rows[1][6] === 'errand; home');
assert('C4 an unknown tag id is dropped, never leaked raw', rows[1][6].indexOf('gone') === -1);
assert('C5 repeat[] becomes weekday names', rows[3][7] === 'Mon,Wed,Fri');
assert('C5 a task with no repeat[] leaves the column empty', rows[1][7] === '');
assert('C6 reminders are readable', rows[3][8] === 'daily 07:30');
assert('C6 checklist keeps its done marks', rows[1][9] === '[x] small | [ ] big');
assert('C6 completed is ISO, and empty when not done',
  rows[1][12] === '' && /^\d{4}-\d{2}-\d{2}T/.test(rows[2][12]));

// --- Markdown -----------------------------------------------------------
const md = sandbox.buildTasksMarkdown(src);
assert('M1 sections are headed by their picker label',
  md.indexOf('## To-dos') !== -1 && md.indexOf('## Dailies') !== -1);
assert('M2 an open task renders an empty checkbox', md.indexOf('- [ ] Buy milk') !== -1);
assert('M2 a done task renders a ticked checkbox', md.indexOf('- [x] Done thing') !== -1);
assert('M3 a title containing [x] cannot fake a checkbox',
  md.indexOf('Done thing \\[x\\]') !== -1);
assert('M4 a multi-line title does not break out of its line',
  md.split(/\r\n/).filter(l => l.indexOf('Buy milk') !== -1).length === 1);
assert('M5 notes indent under the task', md.indexOf('  - line one') !== -1);
assert('M6 subtasks indent and keep their state', md.indexOf('  - [x] small') !== -1);
assert('M7 repeat and streak ride along', md.indexOf('Mon,Wed,Fri | streak 4') !== -1);

// --- gating -------------------------------------------------------------
assert('G1 task sections enable the plain formats',
  sandbox.ioHasTaskSection(['char','todos']) === true);
assert('G1 a non-task selection disables them',
  sandbox.ioHasTaskSection(['char','prefs','history']) === false);
assert('G2 empty state yields a header-only CSV',
  sandbox.buildTasksCsv({tasks:[]}).split('\r\n').filter(Boolean).length === 1);

// --- the promises made to the backup path -------------------------------
const runPlain = extractFunction(appSrc, /^function runPlainExport\(sectionKeys, fmt\)\{/, 'runPlainExport');
assert('C7 runPlainExport never stamps lastExportTs',
  runPlain.indexOf('lastExportTs') === -1);
assert('C7 runPlainExport declares itself not-a-backup',
  /isBackup:\s*false/.test(runPlain));
assert('C7 runPlainExport reads no events (no short-read path to get wrong)',
  runPlain.indexOf('getEvents') === -1 && runPlain.indexOf('countEvents') === -1);

const share = extractFunction(appSrc, /^async function exportShare\(blob, filename, eventCount, opts\) \{/, 'exportShare');
const saveDev = extractFunction(appSrc, /^function exportSaveDevice\(blob, filename, eventCount, opts\) \{/, 'exportSaveDevice');
assert('C7 Share clears the staleness nag only for a real backup',
  /if \(isBackup\) \{[\s\S]*lastExportTs/.test(share));
assert('C7 Save-to-device clears the staleness nag only for a real backup',
  /if \(isBackup\) \{[\s\S]*lastExportTs/.test(saveDev));

// C8: the field map is the cross-version contract. A new code here makes a
// new-build backup unimportable by an older build, and join_exports.py reads
// it too. The plain branch must never have touched it.
const fieldMap = appSrc.slice(appSrc.indexOf('const _EXPORT_FIELD_MAP'));
const fieldMapBody = fieldMap.slice(0, fieldMap.indexOf('};') + 2);
assert('C8 _EXPORT_FIELD_MAP carries no csv/md/plain code',
  !/csv|markdown|plain/i.test(fieldMapBody));
assert('C8 the plain builders never touch the field map or the hash',
  [extractFunction(appSrc, /^function buildTasksCsv\(src\)\{/, 'csv'),
   extractFunction(appSrc, /^function buildTasksMarkdown\(src\)\{/, 'md'),
   extractFunction(appSrc, /^function buildPlainExportFile\(src, fmt\)\{/, 'plain')]
    .every(fn => fn.indexOf('_EXPORT_FIELD_MAP') === -1 &&
                 fn.indexOf('computeHash') === -1 &&
                 fn.indexOf('_tokenize') === -1));

// The CSV BOM is load-bearing: without it Excel reads the file in the local
// ANSI code page and every accented title comes out mangled.
const plainFile = extractFunction(appSrc, /^function buildPlainExportFile\(src, fmt\)\{/, 'buildPlainExportFile');
assert('C9 the CSV is written with a UTF-8 BOM for Excel',
  plainFile.indexOf("'\\uFEFF'") !== -1);
assert('C9 filenames say "tasks", not "backup"',
  plainFile.indexOf("questa-tasks-") !== -1 && plainFile.indexOf('questa-backup') === -1);

if (failures) {
  console.error('\n' + failures + ' plain-export assertion(s) FAILED');
  process.exit(1);
}
console.log('\nALL PLAIN-EXPORT TESTS PASSED');
process.exit(0);
