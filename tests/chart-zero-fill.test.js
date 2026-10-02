// chart-zero-fill.test.js -- CR-KT-006: analytics charts list empty days/weeks/
// months with 0. Loads the REAL anFillDays / anBreakdown from app.js (anchor
// extraction) with a stubbed anRepsSeries. TZ is a DST zone on purpose.
process.env.TZ = 'America/New_York';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract.js');
const src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

let failures = 0;
function assertEq(desc, got, want){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if(g === w) console.log('[PASS] ' + desc);
  else { console.error('[FAIL] ' + desc + ' -- got ' + g + ', want ' + w); failures++; }
}

const code = [
  extractLine(src, /^const DAY\s*=/, 'DAY'),
  extractFunction(src, /^function localDayKey\(/, 'localDayKey'),
  extractFunction(src, /^function nextLocalDay\(/, 'nextLocalDay'),
  extractLine(src, /^const AN_FILL_MAX_DAYS\s*=/, 'AN_FILL_MAX_DAYS'),
  extractFunction(src, /^function anFillDays\(/, 'anFillDays'),
  extractFunction(src, /^function anBreakdown\(/, 'anBreakdown'),
  'this.anFillDays=anFillDays; this.anBreakdown=anBreakdown; this.localDayKey=localDayKey;'
].join('\n');
const sb = { Date, Object, Math, String, Array, JSON, console, _series: [] };
sb.anRepsSeries = function(){ return sb._series; };
vm.createContext(sb); vm.runInContext(code, sb);

const k = (y,m,d) => new Date(y, m-1, d).getTime();   // local midnight

// 1. gap: events on day 1 and day 4 -> 4 points, middle two are 0
let ser = [{d:k(2026,5,1),v:3},{d:k(2026,5,4),v:2}];
assertEq('gap days are 0', sb.anFillDays(ser, k(2026,5,1), k(2026,5,4)).map(x=>x.v), [3,0,0,2]);

// 2. DST spring-forward (2026-03-08, 23h day): one point per local day, all local midnights
ser = [{d:k(2026,3,6),v:1},{d:k(2026,3,10),v:1}];
const dst = sb.anFillDays(ser, k(2026,3,6), k(2026,3,10));
assertEq('DST: 5 points over spring-forward', dst.length, 5);
assertEq('DST: every key is a local midnight', dst.every(x => sb.localDayKey(x.d) === x.d), true);
// DST fall-back (2026-11-01, 25h day)
ser = [{d:k(2026,10,30),v:1},{d:k(2026,11,3),v:1}];
assertEq('DST: 5 points over fall-back', sb.anFillDays(ser, k(2026,10,30), k(2026,11,3)).length, 5);

// 3. empty range -> nothing to draw
assertEq('no events -> []', sb.anFillDays([], k(2026,5,1), k(2026,5,9)), []);

// 4. window starts before the first event: fill starts at the first event
ser = [{d:k(2026,5,3),v:1}];
assertEq('starts at first event', sb.anFillDays(ser, k(2026,1,1), k(2026,5,4)).length, 2);

// 5. trailing zero days up to `to`
assertEq('trailing days to `to`', sb.anFillDays(ser, k(2026,5,3), k(2026,5,6)).map(x=>x.v), [1,0,0,0]);

// 6. cap: huge window stays bounded
const big = sb.anFillDays([{d:k(2000,1,1),v:1}], 0, k(2026,5,1));
assertEq('cap holds', big.length <= 3701, true);

// 7. weekly breakdown lists an empty week; totals unchanged
sb._series = [{d:k(2026,5,4),v:5},{d:k(2026,5,25),v:7}];   // Mondays, 3 weeks apart
const wk = sb.anBreakdown('x', k(2026,5,4), k(2026,5,31), 'week');
assertEq('weekly: empty weeks listed', wk.map(x=>x.v), [5,0,0,7]);

// 8. monthly breakdown lists an empty month
sb._series = [{d:k(2026,1,15),v:2},{d:k(2026,3,15),v:4}];
const mo = sb.anBreakdown('x', k(2026,1,1), k(2026,3,31), 'month');
assertEq('monthly: empty month listed', mo.map(x=>x.label+':'+x.v), ['2026-01:2','2026-02:0','2026-03:4']);

if(failures){ console.error(failures + ' failure(s)'); process.exit(1); }
console.log('chart-zero-fill: all passed');
