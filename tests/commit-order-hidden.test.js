// commit-order-hidden.test.js -- regression cover for the 2026-09-18 review.
//
// commitOrder() persists a drag-and-drop reorder. It used to rebuild S.tasks as
//
//     S.tasks = others.concat(sameType)
//
// where `others` is every task of a DIFFERENT type and `sameType` came solely from
// the rendered cards (`#view .task[draggable="true"]`). Any same-type task that was
// not on screen -- hidden by the active filter, the search box, or a tag filter --
// appeared in neither list and was silently DELETED, then persisted by save().
//
// This was reachable on stock defaults: S.prefs.filter.todos is 'active' and
// S.prefs.sort.todos is 'manual' out of the box, so the To-Dos tab hides completed
// items and manual sort enables dragging. One drag erased every completed to-do.
//
// The fix reorders the visible slots in place and leaves hidden tasks untouched.
//
// Run: node tests/commit-order-hidden.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction } = require('./_extract.js');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assert(desc, cond) {
  if (cond) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc); failures++; }
}
function assertEq(desc, got, want) {
  if (got === want) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); failures++; }
}

const commitOrderFn = extractFunction(appSrc, /^function commitOrder\(\)\{/, 'commitOrder');

const noop = function(){};
// `visible` is the ordered list of card ids the DOM would hand back, i.e. exactly
// what the user sees after the drag. `list` is the dataset.list of the first card.
function build(S, tab, visible, list){
  const cards = visible.map(id => ({ dataset: { id: id, list: list } }));
  const sb = {
    S: S, TAB: tab, save: noop, console: console, JSON: JSON, Math: Math,
    Object: Object, Array: Array, Set: Set, Map: Map, Number: Number, String: String,
    document: { querySelectorAll: function(sel){
      return (sel.indexOf('.task[draggable="true"]') >= 0) ? cards : [];
    } }
  };
  sb.globalThis = sb;
  const names = Object.keys(sb).filter(k => k !== 'globalThis');
  const f = new vm.Script('(function(' + names.join(',') + '){ "use strict";\n' +
    commitOrderFn + '\nreturn { commitOrder };\n})').runInNewContext(sb);
  return f.apply(null, names.map(n => sb[n]));
}

const ids = arr => arr.map(t => t.id).join(',');

// ===========================================================================
// D1 -- the stock-defaults data-loss case
// ===========================================================================
console.log('--- D1: a hidden completed to-do must survive a drag ---');
{
  const S = { tasks: [
    { id:'a', type:'todo', title:'A', done:false },
    { id:'b', type:'todo', title:'B', done:false },
    { id:'c', type:'todo', title:'C-completed', done:true }   // hidden by filter 'active'
  ]};
  const api = build(S, 'todos', ['b','a'], 'todos');          // user dragged B above A
  api.commitOrder();

  assertEq('D1a no task was dropped', S.tasks.length, 3);
  assert('D1b the hidden completed to-do is still present',
    S.tasks.some(t => t.id === 'c'));
  assertEq('D1c ...and it is still marked done', S.tasks.find(t=>t.id==='c').done, true);
  assertEq('D1d the visible drag actually took effect (B before A)',
    S.tasks.filter(t=>t.id==='a'||t.id==='b').map(t=>t.id).join(','), 'b,a');
}

// ===========================================================================
// D2 -- tasks of other types are never touched
// ===========================================================================
console.log('--- D2: other task types are untouched ---');
{
  const S = { tasks: [
    { id:'h1', type:'habit' },
    { id:'t1', type:'todo' },
    { id:'d1', type:'daily' },
    { id:'t2', type:'todo' },
    { id:'t3', type:'todo' }    // hidden by a search term
  ]};
  const api = build(S, 'todos', ['t2','t1'], 'todos');
  api.commitOrder();

  assertEq('D2a nothing was dropped', S.tasks.length, 5);
  assert('D2b the habit survives', S.tasks.some(t=>t.id==='h1'));
  assert('D2c the daily survives', S.tasks.some(t=>t.id==='d1'));
  assert('D2d the hidden to-do survives', S.tasks.some(t=>t.id==='t3'));
  assertEq('D2e the habit kept its original slot', S.tasks[0].id, 'h1');
  assertEq('D2f the daily kept its original slot', S.tasks[2].id, 'd1');
  assertEq('D2g the two visible to-dos swapped in their own slots',
    S.tasks[1].id + ',' + S.tasks[3].id, 't2,t1');
  assertEq('D2h the hidden to-do kept its slot', S.tasks[4].id, 't3');
}

// ===========================================================================
// D3 -- a full, unfiltered reorder still works exactly as before
// ===========================================================================
console.log('--- D3: an unfiltered reorder is unchanged ---');
{
  const S = { tasks: [
    { id:'x', type:'habit' }, { id:'y', type:'habit' }, { id:'z', type:'habit' }
  ]};
  const api = build(S, 'habits', ['z','x','y'], 'habits');
  api.commitOrder();
  assertEq('D3a the new order is persisted exactly', ids(S.tasks), 'z,x,y');
  assertEq('D3b nothing was added or dropped', S.tasks.length, 3);
}

// ===========================================================================
// D4 -- a stale card id (task deleted between render and dragend) is ignored
// ===========================================================================
console.log('--- D4: a stale card id does not corrupt the array ---');
{
  const S = { tasks: [
    { id:'p', type:'todo' }, { id:'q', type:'todo' }
  ]};
  const api = build(S, 'todos', ['q','GONE','p'], 'todos');
  api.commitOrder();
  assertEq('D4a no undefined entry was written', S.tasks.filter(Boolean).length, 2);
  assertEq('D4b both real tasks survive', S.tasks.length, 2);
  assertEq('D4c the surviving pair reordered as asked', ids(S.tasks), 'q,p');
}

// ===========================================================================
// D5 -- the rewards branch is untouched by this change
// ===========================================================================
console.log('--- D5: rewards still sort by the rendered order ---');
{
  const S = { tasks: [], rewards: [
    { id:'r1' }, { id:'r2' }, { id:'r3' }
  ]};
  const api = build(S, 'rewards', ['r3','r1','r2'], 'rewards');
  api.commitOrder();
  assertEq('D5a rewards follow the dragged order', ids(S.rewards), 'r3,r1,r2');
  assertEq('D5b no reward was dropped', S.rewards.length, 3);
}

// ===========================================================================
if (failures) { console.error('\n' + failures + ' commit-order-hidden assertion(s) FAILED'); process.exit(1); }
console.log('\nAll commit-order-hidden tests passed!');
