// subtask-card-drag.test.js
// Regression: on a manual-sort card, a touchstart that ORIGINATES on a
// .subitem (or on a check/fraction/subbox control) must NOT schedule the
// card's long-press drag timer (_tTimer). Otherwise the card and the subtask
// both try to lift on the same gesture. A plain touch on the card body must
// still schedule the timer.
//
// This drives the REAL enableTouchDrag handler extracted from app.js against a
// minimal DOM mock, so it stays honest if the handler changes.
const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const m = code.match(/function enableTouchDrag\(card\)\{[\s\S]*?\r?\n\}\r?\n\r?\nfunction beginTouchDrag\(/);
if (!m) {
  console.error('FAIL: could not extract enableTouchDrag from app.js');
  process.exit(1);
}
// Drop the trailing "\nfunction beginTouchDrag(" we used as an anchor.
const fnSrc = m[0].replace(/\r?\n\r?\nfunction beginTouchDrag\($/, '');

let failures = 0;
function assert(desc, cond) {
  if (cond) { console.log('[PASS] ' + desc); }
  else { console.error('[FAIL] ' + desc); failures++; }
}

// --- Build a controllable context for the handler ------------------------
function makeContext() {
  const ctx = {
    longPressScheduled: false, // true once the long-press setTimeout is armed
    touchstartHandler: null,
    touchmoveHandler: null,    // the card's scroll listener (registered once the handler proceeds)
  };

  // Mock timers: only the long-press setTimeout matters. We record it and
  // never actually fire it.
  const setTimeout = (fn, ms) => { ctx.longPressScheduled = true; return { fn, ms }; };
  const clearTimeout = () => {};
  const requestAnimationFrame = () => 0;

  const noop = () => {};
  const performanceMock = { now: () => 0 };

  // Minimal card + window that only capture listener registration.
  const card = {
    dataset: { list: 'tasks' },
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 40 }),
    classList: { add: noop, remove: noop },
    addEventListener: (type, cb) => { if (type === 'touchstart') ctx.touchstartHandler = cb; if (type === 'touchmove') ctx.touchmoveHandler = cb; },
    removeEventListener: noop,
  };
  const windowMock = { addEventListener: noop, removeEventListener: noop };
  const documentMock = { documentElement: { classList: { add: noop, remove: noop } } };

  const factory = new Function(
    'card', 'window', 'document', 'setTimeout', 'clearTimeout',
    'requestAnimationFrame', 'performance', 'longPressMs', 'resetDragState',
    'stopInertia', 'beginTouchDrag', 'moveTouchDrag', 'endTouchDrag', 'startInertia',
    // module-scope drag state the handler reads/writes:
    "let _tActive=false,_tGhost=null,_tDrag=null,_tTimer=null,_tStartX=0,_tStartY=0,_tPointerY=0,_tSubActive=false;\n" +
    fnSrc + "\n" +
    "return enableTouchDrag;"
  );

  const enableTouchDrag = factory(
    card, windowMock, documentMock, setTimeout, clearTimeout,
    requestAnimationFrame, performanceMock, () => 500, noop,
    noop, noop, noop, noop, noop
  );
  enableTouchDrag(card); // registers ctx.touchstartHandler
  return ctx;
}

// A fake single-finger touchstart event. `hitSelectors` = the set of ancestor
// selectors that e.target.closest(sel) should match (simulating where the
// finger landed in the DOM).
function touchEvent(hitSelectors) {
  return {
    touches: [{ clientX: 10, clientY: 10 }],
    timeStamp: 0,
    target: {
      closest: (sel) => (hitSelectors.includes(sel) ? {} : null),
    },
  };
}

// 1. Touch on the card body (matches nothing special) -> timer armed.
{
  const ctx = makeContext();
  ctx.touchstartHandler(touchEvent([]));
  assert('plain card-body touch schedules the long-press timer', ctx.longPressScheduled === true);
}

// 2. Touch originating on a .subitem -> timer must NOT be armed, BUT the handler
//    must still proceed to register its scroll (touchmove) listener. The old
//    early-return dead-zone skipped that registration, so subtask-origin swipes
//    never scrolled. This assertion FAILS on the regressed code and PASSES after
//    the Part 1 fix.
{
  const ctx = makeContext();
  ctx.touchstartHandler(touchEvent(['.subitem']));
  assert('subtask touch does NOT schedule the card long-press timer', ctx.longPressScheduled === false);
  assert('subtask touch still registers the card scroll (touchmove) listener', ctx.touchmoveHandler !== null);
}

// 3. Touch on the subtask checkbox (.subbox) -> timer must NOT be armed.
{
  const ctx = makeContext();
  ctx.touchstartHandler(touchEvent(['.subbox']));
  assert('subbox touch does NOT schedule the card long-press timer', ctx.longPressScheduled === false);
}

// 4. Touch on a subtask fraction (.subFrac) -> timer must NOT be armed.
{
  const ctx = makeContext();
  ctx.touchstartHandler(touchEvent(['.subFrac']));
  assert('subFrac touch does NOT schedule the card long-press timer', ctx.longPressScheduled === false);
}

// 5. Touch on a +/-/check control (.check) -> timer must NOT be armed (pre-existing behavior).
{
  const ctx = makeContext();
  ctx.touchstartHandler(touchEvent(['.check']));
  assert('.check touch does NOT schedule the card long-press timer', ctx.longPressScheduled === false);
}

if (failures) { console.error('\n' + failures + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll subtask-card-drag assertions passed');
process.exit(0);
