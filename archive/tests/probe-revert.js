// archive/tests/probe-revert.js — probe for the specific title-revert bug.
// Loads sync.js the same way as archive/tests/sync-fixes-tests.js does.
const fs = require('fs'), path = require('path'), vm = require('vm');
const code = fs.readFileSync(path.join(__dirname, '..', '..', 'sync.js'), 'utf8');

function freshCtx(){
  const ctx = {
    console, setTimeout, clearTimeout, Date, JSON, Math, Promise, String, Object, Array,
    addEventListener(){},
    navigator: { onLine: false },
    localStorage: { _m: {}, getItem(k){ return this._m[k] || null; }, setItem(k, v){ this._m[k] = String(v); }, removeItem(k){ delete this._m[k]; } },
    location: { origin: 'http://localhost', pathname: '/', search: '' },
    history: { replaceState(){} },
    document: { addEventListener(){}, getElementById(){ return null; }, visibilityState: 'hidden' },
    fetch: async () => { throw new Error('no network in tests'); },
    S: { tasks: [], char: {}, rewards: [], tags: [], devices: [], prefs: {} },
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

function fullSubset(tasksArr){
  return {
    tasks: tasksArr,
    rewards: [],
    tags: [],
    devices: [],
    an: { views: [], metrics: [] },
    history: [],
    charHistory: [],
    monthlyBackups: [],
    lastCron: 0,
    char: {},
  };
}

console.log('=========================================================');
console.log('SCENARIO 2: clean base (single sync after local edits)');
console.log('=========================================================');
{
  const ctx = freshCtx();

  const base = fullSubset([
    { id: 't1', type: 'todo', title: 'Cuesta ideas', updatedAt: 1000, checklist: [] },
  ]);
  const local = fullSubset([
    { id: 't1', type: 'todo', title: 'Questa ideas', updatedAt: 2000, checklist: [] },
    { id: 't2', type: 'todo', title: 'Make all times European', updatedAt: 2001, createdAt: 2001, checklist: [] },
  ]);
  const remote = fullSubset([
    { id: 't1', type: 'todo', title: 'Cuesta ideas', updatedAt: 1000, checklist: [] },
  ]);

  const merged = ctx.QuestaSync.merge(base, local, remote, 0);
  console.log('merged.tasks:', JSON.stringify(merged.tasks.map(t => ({ id: t.id, title: t.title })), null, 2));

  const t1 = merged.tasks.find(t => t.id === 't1');
  const t2 = merged.tasks.find(t => t.id === 't2');
  console.log('t1.title === "Questa ideas" (local rename kept)?', t1 && t1.title === 'Questa ideas');
  console.log('t2 exists (new task kept)?', !!t2);
}

console.log();
console.log('=========================================================');
console.log('SCENARIO 3: poisoned base (base already equals new local state)');
console.log('=========================================================');
{
  const ctx = freshCtx();

  const newLocalTasks = [
    { id: 't1', type: 'todo', title: 'Questa ideas', updatedAt: 2000, checklist: [] },
    { id: 't2', type: 'todo', title: 'Make all times European', updatedAt: 2001, createdAt: 2001, checklist: [] },
  ];
  // base is poisoned: equals the NEW local state (deep-clone to avoid aliasing issues)
  const base = fullSubset(JSON.parse(JSON.stringify(newLocalTasks)));
  const local = fullSubset(JSON.parse(JSON.stringify(newLocalTasks)));
  const remote = fullSubset([
    { id: 't1', type: 'todo', title: 'Cuesta ideas', updatedAt: 1000, checklist: [] },
  ]);

  const merged = ctx.QuestaSync.merge(base, local, remote, 0);
  console.log('merged.tasks:', JSON.stringify(merged.tasks.map(t => ({ id: t.id, title: t.title })), null, 2));

  const t1 = merged.tasks.find(t => t.id === 't1');
  const t2 = merged.tasks.find(t => t.id === 't2');
  console.log('merged t1.title:', t1 && t1.title);
  console.log('t2 survives?', !!t2);
  console.log('REVERT REPRODUCED (t1 reverted to "Cuesta ideas" and/or t2 dropped)?',
    (t1 && t1.title === 'Cuesta ideas') || !t2);
}
