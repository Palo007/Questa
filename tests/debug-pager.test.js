const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractLine, extractFunction, extractSpan, functionEndLineIndex } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

const diagnosticKindsLine = extractLine(appSrc, /^var DIAGNOSTIC_KINDS\s*=\s*\[/, 'DIAGNOSTIC_KINDS declaration');
const renderBlock = extractSpan(
  appSrc,
  /^let _evWin=null;/,
  functionEndLineIndex(/^function renderEventDetail\(from,to\)\{/, 'renderEventDetail'),
  'feed render helper block (_evWin..renderEventDetail end)'
);
const escFn = extractFunction(appSrc, /^function esc\(s\)\{/, 'esc');

const evStubs = 'var _evFilterType="all", _evPage=0, _evSearchQuery="";\n';
const code =
  diagnosticKindsLine + '\n' +
  evStubs +
  renderBlock + '\n' +
  escFn + '\n' +
  'return { renderEventDetail, isFeedNoise, getEventCategory, DIAGNOSTIC_KINDS, CONFLICT_CATEGORY };';

// Stub S with controllable prefs.
const S = { prefs: { hideSyncDiag: true, hideConflictDecisions: false }, devices: [] };

function makeEl(id) {
  return {
    _id: id,
    innerHTML: '',
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
  };
}
function makeDoc() {
  const store = {};
  return {
    getElementById(id) {
      if (!store[id]) store[id] = makeEl(id);
      return store[id];
    }
  };
}
const doc = makeDoc();

const sandbox = {
  S,
  document: doc,
  window: {},
  navigator: {},
  console,
  setTimeout: function () {},
  clearTimeout: function () {},
};
sandbox.globalThis = sandbox;

const pagerFixture = [];
for (let i = 0; i < 25; i++) {
  pagerFixture.push({ ts: 1000 + i, kind: 'conflictResolved', taskType: 'habit', taskTitle: 'Noise event ' + i, winner: 'remote', loser: 'local', dev: 'mrg0grhu3mozs' });
}
pagerFixture.push({ ts: 26000, kind: 'habitTap', taskType: 'habit', taskTitle: 'Real habit', dev: 'mrl770yaq56gl' });
pagerFixture.push({ ts: 27000, kind: 'complete', taskType: 'daily', taskTitle: 'Real daily', dev: 'mrg0grhu3mozs' });
pagerFixture.push({ ts: 28000, kind: 'export', notes: 'Real export', dev: 'mrg0grhu3mozs' });

function buildApiWithEvents(events) {
  const getEventsStub =
    'function getEvents(opts){ return Promise.resolve(' +
    JSON.stringify(events.slice().sort((a, b) => a.ts - b.ts)) + '); }';
  const fn = new vm.Script(
    '(function(S, document, window, navigator, console, setTimeout, clearTimeout){ "use strict";' +
    getEventsStub + '\n' + code + '\n})'
  ).runInNewContext(sandbox);
  return fn(S, doc, sandbox.window, sandbox.navigator, console, function () {}, function () {});
}

const api = buildApiWithEvents(pagerFixture);
console.log('CONFLICT_CATEGORY:', api.CONFLICT_CATEGORY);
console.log('getEventCategory(conflictResolved):', api.getEventCategory({ kind: 'conflictResolved' }));
console.log('isFeedNoise(conflictResolved):', api.isFeedNoise({ kind: 'conflictResolved' }));
console.log('S.prefs.hideConflictDecisions:', S.prefs.hideConflictDecisions);
console.log('S.prefs.hideSyncDiag:', S.prefs.hideSyncDiag);

// Now call renderEventDetail and check the filtered count
api.renderEventDetail(0, 1e15);
setTimeout(() => {
  const html = doc.getElementById('evFeedContent').innerHTML;
  const count = (html.match(/class="evRow"/g) || []).length;
  console.log('Row count:', count);
  console.log('Has Noise event:', html.indexOf('Noise event') >= 0);
  console.log('Has Real habit:', html.indexOf('Real habit') >= 0);
}, 100);