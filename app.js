// Questa app logic — extracted from index.html on 2026-06-24 18:48
// APP_VERSION is stamped on every edit; it is shown at the bottom of Settings.
const APP_VERSION = "v2026.06.25-1607";

// Long-press delay (ms) before a stationary touch on a card is treated as a drag
// pickup rather than a scroll. Configurable in Settings (S.prefs.dragDelay), default 200.
// KEEP IT SMALL. Research + this project's own history show Chrome Android commits the
// touch stream to a SCROLL during a long stationary hold, BEFORE the timer fires; once
// committed, touchmove is non-cancelable and the card freezes lifted while the page
// scrolls. A short window (~200) beats that commit; raising it (e.g. 1000) makes the
// freeze MORE likely, not less. The setting exists so it can be tuned on a real device.
const DRAG_DELAY_DEFAULT = 200;
function longPressMs(){
  const v = (S.prefs && S.prefs.dragDelay);
  const n = (v==null ? DRAG_DELAY_DEFAULT : +v);
  return (isFinite(n) && n>=0) ? n : DRAG_DELAY_DEFAULT;
}
const STORE_KEY = "questa.save.v1";
function freshState(){
  return {
    version:1,
    char:{ name:"Adventurer", face:"🧙", cls:"Warrior",
           lvl:1, xp:0, hp:50, maxHp:50, mp:0, gold:0 },
    tasks:[], rewards:[],
    lastCron: dayStamp(new Date()),
    history:[], charHistory:[], prefs:{ width:480, notesLines:3, lastTab:'habits' }
  };
}
let S = load();
function load(){
  try{ const raw = localStorage.getItem(STORE_KEY);
    if(raw){ return migrate(JSON.parse(raw)); } }catch(e){}
  return freshState();
}
function migrate(s){ const f=freshState();
  const out=Object.assign(f,s,{char:Object.assign(f.char,s.char||{})});
  out.prefs=Object.assign({width:480, notesLines:3, lastTab:'habits', tipDelay:0}, s.prefs||{});
  // SPLIT: events live in IndexedDB, never in localStorage/S. Drop any events
  // array carried in from a legacy save or an import file so it can't bloat the
  // localStorage blob or be mistaken for a live source.
  delete out.events;
  return out; }
function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
// --- append-only event log (IndexedDB-backed) ------------------------
// Unlike history (one merged point/day), events are NEVER merged: each tap,
// subtask toggle, completion and miss is its own timestamped record. This is
// the fidelity layer for time-of-day / per-subtask analytics.
//
// SPLIT ARCHITECTURE: the whole S object (tasks/char/prefs/per-day history/
// charHistory) still lives in localStorage via save()/load(). ONLY this
// append-only event log lives in IndexedDB, so it can grow far past the
// ~5 MB localStorage quota and be queried by time window / task / kind
// without loading the entire log into memory.
//
// One database ("questa"), one object store ("events"), keyed by an
// auto-increment id, with indexes on ts, kind and taskId.
const IDB_NAME = "questa";
const IDB_VERSION = 1;
const EVENTS_STORE = "events";
// Prune policy (see HISTORY-TRACKING.md): drop events older than this many
// months, with a generous hard-count backstop. localStorage's old 5 MB quota
// no longer applies to events; IDB origin storage is typically hundreds of MB
// to GB, so we keep a long, high-fidelity window and only prune to stay tidy.
const EVENT_AGE_LIMIT_MS = 18 * 30 * 86400000; // ~18 months
const EVENT_HARD_CAP = 200000;                 // backstop count, far above realistic use
let _idbPromise = null;          // cached open() promise (fire-and-forget callers reuse it)
let _idbPruned = false;          // prune runs at most once per session
function idbOpen(){
  if(_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve,reject)=>{
    if(typeof indexedDB === "undefined"){ reject(new Error("IndexedDB unavailable")); return; }
    let req;
    try{ req = indexedDB.open(IDB_NAME, IDB_VERSION); }
    catch(e){ reject(e); return; }
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(EVENTS_STORE)){
        const os = db.createObjectStore(EVENTS_STORE, {keyPath:"id", autoIncrement:true});
        os.createIndex("ts", "ts", {unique:false});
        os.createIndex("kind", "kind", {unique:false});
        os.createIndex("taskId", "taskId", {unique:false});
      }
    };
    req.onsuccess = ()=>{ const db=req.result; resolve(db); schedulePrune(db); };
    req.onerror = ()=>reject(req.error || new Error("IndexedDB open failed"));
  });
  return _idbPromise;
}
// Fire-and-forget event append. Callers (toggleSub, scoreHabit, completeTask,
// runCron, creditYesterday) stay synchronous; all async + failure handling is
// internal here, so a missing/blocked IDB never breaks task scoring.
function logEvent(ev){
  const rec = Object.assign({ts:Date.now()}, ev);
  idbOpen().then(db=>{
    try{
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      tx.objectStore(EVENTS_STORE).add(rec);
    }catch(e){ /* swallow: fidelity layer is best-effort, never blocks scoring */ }
  }).catch(()=>{ /* IDB unavailable (e.g. private mode) — silently skip logging */ });
}
// Async read API: resolve to events in [from,to] (ms, inclusive) optionally
// filtered by kind and/or taskId. Uses the ts index range so we never load the
// whole store for a windowed query. Returns [] on any failure (never throws).
function getEvents(opts){
  opts = opts || {};
  const from = (opts.from!=null) ? opts.from : -Infinity;
  const to   = (opts.to!=null)   ? opts.to   : Infinity;
  const wantKind = opts.kind || null;
  const wantTask = opts.taskId || null;
  return idbOpen().then(db=>new Promise((resolve)=>{
    const out=[];
    let tx;
    try{ tx = db.transaction(EVENTS_STORE, "readonly"); }
    catch(e){ resolve([]); return; }
    const store = tx.objectStore(EVENTS_STORE);
    let range=null;
    try{
      if(from!==-Infinity && to!==Infinity) range = IDBKeyRange.bound(from,to);
      else if(from!==-Infinity) range = IDBKeyRange.lowerBound(from);
      else if(to!==Infinity) range = IDBKeyRange.upperBound(to);
    }catch(e){ range=null; }
    const cursorReq = store.index("ts").openCursor(range);
    cursorReq.onsuccess = ()=>{
      const cur = cursorReq.result;
      if(!cur){ resolve(out); return; }
      const v = cur.value;
      if((!wantKind || v.kind===wantKind) && (!wantTask || v.taskId===wantTask)) out.push(v);
      cur.continue();
    };
    cursorReq.onerror = ()=>resolve(out);
  })).catch(()=>[]);
}
// Count of stored events (diagnostic / docs). Resolves 0 on failure.
function countEvents(){
  return idbOpen().then(db=>new Promise((resolve)=>{
    try{
      const req = db.transaction(EVENTS_STORE,"readonly").objectStore(EVENTS_STORE).count();
      req.onsuccess=()=>resolve(req.result||0); req.onerror=()=>resolve(0);
    }catch(e){ resolve(0); }
  })).catch(()=>0);
}
// --- event backfill (synthesized from Habitica history) --------------
// The importer emits a separate file of synthetic events (each flagged
// synthetic:true). These let the event-driven dashboard show usable data right
// after import, even though Habitica never recorded per-tap/per-subtask events.
// Loading is idempotent: we first delete any previously-loaded SYNTHETIC events
// (live events the user generated by tapping are kept), then bulk-add the file.
function clearAllEvents(){
  return idbOpen().then(db=>new Promise((resolve)=>{
    let tx;
    try{ tx = db.transaction(EVENTS_STORE,"readwrite"); }catch(e){ resolve(false); return; }
    try{ tx.objectStore(EVENTS_STORE).clear(); }catch(e){}
    tx.oncomplete=()=>resolve(true); tx.onerror=()=>resolve(false); tx.onabort=()=>resolve(false);
  })).catch(()=>false);
}
function clearSyntheticEvents(){
  return idbOpen().then(db=>new Promise((resolve)=>{
    let removed=0, tx;
    try{ tx = db.transaction(EVENTS_STORE,"readwrite"); }catch(e){ resolve(0); return; }
    const cur = tx.objectStore(EVENTS_STORE).openCursor();
    cur.onsuccess = ()=>{ const c=cur.result;
      if(!c){ return; }
      if(c.value && c.value.synthetic){ try{c.delete();}catch(e){} removed++; }
      c.continue();
    };
    tx.oncomplete = ()=>resolve(removed);
    tx.onerror = ()=>resolve(removed);
    tx.onabort = ()=>resolve(removed);
  })).catch(()=>0);
}
function bulkAddEvents(list){
  return idbOpen().then(db=>new Promise((resolve)=>{
    let added=0, tx;
    try{ tx = db.transaction(EVENTS_STORE,"readwrite"); }catch(e){ resolve(0); return; }
    const store = tx.objectStore(EVENTS_STORE);
    list.forEach(ev=>{
      if(!ev || typeof ev!=="object") return;
      // ensure ts/kind exist; drop any incoming id so autoIncrement assigns fresh
      const rec = Object.assign({}, ev); delete rec.id;
      if(typeof rec.ts!=="number") rec.ts = Date.now();
      try{ store.add(rec); added++; }catch(e){}
    });
    tx.oncomplete = ()=>resolve(added);
    tx.onerror = ()=>resolve(added);
    tx.onabort = ()=>resolve(added);
  })).catch(()=>0);
}
// Settings -> "Load event backfill": read the JSON the importer produced and
// load its events into IndexedDB (replacing prior synthetic events).
function importEventsBackfill(ev){
  const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{
    let blob;
    try{ blob=JSON.parse(rd.result); }catch(e){ alert('That file is not valid JSON.'); return; }
    const list = Array.isArray(blob) ? blob : (blob && Array.isArray(blob.events) ? blob.events : null);
    if(!list){ alert('That file does not look like a Questa event backfill (no events array).'); return; }
    if(typeof indexedDB==="undefined"){ alert('IndexedDB is unavailable here (e.g. private browsing), so events cannot be loaded.'); return; }
    if(!confirm('Load '+list.length+' synthesized events? This replaces any previously loaded backfill (your live taps are kept).')) return;
    // mark everything from this load as synthetic so a re-load can replace it
    list.forEach(e=>{ if(e && typeof e==="object" && e.synthetic===undefined) e.synthetic=true; });
    clearSyntheticEvents().then(()=>bulkAddEvents(list)).then(added=>{
      toast('Loaded '+added+' events');
      if(TAB==='analytics') render();
    });
  };
  rd.readAsText(f);
}
// Prune once per session: delete events older than EVENT_AGE_LIMIT_MS via a
// ts-index cursor, then enforce the hard-count backstop (oldest first). All
// best-effort; failures are swallowed.
function schedulePrune(db){
  if(_idbPruned) return; _idbPruned = true;
  setTimeout(()=>{ try{ pruneEvents(db); }catch(e){} }, 0);
}
function pruneEvents(db){
  const cutoff = Date.now() - EVENT_AGE_LIMIT_MS;
  let tx;
  try{ tx = db.transaction(EVENTS_STORE,"readwrite"); }catch(e){ return; }
  const store = tx.objectStore(EVENTS_STORE);
  // 1) age-based delete: everything with ts < cutoff
  try{
    const ageReq = store.index("ts").openCursor(IDBKeyRange.upperBound(cutoff, true));
    ageReq.onsuccess = ()=>{ const c=ageReq.result; if(c){ try{c.delete();}catch(e){} c.continue(); } };
  }catch(e){}
  // 2) hard-count backstop: if still over cap, drop oldest by ts until under
  try{
    const cReq = store.count();
    cReq.onsuccess = ()=>{
      const over = (cReq.result||0) - EVENT_HARD_CAP;
      if(over <= 0) return;
      let removed=0;
      const tx2 = db.transaction(EVENTS_STORE,"readwrite");
      const cur2 = tx2.objectStore(EVENTS_STORE).index("ts").openCursor();
      cur2.onsuccess = ()=>{ const c=cur2.result; if(c && removed<over){ try{c.delete();}catch(e){} removed++; c.continue(); } };
    };
  }catch(e){}
}
// Once-per-day snapshot of the character vitals, for progression charts.
function logCharSnapshot(){
  S.charHistory = S.charHistory || [];
  const c=S.char||{};
  S.charHistory.push({date:Date.now(), hp:c.hp, maxHp:c.maxHp, xp:c.xp, mp:c.mp, gold:c.gold, lvl:c.lvl});
}
function applyWidth(){ document.documentElement.style.setProperty('--appw',(S.prefs.width||480)+'px'); }

const uid = ()=> Date.now().toString(36)+Math.random().toString(36).slice(2,7);
function dayStamp(d){ return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

const DIFF = { trivial:0.1, easy:1, medium:1.5, hard:2 };
function xpToLevel(lvl){ return Math.round(0.25*lvl*lvl + 10*lvl + 139.75); }
function valColor(v){
  if(v < -16) return ["Dark red","var(--darkred)"];
  if(v < -9)  return ["Red","var(--red)"];
  if(v < -1)  return ["Orange","var(--orange)"];
  if(v < 1)   return ["Yellow","var(--yellow)"];
  if(v < 6)   return ["Green","var(--green)"];
  if(v < 12)  return ["Light blue","var(--lblue)"];
  return ["Bright blue","var(--blue)"];
}
function valueDelta(value){ return Math.pow(0.9747, clamp(value, -47.27, 21.27)); }
function completionReward(task){
  const d = valueDelta(task.value);
  const m = DIFF[task.difficulty] || 1;
  return { xp:Math.max(1, Math.round(d*m*7)), gold:Math.max(0,+(d*m*1.2).toFixed(2)), mp:Math.round(m) };
}
function missDamage(task){
  const base = task.difficulty==='hard'?4 : task.difficulty==='medium'?3 : task.difficulty==='trivial'?1 : 2;
  return +(base * valueDelta(task.value) * 0.9).toFixed(2);
}
function gainXp(xp){
  S.char.xp += xp;
  let need = xpToLevel(S.char.lvl);
  while(S.char.xp >= need){
    S.char.xp -= need; S.char.lvl++;
    S.char.maxHp = 50; S.char.hp = S.char.maxHp;
    levelFlash(S.char.lvl);
    need = xpToLevel(S.char.lvl);
  }
}
function takeDamage(amount){ S.char.hp = +(S.char.hp - amount).toFixed(2); if(S.char.hp <= 0){ death(); } }
function death(){
  S.char.lvl = Math.max(1, S.char.lvl - 1);
  S.char.gold = +Math.max(0, S.char.gold * 0.75).toFixed(2);
  S.char.hp = S.char.maxHp; S.char.xp = 0;
  document.getElementById('deathOverlay').classList.add('show');
}
// --- live history logging ---------------------------------------------
// Append/merge a dated point onto a task's history in Habitica's shape.
// Same-day events merge (scoredUp accumulates, completed/ value updated) so
// the series stays one-point-per-day, continuous with the imported data.
function logHistory(t, patch){
  t.history = t.history || [];
  const now = Date.now();
  const dayOf = ms => Math.floor(ms/86400000);
  const last = t.history[t.history.length-1];
  if(last && dayOf(last.date)===dayOf(now)){
    last.date = now;
    if('value' in patch) last.value = patch.value;
    if('scoredUp' in patch) last.scoredUp = (last.scoredUp||0) + patch.scoredUp;
    if('scoredDown' in patch) last.scoredDown = (last.scoredDown||0) + patch.scoredDown;
    if('completed' in patch) last.completed = patch.completed;
    if('checklist' in patch) last.checklist = patch.checklist;
    if('reward' in patch) last.reward = patch.reward;
    if('reps' in patch) last.reps = (last.reps||0) + patch.reps;
    if('repCounted' in patch) last.repCounted = last.repCounted || patch.repCounted;
    if('scored' in patch) last.scored = last.scored || patch.scored;
  } else {
    t.history.push(Object.assign({date:now}, patch));
  }
}
function completeTask(t){
  if(t.done) return;
  const r = completionReward(t);
  const delta = valueDelta(t.value);
  gainXp(r.xp); S.char.gold = +(S.char.gold + r.gold).toFixed(2); S.char.mp += r.mp;
  t.value = clamp(t.value + delta, -47.27, 99);
  t.done = true;
  t._gr = { xp:r.xp, gold:r.gold, mp:r.mp, delta:delta };  // remember exactly what was granted
  if(t.type==='daily'){ t.streak = (t.streak||0) + 1;
    const cl=(t.checklist||[]); const snap = cl.length? {checklist:cl.map(c=>({text:c.text,done:!!c.done}))} : {};
    logHistory(t,Object.assign({value:t.value,completed:true,isDue:true,reward:Object.assign({},t._gr),repeat:(t.repeat||[]).slice()},snap));
    logEvent({kind:'complete', taskType:'daily', taskId:t.id, taskTitle:t.title,
              streak:t.streak, reward:Object.assign({},t._gr), repeat:(t.repeat||[]).slice(),
              checklist:cl.map(c=>({id:c.id||null,text:c.text,done:!!c.done}))}); }
  if(t.type==='todo'){ t.completedAt = Date.now();
    logHistory(t,{value:t.value,completed:true,reward:Object.assign({},t._gr)});
    logEvent({kind:'complete', taskType:'todo', taskId:t.id, taskTitle:t.title,
              reward:Object.assign({},t._gr), createdAt:t.createdAt||null, completedAt:t.completedAt}); }
  toast('+'+r.xp+' XP · +'+r.gold.toFixed(1)+' gold'); bumpAvatar();
  save(); render();
}
function reverseGrant(t){
  const g = t._gr || { xp:0, gold:0, mp:0, delta:valueDelta(t.value) };
  S.char.xp = Math.max(0, S.char.xp - g.xp);
  S.char.gold = +Math.max(0, S.char.gold - g.gold).toFixed(2);
  S.char.mp = Math.max(0, S.char.mp - g.mp);
  t.value = clamp(t.value - g.delta, -47.27, 99);
  t._gr = null;
}
// undo a same-day logged completion point (used when un-checking)
function unlogToday(t){
  if(!t.history || !t.history.length) return;
  const dayOf = ms => Math.floor(ms/86400000);
  const last = t.history[t.history.length-1];
  if(dayOf(last.date)===dayOf(Date.now())){
    if(last.completed){ last.completed=false; }
    // if the point carried no other signal, drop it
    if(!last.scoredUp && !last.scoredDown && !last.completed) t.history.pop();
    else last.value = t.value;
  }
}
function uncompleteDaily(t){
  reverseGrant(t);
  unlogToday(t);
  t.done = false;
  if(t.type==='daily' && t.streak){ t.streak = Math.max(0, t.streak - 1); }
  save(); render();
}
function uncompleteTodo(t){
  reverseGrant(t);
  unlogToday(t);
  t.done = false;
  toast('Reverted');
  save(); render();
}
function scoreHabit(id, dir){
  const t=S.tasks.find(x=>x.id===id); if(!t)return;
  if(dir>0){
    const r=completionReward(t);
    gainXp(r.xp); S.char.gold=+(S.char.gold+r.gold).toFixed(2); S.char.mp+=r.mp;
    t.value=clamp(t.value+valueDelta(t.value),-47.27,99);
    t.cUp=(t.cUp||0)+1;
    const _rpt = t.repsPerTap || repsPerTap(t.title);
    logHistory(t,{value:t.value,scoredUp:1,reps:_rpt,repCounted:true,scored:true});
    logEvent({kind:'habitTap', dir:1, taskId:t.id, taskTitle:t.title, reps:_rpt, value:t.value});
    toast('+'+r.xp+' XP · +'+r.gold.toFixed(1)+' gold'); bumpAvatar();
  } else {
    const dmg=missDamage(t);
    t.value=clamp(t.value-valueDelta(t.value),-47.27,99);
    t.cDown=(t.cDown||0)+1;
    logHistory(t,{value:t.value,scoredDown:1});
    logEvent({kind:'habitTap', dir:-1, taskId:t.id, taskTitle:t.title, value:t.value});
    takeDamage(dmg); toast('-'+dmg.toFixed(1)+' HP');
  }
  save(); render();
}
function periodBoundaryCrossed(freq, lastStamp, now){
  // lastStamp is YYYYMMDD of the previous cron; now is a Date (today)
  const ly=Math.floor(lastStamp/10000), lm=Math.floor(lastStamp/100)%100, ld=lastStamp%100;
  const last=new Date(ly, lm-1, ld);
  if(freq==='weekly'){
    // reset if we've crossed into a new ISO-ish week (week starts Monday)
    const monday=d=>{ const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day); x.setHours(0,0,0,0); return x.getTime(); };
    return monday(now) > monday(last);
  }
  if(freq==='monthly'){
    return now.getFullYear()*12+now.getMonth() > last.getFullYear()*12+last.getMonth();
  }
  return true; // daily (or unknown) -> reset every cron
}
// ── Yesterday's check-in (RYA) ─────────────────────────────────────────────
// Dailies that were due yesterday and are still unticked. Computed with the
// same scheduledYesterday test runCron() uses, so the two stay in sync.
function missedYesterdayDailies(){
  if(S.lastCron === dayStamp(new Date())) return []; // already crossed today
  const dow = new Date().getDay();
  return S.tasks.filter(t=>{
    if(t.type!=='daily') return false;
    const scheduledYesterday = !t.repeat || t.repeat[(dow+6)%7];
    return scheduledYesterday && !t.done;
  });
}
// Credit a daily the user forgot to tick yesterday. Mirrors completeTask()'s
// reward/streak/history logic, but stamps the history point to YESTERDAY and
// stays silent (no per-task toast, no render) for batch use by the modal.
function creditYesterday(t){
  if(t.done) return;
  const r = completionReward(t);
  const delta = valueDelta(t.value);
  gainXp(r.xp); S.char.gold = +(S.char.gold + r.gold).toFixed(2); S.char.mp += r.mp;
  t.value = clamp(t.value + delta, -47.27, 99);
  t.done = true;
  t._gr = { xp:r.xp, gold:r.gold, mp:r.mp, delta:delta };
  t.streak = (t.streak||0) + 1;
  const cl=(t.checklist||[]);
  const yMs = Date.now() - 86400000; // backdate the point to yesterday
  t.history = t.history || [];
  const snap = cl.length ? {checklist:cl.map(c=>({text:c.text,done:true}))} : {};
  t.history.push(Object.assign({date:yMs,value:t.value,completed:true,isDue:true,
    reward:Object.assign({},t._gr),repeat:(t.repeat||[]).slice()},snap));
  logEvent({kind:'complete', taskType:'daily', taskId:t.id, taskTitle:t.title,
            streak:t.streak, reward:Object.assign({},t._gr), repeat:(t.repeat||[]).slice(),
            late:true, checklist:cl.map(c=>({id:c.id||null,text:c.text,done:true}))});
}
// Render the blocking check-in modal listing yesterday's unfinished dailies.
let _yesterMissed = [];
let _yesterTick = {}; // id -> bool
function openYesterCheck(missed){
  _yesterMissed = missed;
  _yesterTick = {};
  drawYesterCheck();
  document.getElementById('yScrim').classList.add('show');
}
function toggleYesterTick(id){
  _yesterTick[id] = !_yesterTick[id];
  drawYesterCheck();
}
function drawYesterCheck(){
  const n=_yesterMissed.length;
  let h='<div class="ySheet">';
  h+='<div class="yHead"><span class="yIcon">🌅</span><h3>New day — quick check</h3></div>';
  h+='<p class="ySub">You had '+n+' '+(n===1?'daily':'dailies')+' due yesterday that '+(n===1?"isn't":"aren't")+
     ' ticked. Tick anything you actually did to keep your 🔥 streak and avoid the HP hit.</p>';
  h+='<div class="yList">';
  _yesterMissed.forEach(t=>{
    const on=!!_yesterTick[t.id];
    h+='<div class="yItem'+(on?' on':'')+'" onclick="toggleYesterTick(\''+t.id+'\')">'+
         '<span class="yBox">'+(on?'✓':'')+'</span>'+
         '<span class="yBody"><span class="yTitle">'+esc(t.title)+'</span>'+
           '<span class="yNote">'+(on?'Will restore streak · +XP':'Leave unticked → counts as missed')+'</span>'+
         '</span></div>';
  });
  h+='</div>';
  h+='<button class="btn primary yGo" onclick="commitYesterCheck()">Start my day</button>';
  h+='<p class="yFine">Anything left unticked applies its miss damage now.</p>';
  h+='</div>';
  document.getElementById('yScrim').innerHTML=h;
}
function commitYesterCheck(){
  _yesterMissed.forEach(t=>{ if(_yesterTick[t.id]) creditYesterday(t); });
  const credited=_yesterMissed.filter(t=>_yesterTick[t.id]).length;
  document.getElementById('yScrim').classList.remove('show');
  document.getElementById('yScrim').innerHTML='';
  _yesterMissed=[]; _yesterTick={};
  runCron();            // finalize the day; corrected dailies are now done, so cron skips them
  render();
  if(credited>0) toast('Credited '+credited+' daily'+(credited===1?'':'s')+' from yesterday');
}
// Startup gate: prompt if anything was missed yesterday, else run cron directly.
function startDay(){
  const missed=missedYesterdayDailies();
  if(missed.length){ openYesterCheck(missed); }
  else { runCron(); render(); }
}
function runCron(){
  const today = dayStamp(new Date());
  if(S.lastCron === today) return;
  const dow = new Date().getDay();
  let totalDmg = 0;
  S.tasks.forEach(t=>{
    if(t.type==='habit'){ if(periodBoundaryCrossed(t.resetFreq||'daily', S.lastCron, new Date())){ t.cUp=0; t.cDown=0; } return; }
    if(t.type!=='daily') return;
    const scheduledYesterday = !t.repeat || t.repeat[(dow+6)%7];
    if(scheduledYesterday && !t.done){
      totalDmg += missDamage(t);
      t.value = clamp(t.value - valueDelta(t.value), -47.27, 99);
      t.streak = 0;
      logHistory(t,{value:t.value,completed:false,isDue:true,repeat:(t.repeat||[]).slice()});
      const cl=(t.checklist||[]);
      logEvent({kind:'miss', taskType:'daily', taskId:t.id, taskTitle:t.title,
                repeat:(t.repeat||[]).slice(),
                checklist:cl.map(c=>({id:c.id||null,text:c.text,done:!!c.done}))});
    }
    t.done = false;
    (t.checklist||[]).forEach(c=>c.done=false);
  });
  S.lastCron = today;
  if(totalDmg>0){ takeDamage(totalDmg); toast('-'+totalDmg.toFixed(1)+' HP (missed dailies)'); }
  logCharSnapshot();
  save();
}
function levelFlash(lvl){
  const f=document.getElementById('lvlFlash'); const t=document.getElementById('lvlFlashTxt');
  t.textContent='⭐ Level '+lvl+'!'; f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
}
function bumpAvatar(){ const a=document.getElementById('avatarFace');
  a.classList.add('bump'); setTimeout(()=>a.classList.remove('bump'),150); }
function toast(msg){
  const w=document.getElementById('toast'); const e=document.createElement('div');
  e.className='toastMsg'; e.textContent=msg; w.appendChild(e);
  setTimeout(()=>e.remove(),2400);
}
let TAB=(S.prefs && S.prefs.lastTab) || 'habits', EDIT=null;
// FILTER, FILTEROPEN, and per-tab scroll positions persist in S.prefs
function ensureUiPrefs(){
  S.prefs = S.prefs || {};
  if(!S.prefs.filter) S.prefs.filter = {habits:'all', dailies:'all', todos:'active'};
  if(S.prefs.filterOpen===undefined) S.prefs.filterOpen=false;
  if(!S.prefs.scroll) S.prefs.scroll = {};
  return S.prefs;
}
ensureUiPrefs();
let FILTER=S.prefs.filter;
let FILTEROPEN=S.prefs.filterOpen;
function toggleFilter(){ FILTEROPEN=!FILTEROPEN; S.prefs.filterOpen=FILTEROPEN; save(); render(); }
const EXPANDED={}; // taskId -> bool (checklist expanded on card)
function toggleExpand(id){ EXPANDED[id]=!EXPANDED[id]; render(); }
function toggleSub(taskId, idx){
  const t=S.tasks.find(x=>x.id===taskId); if(!t||!t.checklist||!t.checklist[idx])return;
  const c=t.checklist[idx];
  c.done=!c.done;
  logEvent({kind:'subtask', taskId:t.id, taskTitle:t.title, taskType:t.type,
            subId:c.id||null, subText:c.text, done:c.done});
  save(); render();
}
function checklistBlock(t){
  const cl=(t.checklist||[]); if(!cl.length) return '';
  if(!EXPANDED[t.id]) return '';
  let h='<div class="sublist">';
  cl.forEach((c,i)=>{
    h+='<div class="subitem" onclick="event.stopPropagation();toggleSub(\''+t.id+'\','+i+')">'+
       '<span class="subbox '+(c.done?'on':'')+'">'+(c.done?'✔':'')+'</span>'+
       '<span class="subtxt '+(c.done?'sdone':'')+'">'+esc(c.text)+'</span></div>';
  });
  h+='</div>';
  return h;
}
function renderStats(){
  const c=S.char;
  (function(){ var a=document.getElementById('avatarFace');
    if(c.faceImg){ a.textContent=''; a.style.backgroundImage='url("'+c.faceImg+'")';
      a.style.backgroundSize='cover'; a.style.backgroundPosition='center'; }
    else { a.style.backgroundImage=''; a.textContent=c.face; } })();
  document.getElementById('charName').textContent=c.name;
  document.getElementById('charLvl').textContent=c.lvl;
  document.getElementById('charClass').textContent=c.cls;
  document.getElementById('statGold').textContent=Math.floor(c.gold);
  document.getElementById('statMp').textContent=Math.floor(c.mp);
  document.getElementById('hpFill').style.width=clamp(c.hp/c.maxHp*100,0,100)+'%';
  document.getElementById('hpLab').textContent=Math.ceil(Math.max(0,c.hp))+' / '+c.maxHp+' HP';
  const need=xpToLevel(c.lvl);
  document.getElementById('xpFill').style.width=clamp(c.xp/need*100,0,100)+'%';
  document.getElementById('xpLab').textContent=Math.floor(c.xp)+' / '+need+' XP';
  document.body.classList.toggle('lowhp', c.hp/c.maxHp <= 0.3);
}
function metaRow(t){
  const notesPreview = (t.notes && S.prefs.notesLines>0)
    ? '<div class="notes" style="-webkit-line-clamp:'+S.prefs.notesLines+';line-clamp:'+S.prefs.notesLines+'">'+esc(t.notes)+'</div>' : '';
  return '<div class="meta"><span class="pill">'+t.difficulty+'</span></div>'+notesPreview+checklistBlock(t);
}
// the right-side rail: counter/streak + subtask toggle, pinned to top of card
function rail(t){
  let counter='';
  if(t.type==='daily'){ counter='<span class="railItem streak" title="Day streak">🔥 '+(t.streak||0)+'</span>'; }
  else if(t.type==='habit'){
    const up=t.up!==false, down=t.down!==false;
    if(up&&down) counter='<span class="railItem cnt" title="Today + / −">+'+(t.cUp||0)+'|−'+(t.cDown||0)+'</span>';
    else if(up)  counter='<span class="railItem cnt" title="Today +">+'+(t.cUp||0)+'</span>';
    else if(down)counter='<span class="railItem cnt" title="Today −">−'+(t.cDown||0)+'</span>';
  }
  const cl=(t.checklist||[]);
  let sub='';
  if(cl.length){
    const doneCl=cl.filter(c=>c.done).length;
    sub='<span class="subFrac'+(doneCl===cl.length?' full':'')+'" onclick="event.stopPropagation();toggleExpand(\''+t.id+'\')">'+
        '<b>'+doneCl+'</b><i></i><b>'+cl.length+'</b></span>';
  } else if(t.type==='daily'){
    // dailies: reserve the subtask-button slot so the streak stays left-aligned
    sub='<span class="subFrac placeholder" aria-hidden="true"></span>';
  }
  if(!counter && !sub) return '';
  return '<div class="rail">'+counter+sub+'</div>';
}
// Inline SVG coin — renders identically on every platform (no emoji-font dependency)
const COIN_SVG='<svg viewBox="0 0 24 24" width="22" height="22" aria-label="coin" role="img">'+
  '<circle cx="12" cy="12" r="10" fill="#ffbe5c" stroke="#c8862f" stroke-width="1.5"/>'+
  '<circle cx="12" cy="12" r="6.5" fill="none" stroke="#c8862f" stroke-width="1.2" opacity="0.7"/>'+
  '<text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="#7a4d12" font-family="serif">$</text></svg>';
function taskCard(t){
  const ccol=valColor(t.value)[1];
  const inner = t.done ? '<span class="ckmark">✓</span>' : '<span class="ckbox"></span>';
  return '<div class="task '+t.type+' '+(t.done?'done':'')+'" draggable="true" data-id="'+t.id+'" data-list="tasks">'+
    '<div class="valdot" style="background:'+ccol+'"></div>'+
    '<div class="check" onclick="toggle(\''+t.id+'\')">'+inner+'</div>'+
    '<div class="body" onclick="openEdit(\''+t.id+'\')"><div class="ttl">'+esc(t.title||'Untitled')+'</div>'+metaRow(t)+'</div>'+rail(t)+'</div>';
}
function habitCard(t){
  const ccol=valColor(t.value)[1];
  const up = t.up!==false, down = t.down!==false;
  return '<div class="task habit" draggable="true" data-id="'+t.id+'" data-list="tasks"><div class="valdot" style="background:'+ccol+'"></div>'+
    (up?'<div class="check hbtn up" onclick="scoreHabit(\''+t.id+'\',1)">+</div>':'<div class="check hbtn off">+</div>')+
    '<div class="body" onclick="openEdit(\''+t.id+'\')"><div class="ttl">'+esc(t.title||'Untitled')+'</div>'+metaRow(t)+'</div>'+rail(t)+
    (down?'<div class="check hbtn down" onclick="scoreHabit(\''+t.id+'\',-1)">−</div>':'<div class="check hbtn off">−</div>')+'</div>';
}
function colTitle(title, addType){
  const tabKey = addType==='habit'?'habits':addType==='daily'?'dailies':'todos';
  const defaultVal = tabKey==='todos'?'active':'all';
  const active = FILTER[tabKey]!==defaultVal;
  return '<div class="colTitle"><h2>'+title+'</h2>'+
    '<button class="filterIcon'+(FILTEROPEN?' open':'')+(active?' active':'')+'" title="Filter" onclick="toggleFilter()">🔽</button>'+
    '<button class="addBtn" onclick="openEdit(null,\''+addType+'\')">+</button></div>';
}
function filterBar(tab, opts){
  if(!FILTEROPEN) return '';
  return '<div class="filterBar">'+opts.map(o=>'<button class="'+(FILTER[tab]===o[1]?'on':'')+'" onclick="setFilter(\''+tab+'\',\''+o[1]+'\')">'+o[0]+'</button>').join('')+'</div>';
}
function setFilter(tab,val){ FILTER[tab]=val; S.prefs.filter=FILTER; save(); render(); }
function viewHabits(){
  let habits=S.tasks.filter(t=>t.type==='habit');
  const fl=FILTER.habits;
  if(fl==='weak') habits=habits.filter(t=>t.value<1);
  else if(fl==='strong') habits=habits.filter(t=>t.value>=1);
  const bar=filterBar('habits',[['All','all'],['Weak','weak'],['Strong','strong']]);
  return colTitle('Habits','habit')+bar+
    (habits.length?habits.map(habitCard).join(''):'<div class="empty">Nothing matches this filter.</div>');
}
function viewDailies(){
  let dailies=S.tasks.filter(t=>t.type==='daily');
  const fl=FILTER.dailies; const dow=new Date().getDay();
  const isScheduledToday=t=> !t.repeat || t.repeat[new Date().getDay()];
  if(fl==='due') dailies=dailies.filter(t=> isScheduledToday(t) && !t.done);
  else if(fl==='notdue') dailies=dailies.filter(t=> t.done || !isScheduledToday(t));
  const bar=filterBar('dailies',[['All','all'],['Due','due'],['Not Due','notdue']]);
  return colTitle('Dailies','daily')+bar+
    (dailies.length?dailies.map(taskCard).join(''):'<div class="empty">Nothing matches this filter.</div>');
}
function viewTodos(){
  const fl=FILTER.todos;
  const bar=filterBar('todos',[['Active','active'],['Complete','complete'],['All','all']]);
  let list;
  if(fl==='complete') list=S.tasks.filter(t=>t.type==='todo' && t.done);
  else if(fl==='all') list=S.tasks.filter(t=>t.type==='todo');
  else list=S.tasks.filter(t=>t.type==='todo' && !t.done);
  return colTitle('To-Dos','todo')+bar+
    (list.length?list.map(taskCard).join(''):'<div class="empty">Nothing matches this filter.</div>');
}
function viewRewards(){
  let h='<div class="colTitle"><h2>Shop</h2></div>'+
    '<div class="small" style="margin:0 4px 10px">Built-in items. Drink a potion to recover HP before a death wipes your gold and level.</div>';
  h+=SHOP_ITEMS.map(i=>'<div class="task shopitem"><div class="valdot" style="background:var(--hp)"></div>'+
    '<div class="check" onclick="buyShopItem(\''+i.id+'\')" title="Buy">'+i.icon+'</div>'+
    '<div class="body" onclick="buyShopItem(\''+i.id+'\')"><div class="ttl">'+i.title+'</div>'+
    '<div class="meta"><span class="pill">'+i.cost+' gold</span><span>'+i.desc+'</span></div></div></div>').join('');
  h+='<div class="colTitle"><h2>Your Rewards</h2><button class="addBtn" onclick="openReward(null)">+</button></div>'+
    '<div class="small" style="margin:0 4px 10px">Spend gold on real-life rewards you define yourself.</div>';
  h+= S.rewards.length ? S.rewards.map(r=>'<div class="task" draggable="true" data-id="'+r.id+'" data-list="rewards"><div class="valdot" style="background:var(--gold)"></div>'+
    '<div class="check coin" onclick="buyReward(\''+r.id+'\')" title="Buy">'+COIN_SVG+'</div>'+
    '<div class="body" onclick="openReward(\''+r.id+'\')"><div class="ttl">'+esc(r.title)+'</div>'+
    '<div class="meta"><span class="pill">'+r.cost+' gold</span>'+(r.notes?'<span>📝</span>':'')+'</div></div></div>').join('')
    : '<div class="empty">No rewards yet. Create one to spend your gold on.</div>';
  return h;
}

/* ============================================================
   ANALYTICS
   History points (from Habitica import):
     habit: {date:<ms>, value, scoredUp, scoredDown}
     daily: {date:<ms>, value, completed, isDue}
   scoredUp = "+ taps that day"; completed = real daily-completion flag.
   `value` is Habitica's internal score and is NOT used as a count.
   ============================================================ */
const DAY = 86400000;
function anPrefs(){
  S.prefs = S.prefs || {};
  if(!S.prefs.an) S.prefs.an = { fromOff:90, toOff:0, snap:'90d', metricKw:'klik' };
  const a=S.prefs.an;
  // saved named metrics (kliky, zdvihy, ...). Seed sensibly on first run.
  if(!a.metrics){
    a.metrics = [
      {id:uid(), name:'Kliky', keyword:'klik'},
      {id:uid(), name:'Zdvihy', keyword:'zdvih'}
    ];
  }
  if(a.activeMetric===undefined) a.activeMetric = a.metrics[0] ? a.metrics[0].id : null;
  return a;
}
function anActiveMetric(){
  const a=anPrefs();
  return a.metrics.find(m=>m.id===a.activeMetric) || a.metrics[0] || null;
}
// Normalize a metric argument: callers may pass a keyword string (legacy) or a
// metric object {name,keyword,exact,habits:[{id,reps}]}. Returns a matcher.
function anMatcher(arg){
  // string -> keyword matcher with title-number reps
  if(typeof arg==='string'){
    const kw=arg.trim().toLowerCase();
    return {
      match: e => e.type==='habit' && e.title.toLowerCase().includes(kw),
      reps:  e => e.reps,                 // already title-number based in events
      keyword: kw
    };
  }
  const m=arg||{};
  if(m.exact && Array.isArray(m.habits) && m.habits.length){
    // explicit habit membership + optional per-habit reps-per-tap override
    const map={}; m.habits.forEach(h=>{ map[h.id]= (h.reps==null||h.reps==='')? null : Number(h.reps); });
    return {
      match: e => e.type==='habit' && (e.taskId in map),
      reps:  e => { const ov=map[e.taskId]; return ov==null ? e.reps : ov*(e.scoredUp||0); },
      keyword: (m.keyword||'').toLowerCase()
    };
  }
  // default: keyword match, title-number reps
  const kw=(m.keyword||'').trim().toLowerCase();
  return {
    match: e => e.type==='habit' && e.title.toLowerCase().includes(kw),
    reps:  e => e.reps,
    keyword: kw
  };
}
function anAllEvents(){
  const ev=[];
  (S.tasks||[]).forEach(t=>{
    const rpt = t.repsPerTap || repsPerTap(t.title);
    (t.history||[]).forEach(p=>{
      if(!p || typeof p.date!=='number') return;
      const su=p.scoredUp||0;
      // prefer the enriched, exact `reps` field; fall back to title×taps for old saves
      const reps = ('reps' in p) ? (p.reps||0) : rpt*su;
      const repCounted = ('repCounted' in p) ? !!p.repCounted : (su>0);
      const scored = ('scored' in p && p.scored!==null) ? !!p.scored : (su>0 || p.completed===true);
      ev.push({ taskId:t.id, title:t.title, type:t.type, repsPerTap:rpt,
        date:p.date, value:p.value,
        scoredUp:su, scoredDown:p.scoredDown||0,
        reps:reps, repCounted:repCounted, scored:scored,
        reward:('reward' in p)? p.reward : null,
        checklist:('checklist' in p)? p.checklist : null,
        completed:('completed' in p)? !!p.completed : null });
    });
  });
  return ev;
}
function anSpan(){
  const ev=anAllEvents();
  if(!ev.length){ const now=Date.now(); return [now-90*DAY, now]; }
  let mn=Infinity,mx=-Infinity;
  ev.forEach(e=>{ if(e.date<mn)mn=e.date; if(e.date>mx)mx=e.date; });
  return [mn, Math.max(mx, Date.now())];
}
function anWindow(){
  const p=anPrefs(); const now=Date.now();
  const [mn]=anSpan();
  let to=now - (p.toOff||0)*DAY;
  let from=now - (p.fromOff||90)*DAY;
  if(p.snap==='all'){ from=mn; to=now; }
  if(from<mn) from=mn;
  if(to>now) to=now;
  if(from>to) from=to;
  return [from,to];
}
function repsPerTap(title){ const m=(title||'').match(/\d+/); return m?parseInt(m[0],10):1; }
function repsPerTapTitle(t){ return t; }
function anCumulativeReps(metric,from,to){
  const M=anMatcher(metric);
  const ev=anAllEvents().filter(e=>M.match(e) && e.date>=from && e.date<=to);
  let total=0, taps=0, missingTapPts=0, activityDays=0;
  const byTask={};
  ev.forEach(e=>{
    const r=M.reps(e);
    total += r; taps += e.scoredUp;
    if(e.scored) activityDays++;          // a recorded day = activity, exact-reps or not
    if(!e.repCounted && e.scored) missingTapPts++;  // active but no exact rep count
    byTask[e.title]=(byTask[e.title]||0)+r;
  });
  return {total,taps,byTask,missingTapPts,activityDays,matched:Object.keys(byTask).length};
}
function anRepsSeries(metric,from,to){
  const M=anMatcher(metric);
  const buckets={};
  anAllEvents().forEach(e=>{
    if(!M.match(e))return;
    if(e.date<from||e.date>to)return;
    const day=Math.floor(e.date/DAY)*DAY;
    buckets[day]=(buckets[day]||0)+M.reps(e);
  });
  return Object.keys(buckets).sort((a,b)=>a-b).map(d=>({d:+d,v:buckets[d]}));
}
// value/score trend per metric: avg habit value per day (real, continuous since 2025)
function anValueSeries(metric,from,to){
  const M=anMatcher(metric);
  const day={};
  anAllEvents().forEach(e=>{
    if(!M.match(e))return;
    if(e.date<from||e.date>to||e.value==null)return;
    const d=Math.floor(e.date/DAY)*DAY;
    day[d]=day[d]||{sum:0,n:0};
    day[d].sum+=e.value; day[d].n++;
  });
  return Object.keys(day).sort((a,b)=>a-b).map(d=>({d:+d,v:day[d].sum/day[d].n}));
}
// activity-day series (1 if any matching habit was scored that day) for the metric
function anActivitySeries(metric,from,to){
  const M=anMatcher(metric);
  const day={};
  anAllEvents().forEach(e=>{
    if(!M.match(e))return;
    if(e.date<from||e.date>to||!e.scored)return;
    day[Math.floor(e.date/DAY)*DAY]=1;
  });
  return Object.keys(day).map(Number).sort((a,b)=>a-b);
}
// per-year and per-month rollups of reps for a metric
function anRollup(kw,mode){
  const [mn]=anSpan();
  const series=anRepsSeries(kw,mn,Date.now());
  const b={};
  series.forEach(s=>{ const dt=new Date(s.d);
    const key = mode==='year' ? ''+dt.getFullYear()
              : dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0');
    b[key]=(b[key]||0)+s.v; });
  return Object.keys(b).sort().map(k=>({label:k,v:b[k]}));
}
function anAdherenceSeries(from,to){
  const day={};
  anAllEvents().forEach(e=>{
    if(e.type!=='daily'||e.completed===null)return;
    if(e.date<from||e.date>to)return;
    const d=Math.floor(e.date/DAY)*DAY;
    day[d]=day[d]||{done:0,tot:0};
    day[d].tot++; if(e.completed) day[d].done++;
  });
  return Object.keys(day).sort((a,b)=>a-b).map(d=>({d:+d,pct:day[d].tot?day[d].done/day[d].tot:0,done:day[d].done,tot:day[d].tot}));
}
function anIntensity(from,to){
  const day={};
  anAllEvents().forEach(e=>{
    if(e.date<from||e.date>to)return;
    const d=Math.floor(e.date/DAY)*DAY;
    let w=e.scoredUp||0; if(e.completed) w+=1;
    if(w>0) day[d]=(day[d]||0)+w;
  });
  return day;
}
function anStreaks(){
  return (S.tasks||[]).filter(t=>t.type==='daily').map(t=>({title:t.title,streak:t.streak||0}))
    .sort((a,b)=>b.streak-a.streak);
}
// lifetime milestones for a metric keyword (ignores window — all-time)
function anMilestones(kw){
  const [mn,mx]=anSpan();
  const r=anCumulativeReps(kw,mn,Date.now());
  const series=anRepsSeries(kw,mn,Date.now());
  let biggest={d:null,v:0};
  series.forEach(s=>{ if(s.v>biggest.v) biggest={d:s.d,v:s.v}; });
  const activityDays = anActivitySeries(kw,mn,Date.now()).length; // real scoring-days
  const repDays = series.filter(s=>s.v>0).length;                 // days with exact reps
  const firstDate = series.length? series[0].d : (anActivitySeries(kw,mn,Date.now())[0]||null);
  return { total:r.total, taps:r.taps, biggestDay:biggest, activityDays, repDays, firstDate, matched:r.matched };
}
// group reps into weekly or monthly buckets within window -> [{label,v}]
function anBreakdown(kw,from,to,mode){
  const series=anRepsSeries(kw,from,to);
  const buckets={};
  series.forEach(s=>{
    const d=new Date(s.d); let key;
    if(mode==='month'){ key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); }
    else { // ISO-ish week: year + week number (Mon start)
      const x=new Date(d); const day=(x.getDay()+6)%7; x.setDate(x.getDate()-day);
      key=x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');
    }
    buckets[key]=(buckets[key]||0)+s.v;
  });
  return Object.keys(buckets).sort().map(k=>({label:k,v:buckets[k]}));
}
// per-metric totals in window for all saved metrics -> [{name,keyword,total,taps}]
function anAllMetricTotals(from,to){
  return anPrefs().metrics.map(m=>{
    const r=anCumulativeReps(m,from,to);
    return {id:m.id,name:m.name,keyword:m.keyword,total:r.total,taps:r.taps,matched:r.matched};
  });
}
// daily series for several metrics, aligned on the same day axis (for comparison chart)
function anCompareSeries(from,to){
  const metrics=anPrefs().metrics;
  const dayset=new Set();
  const per={};
  metrics.forEach(m=>{ per[m.id]={}; anRepsSeries(m,from,to).forEach(s=>{ per[m.id][s.d]=s.v; dayset.add(s.d); }); });
  const days=[...dayset].sort((a,b)=>a-b);
  return { days, metrics, per };
}
function fmtDate(ms){ const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
// tips: optional array of strings aligned to series (after cumulative transform) for hover
function svgSpark(series,cumulative,color,h,tips){
  h=h||60; const w=300;
  if(!series.length) return '<svg viewBox="0 0 '+w+' '+h+'"><text x="'+(w/2)+'" y="'+(h/2)+'" fill="var(--muted)" font-size="11" text-anchor="middle">No data in this window</text></svg>';
  let pts=series.map(s=>s.v), run=0;
  if(cumulative) pts=pts.map(v=>run+=v);
  const max=Math.max(1,...pts);
  const n=pts.length;
  const X=i=> n===1? w/2 : (i/(n-1))*w;
  const Y=v=> h-4-(v/max)*(h-10);
  let dLine='', dArea='M0 '+h+' ';
  pts.forEach((v,i)=>{ const x=X(i).toFixed(1),y=Y(v).toFixed(1);
    dLine+=(i?'L':'M')+x+' '+y+' '; dArea+='L'+x+' '+y+' '; });
  dArea+='L'+w+' '+h+' Z';
  // invisible hover hit-areas only (keep the line clean — no visible points)
  let dots='';
  if(tips && tips.length){
    pts.forEach((v,i)=>{ const x=X(i).toFixed(1), y=Y(v).toFixed(1);
      dots+='<circle class="spkHit" cx="'+x+'" cy="'+y+'" r="14" fill="transparent" data-tip="'+esc(tips[i]||'')+'"/>'; });
  }
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+
    '<path d="'+dArea+'" fill="'+color+'" opacity="0.18"/>'+
    '<path d="'+dLine+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'+
    dots+'</svg>';
}
function heatColor(v,max){
  if(!v) return 'var(--panel2)';
  const t=Math.min(1,v/Math.max(1,max));
  const stops=['#5b3a86','#6f4ddb','#8a5cff','#a98bff','#bda8ff'];
  const idx=Math.min(stops.length-1, Math.floor(t*(stops.length-1))+1);
  return stops[idx];
}
const METRIC_COLORS=['#bda8ff','#50b5e9','#48b677','#ffbe5c','#f9a03f','#f74e52','#74b6e0'];
// multi-line cumulative comparison chart
function svgCompare(cmp){
  const w=300,h=110;
  const all=[];
  cmp.metrics.forEach(m=>{ let run=0; cmp.days.forEach(d=>{ run+=(cmp.per[m.id][d]||0); all.push(run); }); });
  const max=Math.max(1,...all);
  if(!cmp.days.length) return '<svg viewBox="0 0 '+w+' '+h+'"><text x="'+(w/2)+'" y="'+(h/2)+'" fill="var(--muted)" font-size="11" text-anchor="middle">No data in this window</text></svg>';
  const n=cmp.days.length;
  const X=i=> n===1? w/2 : (i/(n-1))*w;
  const Y=v=> h-4-(v/max)*(h-12);
  let paths='', hits='';
  cmp.metrics.forEach((m,mi)=>{
    let run=0,d='';
    cmp.days.forEach((day,i)=>{ run+=(cmp.per[m.id][day]||0); const x=X(i).toFixed(1), y=Y(run).toFixed(1);
      d+=(i?'L':'M')+x+' '+y+' ';
      hits+='<circle class="spkHit" cx="'+x+'" cy="'+y+'" r="14" fill="transparent" data-tip="'+esc('📈 '+m.name+'\n📅 '+fmtDate(day)+'\n∑ '+run.toLocaleString()+' total')+'"/>'; });
    paths+='<path d="'+d+'" fill="none" stroke="'+METRIC_COLORS[mi%METRIC_COLORS.length]+'" stroke-width="2" stroke-linejoin="round"/>';
  });
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+paths+hits+'</svg>';
}
// simple vertical bar chart from [{label,v}]
function svgBars(data,color){
  const w=300,h=90;
  if(!data.length) return '<svg viewBox="0 0 '+w+' '+h+'"><text x="'+(w/2)+'" y="'+(h/2)+'" fill="var(--muted)" font-size="11" text-anchor="middle">No data</text></svg>';
  const max=Math.max(1,...data.map(d=>d.v));
  const n=data.length, slot=w/n, bw=Math.max(2,slot*0.66), gap=slot-bw;
  const base=h-1, top=4, plot=base-top, minBar=2, rad=Math.min(2,bw/2);
  let bars='', hits='';
  data.forEach((d,i)=>{
    let bh=(d.v/max)*plot; if(d.v>0) bh=Math.max(minBar,bh);   // keep tiny non-zero bars visible
    const x=i*slot+gap/2; const y=base-bh;
    const tip=esc('📊 '+d.label+'\n🔁 '+d.v.toLocaleString()+' reps');
    // round only the top corners; bar sits on a common baseline
    const r=Math.min(rad,bh);
    const path='M'+x.toFixed(1)+' '+base.toFixed(1)
      +' V'+(y+r).toFixed(1)
      +' Q'+x.toFixed(1)+' '+y.toFixed(1)+' '+(x+r).toFixed(1)+' '+y.toFixed(1)
      +' H'+(x+bw-r).toFixed(1)
      +' Q'+(x+bw).toFixed(1)+' '+y.toFixed(1)+' '+(x+bw).toFixed(1)+' '+(y+r).toFixed(1)
      +' V'+base.toFixed(1)+' Z';
    bars+='<path class="bar" data-i="'+i+'" d="'+path+'" fill="'+color+'"/>';
    // full-height invisible hit-area so the whole column is selectable
    hits+='<rect class="barHit" data-i="'+i+'" x="'+(i*slot).toFixed(1)+'" y="0" width="'+slot.toFixed(1)+'" height="'+h+'" fill="transparent" data-tip="'+tip+'"/>'; });
  // baseline rule
  const axis='<line x1="0" y1="'+base+'" x2="'+w+'" y2="'+base+'" stroke="var(--line)" stroke-width="0.5"/>';
  return '<svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="xMidYMax meet">'+axis+bars+hits+'</svg>';
}
function viewAnalytics(){
  const p=anPrefs();
  let h='<div class="anWrap">';
  h+='<div class="anHead"><h2>&#128202; Analytics</h2><span class="anRangeLbl" id="anRangeLbl"></span></div>';
  const chips=[['7d','7d'],['30d','30d'],['90d','90d'],['1y','365d'],['All','all']];
  h+='<div class="anChips" id="anSnapChips">'+chips.map(c=>'<span class="anChip'+(p.snap===c[1]?' on':'')+'" data-snap="'+c[1]+'">'+c[0]+'</span>').join('')+'</div>';
  h+='<div class="anSlider" id="anSlider">'+
       '<div class="anTrack"></div><div class="anFill" id="anFill"></div>'+
       '<div class="anHandle" id="anH0"></div><div class="anHandle" id="anH1"></div>'+
       '<div class="anTicks"><span id="anTickL"></span><span id="anTickR"></span></div>'+
     '</div>';
  // saved-metric selector chips + manage button
  h+='<div class="anSection">Saved metrics</div>';
  h+='<div class="anChips" id="anMetricChips">'+
     p.metrics.map(m=>'<span class="anChip'+(m.id===p.activeMetric?' on':'')+'" data-mid="'+m.id+'">'+esc(m.name)+'</span>').join('')+
     '<span class="anChip" id="anMetricAdd" style="border-style:dashed">+ add</span></div>';
  h+='<div id="anMetricEdit"></div>';
  h+='<div id="anBody"></div>';
  h+='</div>';
  return h;
}
let _anBound=false;
function initAnalytics(){
  const p=anPrefs();
  const [mn,mx]=anSpan();
  const slider=document.getElementById('anSlider'); if(!slider)return;
  const h0=document.getElementById('anH0'), h1=document.getElementById('anH1');
  const fill=document.getElementById('anFill');
  const totalDays=Math.max(1,Math.round((mx-mn)/DAY));
  function offToFrac(off){ const t=Date.now()-off*DAY; return clamp((t-mn)/(mx-mn),0,1); }
  function fracToOff(fr){ const t=mn+fr*(mx-mn); return Math.round((Date.now()-t)/DAY); }
  function layout(){
    const w=slider.clientWidth||300;
    let f0=offToFrac(p.fromOff), f1=offToFrac(p.toOff);
    if(f0>f1){const t=f0;f0=f1;f1=t;}
    h0.style.left=(f0*w)+'px'; h1.style.left=(f1*w)+'px';
    fill.style.left=(f0*w)+'px'; fill.style.width=((f1-f0)*w)+'px';
    const [from,to]=anWindow();
    const lbl=document.getElementById('anRangeLbl');
    if(lbl) lbl.textContent=fmtDate(from)+' → '+fmtDate(to);
    document.getElementById('anTickL').textContent=fmtDate(mn);
    document.getElementById('anTickR').textContent='today';
  }
  function drag(handle,which){
    const onMove=(clientX)=>{
      const r=slider.getBoundingClientRect();
      const fr=clamp((clientX-r.left)/r.width,0,1);
      const off=fracToOff(fr);
      if(which===0) p.fromOff=off; else p.toOff=off;
      p.snap=null;
      document.querySelectorAll('#anSnapChips .anChip').forEach(c=>c.classList.remove('on'));
      layout(); refreshAnalytics(); save();
    };
    const mm=e=>{ e.preventDefault(); onMove(e.touches?e.touches[0].clientX:e.clientX); };
    const up=()=>{ document.removeEventListener('mousemove',mm); document.removeEventListener('mouseup',up);
      document.removeEventListener('touchmove',mm); document.removeEventListener('touchend',up); };
    const down=e=>{ e.preventDefault();
      document.addEventListener('mousemove',mm); document.addEventListener('mouseup',up);
      document.addEventListener('touchmove',mm,{passive:false}); document.addEventListener('touchend',up); };
    handle.addEventListener('mousedown',down); handle.addEventListener('touchstart',down,{passive:false});
  }
  drag(h0,0); drag(h1,1);
  document.querySelectorAll('#anSnapChips .anChip').forEach(c=>{
    c.onclick=()=>{ const s=c.dataset.snap; p.snap=s;
      if(s==='all'){ p.fromOff=totalDays; p.toOff=0; }
      else { p.fromOff=parseInt(s); p.toOff=0; }
      document.querySelectorAll('#anSnapChips .anChip').forEach(x=>x.classList.toggle('on',x===c));
      layout(); refreshAnalytics(); save();
    };
  });
  bindMetricChips();
  layout(); refreshAnalytics();
  if(!_anBound){ window.addEventListener('resize',()=>{ if(TAB==='analytics') layout(); }); _anBound=true; }
}
// bind metric selector chips + add/edit form
function bindMetricChips(){
  const p=anPrefs();
  document.querySelectorAll('#anMetricChips .anChip[data-mid]').forEach(c=>{
    c.onclick=()=>{ p.activeMetric=c.dataset.mid;
      document.querySelectorAll('#anMetricChips .anChip').forEach(x=>x.classList.toggle('on',x===c));
      document.getElementById('anMetricEdit').innerHTML='';
      refreshAnalytics(); save();
    };
    // long-press / double-click to edit
    c.ondblclick=()=>openMetricEditor(c.dataset.mid);
  });
  const add=document.getElementById('anMetricAdd');
  if(add) add.onclick=()=>openMetricEditor(null);
}
// working draft of the metric being edited (so the habit picker can mutate it live)
let MEDIT=null;
function openMetricEditor(mid){
  const p=anPrefs();
  const src = mid ? p.metrics.find(x=>x.id===mid) : {id:null,name:'',keyword:'',exact:false,habits:[]};
  // deep-ish copy into MEDIT
  MEDIT = { id:src.id, name:src.name||'', keyword:src.keyword||'', exact:!!src.exact,
            habits:(src.habits||[]).map(h=>({id:h.id, reps:(h.reps==null?'':h.reps)})), _mid:mid };
  drawMetricEditor();
}
function drawMetricEditor(){
  const box=document.getElementById('anMetricEdit'); if(!box)return;
  const m=MEDIT;
  let h='<div class="anCard full mEditor">';
  h+='<div class="mEditTitle">'+(m._mid?'Edit metric':'New metric')+'</div>';
  h+='<label class="mField"><span class="mLabel">Name</span>'+
     '<input type="text" id="mName" placeholder="e.g. Zdvihy" value="'+esc(m.name)+'"></label>';
  // mode toggle: Keyword vs Exact
  h+='<div class="mLabel" style="margin-top:12px">How habits are matched</div>';
  h+='<div class="mModeToggle">'+
       '<button type="button" class="mModeBtn'+(!m.exact?' on':'')+'" data-exact="0">By keyword</button>'+
       '<button type="button" class="mModeBtn'+(m.exact?' on':'')+'" data-exact="1">Pick exact habits</button>'+
     '</div>';
  if(!m.exact){
    h+='<label class="mField"><span class="mLabel">Habit title contains</span>'+
       '<input type="text" id="mKw" placeholder="e.g. zdvih" value="'+esc(m.keyword)+'" autocomplete="off"></label>';
    h+='<div class="mHint">Counts the number in each matching habit title × your + taps.</div>';
  } else {
    h+='<div class="mHint">Pick the habits to include. Each habit’s reps-per-tap defaults to the number in its title — set a value to override.</div>';
    // selected section first (the result), then the picker
    h+='<div class="mSubhead"><span>Selected</span><span id="mSelCount" class="mCount">0</span></div>';
    h+='<div id="mSelected" class="mSelList"></div>';
    h+='<div class="mSubhead" style="margin-top:12px">Add habits</div>';
    h+='<div class="mSearchWrap"><input type="text" id="mFilter" placeholder="Search habits…" autocomplete="off"></div>';
    h+='<div id="mHabitList" class="mPickList"></div>';
  }
  h+='<div class="mActions">'+
      '<button class="btn primary" id="mSave">Save</button>'+
      '<button class="btn ghost" id="mCancel">Cancel</button>'+
      (m._mid?'<button class="btn danger" id="mDel" style="margin-left:auto">Delete</button>':'')+
    '</div></div>';
  box.innerHTML=h;

  document.getElementById('mName').oninput=e=>{ MEDIT.name=e.target.value; };
  document.querySelectorAll('.mModeBtn').forEach(btn=>{
    btn.onclick=()=>{
      const wantExact=btn.dataset.exact==='1';
      if(wantExact===MEDIT.exact) return;
      if(document.getElementById('mKw')) MEDIT.keyword=document.getElementById('mKw').value;
      MEDIT.exact=wantExact;
      drawMetricEditor();
    };
  });
  if(!m.exact){
    document.getElementById('mKw').oninput=e=>{ MEDIT.keyword=e.target.value; };
  } else {
    const filt=document.getElementById('mFilter');
    filt.oninput=()=>renderHabitPicker(filt.value);
    renderHabitPicker('');
    renderSelectedHabits();
  }
  document.getElementById('mSave').onclick=saveMetricEditor;
  if(m._mid){ document.getElementById('mDel').onclick=()=>{
    const p=anPrefs();
    p.metrics=p.metrics.filter(x=>x.id!==m._mid);
    if(p.activeMetric===m._mid) p.activeMetric=p.metrics[0]?p.metrics[0].id:null;
    MEDIT=null; save(); render();
  };}
  document.getElementById('mCancel').onclick=()=>{ MEDIT=null; document.getElementById('anMetricEdit').innerHTML=''; };
}
function renderHabitPicker(filter){
  const list=document.getElementById('mHabitList'); if(!list)return;
  const f=(filter||'').trim().toLowerCase();
  const chosen=new Set(MEDIT.habits.map(h=>h.id));
  // show habits not yet selected; filter by contains
  const habits=(S.tasks||[]).filter(t=>t.type==='habit' && !chosen.has(t.id) && (!f || t.title.toLowerCase().includes(f)));
  if(!habits.length){ list.innerHTML='<div class="mEmpty">'+(f?'No matching habits.':'All habits added.')+'</div>'; return; }
  list.innerHTML=habits.slice(0,50).map(t=>{
    const tn=t.repsPerTap||repsPerTap(t.title);
    return '<button type="button" class="mPickItem" data-hid="'+t.id+'">'+
      '<span class="mPickName">'+esc(t.title)+'</span>'+
      '<span class="mPickAdd">+ add</span></button>';
  }).join('');
  list.querySelectorAll('.mPickItem').forEach(el=>{
    el.onclick=()=>{ MEDIT.habits.push({id:el.dataset.hid, reps:''});
      renderHabitPicker(document.getElementById('mFilter').value);
      renderSelectedHabits();
    };
  });
}
function renderSelectedHabits(){
  const wrap=document.getElementById('mSelected'); if(!wrap)return;
  const cnt=document.getElementById('mSelCount'); if(cnt) cnt.textContent=MEDIT.habits.length;
  if(!MEDIT.habits.length){ wrap.innerHTML='<div class="mEmpty">No habits selected yet — add some below.</div>'; return; }
  wrap.innerHTML=MEDIT.habits.map(h=>{
    const t=(S.tasks||[]).find(x=>x.id===h.id);
    const titleNum=t? (t.repsPerTap||repsPerTap(t.title)) : '';
    return '<div class="mSelRow">'+
      '<button type="button" class="mSelRemove" data-hid="'+h.id+'" title="Remove">×</button>'+
      '<span class="mSelName">'+esc(t?t.title:h.id)+'</span>'+
      '<span class="mSelReps"><input type="number" min="0" class="mReps" data-hid="'+h.id+'" value="'+(h.reps===''?'':h.reps)+'" placeholder="'+titleNum+'"><span class="mSelUnit">/tap</span></span>'+
      '</div>';
  }).join('');
  wrap.querySelectorAll('.mReps').forEach(inp=>{
    inp.oninput=()=>{ const hh=MEDIT.habits.find(x=>x.id===inp.dataset.hid); if(hh) hh.reps=inp.value; };
  });
  wrap.querySelectorAll('.mSelRemove').forEach(btn=>{
    btn.onclick=()=>{ const i=MEDIT.habits.findIndex(x=>x.id===btn.dataset.hid); if(i>=0)MEDIT.habits.splice(i,1);
      renderSelectedHabits(); renderHabitPicker(document.getElementById('mFilter').value);
    };
  });
}
function saveMetricEditor(){
  const p=anPrefs(); const m=MEDIT;
  const name=(document.getElementById('mName').value||'').trim();
  if(!name){ toast('Name required'); return; }
  if(m.exact){
    if(!m.habits.length){ toast('Pick at least one habit'); return; }
  } else {
    m.keyword=(document.getElementById('mKw').value||'').trim();
    if(!m.keyword){ toast('Keyword required'); return; }
  }
  // normalize habit reps: '' -> null (read from title)
  const habits=m.habits.map(h=>({id:h.id, reps:(h.reps===''||h.reps==null)?null:Number(h.reps)}));
  if(m._mid){
    const tgt=p.metrics.find(x=>x.id===m._mid);
    tgt.name=name; tgt.keyword=m.keyword; tgt.exact=m.exact; tgt.habits=habits;
  } else {
    const nm={id:uid(), name, keyword:m.keyword, exact:m.exact, habits};
    p.metrics.push(nm); p.activeMetric=nm.id;
  }
  MEDIT=null; save(); render();
}
function refreshAnalytics(){
  const p=anPrefs(); const [from,to]=anWindow();
  const body=document.getElementById('anBody'); if(!body)return;
  const days=Math.max(1,Math.round((to-from)/DAY));
  let h='';
  const M=anActiveMetric();
  const kw = M ? (M.exact ? (M.name) : (M.keyword||'')) : '';  // for display text only
  const mname = M ? M.name : '(no metric)';
  const reps=anCumulativeReps(M,from,to);
  const series=anRepsSeries(M,from,to);
  const mile=anMilestones(M);
  // --- active metric: totals over time ---
  h+='<div class="anSection">'+esc(mname)+' &mdash; totals over time</div>';
  h+='<div class="anCards">';
  h+='<div class="anCard"><div class="k">In window</div><div class="v">'+reps.total.toLocaleString()+'</div>'+
     '<div class="sub">'+reps.taps+' taps · '+days+'d</div></div>';
  h+='<div class="anCard"><div class="k">Per-day avg</div><div class="v">'+Math.round(reps.total/days).toLocaleString()+'</div>'+
     '<div class="sub">in this window</div></div>';
  // cumulative tips: running total per day
  let _run=0; const cumTips=series.map(s=>{ _run+=s.v; return '📅 '+fmtDate(s.d)+'\n∑ '+_run.toLocaleString()+' total'; });
  h+='<div class="anCard full"><div class="k">Cumulative over window</div>'+svgSpark(series,true,'var(--accent)',70,cumTips)+'</div>';
  h+='</div>';
  if(reps.matched){
    h+='<div class="anNote">Matched habits: '+Object.keys(reps.byTask).map(t=>esc(t)+' ('+reps.byTask[t]+')').join(', ')+'.</div>';
  } else {
    h+='<div class="anNote">No habits contain "'+esc(kw)+'" in this window. Edit the metric (double-tap its chip) or pick a keyword that appears in a habit title.</div>';
  }
  if(reps.missingTapPts){
    h+='<div class="anNote">Note: '+reps.missingTapPts+' older imported point(s) predate Habitica logging individual + taps, so those reps are not counted. Newer activity is exact.</div>';
  }
  // --- lifetime milestones (all-time, this metric) ---
  h+='<div class="anSection">'+esc(mname)+' &mdash; lifetime milestones (since '+(mile.firstDate?fmtDate(mile.firstDate):'—')+')</div>';
  h+='<div class="anCards">';
  h+='<div class="anCard"><div class="k">All-time reps</div><div class="v">'+mile.total.toLocaleString()+'</div><div class="sub">'+mile.taps+' taps</div></div>';
  h+='<div class="anCard"><div class="k">Biggest day</div><div class="v">'+(mile.biggestDay.v||0).toLocaleString()+'</div><div class="sub">'+(mile.biggestDay.d?fmtDate(mile.biggestDay.d):'—')+'</div></div>';
  h+='<div class="anCard"><div class="k">Activity days</div><div class="v">'+mile.activityDays.toLocaleString()+'</div><div class="sub">days you did it</div></div>';
  h+='<div class="anCard"><div class="k">Exact-rep days</div><div class="v">'+mile.repDays.toLocaleString()+'</div><div class="sub">of '+mile.activityDays+' active</div></div>';
  h+='</div>';
  if(mile.activityDays>mile.repDays){
    h+='<div class="anNote">'+(mile.activityDays-mile.repDays)+' active day(s) have no exact tap count in the Habitica export (exact-only policy: they count as activity but contribute 0 reps, so totals are a verified floor, never estimated).</div>';
  }
  // --- reps per day (non-cumulative): repetitions done on each day ---
  const daily=anRepsSeries(M,from,to);            // {d, v=reps that day}
  const dailyTips=daily.map(s=>'📅 '+fmtDate(s.d)+'\n🔁 '+s.v.toLocaleString()+' reps');
  h+='<div class="anSection">'+esc(mname)+' &mdash; reps per day</div>';
  h+='<div class="anCard full"><div class="k">Repetitions done each day</div>'+svgSpark(daily,false,'var(--mp)',60,dailyTips)+'</div>';
  // --- weekly / monthly breakdown ---
  const bdMode = days>120 ? 'month' : 'week';
  const bd=anBreakdown(M,from,to,bdMode);
  h+='<div class="anSection">'+esc(mname)+' &mdash; by '+bdMode+'</div>';
  h+='<div class="anCard full">'+svgBars(bd,'var(--accent)')+'</div>';
  // --- per-year & per-month rollups (all-time) ---
  const yr=anRollup(M,'year');
  h+='<div class="anSection">'+esc(mname)+' &mdash; per-year totals</div>';
  h+='<div class="anCards">';
  yr.forEach(y=>{ h+='<div class="anCard"><div class="k">'+y.label+'</div><div class="v">'+y.v.toLocaleString()+'</div><div class="sub">reps</div></div>'; });
  if(!yr.length) h+='<div class="anNote">No reps recorded yet.</div>';
  h+='</div>';
  // --- all-metrics comparison ---
  const totals=anAllMetricTotals(from,to);
  const cmp=anCompareSeries(from,to);
  h+='<div class="anSection">All metrics &mdash; comparison</div>';
  h+='<div class="anCard full"><div class="k">Cumulative (all metrics, this window)</div>'+svgCompare(cmp)+'</div>';
  h+='<div class="anCards">';
  totals.forEach((t,i)=>{ h+='<div class="anCard"><div class="k" style="color:'+METRIC_COLORS[i%METRIC_COLORS.length]+'">'+esc(t.name)+'</div>'+
     '<div class="v">'+t.total.toLocaleString()+'</div><div class="sub">'+t.taps+' taps</div></div>'; });
  h+='</div>';
  const adh=anAdherenceSeries(from,to);
  const avgPct=adh.length? Math.round(adh.reduce((s,a)=>s+a.pct,0)/adh.length*100):0;
  h+='<div class="anSection">Daily adherence</div>';
  h+='<div class="anCards"><div class="anCard"><div class="k">Avg completion</div><div class="v">'+avgPct+'%</div>'+
     '<div class="sub">'+adh.length+' tracked days</div></div>'+
     '<div class="anCard"><div class="k">Days logged</div><div class="v">'+adh.length+'</div><div class="sub">with due dailies</div></div>'+
     '<div class="anCard full"><div class="k">Completion % over window</div>'+
       svgSpark(adh.map(a=>({d:a.d,v:a.pct*100})),false,'var(--green)',70,
         adh.map(a=>'📅 '+fmtDate(a.d)+'\n✅ '+Math.round(a.pct*100)+'% complete\n☑️ '+a.done+' of '+a.tot+' dailies'))+'</div></div>';
  const inten=anIntensity(from,to);
  const maxI=Math.max(1,...Object.values(inten));
  h+='<div class="anSection">Activity heatmap</div>';
  h+=anHeatmapHTML(from,to,inten,maxI);
  h+='<div class="anLegend">Less <i style="background:var(--panel2)"></i><i style="background:#6f4ddb"></i><i style="background:#8a5cff"></i><i style="background:#a98bff"></i><i style="background:#bda8ff"></i> More</div>';
  h+='<div class="anSection">Streak leaderboard</div>';
  const st=anStreaks();
  if(st.length) h+=st.slice(0,12).map(s=>'<div class="anStreak"><span class="t">'+esc(s.title)+'</span><span class="s">&#128293; '+s.streak+'</span></div>').join('');
  else h+='<div class="anNote">No dailies yet.</div>';
  h+='<div class="anNote">History reflects dated value/tap snapshots from Habitica (engagement events), not a per-calendar-day completion grid. Counts shown are from logged + taps and completion flags.</div>';
  // --- event-driven detail (IndexedDB) -------------------------------
  // Renders asynchronously: shows a loading state first, then fills once the
  // IDB read resolves. Powered by the append-only event log, which captures
  // detail history arrays cannot: per-subtask completion (name + time of day),
  // individual habit-tap times, per-completion reward, miss-time partial state.
  h+='<div class="anSection">&#128203; Event log detail (live)</div>';
  h+='<div id="anEventDetail" class="anCard full"><div class="k">From IndexedDB event log</div>'+
     '<div class="anNote">Loading events&hellip;</div></div>';
  body.innerHTML=h;
  bindHeatTooltips();
  bindTips('.spkPt'); bindTips('.spkHit'); bindTips('.barHit');
  renderEventDetail(from,to);   // async; fills #anEventDetail when ready
}
// Async, event-driven dashboard section. Proves the IDB read API end to end on
// the data of interest: the "Kliky - aspoň 50" daily. Shows per-day completion
// and, where subtask events exist, which subtasks were checked and at what time
// of day. Falls back gracefully when there are no events yet (fresh install) or
// IDB is unavailable. Existing history-based charts above are untouched.
function findKlikyTask(){
  return (S.tasks||[]).find(t=>/kliky/i.test(t.title||''))
      || (S.tasks||[]).find(t=>/klik/i.test(t.title||'')) || null;
}
function timeOfDay(ts){ const d=new Date(ts); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function taskTitleById(id){ const t=(S.tasks||[]).find(x=>x.id===id); return t?t.title:'(deleted task)'; }
// Event-detail view state (survives the async re-render).
let _evTaskId=null;     // currently selected task id (null = auto-pick)
let _evPage=0;          // current page of days
let _evWin=null;        // [from,to] of the last render (to detect window change)
const EV_PAGE_SIZE=14;  // days per page
function evPickTask(id){ _evTaskId=id||null; _evPage=0; if(_evWin) renderEventDetail(_evWin[0],_evWin[1]); }
function evGoPage(n){ _evPage=Math.max(0,n); if(_evWin) renderEventDetail(_evWin[0],_evWin[1]); }
// Async, event-driven dashboard section. Lets you pick ANY task that has events
// in the current window (defaults to Kliky), respects the date-window slider,
// and pages the per-day breakdown. Shows per-day completion and, where subtask
// events exist, which subtasks were checked and at what time of day. Degrades
// gracefully on a fresh install (no events) or when IDB is unavailable. The
// existing history-based charts above are untouched.
function renderEventDetail(from,to){
  const box=document.getElementById('anEventDetail'); if(!box) return;
  _evWin=[from,to];
  getEvents({from:from, to:to}).then(all=>{
    const cur=document.getElementById('anEventDetail'); if(!cur) return; // tab changed
    if(!all.length){
      cur.innerHTML='<div class="k">From IndexedDB event log</div>'+
        '<div class="anNote">No events recorded in this window yet. Tap a habit, check a subtask, or complete a daily and it will appear here '+
        '(the event log starts empty by design and fills as you use the app). If you imported a backup or loaded the backfill, widen the date window above.</div>';
      return;
    }
    const counts={};
    all.forEach(e=>{ if(e.taskId) counts[e.taskId]=(counts[e.taskId]||0)+1; });
    const taskIds=Object.keys(counts).sort((a,b)=>counts[b]-counts[a]);
    let sel=_evTaskId;
    if(!sel || taskIds.indexOf(sel)<0){
      const kl=findKlikyTask(); sel=(kl && counts[kl.id])? kl.id : taskIds[0];
      _evTaskId=sel;
    }
    let h='<div class="k">Event log detail</div>';
    h+='<div class="evPickRow"><label class="evPickLbl">Task</label>'+
       '<select class="evSelect" onchange="evPickTask(this.value)">'+
       taskIds.map(id=>'<option value="'+esc(id)+'"'+(id===sel?' selected':'')+'>'+esc(taskTitleById(id))+' ('+counts[id]+')</option>').join('')+
       '</select></div>';
    const evs=all.filter(e=>e.taskId===sel);
    const completes=evs.filter(e=>e.kind==='complete');
    const misses=evs.filter(e=>e.kind==='miss');
    const subs=evs.filter(e=>e.kind==='subtask');
    const taps=evs.filter(e=>e.kind==='habitTap');
    const synCount=evs.filter(e=>e.synthetic).length;
    h+='<div class="anNote">'+evs.length+' event(s) &middot; '+completes.length+' completion(s), '+misses.length+' miss(es), '+subs.length+' subtask tap(s)'+
       (taps.length?(' , '+taps.length+' habit tap(s)'):'')+'.'+
       (synCount? ' <b>'+synCount+'</b> backfilled (synthetic) &mdash; real days, reconstructed times.' : '')+'</div>';
    function dayKey(ts){ const d=new Date(ts); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
    const byDay={};
    function dd(k){ return byDay[k]=byDay[k]||{completed:false,missed:false,subs:[],taps:0,synthetic:false,inferred:false}; }
    completes.forEach(e=>{ const d=dd(dayKey(e.ts)); d.completed=true; d.reward=e.reward; if(e.synthetic)d.synthetic=true; if(e.inferred)d.inferred=true; });
    misses.forEach(e=>{ const d=dd(dayKey(e.ts)); d.missed=true; if(e.synthetic)d.synthetic=true; });
    subs.forEach(e=>{ const d=dd(dayKey(e.ts)); d.subs.push({text:e.subText,done:e.done,ts:e.ts}); if(e.synthetic)d.synthetic=true; });
    taps.forEach(e=>{ const d=dd(dayKey(e.ts)); d.taps++; if(e.synthetic)d.synthetic=true; });
    const days=Object.keys(byDay).sort().reverse();
    const pages=Math.max(1,Math.ceil(days.length/EV_PAGE_SIZE));
    if(_evPage>=pages) _evPage=pages-1;
    const startI=_evPage*EV_PAGE_SIZE;
    const pageDays=days.slice(startI,startI+EV_PAGE_SIZE);
    h+='<div class="anEvDays">';
    pageDays.forEach(k=>{
      const d=byDay[k];
      const status = d.completed ? '<span style="color:var(--green)">&#10003; done</span>'
                   : d.missed   ? '<span style="color:var(--red)">&#10007; missed</span>'
                   : '<span style="color:var(--muted)">&mdash;</span>';
      const rew = (d.reward && d.reward.xp) ? ' &middot; +'+d.reward.xp+' XP' : '';
      const tp = d.taps ? ' &middot; '+d.taps+' tap'+(d.taps>1?'s':'') : '';
      const mark = d.synthetic ? ' <span class="anEvSyn" title="Backfilled from Habitica: real day, reconstructed time">~ backfill'+(d.inferred?' &middot; inferred':'')+'</span>' : '';
      h+='<div class="anEvDay"><div class="anEvHead"><b>'+esc(k)+'</b> '+status+rew+tp+mark+'</div>';
      if(d.subs.length){
        const checked=d.subs.filter(s=>s.done), unchecked=d.subs.filter(s=>!s.done);
        if(checked.length) h+='<div class="anEvSubs">'+checked.map(s=>'&#9745; '+esc(s.text)+' <span style="color:var(--muted)">@ '+timeOfDay(s.ts)+'</span>').join('<br>')+'</div>';
        if(unchecked.length) h+='<div class="anEvSubs" style="color:var(--muted)">'+unchecked.map(s=>'&#9744; '+esc(s.text)+' (unchecked @ '+timeOfDay(s.ts)+')').join('<br>')+'</div>';
      }
      h+='</div>';
    });
    h+='</div>';
    if(pages>1){
      h+='<div class="evPager">'+
         '<button class="evPg" '+(_evPage<=0?'disabled':'')+' onclick="evGoPage('+(_evPage-1)+')">&#8592; Newer</button>'+
         '<span class="evPgLbl">Page '+(_evPage+1)+' / '+pages+' &middot; '+days.length+' days</span>'+
         '<button class="evPg" '+(_evPage>=pages-1?'disabled':'')+' onclick="evGoPage('+(_evPage+1)+')">Older &#8594;</button>'+
         '</div>';
    }
    cur.innerHTML=h;
  }).catch(()=>{
    const cur=document.getElementById('anEventDetail'); if(!cur) return;
    cur.innerHTML='<div class="k">From IndexedDB event log</div>'+
      '<div class="anNote">Event log unavailable (IndexedDB may be disabled, e.g. private browsing). History-based charts above are unaffected.</div>';
  });
}
function anHeatmapHTML(from,to,inten,maxI){
  const start=new Date(Math.floor(from/DAY)*DAY); start.setHours(0,0,0,0);
  start.setDate(start.getDate()-((start.getDay()+6)%7)); // week starts Monday: top cell = Mon, bottom = Sun
  const end=new Date(Math.floor(to/DAY)*DAY); end.setHours(0,0,0,0);
  let cols='', col='', dow=0;
  for(let t=start.getTime(); t<=end.getTime(); t+=DAY){
    const v=inten[Math.floor(t/DAY)*DAY]||0;
    const title='📅 '+fmtDate(t)+'\n'+(v? '🔥 '+v+' activity':'💤 no activity');
    col+='<div class="anHeatCell" style="background:'+heatColor(v,maxI)+'" data-tip="'+esc(title)+'"></div>';
    dow++;
    if(dow===7){ cols+='<div class="anHeatCol">'+col+'</div>'; col=''; dow=0; }
  }
  if(col) cols+='<div class="anHeatCol">'+col+'</div>';
  return '<div class="anHeat">'+cols+'</div>';
}

function saveScroll(){ if(S.prefs&&S.prefs.scroll){ S.prefs.scroll[TAB]=window.scrollY||window.pageYOffset||0; } }
function restoreScroll(){
  const y=(S.prefs&&S.prefs.scroll&&S.prefs.scroll[TAB])||0;
  // wait a frame so the freshly-rendered content has height
  requestAnimationFrame(()=>requestAnimationFrame(()=>window.scrollTo(0,y)));
}
function render(){
  // tearing down #view orphans any in-flight drag node; clear all drag state
  // first so a lingering ghost/listeners can't freeze the next screen.
  if(typeof resetDragState==='function') resetDragState();
  renderStats();
  const v=document.getElementById('view');
  v.innerHTML = TAB==='habits'?viewHabits() : TAB==='dailies'?viewDailies() : TAB==='todos'?viewTodos() : TAB==='analytics'?viewAnalytics() : viewRewards();
  if(TAB==='analytics') initAnalytics();
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.tab===TAB));
  if(TAB!=='analytics') enableDragReorder();
  restoreScroll();
}
// persist scroll continuously (lightweight, debounced)
let _scrollT=null;
window.addEventListener('scroll',()=>{ if(_scrollT)return; _scrollT=setTimeout(()=>{ _scrollT=null; saveScroll(); save(); },400); });
// Mobile PWAs (esp. Android Chrome) can freeze/discard a backgrounded page before a
// tap-triggered localStorage write is committed, reverting to an older snapshot on
// relaunch (e.g. filter re-opens). Force a synchronous flush on the durable
// 'page is going away' signals: visibilitychange->hidden and pagehide.
function flushState(){ if(_scrollT){ clearTimeout(_scrollT); _scrollT=null; } saveScroll(); save(); }
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='hidden') flushState(); });
window.addEventListener('pagehide', flushState);
// ---- drag & drop reordering (tasks + rewards), persisted to S ----
let _dragEl=null, _dragList=null;
function enableDragReorder(){
  const cards=document.querySelectorAll('#view .task[draggable="true"]');
  cards.forEach(card=>{
    // --- desktop: native HTML5 drag (mouse only) ---
    card.addEventListener('dragstart',e=>{
      _dragEl=card; _dragList=card.dataset.list; card.classList.add('dragging');
      e.dataTransfer.effectAllowed='move';
      try{ e.dataTransfer.setData('text/plain',card.dataset.id); }catch(_){}
    });
    card.addEventListener('dragend',()=>{ card.classList.remove('dragging'); _dragEl=null; commitOrder(); });
    card.addEventListener('dragover',e=>{
      if(!_dragEl || card===_dragEl || card.dataset.list!==_dragList) return;
      e.preventDefault();
      const r=card.getBoundingClientRect();
      const after=(e.clientY-r.top)/r.height > 0.5;
      card.parentNode.insertBefore(_dragEl, after?card.nextSibling:card);
    });
    // --- touch: pure pointer-based drag with a floating ghost ---
    enableTouchDrag(card);
  });
}
// Touch reordering via Touch Events. Long-press picks the card up; once lifted
// we attach non-passive move/end listeners on the document and preventDefault on
// every move so the browser can NEVER turn the gesture into a page scroll (the
// cause of the earlier freeze). A floating ghost follows the finger and the
// other cards slide out of the way (FLIP animation).
let _tDrag=null, _tTimer=null, _tStartY=0, _tStartX=0, _tGhost=null, _tGrabDY=0,
    _tAutoScroll=null, _tPointerY=0, _tActive=false;
function enableTouchDrag(card){
  // ONE non-passive touchmove listener on the card spans the ENTIRE gesture
  // (press window AND active drag). It calls preventDefault() from the very
  // first move, so the browser's scroll-vs-drag arbitration can NEVER commit to
  // a scroll: our cancel is in force before the browser ever sees a cancelable
  // move it could turn into a scroll. (NOTE: on Chrome Android this still loses
  // if the stationary hold lasts long enough that the browser commits a scroll
  // before LONGPRESS_MS elapses — see the LONGPRESS_MS comment. Keep it small.)
  card.addEventListener('touchstart',e=>{
    if(e.touches.length!==1) return;
    if(e.target.closest('.check')) return;        // don't hijack +/-/check taps
    if(_tActive || _tGhost || _tDrag) resetDragState();   // clean slate every gesture
    const t=e.touches[0];
    _tStartX=t.clientX; _tStartY=t.clientY; _tPointerY=t.clientY;
    let _lastY=t.clientY, _decided=false, _isScroll=false;
    clearTimeout(_tTimer);
    _tTimer=setTimeout(()=>{ if(!_isScroll){ _decided=true; beginTouchDrag(card,t); } },longPressMs());  // long-press (Settings: drag delay)

    const onMove=ev=>{
      // Cancel EVERY move from the first one. Card is touch-action:none, but we
      // still cancel defensively so a stationary hold can never let the browser
      // start its own scroll/callout and flip subsequent moves non-cancelable.
      if(ev.cancelable) ev.preventDefault();
      const tt=ev.touches[0]; if(!tt) return;
      if(_tActive){                                // ACTIVE DRAG phase
        _tPointerY=tt.clientY;
        moveTouchDrag(tt.clientX,tt.clientY);
        return;
      }
      // PRESS-WINDOW phase (before the long-press fires)
      const dy=tt.clientY-_lastY;
      const totDy=Math.abs(tt.clientY-_tStartY), totDx=Math.abs(tt.clientX-_tStartX);
      // First clear movement before the press fires = a scroll: drive it manually.
      if(!_decided && (totDy>10 || totDx>10)){ _decided=true; _isScroll=true; clearTimeout(_tTimer); _tTimer=null; }
      if(_isScroll){ window.scrollBy(0,-dy); }
      _lastY=tt.clientY;
    };
    const onEnd=()=>{
      clearTimeout(_tTimer); _tTimer=null;
      card.removeEventListener('touchmove',onMove);
      card.removeEventListener('touchend',onEnd);
      card.removeEventListener('touchcancel',onEnd);
      if(_tActive) endTouchDrag();                 // finish an active drag
    };
    card.addEventListener('touchmove',onMove,{passive:false});
    card.addEventListener('touchend',onEnd);
    card.addEventListener('touchcancel',onEnd);
  },{passive:false});
}

function beginTouchDrag(card,t){
  _tActive=true; _tDrag=card; _dragList=card.dataset.list;
  const r=card.getBoundingClientRect();
  _tGrabDY=t.clientY-r.top;
  document.documentElement.classList.add('dragging-active');   // lock scroll (html+body)
  // floating clone that tracks the finger
  _tGhost=card.cloneNode(true);
  _tGhost.classList.add('dragGhost'); _tGhost.classList.remove('dragging');
  _tGhost.style.width=r.width+'px';
  _tGhost.style.left=r.left+'px';
  _tGhost.style.top=(t.clientY-_tGrabDY)+'px';
  document.body.appendChild(_tGhost);
  // animate the lift, then leave a dim placeholder gap where the card was
  requestAnimationFrame(()=>{ if(_tGhost) _tGhost.classList.add('lifted'); });
  card.classList.add('dragging');
  card.style.touchAction='none';                 // browser must not scroll from this card now
  try{ if(navigator.vibrate) navigator.vibrate(15); }catch(_){ }
  // NOTE: no document-level touch listeners. The card's own non-passive touchmove
  // listener (bound at touchstart) drives the active drag, so preventDefault has
  // been in force since the first move of the gesture.
  startAutoScroll();
}
function moveTouchDrag(x,y){
  if(_tGhost) _tGhost.style.top=(y-_tGrabDY)+'px';
  const el=document.elementFromPoint(x,y);       // ghost is pointer-events:none
  const over=el && el.closest('.task[draggable="true"]');
  if(over && over!==_tDrag && over.dataset.list===_dragList){
    const rr=over.getBoundingClientRect();
    const after=(y-rr.top)/rr.height > 0.5;
    flipReorder(()=>{ over.parentNode.insertBefore(_tDrag, after?over.nextSibling:over); });
  }
}
// FLIP: record sibling positions, reorder, then animate them from old->new
function flipReorder(mutate){
  const parent=_tDrag.parentNode;
  const sibs=[...parent.querySelectorAll('.task[draggable="true"]')].filter(s=>s!==_tDrag);
  const first=new Map(); sibs.forEach(s=>first.set(s,s.getBoundingClientRect().top));
  mutate();
  sibs.forEach(s=>{
    const last=s.getBoundingClientRect().top, dy=first.get(s)-last;
    if(!dy) return;
    s.style.transition='none'; s.style.transform='translateY('+dy+'px)';
    requestAnimationFrame(()=>{ s.style.transition='transform .18s ease'; s.style.transform=''; });
  });
}
// auto-scroll the page when the ghost is dragged near the top/bottom edge
function startAutoScroll(){
  stopAutoScroll();
  _tAutoScroll=setInterval(()=>{
    if(!_tDrag) return;
    const m=80, vh=window.innerHeight;
    const gx=(_tGhost?_tGhost.getBoundingClientRect().left:0)+5;
    if(_tPointerY<m){ window.scrollBy(0,-Math.ceil((m-_tPointerY)/5)); moveTouchDrag(gx,_tPointerY); }
    else if(_tPointerY>vh-m){ window.scrollBy(0,Math.ceil((_tPointerY-(vh-m))/5)); moveTouchDrag(gx,_tPointerY); }
  },16);
}
function stopAutoScroll(){ if(_tAutoScroll){ clearInterval(_tAutoScroll); _tAutoScroll=null; } }
// Remove every listener/class/timer and clear all drag globals. Idempotent and
// safe to call at any time (gesture end, interruption, or before a new gesture).
function resetDragState(){
  clearTimeout(_tTimer); _tTimer=null;
  stopAutoScroll();
  document.documentElement.classList.remove('dragging-active');
  if(_tGhost){ _tGhost.remove(); _tGhost=null; }
  if(_tDrag){ _tDrag.style.touchAction=''; _tDrag.classList.remove('dragging'); _tDrag=null; }
  _tActive=false;
}
function endTouchDrag(){
  if(!_tActive && !_tDrag){ resetDragState(); return; }  // nothing in flight
  const dropTarget=_tDrag, ghost=_tGhost;
  // detach listeners + clear globals FIRST so the next gesture is never blocked,
  // even though we still animate the ghost snap below using local references.
  _tGhost=null;                                   // hand the ghost to the animation
  if(dropTarget) commitOrder();                   // persist order before clearing _tDrag
  resetDragState();                               // clears _tActive/_tDrag/classes/listeners
  // animate the (now-detached) ghost snapping into the card's final slot
  if(ghost && dropTarget){
    const r=dropTarget.getBoundingClientRect();
    ghost.classList.remove('lifted');
    ghost.style.transition='left .16s ease, top .16s ease, transform .16s ease';
    ghost.style.left=r.left+'px'; ghost.style.top=r.top+'px'; ghost.style.transform='scale(1)';
    setTimeout(()=>{ ghost.remove(); },170);
  } else if(ghost){ ghost.remove(); }
}
// read the DOM order back into S.tasks / S.rewards
function commitOrder(){
  const cards=[...document.querySelectorAll('#view .task[draggable="true"]')];
  if(!cards.length) return;
  const list=cards[0].dataset.list;
  const order=cards.map(c=>c.dataset.id);
  if(list==='rewards'){
    S.rewards.sort((a,b)=>order.indexOf(a.id)-order.indexOf(b.id));
  } else {
    // reorder only the tasks of the current tab's type; keep other types' relative order
    const typeOfTab = TAB==='habits'?'habit':TAB==='dailies'?'daily':'todo';
    const moved=order.map(id=>S.tasks.find(t=>t.id===id)).filter(Boolean);
    const others=S.tasks.filter(t=>t.type!==typeOfTab);
    // rebuild: place reordered same-type tasks where they were, others appended in original order
    const sameType=[];
    moved.forEach(t=>{ if(t.type===typeOfTab) sameType.push(t); });
    S.tasks = others.concat(sameType);
  }
  save();
}
// ---- shared tooltip + data-point selection (heatmap + charts) ----
// data-tip uses "\n"-separated lines; first line is the bold title.
let _tipTimer=null, _tipEl=null, _selEl=null;
function tipEl(){
  if(!_tipEl){ _tipEl=document.createElement('div'); _tipEl.id='hoverTip';
    _tipEl.className='hoverTip';
    document.body.appendChild(_tipEl); }
  return _tipEl;
}
function tipDelayMs(){ const d=(S.prefs&&S.prefs.tipDelay); return Math.max(0,(d==null?0:+d))*1000; }
// build pretty multi-line HTML from a "\n"-separated data-tip string
function tipHTML(text){
  const lines=String(text||'').split('\n').filter(l=>l.length);
  if(!lines.length) return '';
  let h='<div class="ttTitle">'+lines[0]+'</div>';
  if(lines.length>1) h+='<div class="ttBody">'+lines.slice(1).join('<br>')+'</div>';
  return h;
}
// show tip near (x,y). above=true puts it above the point (used on touch so a
// finger doesn't cover it); we clamp to viewport so it never clips off-screen.
function showTip(text,x,y,above){
  const t=tipEl(); t.innerHTML=tipHTML(text); t.style.display='block';
  // measure then position
  const tw=t.offsetWidth, th=t.offsetHeight, vw=window.innerWidth, vh=window.innerHeight;
  let left=above? x-tw/2 : x+14;            // centered above finger, else to the right
  let top =above? y-th-18 : y+14;           // 18px clearance above the touch point
  if(above && top<6){ top=y+22; }           // not enough room above -> drop below finger
  left=Math.max(6,Math.min(left,vw-tw-6));
  top =Math.max(6,Math.min(top, vh-th-6));
  t.style.left=left+'px'; t.style.top=top+'px';
}
function hideTip(){ clearTimeout(_tipTimer); if(_tipEl)_tipEl.style.display='none'; }
// selection: pin the tooltip to a chosen element and highlight it
function clearSelVisuals(){
  // remove any SVG marker + per-svg selection state
  document.querySelectorAll('.spkMarker').forEach(m=>m.remove());
  document.querySelectorAll('svg.hasSel').forEach(s=>s.classList.remove('hasSel'));
  document.querySelectorAll('rect.bar.sel').forEach(b=>b.classList.remove('sel'));
}
function clearSel(){ if(_selEl){ _selEl.classList.remove('sel'); _selEl=null; } clearSelVisuals(); hideTip(); }
function selectEl(el,touch){
  if(_selEl===el){ clearSel(); return; }      // tapping the same one toggles off
  if(_selEl) _selEl.classList.remove('sel');
  clearSelVisuals();
  _selEl=el; el.classList.add('sel');
  const svg=el.ownerSVGElement;
  if(svg){
    svg.classList.add('hasSel');
    if(el.classList.contains('spkHit')){
      // draw a crisp visible ring at the point
      const cx=el.getAttribute('cx'), cy=el.getAttribute('cy');
      const ns='http://www.w3.org/2000/svg';
      const ring=document.createElementNS(ns,'circle');
      ring.setAttribute('class','spkMarker');
      ring.setAttribute('cx',cx); ring.setAttribute('cy',cy); ring.setAttribute('r','4');
      ring.setAttribute('fill','#fff'); ring.setAttribute('stroke','var(--accent)'); ring.setAttribute('stroke-width','2');
      ring.setAttribute('vector-effect','non-scaling-stroke');
      svg.appendChild(ring);
    } else if(el.classList.contains('barHit')){
      // highlight the matching visible bar (same index)
      const bar=svg.querySelector('.bar[data-i="'+el.dataset.i+'"]');
      if(bar) bar.classList.add('sel');
    }
  }
  const r=el.getBoundingClientRect();
  // anchor tooltip above the datum (touch) / beside it (mouse)
  showTip(el.dataset.tip, r.left+r.width/2, touch? r.top : r.top+r.height/2, true);
}
// dismiss selection when tapping/clicking outside any tracked datum
function bindGlobalDismiss(){
  if(window.__tipDismissBound) return; window.__tipDismissBound=true;
  const off=e=>{ if(_selEl && !e.target.closest('[data-tip]')) clearSel(); };
  document.addEventListener('click',off);
  document.addEventListener('touchstart',off,{passive:true});
}
// bind tooltips + selection to any elements matching selector that carry data-tip
function bindTips(selector){
  bindGlobalDismiss();
  document.querySelectorAll(selector+'[data-tip]').forEach(el=>{
    // mouse hover = transient preview (only when nothing is pinned)
    const hover=e=>{ if(_selEl) return; clearTimeout(_tipTimer);
      const x=e.clientX, y=e.clientY, delay=tipDelayMs();
      if(delay<=0) showTip(el.dataset.tip,x,y,false);
      else _tipTimer=setTimeout(()=>{ if(!_selEl) showTip(el.dataset.tip,x,y,false); },delay);
    };
    el.addEventListener('mouseenter',hover);
    el.addEventListener('mousemove',hover);
    el.addEventListener('mouseleave',()=>{ if(!_selEl) hideTip(); });
    // mouse click = pin/select
    el.addEventListener('click',e=>{ e.stopPropagation(); selectEl(el,false); });
    // touch: tap selects & pins (above finger); also support sliding to preview
    el.addEventListener('touchstart',e=>{
      const t=e.touches&&e.touches[0]; if(!t)return;
      e.preventDefault();
      const u=document.elementFromPoint(t.clientX,t.clientY);
      const target=(u&&u.closest)? u.closest(selector+'[data-tip]') : el;
      selectEl(target||el,true);
    },{passive:false});
    el.addEventListener('touchmove',e=>{
      const t=e.touches&&e.touches[0]; if(!t)return; e.preventDefault();
      const u=document.elementFromPoint(t.clientX,t.clientY);
      const target=(u&&u.closest)? u.closest(selector+'[data-tip]') : null;
      if(target && target!==_selEl) selectEl(target,true);
    },{passive:false});
  });
}
function bindHeatTooltips(){ bindTips('.anHeatCell'); }
function toggle(id){
  const t=S.tasks.find(x=>x.id===id); if(!t)return;
  if(t.type==='daily'){ t.done? uncompleteDaily(t) : completeTask(t); }
  else if(t.type==='todo'){ t.done? uncompleteTodo(t) : completeTask(t); }
  else { completeTask(t); }
}
function openEdit(id,type){
  const t = id? S.tasks.find(x=>x.id===id)
    : {id:null,type:type||'todo',title:'',notes:'',difficulty:'easy',value:0,done:false,
       checklist:[],repeat:[true,true,true,true,true,true,true],up:true,down:true,resetFreq:'daily'};
  EDIT = JSON.parse(JSON.stringify(t));
  drawSheet();
  document.getElementById('scrim').classList.add('show');
}
function drawSheet(){
  const t=EDIT; const dayLabels=['S','M','T','W','T','F','S'];
  const sheet=document.getElementById('sheet');
  let h='<h3>'+(t.id?'Edit':'New')+' '+(t.type==='daily'?'Daily':t.type==='habit'?'Habit':'To-Do')+'</h3>';
  h+='<label>Title</label><input type="text" id="eTitle" value="'+esc(t.title)+'" placeholder="What needs doing?">';
  h+='<label>Difficulty</label><div class="seg" id="eDiff">'+
    ['trivial','easy','medium','hard'].map(d=>'<button class="'+(t.difficulty===d?'on':'')+'" onclick="EDIT.difficulty=\''+d+'\';drawSheet()">'+d+'</button>').join('')+'</div>';
  if(t.type==='habit'){
    h+='<label>Buttons</label><div class="seg">'+
      '<button class="'+(t.up!==false?'on':'')+'" onclick="EDIT.up=!(EDIT.up!==false);drawSheet()">+ Positive</button>'+
      '<button class="'+(t.down!==false?'on':'')+'" onclick="EDIT.down=!(EDIT.down!==false);drawSheet()">− Negative</button></div>'+
      '<div class="small" style="margin-top:6px">+ rewards XP/gold; − costs HP. Enable either or both.</div>';
    const rf=t.resetFreq||'daily';
    h+='<label>Reset counter</label><div class="seg">'+
      [['Daily','daily'],['Weekly','weekly'],['Monthly','monthly']].map(o=>'<button class="'+(rf===o[1]?'on':'')+'" onclick="EDIT.resetFreq=\''+o[1]+'\';drawSheet()">'+o[0]+'</button>').join('')+'</div>'+
      '<div class="small" style="margin-top:6px">How often the + / − counts reset to zero.</div>';
    h+='<label>Adjust counter (this period)</label><div class="adjRow">'+
      '<div class="adj"><span>+ '+(t.cUp||0)+'</span>'+
        '<button onclick="EDIT.cUp=Math.max(0,(EDIT.cUp||0)-1);drawSheet()">−</button>'+
        '<button onclick="EDIT.cUp=(EDIT.cUp||0)+1;drawSheet()">+</button></div>'+
      '<div class="adj"><span>− '+(t.cDown||0)+'</span>'+
        '<button onclick="EDIT.cDown=Math.max(0,(EDIT.cDown||0)-1);drawSheet()">−</button>'+
        '<button onclick="EDIT.cDown=(EDIT.cDown||0)+1;drawSheet()">+</button></div></div>';
  }
  if(t.type==='daily'){
    h+='<label>Repeat on</label><div class="days" id="eDays">'+
      dayLabels.map((d,i)=>'<button style="border:1px solid var(--line);border-radius:8px;background:'+(t.repeat[i]?'var(--panel2)':'var(--panel)')+';color:var(--ink);cursor:pointer" onclick="EDIT.repeat['+i+']=!EDIT.repeat['+i+'];drawSheet()">'+d+'</button>').join('')+'</div>';
    h+='<label>Adjust streak</label><div class="adjRow">'+
      '<div class="adj"><span>🔥 '+(t.streak||0)+'</span>'+
        '<button onclick="EDIT.streak=Math.max(0,(EDIT.streak||0)-1);drawSheet()">−</button>'+
        '<button onclick="EDIT.streak=(EDIT.streak||0)+1;drawSheet()">+</button></div></div>'+
      '<div class="small" style="margin-top:6px">Restore a streak if you completed it but forgot to check it off.</div>';
  }
  if(t.type!=='habit'){
    h+='<label>Checklist (subtasks)</label><div class="checklist" id="eCheck">'+
      (t.checklist||[]).map((c,i)=>'<div class="ci"><div class="box '+(c.done?'on':'')+'" onclick="EDIT.checklist['+i+'].done=!EDIT.checklist['+i+'].done;drawSheet()">'+(c.done?'✔':'')+'</div>'+
        '<input type="text" value="'+esc(c.text)+'" oninput="EDIT.checklist['+i+'].text=this.value">'+
        '<button class="del" onclick="EDIT.checklist.splice('+i+',1);drawSheet()">✕</button></div>').join('')+
      '<button class="btn ghost" style="padding:8px" onclick="EDIT.checklist.push({id:uid(),text:\'\',done:false});drawSheet()">+ Add subtask</button></div>';
  }
  h+='<label>Notes / comments</label><textarea id="eNotes" placeholder="Notes, thoughts, log...">'+esc(t.notes)+'</textarea>';
  h+='<div class="rowBtns">'+(t.id?'<button class="btn danger" onclick="deleteTask()">Delete</button>':'')+
    '<button class="btn ghost" onclick="closeSheet()">Cancel</button>'+
    '<button class="btn primary" onclick="saveTask()">Save</button></div>';
  sheet.innerHTML=h;
}
function saveTask(){
  EDIT.title=document.getElementById('eTitle').value.trim()||'Untitled';
  EDIT.notes=document.getElementById('eNotes').value;
  document.querySelectorAll('#eCheck .ci input[type=text]').forEach((inp,i)=>{ if(EDIT.checklist[i]) EDIT.checklist[i].text=inp.value; });
  EDIT.checklist=(EDIT.checklist||[]).filter(c=>c.text.trim());
  if(EDIT.id){ const idx=S.tasks.findIndex(x=>x.id===EDIT.id); S.tasks[idx]=EDIT; }
  else { EDIT.id=uid(); EDIT.createdAt=Date.now(); S.tasks.push(EDIT); }
  closeSheet(); save(); render();
}
function deleteTask(){ if(!confirm('Delete this task?'))return; S.tasks=S.tasks.filter(x=>x.id!==EDIT.id); closeSheet(); save(); render(); }
function closeSheet(){ document.getElementById('scrim').classList.remove('show'); EDIT=null; }
let REDIT=null;
function openReward(id){
  REDIT = id? JSON.parse(JSON.stringify(S.rewards.find(r=>r.id===id))) : {id:null,title:'',cost:10,notes:''};
  const sheet=document.getElementById('sheet');
  sheet.innerHTML='<h3>'+(REDIT.id?'Edit':'New')+' Reward</h3>'+
    '<label>Reward</label><input type="text" id="rTitle" value="'+esc(REDIT.title)+'" placeholder="e.g. 30 min of gaming">'+
    '<label>Cost (gold)</label><input type="text" id="rCost" value="'+REDIT.cost+'">'+
    '<label>Notes</label><textarea id="rNotes">'+esc(REDIT.notes)+'</textarea>'+
    '<div class="rowBtns">'+(REDIT.id?'<button class="btn danger" onclick="delReward()">Delete</button>':'')+
    '<button class="btn ghost" onclick="closeSheet()">Cancel</button>'+
    '<button class="btn primary" onclick="saveReward()">Save</button></div>';
  document.getElementById('scrim').classList.add('show');
}
function saveReward(){
  REDIT.title=document.getElementById('rTitle').value.trim()||'Reward';
  REDIT.cost=Math.max(0,parseFloat(document.getElementById('rCost').value)||0);
  REDIT.notes=document.getElementById('rNotes').value;
  if(REDIT.id){ const i=S.rewards.findIndex(r=>r.id===REDIT.id); S.rewards[i]=REDIT; }
  else { REDIT.id=uid(); S.rewards.push(REDIT); }
  closeSheet(); save(); render();
}
function delReward(){ S.rewards=S.rewards.filter(r=>r.id!==REDIT.id); closeSheet(); save(); render(); }
function buyReward(id){
  const r=S.rewards.find(x=>x.id===id); if(!r)return;
  if(S.char.gold < r.cost){ toast('Not enough gold'); return; }
  S.char.gold=+(S.char.gold-r.cost).toFixed(2);
  toast('Bought: '+r.title); save(); render();
}
const SHOP_ITEMS = [
  { id:'potion', icon:'❤️', title:'Health Potion', cost:25, desc:'Restore 15 HP.',
    use:function(){ S.char.hp = clamp(S.char.hp+15,0,S.char.maxHp); toast('+15 HP'); } },
  { id:'bigpotion', icon:'💖', title:'Greater Potion', cost:60, desc:'Fully restore HP.',
    use:function(){ S.char.hp = S.char.maxHp; toast('HP fully restored'); } }
];
function buyShopItem(id){
  const item = SHOP_ITEMS.find(i=>i.id===id); if(!item) return;
  if((item.id==='potion'||item.id==='bigpotion') && S.char.hp>=S.char.maxHp){ toast('Already at full HP'); return; }
  if(S.char.gold < item.cost){ toast('Not enough gold'); return; }
  S.char.gold = +(S.char.gold-item.cost).toFixed(2);
  item.use();
  save(); render();
}
function openSettings(){
  const sheet=document.getElementById('sheet');
  let h='<h3>Settings</h3>';
  h+='<label>Character name</label><input type="text" id="setName" value="'+esc(S.char.name)+'">';
  h+='<label>Avatar</label>';
  h+='<div class="avatarSetRow">'+
     '<input type="text" id="setFace" value="'+esc(S.char.face)+'" maxlength="2" placeholder="emoji">'+
     '<button class="btn ghost" type="button" onclick="document.getElementById(\'faceFile\').click()">Browse image\u2026</button>'+
     '</div>';
  h+='<input type="file" id="faceFile" accept="image/jpeg,image/png,image/gif,.jpg,.jpeg,.png,.gif" style="display:none" onchange="uploadFace(event)">';
  if(S.char.faceImg){ h+='<div class="small" style="margin-top:6px;display:flex;align-items:center;gap:8px">'+
     '<img src="'+S.char.faceImg+'" alt="" style="width:32px;height:32px;border-radius:8px;object-fit:cover;border:1px solid var(--line)">'+
     'Custom image in use. <a href="#" onclick="removeFace();return false">Remove</a> to use the emoji instead.</div>'; }
  else { h+='<div class="small" style="margin-top:6px">Type an emoji, or upload a PNG, JPEG or GIF (max 1\u00a0MB) to use as your avatar. An uploaded image takes priority over the emoji.</div>'; }
  h+='<div class="settingsRow"><button class="btn primary" onclick="saveSettings()">Save</button><button class="btn ghost" onclick="closeSheet()">Close</button></div>';
  h+='<label>Interface width (on PC / wide screens)</label><div class="seg" id="setWidth">'+
    [['Slim',430],['Medium',560],['Wide',720],['Full',3000]].map(o=>'<button class="'+((S.prefs.width||480)===o[1]?'on':'')+'" onclick="setWidth('+o[1]+')">'+o[0]+'</button>').join('')+'</div>';
  h+='<div class="small" style="margin-top:6px">On a phone it always fills the screen. This caps the width on a monitor and keeps it centered.</div>';
  const nl=(S.prefs.notesLines==null?3:S.prefs.notesLines);
  h+='<label>Note lines shown on cards</label><div class="seg" id="setNotes">'+
    [['Off',0],['1',1],['2',2],['3',3],['5',5]].map(o=>'<button class="'+(nl===o[1]?'on':'')+'" onclick="setNotesLines('+o[1]+')">'+o[0]+'</button>').join('')+'</div>';
  h+='<div class="small" style="margin-top:6px">How many lines of a task\'s notes preview on the list (default 3, like Habitica).</div>';
  const td=(S.prefs.tipDelay==null?0:S.prefs.tipDelay);
  h+='<label>Hover tooltip delay</label><div class="seg" id="setTipDelay">'+
    [['Instant',0],['0.5s',0.5],['1s',1],['2s',2]].map(o=>'<button class="'+(td===o[1]?'on':'')+'" onclick="setTipDelay('+o[1]+')">'+o[0]+'</button>').join('')+'</div>';
  h+='<div class="small" style="margin-top:6px">Delay before the date/value tooltip shows on the analytics heatmap and charts (default Instant).</div>';
  const dd=(S.prefs.dragDelay==null?DRAG_DELAY_DEFAULT:S.prefs.dragDelay);
  h+='<label>Card drag long-press delay (ms)</label>';
  h+='<input type="number" id="setDragDelay" min="0" max="2000" step="50" value="'+dd+'">';
  h+='<div class="small" style="margin-top:6px">How long to hold a card still before it lifts for reordering on touch (default '+DRAG_DELAY_DEFAULT+'). Lower = quicker pickup; higher values can make the card freeze while the page scrolls on some phones. Saved with Save above.</div>';
  h+='<div class="colTitle"><h2 style="font-size:13px">Backup & transfer</h2></div>';
  h+='<div class="small">Your progress lives only on this device. Export a file to back up or move to another phone, then import it there to continue. Export now includes your full event log (subtask/tap/completion history), so one file is a complete backup.</div>';
  h+='<div class="settingsRow"><button class="btn ghost" onclick="exportData()">Export</button>'+
    '<button class="btn ghost" onclick="document.getElementById(\'importFile\').click()">Import</button></div>';
  h+='<input type="file" id="importFile" accept="application/json,.json" style="display:none" onchange="importData(event)">';
  h+='<div class="small" style="margin-top:10px">Event backfill: load synthesized events (from the importer) into the live event log so the Analytics &ldquo;Event log detail&rdquo; view has data immediately. Days are real; times-of-day are plausible reconstructions.</div>';
  h+='<div class="settingsRow"><button class="btn ghost" onclick="document.getElementById(\'eventsFile\').click()">Load event backfill</button></div>';
  h+='<input type="file" id="eventsFile" accept="application/json,.json" style="display:none" onchange="importEventsBackfill(event)">';
  h+='<div class="small" style="margin-top:8px">Questa - local build. Styled after Habitica; uses original assets, not affiliated with Habitica.</div>';
  h+='<div class="appVersion">'+APP_VERSION+'</div>';
  h+='<div class="resetRow"><button class="btn resetMini" onclick="if(confirm(\'Erase ALL progress on this device? This cannot be undone.\')){localStorage.removeItem(STORE_KEY);S=freshState();save();applyWidth();closeSheet();render();}">Reset everything</button></div>';
  sheet.innerHTML=h;
  document.getElementById('scrim').classList.add('show');
}
function setWidth(px){ S.prefs.width=px; applyWidth(); save(); openSettings(); }
function setNotesLines(n){ S.prefs.notesLines=n; save(); openSettings(); }
function setTipDelay(s){ S.prefs.tipDelay=s; save(); openSettings(); }
function saveSettings(){
  S.char.name=document.getElementById('setName').value.trim()||'Adventurer';
  S.char.face=document.getElementById('setFace').value||'🧙';
  const ddEl=document.getElementById('setDragDelay');
  if(ddEl){ let n=parseInt(ddEl.value,10); if(!isFinite(n)||n<0) n=DRAG_DELAY_DEFAULT; n=Math.min(2000,n); S.prefs.dragDelay=n; }
  save(); render(); closeSheet(); toast('Saved');
}
// Complete single-file backup: the localStorage S object PLUS the IndexedDB
// event log, embedded under an `events` key. Async because reading IDB is async;
// localStorage stays lean (events are only added to the export blob, never back
// into S — migrate() strips `events` on import). Falls back to S-only if IDB is
// unavailable so export never fails outright.
function exportData(){
  const finish=(eventsArr)=>{
    // Build the backup from S without mutating S; attach events for portability.
    const backup=Object.assign({}, S, {events: eventsArr||[]});
    backup._backup={ exportedAt:new Date().toISOString(), appVersion:APP_VERSION,
                     eventCount:(eventsArr||[]).length };
    const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a');
    const d=new Date(); const stamp=''+d.getFullYear()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
    a.href=url; a.download='questa-backup-'+stamp+'.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('Exported'+((eventsArr&&eventsArr.length)?(' ('+eventsArr.length+' events)'):''));
  };
  getEvents({}).then(finish).catch(()=>finish([]));
}
function importData(ev){
  const f=ev.target.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>{ try{ const data=JSON.parse(rd.result);
      if(!data.char||!Array.isArray(data.tasks)) throw 0;
      // Capture any embedded event log BEFORE migrate() (which strips `events`
      // from S so it never re-enters localStorage). A full backup is a full
      // restore: replace the IDB event log entirely (clear then bulk-add) so a
      // re-import never duplicates. Done async; localStorage restore stays sync.
      const embeddedEvents = Array.isArray(data.events) ? data.events : null;
      if(confirm('Replace current progress with the imported file?')){
        S=migrate(data); save(); applyWidth(); closeSheet(); render();
        if(embeddedEvents && typeof indexedDB!=="undefined"){
          clearAllEvents().then(()=>bulkAddEvents(embeddedEvents)).then(n=>{
            toast('Imported · '+n+' events restored');
            if(TAB==='analytics') render();
          });
        } else {
          toast('Imported');
        }
      }
    }catch(e){ alert('That file does not look like a valid Questa backup.'); } };
  rd.readAsText(f); ev.target.value='';
}
function uploadFace(ev){
  const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
  if(!/^image\/(jpeg|png|gif)$/.test(f.type)){ alert('Please choose a PNG, JPEG or GIF image.'); return; }
  if(f.size>1048576){ alert('That image is '+(f.size/1048576).toFixed(1)+' MB. Please use one under 1 MB.'); return; }
  const rd=new FileReader();
  rd.onload=()=>{ S.char.faceImg=rd.result; save(); renderStats(); openSettings(); toast('Avatar image set'); };
  rd.onerror=()=>alert('Could not read that file.');
  rd.readAsDataURL(f);
}
function removeFace(){ delete S.char.faceImg; save(); renderStats(); openSettings(); toast('Image removed'); }
function esc(s){ return (s||'').replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
// Ordered list of screens; used by both the nav bar and swipe navigation.
const TABS=['habits','dailies','todos','analytics','rewards'];
// Switch to a tab by name. dir (-1 left / +1 right) drives an optional slide anim.
function switchTab(tab,dir){
  if(!tab||tab===TAB) return;
  saveScroll();
  TAB=tab;
  if(S.prefs){ S.prefs.lastTab=TAB; save(); }
  if(dir){
    const v=document.getElementById('view');
    if(v){
      v.classList.remove('slideInL','slideInR');
      // force reflow so re-adding the class restarts the animation
      void v.offsetWidth;
      v.classList.add(dir>0?'slideInR':'slideInL');
    }
  }
  render();
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{ switchTab(b.dataset.tab,0); });

// ---- Swipe navigation between screens ----------------------------------
// A horizontal swipe anywhere on #view moves to the previous / next tab.
// Implemented as PASSIVE touch listeners: we only read coordinates and never
// call preventDefault(), so card drag-and-drop (which owns its own non-passive
// listeners) and vertical scrolling are completely unaffected. We commit a tab
// change only on touchend, and only when the gesture is clearly horizontal and
// no card drag is in progress.
(function(){
  const SWIPE_MIN=60;       // min horizontal travel (px) to count as a swipe
  const SWIPE_RATIO=1.7;    // |dx| must exceed |dy| by this factor
  let sx=0, sy=0, tracking=false, multi=false;
  const view=document.getElementById('view');
  if(!view) return;
  // Elements that own their own horizontal touch gestures — never swipe-nav from them.
  function inHGesture(t){ return !!(t && t.closest && t.closest('#anSlider, input[type=range], .anSlider, .seg')); }

  view.addEventListener('touchstart',e=>{
    if(e.touches.length!==1){ multi=true; tracking=false; return; }
    multi=false;
    if(inHGesture(e.target)){ tracking=false; return; }
    sx=e.touches[0].clientX; sy=e.touches[0].clientY; tracking=true;
  },{passive:true});

  view.addEventListener('touchmove',e=>{
    if(e.touches.length!==1) multi=true;
  },{passive:true});

  view.addEventListener('touchend',e=>{
    if(!tracking || multi){ tracking=false; return; }
    tracking=false;
    // A card drag was active for this gesture — that's not a swipe.
    if(typeof _tActive!=='undefined' && _tActive) return;
    const t=(e.changedTouches&&e.changedTouches[0]); if(!t) return;
    const dx=t.clientX-sx, dy=t.clientY-sy;
    if(Math.abs(dx)<SWIPE_MIN) return;
    if(Math.abs(dx)<Math.abs(dy)*SWIPE_RATIO) return;
    const i=TABS.indexOf(TAB); if(i<0) return;
    // swipe left (dx<0) => next tab; swipe right (dx>0) => previous tab
    const ni=dx<0 ? i+1 : i-1;
    if(ni<0||ni>=TABS.length) return;
    switchTab(TABS[ni], dx<0 ? 1 : -1);
  },{passive:true});

  view.addEventListener('touchcancel',()=>{ tracking=false; },{passive:true});
})();

document.getElementById('scrim').onclick=e=>{ if(e.target.id==='scrim') closeSheet(); };
applyWidth();
startDay();
if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(()=>{}); }
