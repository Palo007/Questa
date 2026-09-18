// granular-export-import.test.js -- the section registry that drives granular
// export and import (app.js BEGIN_GRANULAR_IO_HELPERS block).
//
// The feature: the user ticks which parts of their data go INTO a backup file,
// and which parts come back OUT of one. The two dangerous properties, and what
// guards them here:
//
//   G1  the registry describes live state correctly (counts + pick())
//   G2  a full selection is byte-shape identical to the historic full backup --
//       no `partial` flag, nothing omitted, nothing renamed
//   G3  a partial selection OMITS unselected keys entirely. Writing `rewards: []`
//       instead would read back on import as "replace my rewards with none",
//       i.e. silent deletion. Absence is the only safe encoding for "not stated".
//   G4  detection works on a legacy schema-1 file that has no _backup.sections
//       manifest, so old backups are granularly importable too
//   G5  Replace leaves unticked sections byte-identical
//   G6  Merge keeps local-only records and lets a strictly-newer incoming record win
//   G7  a tie on missing timestamps keeps LOCAL. This is the merge-polarity rule:
//       an absent timestamp means "unknown", and unknown must never resolve to
//       "drop the local copy". Treating a missing stamp as 0-and-therefore-loses
//       is how a merge destroys data instead of losing a tiebreak.
//   G8  neither mode can shrink a list, and the events section never removes
//
// Run: node tests/granular-export-import.test.js  (also run by node tests/run.js)
const fs = require('fs'), path = require('path'), vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

// Marker-block slice: this block is pure logic with no DOM and no IndexedDB, so
// it loads into a bare sandbox as-is. Keep it that way -- the dialogs that drive
// it live OUTSIDE the markers on purpose.
function markerBlock(name) {
  const open = '/* BEGIN_' + name + ' */', close = '/* END_' + name + ' */';
  const a = appSrc.indexOf(open), b = appSrc.indexOf(close);
  if (a < 0 || b < 0) {
    console.error('FAIL: ' + name + ' markers missing from app.js');
    process.exit(1);
  }
  return appSrc.slice(a, b + close.length);
}

const sandbox = { console: console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(markerBlock('GRANULAR_IO_HELPERS'), sandbox); }
catch (e) { console.error('FAIL: helper block threw during eval:', e); process.exit(1); }

// `const IO_SECTIONS = ...` is a LEXICAL declaration, so it never lands on the
// sandbox object the way a `function` declaration does. Evaluate the names in the
// context to get at both kinds uniformly.
const [
  IO_SECTIONS, ioSectionByKey, ioAllSectionKeys, ioIsFullSelection,
  sliceStateForExport, detectExportSections, countExportSection, applySectionsToState
] = vm.runInContext(
  '[IO_SECTIONS, ioSectionByKey, ioAllSectionKeys, ioIsFullSelection,' +
  ' sliceStateForExport, detectExportSections, countExportSection, applySectionsToState]',
  sandbox);

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}

function fixtureState() {
  return {
    version: 1,
    char: { name: 'Hero', lvl: 7, gold: 120 },
    tasks: [
      { id: 'h1', type: 'habit', title: 'Water', createdAt: 100 },
      { id: 'h2', type: 'habit', title: 'Stretch', createdAt: 110 },
      { id: 'd1', type: 'daily', title: 'Journal', createdAt: 200 },
      { id: 'o1', type: 'todo', title: 'Taxes', createdAt: 300 },
      { id: 'o2', type: 'todo', title: 'Call bank', createdAt: 310 },
      { id: 'o3', type: 'todo', title: 'Fix bike', createdAt: 320 }
    ],
    rewards: [{ id: 'r1', title: 'Coffee', cost: 10, createdAt: 400 }],
    tags: [{ id: 'g1', name: 'home' }],
    devices: [{ id: 'dev-a', name: 'Phone' }],
    deletions: [{ id: 'x1', ts: 500 }],
    history: [{ day: '2026-09-01', xp: 10 }],
    charHistory: [{ ts: 600, lvl: 6 }],
    monthlyBackups: [{ month: '2026-08' }],
    lastCron: '2026-09-18',
    prefs: { width: 480, haptics: true }
  };
}

// -------------------------------------------------------------------------
// G1: the registry describes live state correctly.
// -------------------------------------------------------------------------
{
  const S = fixtureState();
  assert('G1a every section key is unique',
    new Set(ioAllSectionKeys()).size === IO_SECTIONS.length);
  assert('G1b the ten expected sections are registered',
    ioAllSectionKeys().join(',') === 'char,habits,dailies,todos,rewards,tags,prefs,history,devices,events');
  assert('G1c habits counts only type==="habit"', ioSectionByKey('habits').count(S) === 2);
  assert('G1d dailies counts only type==="daily"', ioSectionByKey('dailies').count(S) === 1);
  assert('G1e todos counts only type==="todo"', ioSectionByKey('todos').count(S) === 3);
  assert('G1f rewards counts the rewards array', ioSectionByKey('rewards').count(S) === 1);
  assert('G1g history sums history+charHistory+monthlyBackups', ioSectionByKey('history').count(S) === 3);
  assert('G1h devices sums devices+deletions', ioSectionByKey('devices').count(S) === 2);
  assert('G1i the three task counts partition S.tasks exactly',
    ioSectionByKey('habits').count(S) + ioSectionByKey('dailies').count(S) + ioSectionByKey('todos').count(S) === S.tasks.length);
}

// -------------------------------------------------------------------------
// G2: a full selection is recognised as full.
// -------------------------------------------------------------------------
{
  assert('G2a every key ticked is a full selection', ioIsFullSelection(ioAllSectionKeys()) === true);
  assert('G2b one key missing is NOT a full selection',
    ioIsFullSelection(ioAllSectionKeys().filter(function (k) { return k !== 'tags'; })) === false);
  assert('G2c an empty selection is not full', ioIsFullSelection([]) === false);
}

// -------------------------------------------------------------------------
// G3: a partial slice OMITS unselected keys. This is the single most important
// assertion in the file: an omitted key is "not stated", an empty array is
// "delete them all", and the two must never be confused.
// -------------------------------------------------------------------------
{
  const S = fixtureState();
  const slice = sliceStateForExport(S, ['todos', 'rewards']);
  assert('G3a the slice carries the selected tasks', Array.isArray(slice.tasks) && slice.tasks.length === 3);
  assert('G3b ...and only the todo ones',
    slice.tasks.every(function (t) { return t.type === 'todo'; }));
  assert('G3c the slice carries rewards', Array.isArray(slice.rewards) && slice.rewards.length === 1);
  assert('G3d `char` is ABSENT, not empty', !('char' in slice));
  assert('G3e `tags` is ABSENT, not an empty array', !('tags' in slice));
  assert('G3f `prefs` is ABSENT', !('prefs' in slice));
  assert('G3g `devices` and `deletions` are ABSENT', !('devices' in slice) && !('deletions' in slice));
  assert('G3h `history` keys are ABSENT',
    !('history' in slice) && !('charHistory' in slice) && !('monthlyBackups' in slice));
  assert('G3i `version` always rides along as the schema marker', slice.version === 1);

  // The three task sections all write the same `tasks` key; the slicer must
  // concatenate them rather than let the last one win.
  const both = sliceStateForExport(S, ['habits', 'todos']);
  assert('G3j two task sections CONCATENATE into one tasks array', both.tasks.length === 5);
  assert('G3k ...and no daily leaked in',
    both.tasks.every(function (t) { return t.type === 'habit' || t.type === 'todo'; }));

  const full = sliceStateForExport(S, ioAllSectionKeys());
  assert('G3l a full slice still contains every task', full.tasks.length === 6);
  assert('G3m ...and every other top-level section',
    !!full.char && !!full.rewards && !!full.tags && !!full.prefs && !!full.devices && !!full.history);
}

// -------------------------------------------------------------------------
// G4: detection. A legacy schema-1 file carries no manifest, so detection must
// infer from the payload -- otherwise every backup written before today would be
// all-or-nothing forever.
// -------------------------------------------------------------------------
{
  const legacyFull = fixtureState();
  legacyFull.events = [{ uid: 'e1', ts: 1 }];
  const det = detectExportSections(legacyFull);
  assert('G4a a legacy full file offers every section',
    det.join(',') === ioAllSectionKeys().join(','));

  // A full backup holding ZERO habits must still offer the Habits box, so the
  // user can legitimately Replace their habits with none. That is why has() keys
  // off the presence of the `tasks` array, not off a non-zero count.
  const noHabits = fixtureState();
  noHabits.tasks = noHabits.tasks.filter(function (t) { return t.type !== 'habit'; });
  assert('G4b a file with a tasks array but zero habits still offers Habits',
    detectExportSections(noHabits).indexOf('habits') !== -1);
  assert('G4c ...and the count shown is 0, not a lie', countExportSection('habits', noHabits) === 0);

  const eventsOnly = { events: [{ uid: 'e1', ts: 1 }, { uid: 'e2', ts: 2 }] };
  assert('G4d an events-only file offers exactly the Event log',
    detectExportSections(eventsOnly).join(',') === 'events');
  assert('G4e ...with the right count', countExportSection('events', eventsOnly) === 2);

  // A manifest is authoritative: it is the only way to express "I deliberately
  // exported an empty section".
  const manifested = { _backup: { partial: true, sections: ['todos', 'rewards'] }, tasks: [], rewards: [] };
  assert('G4f a manifest is trusted over payload inspection',
    detectExportSections(manifested).join(',') === 'todos,rewards');

  assert('G4g a non-Questa object detects nothing', detectExportSections({ hello: 1 }).length === 0);
  assert('G4h null detects nothing', detectExportSections(null).length === 0);
}

// -------------------------------------------------------------------------
// G5: Replace swaps the ticked sections and leaves the rest byte-identical.
// -------------------------------------------------------------------------
{
  const S = fixtureState();
  const beforeChar = JSON.stringify(S.char);
  const beforeTags = JSON.stringify(S.tags);
  const beforeRewards = JSON.stringify(S.rewards);
  const beforeHabits = JSON.stringify(S.tasks.filter(function (t) { return t.type === 'habit'; }));

  const file = { tasks: [{ id: 'oNEW', type: 'todo', title: 'Only this', createdAt: 999 }] };
  applySectionsToState(S, file, ['todos'], 'replace');

  assert('G5a the todos were replaced wholesale',
    S.tasks.filter(function (t) { return t.type === 'todo'; }).length === 1);
  assert('G5b ...with the file\'s copy',
    S.tasks.filter(function (t) { return t.type === 'todo'; })[0].id === 'oNEW');
  assert('G5c habits are byte-identical',
    JSON.stringify(S.tasks.filter(function (t) { return t.type === 'habit'; })) === beforeHabits);
  assert('G5d the daily survived', S.tasks.filter(function (t) { return t.type === 'daily'; }).length === 1);
  assert('G5e char is byte-identical', JSON.stringify(S.char) === beforeChar);
  assert('G5f tags are byte-identical', JSON.stringify(S.tags) === beforeTags);
  assert('G5g rewards are byte-identical', JSON.stringify(S.rewards) === beforeRewards);

  // A section present in the FILE but not ticked must be ignored completely.
  const S2 = fixtureState();
  const beforeChar2 = JSON.stringify(S2.char);
  applySectionsToState(S2, { char: { name: 'Impostor', lvl: 99 }, rewards: [] }, ['rewards'], 'replace');
  assert('G5h an unticked section in the file is ignored', JSON.stringify(S2.char) === beforeChar2);
  assert('G5i ...while the ticked one still applied', S2.rewards.length === 0);
}

// -------------------------------------------------------------------------
// G6/G7/G8: Merge. Nothing is ever removed; strictly-newer wins; a tie or an
// unknown timestamp keeps LOCAL.
// -------------------------------------------------------------------------
{
  const S = fixtureState();
  S.tasks.push({ id: 'oLOCAL', type: 'todo', title: 'Local only', createdAt: 1, updatedAt: 50 });
  const file = {
    tasks: [
      { id: 'oFILE', type: 'todo', title: 'File only', createdAt: 2, updatedAt: 60 },
      { id: 'o1', type: 'todo', title: 'Taxes NEWER', createdAt: 300, updatedAt: 9000 },
      { id: 'o2', type: 'todo', title: 'Call bank OLDER', createdAt: 310, updatedAt: 1 }
    ]
  };
  const beforeCount = S.tasks.filter(function (t) { return t.type === 'todo'; }).length;
  applySectionsToState(S, file, ['todos'], 'merge');
  const todos = S.tasks.filter(function (t) { return t.type === 'todo'; });
  const byId = {}; todos.forEach(function (t) { byId[t.id] = t; });

  assert('G6a the local-only record survived a merge', !!byId.oLOCAL);
  assert('G6b the file-only record was added', !!byId.oFILE);
  assert('G6c a strictly-newer incoming record wins', byId.o1.title === 'Taxes NEWER');
  assert('G6d a strictly-older incoming record loses', byId.o2.title === 'Call bank');
  assert('G6e merge never shrinks the list', todos.length === beforeCount + 1);
  assert('G6f other task types were untouched by a todos merge',
    S.tasks.filter(function (t) { return t.type === 'habit'; }).length === 2);

  // G7: the polarity rule. Neither side carries a usable stamp, so the scores tie
  // at 0 and LOCAL must be kept. If this ever flips to "incoming wins on a tie",
  // every unstamped legacy record in a file silently overwrites the live one.
  const S3 = { tasks: [{ id: 'z1', type: 'todo', title: 'LOCAL' }] };
  applySectionsToState(S3, { tasks: [{ id: 'z1', type: 'todo', title: 'FILE' }] }, ['todos'], 'merge');
  assert('G7a an unstamped tie keeps LOCAL', S3.tasks[0].title === 'LOCAL');

  const S4 = { tasks: [{ id: 'z1', type: 'todo', title: 'LOCAL', updatedAt: 500 }] };
  applySectionsToState(S4, { tasks: [{ id: 'z1', type: 'todo', title: 'FILE' }] }, ['todos'], 'merge');
  assert('G7b an UNSTAMPED incoming record cannot evict a stamped local one', S4.tasks[0].title === 'LOCAL');

  const S5 = { tasks: [{ id: 'z1', type: 'todo', title: 'LOCAL', updatedAt: 500 }] };
  applySectionsToState(S5, { tasks: [{ id: 'z1', type: 'todo', title: 'FILE', updatedAt: 500 }] }, ['todos'], 'merge');
  assert('G7c an equal stamp keeps LOCAL (tie goes to the device)', S5.tasks[0].title === 'LOCAL');

  // createdAt is used when updatedAt is absent, so a record that was created
  // later still wins -- "unknown" must not be confused with "old".
  const S6 = { tasks: [{ id: 'z1', type: 'todo', title: 'LOCAL', createdAt: 100 }] };
  applySectionsToState(S6, { tasks: [{ id: 'z1', type: 'todo', title: 'FILE', createdAt: 200 }] }, ['todos'], 'merge');
  assert('G7d createdAt is the fallback recency signal', S6.tasks[0].title === 'FILE');
}

// -------------------------------------------------------------------------
// G8: object sections, tombstones, and the events guarantee.
// -------------------------------------------------------------------------
{
  // Merge on an object section: LOCAL wins per field, the file only fills gaps.
  const S = { char: { name: 'Hero', lvl: 7 } };
  applySectionsToState(S, { char: { name: 'Impostor', lvl: 1, gold: 55 } }, ['char'], 'merge');
  assert('G8a merge keeps the local field value', S.char.name === 'Hero' && S.char.lvl === 7);
  assert('G8b ...and fills a field the local object lacked', S.char.gold === 55);

  const S2 = { char: { name: 'Hero', lvl: 7 } };
  applySectionsToState(S2, { char: { name: 'Impostor', lvl: 1 } }, ['char'], 'replace');
  assert('G8c replace swaps the object wholesale', S2.char.name === 'Impostor' && S2.char.gold === undefined);

  // Tombstones are never merged away, even under Replace: dropping a deletion
  // record resurrects a task the user deliberately deleted.
  const S3 = { devices: [{ id: 'dev-a' }], deletions: [{ id: 'gone-1', ts: 10 }] };
  applySectionsToState(S3, { devices: [{ id: 'dev-b' }], deletions: [{ id: 'gone-2', ts: 20 }] }, ['devices'], 'replace');
  assert('G8d replace swaps the device list', S3.devices.length === 1 && S3.devices[0].id === 'dev-b');
  assert('G8e ...but deletions are unioned, never dropped', S3.deletions.length === 2);

  // The events section owns no snapshot keys and its apply() is inert: events are
  // written only by the async union-add path in applyImportSections(), which can
  // add but never remove.
  assert('G8f the events section contributes nothing to the snapshot',
    Object.keys(ioSectionByKey('events').pick({ events: [1, 2, 3] })).length === 0);
  const S4 = { events: [{ uid: 'keep' }] };
  applySectionsToState(S4, { events: [] }, ['events'], 'replace');
  assert('G8g applying an EMPTY events section removes nothing', S4.events.length === 1);

  // No section's apply() may be reachable when the file does not carry it.
  const S5 = fixtureState();
  const before = JSON.stringify(S5);
  applySectionsToState(S5, {}, ioAllSectionKeys(), 'replace');
  assert('G8h ticking every box against an EMPTY file changes nothing',
    JSON.stringify(S5) === before);
}

// -------------------------------------------------------------------------
// Source guard: the export builder must tokenize the SLICE, not live state.
// Tokenizing S while hashing the slice produced a file that failed its own
// integrity gate on import -- a silent "corrupted or tampered with" refusal.
// -------------------------------------------------------------------------
{
  const buildSrc = appSrc.slice(appSrc.indexOf('async function buildBackupFile('));
  const body = buildSrc.slice(0, buildSrc.indexOf('function showExportChooser('))
    .split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
  assert('GXa buildBackupFile tokenizes the slice, not S', /_tokenizeSnapshot\(src\)/.test(body));
  assert('GXb ...and tokenizes the events it actually wrote', /_tokenizeEvents\(evts\)/.test(body));
  assert('GXc a partial file is flagged and carries its manifest',
    /_backup\.partial\s*=\s*true/.test(body) && /_backup\.sections\s*=\s*keys/.test(body));
  assert('GXd a partial file gets its own filename prefix', /questa-partial-/.test(body));
}

// -------------------------------------------------------------------------
// GR: full round trip on a PARTIAL file. This is the failure the user would
// actually meet: a partial export that cannot be imported because it fails its
// own integrity hash. The hash is computed over the DETOKENIZED legacy-shaped
// object, while the file on disk is the TOKENIZED envelope, so the two have to
// be built from the same source. Hashing the slice while tokenizing live state
// produces a file that verifies as "corrupted or tampered with" every time.
// -------------------------------------------------------------------------
async function roundTrip() {
  const a = appSrc.indexOf('const _EXPORT_FIELD_MAP = {');
  const b = appSrc.indexOf('function showExportChooser(');
  if (a < 0 || b < 0) { console.error('FAIL: export pipeline slice anchors missing'); process.exit(1); }

  const captured = {};
  const ctx = {
    console: console,
    APP_VERSION: 'vTEST',
    S: fixtureState(),
    Date: Date,
    JSON: JSON,
    Blob: function (parts) { captured.json = parts.join(''); },
    // Stand-in for the real SubtleCrypto digest: only determinism and
    // collision-resistance-in-practice matter to the gate under test.
    computeHash: function (str) {
      let h = 5381;
      for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
      return Promise.resolve(h.toString(16));
    }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(appSrc.slice(a, b), ctx); }
  catch (e) { console.error('FAIL: export pipeline threw during eval:', e); process.exit(1); }

  const events = [
    { uid: 'e1', dev: 'd1', ts: 1000, kind: 'tap', taskId: 'o1', dir: 1, reps: 0, source: 'ui' },
    { uid: 'e2', dev: 'd1', ts: 2000, kind: 'complete', taskId: 'o2', dir: 1, reps: 0, source: null }
  ];

  // --- partial: To-dos + Rewards, no events -------------------------------
  const res = await vm.runInContext('buildBackupFile', ctx)(events, ['todos', 'rewards']);
  assert('GRa a partial export is named questa-partial-*', /^questa-partial-\d{8}-\d{4}\.json$/.test(res.filename));
  assert('GRb ...and reports itself as partial', res.partial === true);
  assert('GRc ...and an unticked Event log means zero events written', res.eventCount === 0);

  const parsed = JSON.parse(captured.json);
  assert('GRd the envelope is schema 2', parsed._backup.schema === 2);
  assert('GRe ...flagged partial', parsed._backup.partial === true);
  assert('GRf ...and carries the section manifest',
    parsed._backup.sections.join(',') === 'todos,rewards');
  assert('GRg _backup.items describes the SLICE, not the device', parsed._backup.items.tasks === 3);

  // Replay exactly what importData() does with a schema-2 file.
  const detok = vm.runInContext('_detokenizeSnapshot', ctx);
  const detokE = vm.runInContext('_detokenizeEvents', ctx);
  const data = detok(parsed);
  data.events = detokE(parsed);
  data._backup = Object.assign({}, parsed._backup);

  const expected = data._backup.hash;
  delete data._backup.hash;
  const check = await ctx.computeHash(JSON.stringify(data));
  data._backup.hash = expected;
  assert('GRh the partial file passes its own integrity hash', check === expected);

  assert('GRi import detects exactly the exported sections',
    detectExportSections(data).join(',') === 'todos,rewards');
  assert('GRj the detokenized payload holds only the todos',
    data.tasks.length === 3 && data.tasks.every(function (t) { return t.type === 'todo'; }));
  assert('GRk ...and carries no char to clobber the device with', !('char' in data));

  // Applying it back must restore those three todos and touch nothing else.
  const live = fixtureState();
  live.tasks = live.tasks.filter(function (t) { return t.type !== 'todo'; });
  const beforeChar = JSON.stringify(live.char);
  applySectionsToState(live, data, detectExportSections(data), 'replace');
  assert('GRl the round-tripped todos land back on a device that lost them',
    live.tasks.filter(function (t) { return t.type === 'todo'; }).length === 3);
  assert('GRm ...and the character was not touched', JSON.stringify(live.char) === beforeChar);

  // --- full: every box ticked, must stay the historic backup shape --------
  const resFull = await vm.runInContext('buildBackupFile', ctx)(events, ioAllSectionKeys());
  assert('GRn a full export keeps the historic filename', /^questa-backup-\d{8}-\d{4}\.json$/.test(resFull.filename));
  assert('GRo ...and is not flagged partial', resFull.partial === false);
  const parsedFull = JSON.parse(captured.json);
  assert('GRp ...carries no partial flag at all', parsedFull._backup.partial === undefined);
  assert('GRq ...carries no sections manifest', parsedFull._backup.sections === undefined);
  assert('GRr ...and includes the events', parsedFull._backup.eventCount === 2);

  const dataFull = detok(parsedFull);
  dataFull.events = detokE(parsedFull);
  dataFull._backup = Object.assign({}, parsedFull._backup);
  const expectedFull = dataFull._backup.hash;
  delete dataFull._backup.hash;
  const checkFull = await ctx.computeHash(JSON.stringify(dataFull));
  assert('GRs the full file still passes its own integrity hash', checkFull === expectedFull);
  assert('GRt ...and round-trips every task', dataFull.tasks.length === 6);
  assert('GRu ...and every event', dataFull.events.length === 2);
}

// Top-level await is unavailable here: this file is CommonJS (it uses require),
// and Node refuses a file that mixes the two.
roundTrip().then(function () {
  if (failures) {
    console.error('\n' + failures + ' granular-export-import assertion(s) FAILED');
    process.exit(1);
  }
  console.log('\nALL GRANULAR-EXPORT-IMPORT TESTS PASSED');
  process.exit(0);
}).catch(function (e) {
  console.error('Unhandled:', (e && e.stack) || e);
  process.exit(1);
});
