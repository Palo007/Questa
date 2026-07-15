// Questa app logic — extracted from index.html on 2026-06-24 18:48
// APP_VERSION is stamped on every edit; it is shown at the bottom of Settings.
const APP_VERSION = "v2026.07.15-2039";
// Global diagnostic error ring buffer (2026-07-12): mobile has no console, so
// capture uncaught errors + promise rejections into a bounded buffer that the
// full diagnostic export (questaFullDiagnostic) includes. Last 50 only.
if(typeof window!=="undefined"){
  window.__qDiag = window.__qDiag || { errors: [] };
  var _qDiagPush = function(kind, data){ try{ window.__qDiag.errors.push(Object.assign({t:Date.now(), kind:kind}, data)); if(window.__qDiag.errors.length>50) window.__qDiag.errors.shift(); }catch(e){} };
  window.addEventListener("error", function(e){ _qDiagPush("error", {message:e.message, src:e.filename, line:e.lineno, col:e.colno, stack:(e.error&&e.error.stack)||null}); });
  window.addEventListener("unhandledrejection", function(e){ _qDiagPush("unhandledrejection", {reason:(e.reason&&(e.reason.stack||e.reason.message))||String(e.reason)}); });
}

// Long-press delay (ms) before a stationary touch on a card is treated as a drag
// pickup rather than a scroll. Configurable in Settings (S.prefs.dragDelay), default 100.
// KEEP IT SMALL. Research + this project's own history show Chrome Android commits the
// touch stream to a SCROLL during a long stationary hold, BEFORE the timer fires; once
// committed, touchmove is non-cancelable and the card freezes lifted while the page
// scrolls. A short window (~200) beats that commit; raising it (e.g. 1000) makes the
// freeze MORE likely, not less. The setting exists so it can be tuned on a real device.
const DRAG_DELAY_DEFAULT = 200;
function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmOverlay');
    const titleEl = document.getElementById('confirmTitle');
    const textEl = document.getElementById('confirmText');
    const yesBtn = document.getElementById('confirmYesBtn');
    const noBtn = document.getElementById('confirmNoBtn');
    if (!overlay || !titleEl || !textEl || !yesBtn || !noBtn) {
      // Fallback if DOM not ready or elements missing
      resolve(true);
      return;
    }

    titleEl.textContent = title || 'Are you sure?';
    textEl.textContent = text || '';
    noBtn.style.display = ''; // Show cancel button
    yesBtn.textContent = 'Yes';
    overlay.classList.add('show');

    const cleanUp = (result) => {
      overlay.classList.remove('show');
      yesBtn.onclick = null;
      noBtn.onclick = null;
      resolve(result);
    };

    yesBtn.onclick = () => cleanUp(true);
    noBtn.onclick = () => cleanUp(false);
  });
}

function alertDialog(title, text) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirmOverlay');
    const titleEl = document.getElementById('confirmTitle');
    const textEl = document.getElementById('confirmText');
    const yesBtn = document.getElementById('confirmYesBtn');
    const noBtn = document.getElementById('confirmNoBtn');
    if (!overlay || !titleEl || !textEl || !yesBtn || !noBtn) {
      // Fallback if DOM not ready or elements missing
      resolve();
      return;
    }

    titleEl.textContent = title || 'Info';
    textEl.textContent = text || '';
    noBtn.style.display = 'none'; // Hide cancel button
    yesBtn.textContent = 'OK';
    overlay.classList.add('show');

    const cleanUp = () => {
      overlay.classList.remove('show');
      noBtn.style.display = ''; // Restore default display
      yesBtn.textContent = 'Yes';
      yesBtn.onclick = null;
      resolve();
    };

    yesBtn.onclick = cleanUp;
  });
}
function longPressMs(){
  return 200;
}
let _buzzLastResult = null;
let _buzzCount = 0;
function getBuzzDiag(){ return { type: typeof navigator.vibrate, lastResult: _buzzLastResult, count: _buzzCount }; }
// repeat index 0=Sun..6=Sat (matches JS getDay() AND the [Su,M,T,W,Th,F,Sa] array)
function isDailyDueOn(t, dow){ return !t.repeat || !!t.repeat[dow]; }
function isDailyDueToday(t){ return isDailyDueOn(t, new Date().getDay()); }
const DOW_LABELS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function nextDueWeekday(t){
  if(!t.repeat) return null;              // legacy daily: due every day, no pill
  const today=new Date().getDay();
  for(let i=1;i<7;i++){ const d=(today+i)%7; if(t.repeat[d]) return DOW_LABELS[d]; }
  return 'Never';                         // repeat all-false -> never due
}
const STORE_KEY = "questa.save.v1";
function freshState(){
  return {
    version:1,
    char:{ name:"Adventurer", face:"🧙", cls:"Warrior",
           lvl:1, xp:0, hp:50, maxHp:50, mp:0, gold:0 },
    tasks:[], rewards:[], tags:[], devices:[],
    lastCron: dayStamp(new Date()),
    history:[], charHistory:[],
    monthlyBackups: [],
    deletions: [],
    prefs:{ width:480, notesLines:3, lastTab:'habits', haptics:true, cardThick:0, saveBtnTop:false }
  };
}
var lastIssued = 0;
let S = load();
lastIssued = (S && S.__hlcLast) || 0;
function now(){ var p=Date.now(); lastIssued=Math.max(p, lastIssued+1); try{ if(S) S.__hlcLast=lastIssued; }catch(e){} return lastIssued; }
function ratchetHlc(maxRemoteTs){ var p=Date.now(); if(maxRemoteTs > p + 3600000){ try{ logEvent({kind:'clockSkew', remoteTs:maxRemoteTs, localTs:p}); }catch(e){} return; } lastIssued = Math.max(lastIssued, maxRemoteTs); if(S) S.__hlcLast = lastIssued; }
function load(){
  try{ const raw = localStorage.getItem(STORE_KEY);
    if(raw){ return migrate(JSON.parse(raw)); } }catch(e){}
  return freshState();
}
// Tombstone recorder (2026-07-12): deletion is a first-class, syncable fact.
// Every removal of a synced id-keyed entity (task/reward/tag/view/metric)
// records {id, at} in S.deletions so the sync merge can tell a REAL deletion
// apart from an entity merely absent in a stale/partial remote snapshot.
// Without this, mergeCollection could only guess from presence -- the bug that
// silently dropped 500+ day dailies. See sync.js tombstone overlay.
function delMark(id){
  if(id==null) return;
  try{
    if(!Array.isArray(S.deletions)) S.deletions=[];
    const at=now();
    const e=S.deletions.find(d=>d&&d.id===id);
    if(e){ if(at>(Number(e.at)||0)) e.at=at; } else S.deletions.push({id:id, at:at});
  }catch(e){}
}
// F4 (2026-07-11): deterministic id for legacy checklist items that predate
// per-item ids. MUST be pure (no Date.now()/Math.random()) so two devices
// independently backfilling the SAME legacy item converge on the SAME id
// instead of duplicating it at the next merge. Prefixed "lg-" so it can never
// collide with a uid()-generated id (uid() never contains a hyphen: it is
// Date.now().toString(36) concatenated directly with a base36 random suffix).
// Keyed on (taskId, text, occurrence) rather than array index (AMENDMENT
// 2026-07-11, after 452ad25 added subtask drag-reorder) so the id survives a
// pure reorder: occurrence counts same-text duplicates, not position.
function legacySubtaskId(taskId, text, occurrence){
  const s = String(taskId) + '\x1f' + String(text || '') + '\x1f' + String(occurrence);
  let h = 5381;
  for(let i=0;i<s.length;i++){ h = ((h*33) ^ s.charCodeAt(i)) >>> 0; }
  return 'lg-' + h.toString(36);
}
function migrate(s){ const f=freshState();
  const out=Object.assign(f,s,{char:Object.assign(f.char,s.char||{})});
  out.prefs=Object.assign({width:480, notesLines:3, lastTab:'habits', tipDelay:0, haptics:true, cardThick:0, notificationsEnabled:false, saveBtnTop:false}, s.prefs||{});
  if(out.prefs.cardPad !== undefined){
    let cp = parseInt(out.prefs.cardPad, 10);
    if(isFinite(cp)){
      out.prefs.cardThick = Math.max(0, cp - 5);
    }
    delete out.prefs.cardPad;
  }
  // Tooltip delay is fixed at Instant; the control was removed, so normalize any saved value.
  out.prefs.tipDelay=0;
  // Card drag delay now lives on a 100-300 ms slider; clamp legacy values into range.
  if(out.prefs.dragDelay!=null){ let d=parseInt(out.prefs.dragDelay,10);
    out.prefs.dragDelay=isFinite(d)?Math.min(300,Math.max(100,d)):DRAG_DELAY_DEFAULT; }
  // SPLIT: events live in IndexedDB, never in localStorage/S. Drop any events
  // array carried in from a legacy save or an import file so it can't bloat the
  // localStorage blob or be mistaken for a live source.
  if(!Array.isArray(out.tags)) out.tags=[];
  if(!Array.isArray(out.devices)) out.devices=[];
  if(!Array.isArray(out.monthlyBackups)) out.monthlyBackups=[];
  if(!Array.isArray(out.deletions)) out.deletions=[];
  delete out.events;
  // GFS (grandfather-father-son) snapshot rotation counters — ensure prefs.gfs
  // is a {daily, weekly, monthly} numeric object; coerce any legacy/non-numeric
  // values to 0 so downstream rotation logic can rely on number semantics.
  out.prefs.gfs = (out.prefs.gfs && typeof out.prefs.gfs==="object") ? out.prefs.gfs : {daily:0, weekly:0, monthly:0};
  out.prefs.gfs.daily   = Number(out.prefs.gfs.daily)   || 0;
  out.prefs.gfs.weekly  = Number(out.prefs.gfs.weekly)  || 0;
  out.prefs.gfs.monthly = Number(out.prefs.gfs.monthly) || 0;
  if(Array.isArray(out.tasks)){ out.tasks.forEach(normalizeTaskReminders); }
  // F4 (2026-07-11): backfill missing checklist-item ids deterministically so
  // two devices converge on the same id for the same legacy item instead of
  // duplicating it at the next sync (see .omo/plans/2026-07-11-subtask-granular-merge.md §3).
  // occurrence = 0-based count of prior items with identical text in this
  // checklist -- order-independent (a pure reorder of the checklist does not
  // change the SET of (text, occurrence) pairs, only which physical item ends
  // up holding which pair -- see the "same-text items swap ids" note below).
  (out.tasks||[]).forEach(t=>{
    const seenByText = new Map();
    (t.checklist||[]).forEach(c=>{
      if(!c) return;
      const text = c.text || '';
      const occurrence = seenByText.get(text) || 0;
      seenByText.set(text, occurrence + 1);
      if(!c.id) c.id = legacySubtaskId(t.id, text, occurrence);
    });
  });
  // Sync groundwork: every synced entity needs a deterministic updatedAt so
  // three-way merge (see sync.js) can tiebreak consistently, even for data
  // saved before this field existed.
  (out.tasks||[]).forEach(t=>{ t.updatedAt = t.updatedAt || t.createdAt || 0; });
  (out.rewards||[]).forEach(r=>{ r.updatedAt = r.updatedAt || r.createdAt || 0; });
  (out.tags||[]).forEach(g=>{ g.updatedAt = g.updatedAt || g.createdAt || 0; });
  (out.devices||[]).forEach(d=>{ d.updatedAt = d.updatedAt || 0; });
  if(out.prefs && out.prefs.an){
    (out.prefs.an.views||[]).forEach(v=>{ v.updatedAt = v.updatedAt || v.createdAt || 0; });
    (out.prefs.an.metrics||[]).forEach(m=>{ m.updatedAt = m.updatedAt || m.createdAt || 0; });
  }
  if(out.char && (out.char.updatedAt == null)) out.char.updatedAt = now();
  return out; }
let IS_DIRTY = false;
let _flushPromise = null;
var _prevCharSig = null;
function _charSig(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } }
/* BEGIN_DURABLE_STATE_HELPERS */
let _stateWritePromise = null;
// 2026-07-13 P0-1: save() must be fully SYNCHRONOUS. The previous design
// deferred the actual localStorage write into a navigator.locks.request()
// callback, so save() returned before anything persisted — the pagehide
// flush (flushState -> save) inherited this, and an OS kill between pagehide
// and lock grant lost the edit. Web Locks are removed from save() entirely
// (they remain in sync.js's syncNow runner election, untouched here). Instead,
// multi-tab clobber detection uses a tiny companion key (STORE_KEY + ".seq")
// that is cheap to read on every save without parsing the full stored blob;
// the full parse only happens in the rare case where another tab has already
// written a higher seq.
function save(){
  var applying = (typeof syncIsApplying==="function" && syncIsApplying());
  // Stamp char.updatedAt only on a genuine user-driven char change (not while
  // sync is applying a merged state, which already carries its own updatedAt).
  if(!applying && S && S.char){
    var sig = _charSig(S.char);
    if(_prevCharSig !== null && sig !== _prevCharSig){ S.char.updatedAt = now(); }
    _prevCharSig = sig;
  } else if(S && S.char){
    _prevCharSig = _charSig(S.char);
  }
  IS_DIRTY = true;
  // #10 Multi-tab clobber protection: capture pre-bump __seq so we can detect
  // whether another tab wrote a newer state before this save() commits.
  var preBumpSeq = (S.__seq || 0);
  // Durable-state stamps (2026-07-11 persistence-loss fix, Phase A): a
  // monotonic __seq + wall-clock __savedAt on every S snapshot, so load()/
  // reconcileDurableState() can tell a genuinely newer copy (IndexedDB) from a
  // stale one (a localStorage write whose disk flush the OS never got to run
  // before a kill), and Phase B's merge guard can recognize a whole-state-
  // stale local. syncSubset() builds its own whitelisted-field object and
  // never copies these two keys, so they never leak into base/remote/Dropbox.
  function _saveCommit(){
    S.__seq = preBumpSeq + 1;
    S.__savedAt = now();
    var _json = JSON.stringify(S);
    try{
      localStorage.setItem(STORE_KEY, _json);
      // Companion key, written right after the state itself so the next
      // save() (in this tab or another) can cheaply detect a newer writer
      // without parsing the full blob. Skipped if setItem above threw.
      try{ localStorage.setItem(STORE_KEY + ".seq", String(S.__seq)); }catch(_){}
    }catch(quotaErr){
      // #11a: QuotaExceededError aborts setItem but __seq already bumped.
      // IDB has its own larger quota; write the mirror so reconcileDurableState
      // (which prefers higher __seq) recovers the state on next boot.
      try{ if(typeof toast==="function") toast("Storage quota exceeded \u2014 data saved to backup"); }catch(_){}
      try{ if(typeof logEvent==="function") logEvent({kind:"quotaError", message:String(quotaErr&&quotaErr.message||quotaErr)}); }catch(_){}
    }
    // Fire-and-forget durable mirror. IDB commits (oncomplete) far more
    // reliably than localStorage's batched flush; this is the actual fix, not
    // a backup of one. Exposed as _stateWritePromise so lifecycle handlers can
    // best-effort wait on it.
    _stateWritePromise = _idbWriteState(_json).catch(function(){ /* best-effort mirror */ });
    if(typeof scheduleSync==="function" && !applying) scheduleSync();
  }
  // Fast synchronous check against the companion seq key (no full-state
  // parse on the common path). If absent (legacy/first run), skip the check
  // and commit normally. This replaces the old Web-Locks read-check-write:
  // save() must return with localStorage already updated in the same JS
  // turn (2026-07-13 P0-1 — fixes an Android kill-path data-loss regression
  // where the lock callback deferred the actual write).
  var _companionRaw = null;
  try{ _companionRaw = localStorage.getItem(STORE_KEY + ".seq"); }catch(ex){}
  if(_companionRaw != null && Number(_companionRaw) > preBumpSeq){
    // Another tab already wrote a newer state — adopt it, drop this write,
    // same semantics as the old lock-based clobber-avoidance path.
    try{
      var stored = localStorage.getItem(STORE_KEY);
      if(stored){
        var storedObj = JSON.parse(stored);
        var storedSeq = Number(storedObj.__seq) || 0;
        S = migrate(storedObj);
        if(typeof logEvent==='function') logEvent({kind:'multiTabClobberAvoided', preBumpSeq:preBumpSeq, storedSeq:storedSeq});
        if(typeof render==='function') render();
        return;
      }
    }catch(ex){ /* fall through to _saveCommit on parse/read error */ }
  }
  _saveCommit();
}
// #10 Layer (b): storage event listener — incoming __seq > live → adopt + render.
// Keeps idle tabs current so layer (a) rarely fires.
if(typeof window!=='undefined'){
  try{
    window.addEventListener('storage', function(e){
      if(e.key !== STORE_KEY) return;
      try{
        if(!e.newValue) return;
        var incoming = JSON.parse(e.newValue);
        var incomingSeq = Number(incoming.__seq) || 0;
        var liveSeq = Number(S.__seq) || 0;
        if(incomingSeq > liveSeq){
          S = migrate(incoming);
          if(typeof render==='function') render();
        }
      }catch(ex){}
    });
  }catch(ex){}
}
// ---- durable IDB mirror of S (Phase A, 2026-07-11 persistence-loss fix) ----
function _idbWriteState(json){
  return idbOpen().then(function(db){
    return new Promise(function(resolve, reject){
      try{
        var tx = db.transaction("state", "readwrite");
        tx.objectStore("state").put(json, "S");
        tx.oncomplete = function(){ resolve(); };
        tx.onerror = function(){ reject(tx.error || new Error("state write failed")); };
        tx.onabort = function(){ reject(tx.error || new Error("state write aborted")); };
      }catch(e){ reject(e); }
    });
  });
}
function _idbReadState(){
  return idbOpen().then(function(db){
    return new Promise(function(resolve){
      try{
        var tx = db.transaction("state", "readonly");
        var req = tx.objectStore("state").get("S");
        req.onsuccess = function(){ resolve(req.result || null); };
        req.onerror = function(){ resolve(null); };
      }catch(e){ resolve(null); }
    });
  }).catch(function(){ return null; });
}
// Reconciles the synchronous localStorage-based boot (load(), already run
// above) against the durable IDB mirror. MUST resolve before syncInit()'s
// first sync round captures `local` -- otherwise a stale reverted local can
// be uploaded and permanently overwrite good remote/base data (the amplifier
// documented in .omo/plans/2026-07-11-persistence-loss-fix-plan.md §1.2).
// Never resurrects an OLDER IDB copy over a newer localStorage one (equal
// __seq is a cheap no-op -- localStorage stays authoritative, no spurious
// re-render on the common path).
function reconcileDurableState(){
  return _idbReadState().then(function(raw){
    if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'reconcile:read', found: !!raw});
    if(!raw) return;
    var idbS;
    try{ idbS = migrate(JSON.parse(raw)); }catch(e){ return; }
    var idbSeq = Number(idbS.__seq) || 0;
    var liveSeq = Number(S.__seq) || 0;
    if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'reconcile:compare', idbSeq:idbSeq, liveSeq:liveSeq});
    if(idbSeq > liveSeq){
      S = idbS;
      if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'reconcile:idb-won', idbSeq:idbSeq, liveSeq:liveSeq});
      if(typeof render==="function") render();
    }
  }).catch(function(){ /* best-effort; boot proceeds on the localStorage copy */ });
}
/* END_DURABLE_STATE_HELPERS */
// --- TEMP debug overlay (2026-07-11 recency-guard on-device diagnosis) -----
// 5 taps on the version number in Settings within 3s opens an on-screen dump
// of BASE (IndexedDB syncmeta.base) vs LIVE (S) task/device state, so this can
// be read directly on a phone with no console/bookmarklet access.
// 2026-07-12: promoted to a permanent field-diagnostic tool. The "Download All"
// button gathers EVERYTHING a desktop devtools session could inspect into one
// JSON file -- all localStorage, every IndexedDB database+store (event log,
// snapshots, sync base, durable mirror), Cache Storage, service-worker state, a
// storage-quota estimate, the live in-memory S, runtime/environment facts, and a
// ring buffer of uncaught errors -- for phones with no dev console. dump() also
// carries type/streak/done so the on-screen copy shows daily streaks, not just ids.
var _versionTapCount = 0, _versionTapTimer = null;
function tapVersionDebug(){
  _versionTapCount++;
  clearTimeout(_versionTapTimer);
  _versionTapTimer = setTimeout(function(){ _versionTapCount = 0; }, 3000);
  if(_versionTapCount >= 5){
    _versionTapCount = 0;
    clearTimeout(_versionTapTimer);
    showSyncDebugOverlay();
  }
}
function showSyncDebugOverlay(){
  var cfg = {}; try{ cfg = JSON.parse(localStorage.getItem("questa.sync.v1") || "{}"); }catch(e){}
  function dump(a){ return (a && a.tasks) ? a.tasks.map(function(t){ return {id:t.id, type:t.type, title:t.title, streak:t.streak, done:t.done, updatedAt:t.updatedAt, createdAt:t.createdAt}; }) : "n/a"; }
  function renderOverlay(base){
    var out = {
      APP_VERSION: (typeof APP_VERSION!=="undefined")?APP_VERSION:"?",
      baseReset: localStorage.getItem("questa.baseReset.v1"),
      cfg: {lastRev:cfg.lastRev, lastSyncAt:cfg.lastSyncAt, lastError:cfg.lastError, evtLastUploadTs:cfg.evtLastUploadTs, deviceId:cfg.deviceId, deviceName:cfg.deviceName},
      BASE_tasks: dump(base),
      LIVE_tasks: (typeof S!=="undefined")?dump(S):"no S",
      LIVE_devices: (typeof S!=="undefined" && S.devices)?S.devices:"n/a",
      BASE_devices: (base && base.devices)?base.devices:"n/a"
    };
    var text = JSON.stringify(out, null, 2);
    var ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;background:#000;z-index:99999;display:flex;flex-direction:column;padding:10px;box-sizing:border-box;";
    var ta = document.createElement("textarea");
    ta.readOnly = true;
    ta.value = text;
    ta.style.cssText = "flex:1;width:100%;background:#111;color:#0f0;font-family:monospace;font-size:11px;border:1px solid #444;padding:8px;box-sizing:border-box;";
    var btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:8px;";
    var copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.style.cssText = "flex:1;padding:12px;font-size:16px;";
    copyBtn.onclick = function(){
      ta.focus(); ta.select();
      try{
        if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text); }
        else { document.execCommand("copy"); }
        copyBtn.textContent = "Copied!";
      }catch(e){
        try{ document.execCommand("copy"); copyBtn.textContent = "Copied!"; }
        catch(e2){ copyBtn.textContent = "Copy failed - select manually"; }
      }
    };
    var dlBtn = document.createElement("button");
    dlBtn.textContent = "Download All";
    dlBtn.style.cssText = "flex:1;padding:12px;font-size:16px;";
    dlBtn.onclick = function(){ downloadFullDiagnostic(dlBtn); };
    var closeBtn = document.createElement("button");
    closeBtn.textContent = "Close";
    closeBtn.style.cssText = "flex:1;padding:12px;font-size:16px;";
    closeBtn.onclick = function(){ ov.remove(); };
    btnRow.appendChild(copyBtn); btnRow.appendChild(dlBtn); btnRow.appendChild(closeBtn);
    ov.appendChild(ta); ov.appendChild(btnRow);
    document.body.appendChild(ov);
    ta.focus(); ta.select();
  }
  try{
    var r = indexedDB.open("questa");
    r.onerror = function(){ renderOverlay(null); };
    r.onsuccess = function(){
      try{
        var g = r.result.transaction("syncmeta","readonly").objectStore("syncmeta").get("base");
        g.onsuccess = function(){ renderOverlay(g.result ? JSON.parse(g.result) : null); };
        g.onerror = function(){ renderOverlay(null); };
      }catch(e){ renderOverlay(null); }
    };
  }catch(e){ renderOverlay(null); }
}
// --- FULL on-device diagnostic export (2026-07-12) --------------------------
// Everything a desktop devtools session could inspect, in one downloadable JSON.
// Async because IndexedDB / Cache Storage / SW / storage-estimate are all async.
function _diagIdbDumpAll(){
  function listDbs(){
    try{ if(indexedDB.databases) return indexedDB.databases().then(function(l){ return l.map(function(d){return d.name;}).filter(Boolean); }).catch(function(){ return ["questa"]; }); }catch(e){}
    return Promise.resolve(["questa"]);
  }
  return listDbs().then(function(names){
    return Promise.all(names.map(function(name){
      return new Promise(function(resolve){
        var out = {}; var req;
        try{ req = indexedDB.open(name); }catch(e){ resolve([name, {__error:String(e)}]); return; }
        req.onerror = function(){ resolve([name, {__error:"open failed"}]); };
        req.onsuccess = function(){
          var db = req.result;
          var stores = Array.prototype.slice.call(db.objectStoreNames);
          if(!stores.length){ try{db.close();}catch(e){} resolve([name, {}]); return; }
          var pending = stores.length;
          stores.forEach(function(sn){
            try{
              var g = db.transaction(sn,"readonly").objectStore(sn).getAll();
              g.onsuccess = function(){ out[sn] = g.result; if(--pending===0){ try{db.close();}catch(e){} resolve([name, out]); } };
              g.onerror = function(){ out[sn] = {__error:"getAll failed"}; if(--pending===0){ try{db.close();}catch(e){} resolve([name, out]); } };
            }catch(e){ out[sn] = {__error:String(e)}; if(--pending===0){ try{db.close();}catch(e){} resolve([name, out]); } }
          });
        };
      });
    })).then(function(pairs){ var o={}; pairs.forEach(function(p){ o[p[0]]=p[1]; }); return o; });
  }).catch(function(e){ return {__error:String(e)}; });
}
function _diagCacheDump(){
  try{
    if(!(window.caches && caches.keys)) return Promise.resolve("n/a");
    return caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        return caches.open(k).then(function(c){ return c.keys().then(function(reqs){ return [k, reqs.map(function(r){return r.url;})]; }); });
      })).then(function(pairs){ var o={}; pairs.forEach(function(p){o[p[0]]=p[1];}); return o; });
    }).catch(function(){ return "error"; });
  }catch(e){ return Promise.resolve("error"); }
}
function _diagSwDump(){
  try{
    if(!navigator.serviceWorker) return Promise.resolve("n/a");
    var getRegs = navigator.serviceWorker.getRegistrations ? navigator.serviceWorker.getRegistrations() : Promise.resolve([]);
    return getRegs.then(function(regs){
      return { controller: (navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL)||null,
        registrations: regs.map(function(r){ return {scope:r.scope, active:(r.active&&r.active.scriptURL)||null, waiting:(r.waiting&&r.waiting.scriptURL)||null, installing:(r.installing&&r.installing.scriptURL)||null}; }) };
    }).catch(function(){ return "error"; });
  }catch(e){ return Promise.resolve("error"); }
}
function _diagStorageEstimate(){
  try{ if(navigator.storage && navigator.storage.estimate) return navigator.storage.estimate().catch(function(){return "error";}); }catch(e){}
  return Promise.resolve("n/a");
}
function questaFullDiagnostic(){
  var ls = {};
  try{ for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); ls[k]=localStorage.getItem(k); } }catch(e){ ls={__error:String(e)}; }
  var meta = {
    generatedAt: new Date().toISOString(),
    appVersion: (typeof APP_VERSION!=="undefined")?APP_VERSION:"?",
    userAgent: navigator.userAgent, platform: navigator.platform,
    language: navigator.language, languages: navigator.languages, onLine: navigator.onLine,
    displayMode: (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)?"standalone":"browser",
    viewport: {w:window.innerWidth, h:window.innerHeight, dpr:window.devicePixelRatio, screenW:(window.screen&&screen.width)||null, screenH:(window.screen&&screen.height)||null},
    visibilityState: (typeof document!=="undefined")?document.visibilityState:null,
    vibrate: typeof navigator.vibrate,
    notificationPermission: (typeof Notification!=="undefined")?Notification.permission:"n/a"
  };
  return Promise.all([_diagIdbDumpAll(), _diagCacheDump(), _diagSwDump(), _diagStorageEstimate()]).then(function(r){
    var idb = r[0], caches_ = r[1], sw = r[2], est = r[3];
    var errors = (window.__qDiag && window.__qDiag.errors) ? window.__qDiag.errors : [];
    var live = (typeof S!=="undefined") ? S : null;
    function bytes(x){ try{ return JSON.stringify(x).length; }catch(e){ return -1; } }
    var tbt = {daily:0, habit:0, todo:0, other:0};
    try{ ((live && live.tasks) || []).forEach(function(t){ if(t && tbt[t.type]!==undefined) tbt[t.type]++; else tbt.other++; }); }catch(e){}
    var idbCounts = {};
    try{ Object.keys(idb||{}).forEach(function(db){ idbCounts[db] = {}; var stores = idb[db]||{}; Object.keys(stores).forEach(function(sn){ var v = stores[sn]; idbCounts[db][sn] = Array.isArray(v) ? v.length : ((v && v.__error) ? ("err:"+v.__error) : "?"); }); }); }catch(e){}
    var manifest = {
      schemaVersion: 1,
      generatedAt: meta.generatedAt,
      appVersion: meta.appVersion,
      note: "Read this block first to triage. Then slice the section you need with jq/python -- do NOT load the whole file into an LLM context. See DIAGNOSTIC-FORMAT.md in the repo.",
      sizesBytes: { meta:bytes(meta), localStorage:bytes(ls), indexedDB:bytes(idb), caches:bytes(caches_), serviceWorker:bytes(sw), storageEstimate:bytes(est), errors:bytes(errors), liveS:bytes(live) },
      counts: {
        tasksByType: tbt,
        deletionsTombstones: (live && Array.isArray(live.deletions)) ? live.deletions.length : 0,
        localStorageKeys: Object.keys(ls).length,
        errors: (errors && errors.length) || 0,
        indexedDB: idbCounts
      },
      keyDescriptions: {
        manifest: "This block: schema version, per-section byte sizes and record counts.",
        meta: "Runtime/environment: appVersion, userAgent, viewport, display-mode, online, permissions.",
        localStorage: "Every localStorage key/value. questa.save.v1 = full persisted state S; questa.sync.v1 = sync config; questa.baseReset.v1 = one-time base-purge flag.",
        indexedDB: "Every IndexedDB db+store. questa.backups = Tier-1 snapshots; questa.syncmeta (key 'base') = last synced baseline; the events store = append-only event log (streak/completion history); durable store = persistence mirror of S.",
        caches: "Cache Storage: cache name -> cached URLs. Diagnoses stale-shell / SW-update issues (look for questa-vNNN).",
        serviceWorker: "Active/waiting/installing SW script URLs + controller. Mismatch vs latest questa-vNNN => update did not take.",
        storageEstimate: "Quota vs usage bytes.",
        errors: "Ring buffer (<=50) of uncaught errors + unhandled promise rejections, newest last.",
        liveS: "In-memory app state S at capture time (tasks incl. streak/done/repeat, char, prefs, deletions tombstones). Compare to localStorage.questa.save.v1 to spot divergence."
      }
    };
    return Object.assign({ manifest: manifest }, {
      meta: meta, storageEstimate: est, errors: errors,
      liveS: live, localStorage: ls, serviceWorker: sw, caches: caches_, indexedDB: idb
    });
  });
}
function downloadFullDiagnostic(btn){
  if(btn) btn.textContent = "Gathering...";
  questaFullDiagnostic().then(function(bundle){
    var json = JSON.stringify(bundle, null, 2);
    var blob = new Blob([json], {type:"application/json"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "questa-fulldiag-" + new Date().toISOString().replace(/[:.]/g,"-") + ".json";
    document.body.appendChild(a); a.click();
    setTimeout(function(){ try{ document.body.removeChild(a); }catch(e){} URL.revokeObjectURL(url); }, 2000);
    if(btn) btn.textContent = "Downloaded!";
  }).catch(function(e){ if(btn) btn.textContent = "Failed - use Copy"; });
}
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
const IDB_VERSION = 4;
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
      let evStore;
      if(!db.objectStoreNames.contains(EVENTS_STORE)){
        evStore = db.createObjectStore(EVENTS_STORE, {keyPath:"id", autoIncrement:true});
        evStore.createIndex("ts", "ts", {unique:false});
        evStore.createIndex("kind", "kind", {unique:false});
        evStore.createIndex("taskId", "taskId", {unique:false});
      } else {
        evStore = req.transaction.objectStore(EVENTS_STORE);
      }
      if(!evStore.indexNames.contains("uid")){
        evStore.createIndex("uid", "uid", {unique:false});
      }
      if(!db.objectStoreNames.contains("backups")){
        db.createObjectStore("backups", {keyPath:"id", autoIncrement:true});
      }
      if(!db.objectStoreNames.contains("syncmeta")){
        db.createObjectStore("syncmeta");
      }
      // Phase A (2026-07-11 persistence-loss fix): durable mirror of S. See
      // .omo/plans/2026-07-11-persistence-loss-fix-plan.md §2.
      if(!db.objectStoreNames.contains("state")){
        db.createObjectStore("state");
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
  const rec = (typeof syncEventUid==="function" && typeof syncDeviceId==="function")
    ? Object.assign({ts:Date.now(), uid:syncEventUid(), dev:syncDeviceId()}, ev)
    : Object.assign({ts:Date.now()}, ev);
  idbOpen().then(db=>{
    try{
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      tx.objectStore(EVENTS_STORE).add(rec);
    }catch(e){ /* swallow: fidelity layer is best-effort, never blocks scoring */ }
  }).catch(()=>{ /* IDB unavailable (e.g. private mode) — silently skip logging */ });
}
/* BEGIN_EVENTS_HELPERS */
// Async read API: resolve to events in [from,to] (ms, inclusive) optionally
// filtered by kind and/or taskId. Uses the ts index range so we never load the
// whole store for a windowed query. Returns [] on any failure (never throws).
var DIAGNOSTIC_KINDS = ['lifecycle','storagePersist','webLocksUnavailable','clockSkew','multiTabClobberAvoided','quotaError'];
function getEvents(opts){
  opts = opts || {};
  const from = (opts.from!=null) ? opts.from : -Infinity;
  const to   = (opts.to!=null)   ? opts.to   : Infinity;
  const wantKind = opts.kind || null;
  const wantTask = opts.taskId || null;
  const includeDiag = !!opts.includeDiag;
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
      const isDiag = DIAGNOSTIC_KINDS.indexOf(v.kind) >= 0;
      if(!isDiag || includeDiag || wantKind === v.kind){
        if((!wantKind || v.kind===wantKind) && (!wantTask || v.taskId===wantTask)) out.push(v);
      }
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
// One-time purge of 'lifecycle' diagnostic events written by an earlier
// build of the Phase C instrumentation, which (bug, fixed 2026-07-11) logged
// on every save() -- including the 400ms-debounced scroll-driven save() --
// and flooded the user-facing Activity Feed with "System action" rows. Safe
// to run unconditionally: getEvents() now filters these out of every normal
// read regardless, so this is strictly a storage/hygiene cleanup, not a
// correctness fix on its own.
function clearLifecycleEvents(){
  return idbOpen().then(db=>new Promise((resolve)=>{
    let removed=0, tx;
    try{ tx = db.transaction(EVENTS_STORE,"readwrite"); }catch(e){ resolve(0); return; }
    const cur = tx.objectStore(EVENTS_STORE).openCursor();
    cur.onsuccess = ()=>{ const c=cur.result;
      if(!c){ return; }
      if(c.value && c.value.kind==="lifecycle"){ try{c.delete();}catch(e){} removed++; }
      c.continue();
    };
    tx.oncomplete = ()=>resolve(removed);
    tx.onerror = ()=>resolve(removed);
    tx.onabort = ()=>resolve(removed);
  })).catch(()=>0);
}
/* END_EVENTS_HELPERS */
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
// SHA-256 hash for backup integrity verification. Falls back to a simple
// length-based digest when Web Crypto is unavailable (e.g. insecure context).
async function computeHash(str){
  if(typeof crypto!=="undefined" && crypto.subtle && crypto.subtle.digest){
    try{
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
    }catch(e){ /* fall through */ }
  }
  // Fallback: deterministic string-length-based hash when crypto unavailable
  let h = 0;
  for(let i=0; i<str.length; i++){ h = ((h<<5)-h)+str.charCodeAt(i); h |= 0; }
  return 'fallback-' + Math.abs(h).toString(16).padStart(8,'0');
}

// --- Backup snapshot read/list (Tier-1 core write/verify) --------------------
async function listSnapshots(){
  try{
    const db = await idbOpen();
    const tx = db.transaction("backups","readonly");
    const store = tx.objectStore("backups");
    return await new Promise((resolve,reject)=>{
      const out=[];
      const req = store.openCursor();
      req.onsuccess = ()=>{ const c=req.result;
        if(!c){ resolve(out.sort((a,b)=>b.ts-a.ts)); return; }
        out.push(c.value); c.continue(); };
      req.onerror = ()=>reject(req.error);
    });
  }catch(e){ console.error("listSnapshots failed:",e); return []; }
}
async function readSnapshot(id){
  try{
    const db = await idbOpen();
    return await new Promise((resolve,reject)=>{
      const req = db.transaction("backups","readonly").objectStore("backups").get(id);
      req.onsuccess = ()=>resolve(req.result||null);
      req.onerror = ()=>reject(req.error);
    });
  }catch(e){ console.error("readSnapshot failed:",e); return null; }
}
async function writeSnapshot(type, tier){
  try{
    const db = await idbOpen();
    let events = [];
    if(type === "full"){
      const all = await getEvents({includeDiag:true});
      events = all || [];
    } else {
      try{
        const snapshots = await listSnapshots();
        const lastBaseline = snapshots.find(s => s.type === "full");
        const since = lastBaseline ? lastBaseline.ts : 0;
        const recent = await getEvents({from: since, includeDiag:true});
        events = recent || [];
      }catch(e){
        console.warn("Delta snapshot fallback to full", e);
        const all = await getEvents({includeDiag:true});
        events = all || [];
        type = "full";
      }
    }
    const payload = JSON.stringify({stateSnapshot: S, events});
    const hash = await computeHash(payload);
    const rec = {
      payload, hash, type,
      appVersion: typeof APP_VERSION!=="undefined"?APP_VERSION:"unknown",
      ts: Date.now(),
      counts: {
        tasks: (S.tasks||[]).length, rewards: (S.rewards||[]).length,
        tags: (S.tags||[]).length,
        views: ((S.prefs&&S.prefs.an&&S.prefs.an.views)||[]).length,
        events: events.length
      },
      verified: false,
      tier: tier || null
    };
    const tx = db.transaction("backups","readwrite");
    const store = tx.objectStore("backups");
    const id = await new Promise((resolve,reject)=>{
      const req = store.add(rec);
      req.onsuccess = ()=>resolve(req.result);
      req.onerror = ()=>reject(req.error);
    });
    await new Promise(r=>{ tx.oncomplete=r; tx.onerror=r; tx.onabort=r; });
    // Write-then-verify: read back, recompute hash, mark verified or delete
    try{
      const tx2 = db.transaction("backups","readonly");
      const store2 = tx2.objectStore("backups");
      const saved = await new Promise((resolve,reject)=>{
        const req = store2.get(id);
        req.onsuccess = ()=>resolve(req.result);
        req.onerror = ()=>reject(req.error);
      });
      if(saved){
        const check = await computeHash(saved.payload);
        if(check === saved.hash){
          const tx3 = db.transaction("backups","readwrite");
          const store3 = tx3.objectStore("backups");
          saved.verified = true; store3.put(saved);
        } else {
          const tx3 = db.transaction("backups","readwrite");
          const store3 = tx3.objectStore("backups");
          store3.delete(id);
          console.error("Snapshot verification failed - hash mismatch, deleted record", id);
        }
      }
    }catch(e){ console.error("Snapshot verification error:",e); }
    return id;
  }catch(e){ console.error("writeSnapshot failed:",e); return null; }
}

// takeSnapshot: write a single full (GFS tier if boundary crossed) or delta,
// then rotate. Uses snapshotBoundaryKeys (W1.1), S.prefs.gfs markers (W1.2),
// and writeSnapshot(type, tier) (W1.3).
async function takeSnapshot(){
  const k = snapshotBoundaryKeys(Date.now());
  const g = S.prefs.gfs || (S.prefs.gfs = {daily:0, weekly:0, monthly:0});
  let tier = null;
  if(g.monthly !== k.month) tier = "monthly";
  else if(g.weekly !== k.week) tier = "weekly";
  else if(g.daily  !== k.day)  tier = "daily";
  // Advance markers ONLY if the write actually succeeded (writeSnapshot returns
  // the new id, or null on failure). Otherwise the boundary cross is "consumed"
  // without a baseline full and that daily/weekly/monthly slot is silently skipped
  // until the next boundary -- a transient IDB error must NOT permanently skip a tier.
  const id = tier ? await writeSnapshot("full", tier) : await writeSnapshot("delta");
  if(id){
    try { g.daily = k.day; g.weekly = k.week; g.monthly = k.month; save(); }
    catch(e) { /* markers not persisted; next call may re-promote -- acceptable */ }
    await rotateSnapshots();
  }
  return id;
}

// Grandfather-father-son rotation: keep 7 daily, 4 weekly, 6 monthly baselines.
// Uses calendar-boundary keys (snapshotBoundaryKeys) NOT epoch buckets.
async function rotateSnapshots(){
  try{
    const db = await idbOpen();
    const snaps = await listSnapshots();
    if(snaps.length === 0) return;
    const fulls = snaps.filter(s => s.type === "full");
    const deltas = snaps.filter(s => s.type === "delta");
    const keep = new Set([snaps[0].id]); // newest overall
    // Daily: keep 7 most-recent distinct calendar-day fulls
    const dailySeen = new Set(); const dailyKeptFulls = [];
    for(const s of fulls){ const dk = snapshotBoundaryKeys(s.ts).day;
      if(!dailySeen.has(dk)){ dailySeen.add(dk); keep.add(s.id); dailyKeptFulls.push(s); if(dailySeen.size>=7) break; } }
    // Weekly: keep 4 most-recent distinct ISO-week fulls
    const weekSeen = new Set();
    for(const s of fulls){ const wk = snapshotBoundaryKeys(s.ts).week;
      if(!weekSeen.has(wk)){ weekSeen.add(wk); keep.add(s.id); if(weekSeen.size>=4) break; } }
    // Monthly: keep 6 most-recent distinct month fulls
    const monthSeen = new Set();
    for(const s of fulls){ const mk = snapshotBoundaryKeys(s.ts).month;
      if(!monthSeen.has(mk)){ monthSeen.add(mk); keep.add(s.id); if(monthSeen.size>=6) break; } }
    // Son window floor = oldest retained DAILY full (keeps deltas within ~7 days)
    let oldestDailyFullTs = Infinity;
    for(const s of dailyKeptFulls){ oldestDailyFullTs = Math.min(oldestDailyFullTs, s.ts); }
    for(const s of deltas){ if(s.ts >= oldestDailyFullTs) keep.add(s.id); }
    // Chain integrity: a kept delta must keep its baseline full (ts <= delta.ts)
    for(const s of deltas){ if(keep.has(s.id)){
      const base = fulls.find(f => f.ts <= s.ts); if(base) keep.add(base.id); } }
    const tx = db.transaction("backups","readwrite");
    const store = tx.objectStore("backups");
    for(const s of snaps){ if(!keep.has(s.id)) store.delete(s.id); }
  }catch(e){ console.error("rotateSnapshots failed:", e); }
}

// (Retained, no longer wired to a Settings button.) Loads a standalone events
// JSON into IndexedDB, replacing prior synthetic events. The importer now embeds
// events directly in the import file, so normal Settings -> Import handles them;
// this remains available for loading a separate events file if ever needed.
function importEventsBackfill(ev){
  const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{
    let blob;
    try{ blob=JSON.parse(rd.result); }catch(e){ alertDialog('Error', 'That file is not valid JSON.'); return; }
    const list = Array.isArray(blob) ? blob : (blob && Array.isArray(blob.events) ? blob.events : null);
    if(!list){ alertDialog('Error', 'That file does not look like a Questa event backfill (no events array).'); return; }
    if(typeof indexedDB==="undefined"){ alertDialog('Error', 'IndexedDB is unavailable here (e.g. private browsing), so events cannot be loaded.'); return; }
    confirmDialog('Load Synthesized Events', 'Load '+list.length+' synthesized events? This replaces any previously loaded backfill (your live taps are kept).').then(ok => {
      if(!ok) return;
      // mark everything from this load as synthetic so a re-load can replace it
      list.forEach(e=>{ if(e && typeof e==="object" && e.synthetic===undefined) e.synthetic=true; });
      clearSyntheticEvents().then(()=>bulkAddEvents(list)).then(added=>{
        toast('Loaded '+added+' events');
        if(TAB==='analytics') render();
      });
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
function applyCardThick(){ document.documentElement.style.setProperty('--card-min-h',(32+(S.prefs.cardThick||0))+'px'); }

const uid = ()=> Date.now().toString(36)+Math.random().toString(36).slice(2,7);
// dayStamp: LOCAL calendar day via JS Date (getFullYear/getMonth/getDate, not UTC).
// missedOn and lastCron store these LOCAL YYYYMMDD ints. Cross-device TZ diffs
// are cosmetic mismatches only, not data loss — see tests/daystamp.test.js.
function dayStamp(d){ return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate(); }
// isoWeekKey(ts): ISO-8601 week key — year*100 + ISO week number (Mon-start).
// Week 1 contains the first Thursday of the year (ISO 8601 definition).
function isoWeekKey(ts){
  var d = new Date(ts);
  // Shift to the Monday of the ISO week: day-of-week (0=Sun..6=Sat) -> ISO (0=Mon..6=Sun)
  var dow = (d.getDay() + 6) % 7;
  // Thursday trick: set to Thursday of this week, then read its year
  d.setDate(d.getDate() - dow + 3);
  var isoYear = d.getFullYear();
  // Jan 4 is always in ISO week 1; weekNo = 1 + days since first Thursday / 7
  var jan4 = new Date(isoYear, 0, 4);
  var weekNo = 1 + Math.floor((d - jan4) / 604800000);
  return isoYear * 100 + weekNo;
}
// snapshotBoundaryKeys(ts): calendar-boundary keys for GFS tier rotation.
// Returns {day: YYYYMMDD, week: ISO week key, month: year*12+month}.
function snapshotBoundaryKeys(ts){
  var d = new Date(ts);
  return {
    day:   dayStamp(d),
    week:  isoWeekKey(ts),
    month: d.getFullYear() * 12 + d.getMonth()
  };
}
/* BEGIN_REMINDER_HELPERS */
function normalizeTaskReminders(t) {
  if (!t.reminders || !Array.isArray(t.reminders)) {
    t.reminders = [];
  }
}

function isReminderDue(t, r, now) {
  if (!r.enabled) return false;
  if (t.type === 'todo' && t.done) return false;
  
  const currentHour = String(now.getHours()).padStart(2, '0');
  const currentMin = String(now.getMinutes()).padStart(2, '0');
  const currentTimeStr = `${currentHour}:${currentMin}`;
  if (r.time !== currentTimeStr) return false;
  
  if (r.kind === 'once') {
    const currentYear = now.getFullYear();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentDateVal = String(now.getDate()).padStart(2, '0');
    const currentDateStr = `${currentYear}-${currentMonth}-${currentDateVal}`;
    if (r.date !== currentDateStr) return false;
  } else {
    const currentDay = now.getDay();
    if (t.type === 'daily') {
      if (t.repeat && !t.repeat[currentDay]) return false;
    } else {
      if (r.days && !r.days[currentDay]) return false;
    }
  }
  
  const fireKey = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${r.time}`;
  if (r.lastFiredKey === fireKey) return false;
  
  return true;
}

function getReminderNotificationPayload(t, r) {
  let title = t.title || 'Questa Reminder';
  let body = '';
  if (t.type === 'habit') {
    body = t.notes ? `Nudge: ${t.notes}` : 'Time to score your habit!';
  } else if (t.type === 'daily') {
    body = t.notes ? `Daily reminder: ${t.notes}` : 'Check off your daily task!';
  } else {
    body = t.notes ? `To-Do due: ${t.notes}` : 'Complete your to-do!';
  }
  return {
    title: title,
    body: body,
    tag: `questa-${t.id}`
  };
}
/* END_REMINDER_HELPERS */
let _schedulerInterval = null;
function startReminderScheduler() {
  if (_schedulerInterval) clearInterval(_schedulerInterval);
  checkReminders();
  _schedulerInterval = setInterval(checkReminders, 60000);
}

function checkReminders() {
  if (!S.prefs || !S.prefs.notificationsEnabled) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  
  const now = new Date();
  let tasksChanged = false;
  
  S.tasks.forEach(t => {
    if (!t.reminders) return;
    t.reminders.forEach(r => {
      if (isReminderDue(t, r, now)) {
        const payload = getReminderNotificationPayload(t, r);
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'SHOW_NOTIFICATION',
            title: payload.title,
            body: payload.body,
            tag: payload.tag
          });
        } else {
          new Notification(payload.title, { body: payload.body, tag: payload.tag });
        }
        
        const fireKey = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${r.time}`;
        r.lastFiredKey = fireKey;
        tasksChanged = true;
      }
    });
  });
  
  if (tasksChanged) {
    save();
  }
}
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

const DIFF = { trivial:0.1, easy:1, medium:1.5, hard:2, log:0 };
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
function completeTask(t, ev){
  if(t.done) return;
  if(t.type==='daily' && !isDailyDueToday(t)) return; // non-due dailies must never complete (blocks streak/reward/isDue inflation)
  const r = completionReward(t);
  const delta = valueDelta(t.value);
  gainXp(r.xp); S.char.gold = +(S.char.gold + r.gold).toFixed(2); S.char.mp += r.mp;
  t.value = clamp(t.value + delta, -47.27, 99);
  t.done = true;
  t.updatedAt = now();
  t.doneAt = Date.now(); // F3 (2026-07-11): completion-day channel for cron-aware merge; see sync.js resolveDailyConflict/.omo/plans/2026-07-11-cron-merge-recency.md
  delete t.missedOn;
  buzz(50);
  t._gr = { xp:r.xp, gold:r.gold, mp:r.mp, delta:delta };  // remember exactly what was granted
  if(t.type==='daily'){ t.streak = (t.streak||0) + 1;
    const cl=(t.checklist||[]); const snap = cl.length? {checklist:cl.map(c=>({text:c.text,done:!!c.done}))} : {};
    logHistory(t,Object.assign({value:t.value,completed:true,isDue:true,reward:Object.assign({},t._gr),repeat:(t.repeat||[]).slice()},snap));
    // isDue:true is safe here: non-due dailies are gated above
    logEvent({kind:'complete', taskType:'daily', taskId:t.id, taskTitle:t.title,
              streak:t.streak, reward:Object.assign({},t._gr), repeat:(t.repeat||[]).slice(),
              checklist:cl.map(c=>({id:c.id||null,text:c.text,done:!!c.done}))}); }
  if(t.type==='todo'){ t.completedAt = Date.now();
    logHistory(t,{value:t.value,completed:true,reward:Object.assign({},t._gr)});
    logEvent({kind:'complete', taskType:'todo', taskId:t.id, taskTitle:t.title,
              reward:Object.assign({},t._gr), createdAt:t.createdAt||null, completedAt:t.completedAt}); }
  bumpAvatar(); floatFx(fxGain(r.xp,r.gold),'pos',ev);
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
  const _gr=t._gr?Object.assign({},t._gr):null;
  reverseGrant(t);
  unlogToday(t);
  t.done = false;
  delete t.doneAt; // F3 (2026-07-11): unchecking retracts the completion-day claim
  if(t.type==='daily' && t.streak){ t.streak = Math.max(0, t.streak - 1); }
  t.updatedAt = now(); // F1 (2026-07-11): unchecking is an edit — without this it loses every both-changed merge tiebreak
  try{ logEvent(Object.assign({kind:'uncomplete', taskType:t.type, taskId:t.id, taskTitle:t.title}, _gr?{clawback:{xp:_gr.xp,gold:_gr.gold,mp:_gr.mp}}:{})); }catch(e){}
  save(); render();
}
function uncompleteTodo(t){
  const _gr=t._gr?Object.assign({},t._gr):null;
  reverseGrant(t);
  unlogToday(t);
  t.done = false;
  delete t.doneAt; // F3 (2026-07-11): see uncompleteDaily
  t.updatedAt = now(); // F1 (2026-07-11): see uncompleteDaily
  toast('Reverted');
  try{ logEvent(Object.assign({kind:'uncomplete', taskType:t.type, taskId:t.id, taskTitle:t.title}, _gr?{clawback:{xp:_gr.xp,gold:_gr.gold,mp:_gr.mp}}:{})); }catch(e){}
  save(); render();
}
function scoreHabit(id, dir, ev){
  if(_suppressHabitClick===id){ _suppressHabitClick=null; return; }  // ignore the click fired right after a long-press
  const t=S.tasks.find(x=>x.id===id); if(!t)return;
  if(t.difficulty==='log'){
    // Log habit: a pure tally. NO xp/gold/mp/hp, and value/color never changes.
    // Any tap (+ or −) increments the period counter; a non-zero counter is what
    // marks it "logged" and hides it from the All filter (see viewHabits) until
    // the counter resets on the resetFreq boundary (cron). Reps are still logged
    // so the metrics/analytics system counts the activity, but scored:false so it
    // is never treated as a rewarded score.
    const _rpt = t.repsPerTap || repsPerTap(t.title);
    if(dir>0){
      t.cUp=(t.cUp||0)+1;
      logHistory(t,{value:t.value,reps:_rpt,repCounted:true,scored:false});
      logEvent({kind:'habitTap', dir:1, taskId:t.id, taskTitle:t.title, reps:_rpt, value:t.value, log:true});
    } else {
      t.cDown=(t.cDown||0)+1;
      logHistory(t,{value:t.value,reps:_rpt,repCounted:true,scored:false});
      logEvent({kind:'habitTap', dir:-1, taskId:t.id, taskTitle:t.title, reps:_rpt, value:t.value, log:true});
    }
    buzz(50); floatFx('logged','pos',ev);
    t.updatedAt=now();
    save(); render();
    return;
  }
  if(dir>0){
    const r=completionReward(t);
    gainXp(r.xp); S.char.gold=+(S.char.gold+r.gold).toFixed(2); S.char.mp+=r.mp;
    t.value=clamp(t.value+valueDelta(t.value),-47.27,99);
    t.cUp=(t.cUp||0)+1;
    const _rpt = t.repsPerTap || repsPerTap(t.title);
    logHistory(t,{value:t.value,scoredUp:1,reps:_rpt,repCounted:true,scored:true});
    logEvent({kind:'habitTap', dir:1, taskId:t.id, taskTitle:t.title, reps:_rpt, value:t.value});
    bumpAvatar(); buzz(50); floatFx(fxGain(r.xp,r.gold),'pos',ev);
  } else {
    const dmg=missDamage(t);
    t.value=clamp(t.value-valueDelta(t.value),-47.27,99);
    t.cDown=(t.cDown||0)+1;
    logHistory(t,{value:t.value,scoredDown:1});
    logEvent({kind:'habitTap', dir:-1, taskId:t.id, taskTitle:t.title, value:t.value, dmg:dmg});
    takeDamage(dmg); buzz(100); floatFx('-'+dmg.toFixed(1)+' HP','neg',ev);
  }
  t.updatedAt=now();
  save(); render();
}
// ---- Bulk reps entry (long-press +/− on a habit card) ---------------------
// Logs a precise rep count WITHOUT scoring the habit (no value/XP/gold/HP, no
// cUp/cDown increment). Reps are aggregated by the 'reps' metric system via the
// history event. `n` is signed: positive adds, negative removes.
let REP=null;                 // active rep-sheet draft: {id, sign, value}
let _suppressHabitClick=null; // id whose trailing click we must ignore after a long-press
const REP_LONGPRESS_MS=350;
function addReps(id, n){
  const t=S.tasks.find(x=>x.id===id); if(!t) return;
  // Reflect bulk reps on the habit's +/− counter (no scoring): positive reps
  // add to cUp, negative reps add to cDown. This is the on-card feedback the
  // reps panel needs; value/XP/gold/HP are intentionally untouched.
  if(n>0) t.cUp=(t.cUp||0)+n; else t.cDown=(t.cDown||0)+(-n);
  logHistory(t,{value:t.value, reps:n, repCounted:true, scored:false});
  logEvent({kind:'habitReps', dir:Math.sign(n), taskId:t.id, taskTitle:t.title, reps:n, value:t.value});
  t.updatedAt=now();
  save(); render();
  toast((n>0?'+':'') + n + ' reps · no reward');
}
function openRepSheet(id, sign){
  const t=S.tasks.find(x=>x.id===id); if(!t) return;
  REP={id, sign:sign>0?1:-1, value:0};
  drawRepSheet();
  document.getElementById('scrim').classList.add('show');
}
function closeRepSheet(){
  REP=null;
  document.getElementById('scrim').classList.remove('show');
}
function repAdjust(delta){
  if(!REP) return;
  if(REP.sign>0) REP.value=Math.max(0, REP.value+delta);
  else           REP.value=Math.min(0, REP.value+delta);
  drawRepSheet();
}
function repQuick(n){
  if(!REP) return;
  REP.value = n;
  drawRepSheet();
}
function repInput(v){
  if(!REP) return;
  let n=parseInt(v,10); if(isNaN(n)) n=0;
  REP.value = REP.sign>0 ? Math.max(0,n) : Math.min(0,n);
  const b=document.getElementById('repConfirm'); if(b) b.disabled=(REP.value===0);
}
function commitReps(){
  if(!REP) return;
  const n=REP.value; if(!n){ closeRepSheet(); return; }
  const id=REP.id; closeRepSheet(); addReps(id, n);
}
function drawRepSheet(){
  const sheet=document.getElementById('sheet'); if(!sheet||!REP) return;
  const t=S.tasks.find(x=>x.id===REP.id); if(!t){ REP=null; return; }
  const pos=REP.sign>0;
  
  // Generate quick select buttons from +/- 2 up to +/- 10
  const q = [];
  for (let i = 2; i <= 10; i++) {
    q.push({
      l: pos ? '+' + i : '−' + i,
      v: pos ? i : -i
    });
  }
  
  const quick = q.map(o => {
    const isSelected = REP.value === o.v;
    const cls = 'repQuick' + (isSelected ? ' on' : '');
    return '<button type="button" class="' + cls + '" onclick="repQuick(' + o.v + ')">' + o.l + '</button>';
  }).join('');
  
  let h = '<div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px">';
  h += '  <div style="min-width:0; flex:1">';
  h += '    <h3 style="margin:0 0 2px; font-size:16px; font-weight:700">Log reps</h3>';
  h += '    <div class="small" style="margin:0; text-overflow:ellipsis; overflow:hidden; white-space:nowrap" title="' + esc(t.title) + '">' + esc(t.title) + '</div>';
  h += '  </div>';
  h += '  <button type="button" class="btn primary" id="repConfirm" onclick="commitReps()" style="flex:none; width:auto; padding:0 16px; height:32px; font-size:13px" ' + ((REP.value === 0) ? 'disabled' : '') + '>Confirm</button>';
  h += '</div>';
  
  h += '<div class="repRow" style="margin-top:10px">';
  h += '  <button type="button" class="repSide" onclick="repAdjust(-1)" aria-label="remove one">−</button>';
  h += '  <input type="number" id="repInput" class="repInput" value="' + (REP.value || 0) + '" oninput="repInput(this.value)">';
  h += '  <button type="button" class="repSide" onclick="repAdjust(1)" aria-label="add one">+</button>';
  h += '</div>';
  
  h += '<div class="repQuickRow">' + quick + '</div>';
  
  sheet.innerHTML=h;
}
// Adjust the habit counter from the editor sheet. Reward/penalty application
// is deferred to saveTask() which calculates the net delta from the original
// counter values and applies/removes rewards on save, with visual feedback.
function adjustCount(step, sign){
  const t=EDIT; if(!t) return;
  if(sign>0){
    if(step>0){
      t.cUp=(t.cUp||0)+1;
    } else {
      if(!(t.cUp>0)) { drawSheet(); return; }
      t.cUp=Math.max(0,(t.cUp||0)-1);
    }
  } else {
    if(step>0){
      t.cDown=(t.cDown||0)+1;
    } else {
      if(!(t.cDown>0)) { drawSheet(); return; }
      t.cDown=Math.max(0,(t.cDown||0)-1);
    }
  }
  drawSheet();
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
  if(t.type==='daily' && !isDailyDueOn(t, (new Date().getDay()+6)%7)) return; // only credit dailies actually due yesterday; missedYesterdayDailies already filters, this is defense-in-depth
  const r = completionReward(t);
  const delta = valueDelta(t.value);
  gainXp(r.xp); S.char.gold = +(S.char.gold + r.gold).toFixed(2); S.char.mp += r.mp;
  t.value = clamp(t.value + delta, -47.27, 99);
  t.done = true;
  t.updatedAt = now();
  t.doneAt = Date.now() - 86400000; // F3: backdated to match the history point below (yMs) — this IS yesterday's completion
  delete t.missedOn;
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
  const _s = document.querySelector('.ySheet');
  const _sc = _s ? _s.scrollTop : 0;
  document.getElementById('yScrim').innerHTML=h;
  const _ns = document.querySelector('.ySheet');
  if(_ns) _ns.scrollTop = _sc;
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
  render(); // paint the day's UI behind any blocking modal
  if(missed.length){ openYesterCheck(missed); }
  else { runCron(); render(); }
}
// LOCAL-DAY SEMANTICS: runCron uses dayStamp(new Date()) = device-local calendar day.
// yesterdayStamp is also local. Cross-TZ merge arbitrates via resolveDailyConflict
// (sync.js) — newer event-day wins. NOT vm-testable (DOM, C12 gap);
// coverage: code review + tests/daystamp.test.js cross-TZ tests (T1-T4).
function runCron(){
  const today = dayStamp(new Date());
  if(S.lastCron === today) return;
  const dow = new Date().getDay();
  const yesterdayStamp = dayStamp(new Date(Date.now() - 86400000)); // F3: device-local calendar day before today, for t.missedOn
  let totalDmg = 0;
  S.tasks.forEach(t=>{
    if(t.type==='habit'){ if(periodBoundaryCrossed(t.resetFreq||'daily', S.lastCron, new Date())){ t.cUp=0; t.cDown=0; } return; } // F3 (2026-07-11): cron no longer bumps updatedAt — see .omo/plans/2026-07-11-cron-merge-recency.md §3.1.4
    if(t.type!=='daily') return;
    const scheduledYesterday = isDailyDueOn(t, (dow+6)%7);  // intentional YESTERDAY test — do NOT use isDailyDueToday
    if(scheduledYesterday && !t.done){
      const dmg = missDamage(t);
      totalDmg += dmg;
      t.value = clamp(t.value - valueDelta(t.value), -47.27, 99);
      t.streak = 0;
      t.missedOn = yesterdayStamp; // F3 (2026-07-11): recency channel for cron-aware merge — cleared on completion/credit
      logHistory(t,{value:t.value,completed:false,isDue:true,repeat:(t.repeat||[]).slice()});
      const cl=(t.checklist||[]);
      logEvent({kind:'miss', taskType:'daily', taskId:t.id, taskTitle:t.title,
                dmg: dmg,
                repeat:(t.repeat||[]).slice(),
                checklist:cl.map(c=>({id:c.id||null,text:c.text,done:!!c.done}))});
    }
    t.done = false;
    (t.checklist||[]).forEach(c=>c.done=false); // F4 (2026-07-11): never stamps touchedAt here either — cron is not a user edit; see mergeChecklist (sync.js)
    // F3 (2026-07-11): no updatedAt bump here any more — cron is a deterministic
    // day-boundary transform, not a user edit; recency must encode user intent
    // only, or it swallows same-day completions in mergeCollection's both-changed
    // tiebreak (see .omo/plans/2026-07-11-cron-merge-recency.md §1-§3).
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
function buzz(p){ _buzzCount++; try{ if(navigator.vibrate && !(S.prefs&&S.prefs.haptics===false)){ _buzzLastResult=navigator.vibrate(p); return _buzzLastResult; } }catch(_){} _buzzLastResult=false; return false; }
// Habitica-style floating gain/loss anchored to the tapped control.
// kind: 'pos' (green) or 'neg' (red). ev: the click event (for x/y).
function floatFx(parts, kind, ev){
  try{
    let x = window.innerWidth/2, y = window.innerHeight/2;
    const src = ev && (ev.currentTarget || ev.target);
    if(src && src.getBoundingClientRect){ const r=src.getBoundingClientRect(); x=r.left+r.width/2; y=r.top; }
    else if(ev && ev.clientX){ x=ev.clientX; y=ev.clientY; }
    const e=document.createElement('div');
    e.className='floatFx '+(kind==='neg'?'neg':'pos');
    e.style.left=x+'px'; e.style.top=(y-8)+'px';
    e.innerHTML=parts;
    document.body.appendChild(e);
    setTimeout(()=>e.remove(),1150);
  }catch(_){ }
}
// Build the inline parts for a positive gain (coin + amounts).
function fxGain(xp,gold){
  const coin='<svg class="fxCoin" viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#ffbe5c" stroke="#c8862f" stroke-width="1.5"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="#c8862f" stroke-width="1.2" opacity="0.7"/><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="#7a4d12" font-family="serif">$</text></svg>';
  return '+'+xp+' XP '+coin+'+'+(+gold).toFixed(1);
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
  if(!S.prefs.sort) S.prefs.sort = {habits:'manual', dailies:'manual', todos:'manual', rewards:'manual'};
  if(!S.prefs.tagFilter) S.prefs.tagFilter = {habits:[], dailies:[], todos:[]};
  if(S.prefs.filterOpen===undefined) S.prefs.filterOpen=false;
  if(!S.prefs.scroll) S.prefs.scroll = {};
  return S.prefs;
}
ensureUiPrefs();
let FILTER=S.prefs.filter;
let SORT=S.prefs.sort;
let TAGFILTER=S.prefs.tagFilter;
let FILTEROPEN=S.prefs.filterOpen; let SORTOPEN=S.prefs.sortOpen;
let SEARCH_TERM = {};
let FOCUS_ID = null, FOCUS_SEL_START = 0, FOCUS_SEL_END = 0;
function saveFocus() {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') {
    FOCUS_ID = document.activeElement.id;
    FOCUS_SEL_START = document.activeElement.selectionStart;
    FOCUS_SEL_END = document.activeElement.selectionEnd;
  } else { FOCUS_ID = null; }
}
function restoreFocus() {
  if (FOCUS_ID) {
    const el = document.getElementById(FOCUS_ID);
    if (el) {
      el.focus();
      try { el.setSelectionRange(FOCUS_SEL_START, FOCUS_SEL_END); } catch(e){}
    }
  }
}
function applySearch(list, tabKey) {
  const q = SEARCH_TERM[tabKey];
  if (!q) return list;
  return list.filter(t => (t.title||'').toLowerCase().includes(q) || (t.notes||'').toLowerCase().includes(q));
}
function toggleFilter(){
  FILTEROPEN=!FILTEROPEN;
  if (!FILTEROPEN && TAB === 'habits' && FILTER.habits === 'log') {
    FILTER.habits = 'all';
    S.prefs.filter = FILTER;
  }
  S.prefs.filterOpen=FILTEROPEN;
  save();
  render();
}
function toggleSort(){ SORTOPEN=!SORTOPEN; S.prefs.sortOpen=SORTOPEN; save(); render(); }
const EXPANDED={}; // taskId -> bool (checklist expanded on card)
function toggleExpand(id){ EXPANDED[id]=!EXPANDED[id]; render(); }
function toggleSub(taskId, subId, idxFallback){
  const t=S.tasks.find(x=>x.id===taskId); if(!t||!t.checklist)return;
  let c = (subId!=null) ? t.checklist.find(x=>x && x.id===subId) : null;
  if(!c && idxFallback!=null) c = t.checklist[idxFallback]; // fallback: stale cached markup mid-deploy, or a subId that no longer exists
  if(!c) return;
  if(!c.id) c.id = uid(); // defensive backfill (F4 2026-07-11) — should not happen post-migration; see .omo/plans/2026-07-11-subtask-granular-merge.md §3
  c.done=!c.done;
  c.touchedAt = now(); // F4 (2026-07-11): per-subtask recency channel, consumed by mergeChecklist (sync.js)
  if(c.done) buzz(50);
  logEvent({kind:'subtask', taskId:t.id, taskTitle:t.title, taskType:t.type,
            subId:c.id||null, subText:c.text, done:c.done});
  t.updatedAt=now();
  save(); render();
}
function checklistBlock(t){
  const cl=(t.checklist||[]); if(!cl.length) return '';
  if(!EXPANDED[t.id]) return '';
  let h='<div class="sublist">';
  cl.forEach((c,i)=>{
    h+='<div class="subitem" draggable="true" data-task-id="'+t.id+'" data-idx="'+i+'" onclick="event.stopPropagation();toggleSub(\''+t.id+'\',\''+(c.id||'')+'\','+i+')">'+
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
  document.getElementById('hpFill').style.width=clamp(c.hp/c.maxHp*100,0,100)+'%';
  document.getElementById('hpLab').textContent=Math.ceil(Math.max(0,c.hp))+' / '+c.maxHp+' HP';
  const need=xpToLevel(c.lvl);
  document.getElementById('xpFill').style.width=clamp(c.xp/need*100,0,100)+'%';
  document.getElementById('xpLab').textContent=Math.floor(c.xp)+' / '+need+' XP';
  document.body.classList.toggle('lowhp', c.hp/c.maxHp <= 0.3);
}
function metaRow(t){
  const tagsHtml = tagChips(t);
  const notesPreview = (t.notes && S.prefs.notesLines>0)
    ? '<div class="notes" style="-webkit-line-clamp:'+S.prefs.notesLines+';line-clamp:'+S.prefs.notesLines+'">'+esc(t.notes)+'</div>' : '';
  const chk = checklistBlock(t);
  if(!tagsHtml && !notesPreview && !chk) return '';
  const metaHtml = tagsHtml ? '<div class="meta">'+tagsHtml+'</div>' : '';
  return metaHtml+notesPreview+chk;
}
// the right-side rail: counter/streak + subtask toggle, pinned to top of card
function rail(t){
  let items = [];
  items.push('<span class="railItem diff-'+t.difficulty+'">'+t.difficulty+'</span>');
  const hasRem = t.reminders && t.reminders[0] && t.reminders[0].enabled;
  if(hasRem){
    items.push('<span class="railItem bell" title="Reminder set" style="color:var(--accent);border-color:transparent;background:transparent;padding:0 2px;font-size:11px">🔔</span>');
  }
  if(t.type==='daily'){
    items.push('<span class="railItem streak" title="Day streak">🔥 '+(t.streak||0)+'</span>');
    if(!t.done && !isDailyDueToday(t)){
      const nd=nextDueWeekday(t);
      if(nd) items.push('<span class="railItem notdue" title="Not due yet">⏳ '+nd+'</span>');
    }
  } else if(t.type==='habit'){
    const up=t.up!==false, down=t.down!==false;
    if(up&&down) items.push('<span class="railItem cnt" title="Today + / −">+'+(t.cUp||0)+'|−'+(t.cDown||0)+'</span>');
    else if(up)  items.push('<span class="railItem cnt" title="Today +">+'+(t.cUp||0)+'</span>');
    else if(down)items.push('<span class="railItem cnt" title="Today −">−'+(t.cDown||0)+'</span>');
  }
  const cl=(t.checklist||[]);
  if(cl.length){
    const doneCl=cl.filter(c=>c.done).length;
    items.push('<span class="subFrac'+(doneCl===cl.length?' full':'')+'" onclick="event.stopPropagation();toggleExpand(\''+t.id+'\')">'+
        '<b>'+doneCl+'</b><i></i><b>'+cl.length+'</b></span>');
  }
  return '<div class="rail">'+items.join('')+'</div>';
}
// Inline SVG coin — renders identically on every platform (no emoji-font dependency)
const COIN_SVG='<svg viewBox="0 0 24 24" width="22" height="22" aria-label="coin" role="img">'+
  '<circle cx="12" cy="12" r="10" fill="#ffbe5c" stroke="#c8862f" stroke-width="1.5"/>'+
  '<circle cx="12" cy="12" r="6.5" fill="none" stroke="#c8862f" stroke-width="1.2" opacity="0.7"/>'+
  '<text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="#7a4d12" font-family="serif">$</text></svg>';
function taskCard(t){
  const ccol=valColor(t.value)[1];
  const inner = t.done ? '<span class="ckmark">✓</span>' : '<span class="ckbox"></span>';
  const notDue = t.type==='daily' && !t.done && !isDailyDueToday(t);
  return '<div class="task '+t.type+' '+(t.done?'done':'')+(notDue?' notdue':'')+'" draggable="'+(dragOK(t.type)?'true':'false')+'" data-id="'+t.id+'" data-list="tasks">'+
    '<div class="valdot" style="background:'+ccol+'"></div>'+
    '<div class="check" onclick="toggle(\''+t.id+'\',event)">'+inner+'</div>'+
    '<div class="body" onclick="openEdit(\''+t.id+'\')"><div class="ttl">'+esc(t.title||'Untitled')+'</div>'+metaRow(t)+'</div>'+rail(t)+'</div>';
}
function habitCard(t){
  const ccol=valColor(t.value)[1];
  const up = t.up!==false, down = t.down!==false;
  return '<div class="task habit" draggable="'+(dragOK('habit')?'true':'false')+'" data-id="'+t.id+'" data-list="tasks"><div class="valdot" style="background:'+ccol+'"></div>'+
    (up?'<div class="check hbtn up" onclick="scoreHabit(\''+t.id+'\',1,event)">+</div>':'<div class="check hbtn off">+</div>')+
    '<div class="body" onclick="openEdit(\''+t.id+'\')"><div class="ttl">'+esc(t.title||'Untitled')+'</div>'+metaRow(t)+'</div>'+rail(t)+
    (down?'<div class="check hbtn down" onclick="scoreHabit(\''+t.id+'\',-1,event)">−</div>':'<div class="check hbtn off">−</div>')+'</div>';
}
function sortActiveFunc(tab){ return (SORT&&SORT[tab]&&SORT[tab]!=="manual"); }
function colTitle(title, addType, customTabKey){
  const tabKey = addType==='habit'?'habits':addType==='daily'?'dailies':addType==='todo'?'todos':customTabKey;
  let filterActive = false, sortActive = false;
  if(tabKey && FILTER[tabKey]){
    const defaultVal = tabKey==='todos'?'active':'all';
    filterActive = FILTER[tabKey]!==defaultVal || (S.tags && S.tags.length > 0 && S.prefs.tagFilter && S.prefs.tagFilter[tabKey] && S.prefs.tagFilter[tabKey].length > 0);
    sortActive = sortActiveFunc(tabKey);
  }
  let h = '<div class="colTitle"><h2>'+title+'</h2>';
  if(tabKey) {
    const q = SEARCH_TERM[tabKey] || '';
    h += '<div class="searchBox"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" onclick="this.nextElementSibling.focus()"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>'+
      '<input type="text" id="searchInput_'+tabKey+'" placeholder="Search..." value="'+esc(q)+'" oninput="SEARCH_TERM[\''+tabKey+'\']=this.value.toLowerCase(); render();">';
    if (q) {
      h += '<svg class="clearSearch" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" onclick="SEARCH_TERM[\''+tabKey+'\']=\'\'; render();"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    }
    h += '</div>';
  }
  if (addType || customTabKey === 'rewards') {
    h += '<div class="colTitleActions">';
    if (addType) {
      h += '<button class="filterIcon'+(FILTEROPEN?' open':'')+(filterActive?' active':'')+'" title="Filter" onclick="toggleFilter()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg></button>';
    }
    h += '<button class="filterIcon'+(SORTOPEN?' open':'')+(sortActive?' active':'')+'" title="Sort" onclick="toggleSort()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg></button>';
    
    if (addType) {
      h += '<button class="addBtn" onclick="openEdit(null,\''+addType+'\')"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>';
    } else {
      h += '<button class="addBtn" onclick="openReward(null)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg></button>';
    }
    h += '</div>';
  }
  h += '</div>';
  return h;
}
function filterBar(tab, opts){
  if(!FILTEROPEN) return '';
  return '<div class="filterBar">'+opts.map(o=>'<button class="'+(FILTER[tab]===o[1]?'on':'')+'" onclick="setFilter(\''+tab+'\',\''+o[1]+'\')">'+o[0]+'</button>').join('')+'</div>';
}
// ---- Tags -------------------------------------------------------------
// Global tag list lives in S.tags = [{id,name,color}]; each task carries
// t.tags = [tagId,...]. Both persist in S, so export/import cover them for
// free (see migrate/exportData). Filtering is multi-select OR per screen.
const TAG_COLORS=['#bda8ff','#50b5e9','#48b677','#ffbe5c','#f9a03f','#f74e52','#74b6e0','#e07be0','#3fc7a8','#ff8fab'];
function ensureTags(){ if(!Array.isArray(S.tags)) S.tags=[]; }
function tagById(id){ ensureTags(); return S.tags.find(t=>t.id===id)||null; }
function taskTags(t){ return (t&&Array.isArray(t.tags))?t.tags:[]; }
function addTag(name){ name=(name||'').trim(); if(!name) return null; ensureTags();
  const ex=S.tags.find(t=>t.name.toLowerCase()===name.toLowerCase()); if(ex) return ex.id;
  const col=TAG_COLORS[S.tags.length%TAG_COLORS.length]; const tg={id:uid(),name:name,color:col,createdAt:Date.now(),updatedAt:now()}; S.tags.push(tg); return tg.id; }
function renameTag(id,name){ const g=tagById(id); if(g){ g.name=(name||'').trim()||g.name; g.updatedAt=now(); save(); } }
function deleteTag(id){ ensureTags(); delMark(id); S.tags=S.tags.filter(t=>t.id!==id);
  (S.tasks||[]).forEach(t=>{ if(Array.isArray(t.tags)) t.tags=t.tags.filter(x=>x!==id); });
  Object.keys(TAGFILTER).forEach(k=>{ TAGFILTER[k]=(TAGFILTER[k]||[]).filter(x=>x!==id); });
  save(); }
function tagChips(t){ const ids=taskTags(t); if(!ids.length) return '';
  return '<span class="tagChips">'+ids.map(id=>{ const g=tagById(id); if(!g) return '';
    return '<span class="tagChip" style="--tc:'+g.color+'">'+esc(g.name)+'</span>'; }).join('')+'</span>'; }
// tag filter (per screen, OR)
function toggleTagFilter(tab,id){ TAGFILTER[tab]=TAGFILTER[tab]||[]; const i=TAGFILTER[tab].indexOf(id);
  if(i<0) TAGFILTER[tab].push(id); else TAGFILTER[tab].splice(i,1); S.prefs.tagFilter=TAGFILTER; save(); render(); }
function clearTagFilter(tab){ TAGFILTER[tab]=[]; S.prefs.tagFilter=TAGFILTER; save(); render(); }
function tagFilterActive(tab){ return ((TAGFILTER[tab]||[]).length>0); }
function applyTagFilter(list,tab){ const sel=(TAGFILTER[tab]||[]); if(!sel.length) return list;
  return list.filter(t=>{ const tt=taskTags(t); return sel.some(id=>tt.indexOf(id)>=0); }); }
function tagFilterBar(tab){
  if(!FILTEROPEN) return ''; ensureTags(); if(!S.tags.length) return '';
  const sel=(TAGFILTER[tab]||[]);
  return '<div class="filterBar tagFilterBar"><span class="sortLbl">Tags</span>'+
    S.tags.map(g=>'<button class="tagBtn'+(sel.indexOf(g.id)>=0?' on':'')+'" style="--tc:'+g.color+'" onclick="toggleTagFilter(\''+tab+'\',\''+g.id+'\')">'+esc(g.name)+'</button>').join('')+
    (sel.length?'<button class="tagClear" onclick="clearTagFilter(\''+tab+'\')">clear</button>':'')+'</div>';
}
// tag editing inside the task sheet
function addTagToEdit(){ const inp=document.getElementById('eTagInput'); if(!inp) return;
  const id=addTag(inp.value); if(id){ EDIT.tags=EDIT.tags||[]; if(EDIT.tags.indexOf(id)<0) EDIT.tags.push(id); }
  inp.value=''; save(); drawSheet(); }
function toggleEditTag(id){ EDIT.tags=EDIT.tags||[]; const i=EDIT.tags.indexOf(id);
  if(i<0) EDIT.tags.push(id); else EDIT.tags.splice(i,1); drawSheet(); }
function tagEditorBlock(t){
  ensureTags(); const own=taskTags(t);
  let h='<label>Tags</label><div class="tagEdit">';
  h+= own.length? own.map(id=>{ const g=tagById(id); if(!g) return '';
      return '<span class="tagChip on" style="--tc:'+g.color+'" onclick="toggleEditTag(\''+id+'\')">'+esc(g.name)+' \u00d7</span>'; }).join('')
    : '<span class="tagNone">No tags yet.</span>';
  h+='</div>';
  const others=S.tags.filter(g=>own.indexOf(g.id)<0);
  if(others.length){ h+='<div class="tagEdit tagPick">'+others.map(g=>'<span class="tagChip" style="--tc:'+g.color+'" onclick="toggleEditTag(\''+g.id+'\')">+ '+esc(g.name)+'</span>').join('')+'</div>'; }
  h+='<div class="tagAddRow"><input type="text" id="eTagInput" placeholder="New tag\u2026" autocomplete="off" onkeydown="if(event.key===\'Enter\'){event.preventDefault();addTagToEdit();}"><button type="button" class="btn ghost" onclick="addTagToEdit()">+ Add</button></div>';
  return h;
}
function setFilter(tab,val){ FILTER[tab]=val; S.prefs.filter=FILTER; save(); render(); }
// ---- Sort ordering (per-screen; created / updated date) ----------------
// Manual (default) preserves drag order. Date sorts render a sorted COPY and
// leave the underlying S.tasks/S.rewards order untouched; drag is disabled
// while a date sort is active (see dragOK).
// Sort UI: Manual + Created + Updated. Created/Updated toggle asc/desc on
// re-tap; first tap activates descending (newest / last-updated on top).
function createdMs(t){ return (t&&t.createdAt) || (t&&t.history&&t.history.length?t.history[0].date:0) || (t&&t.completedAt) || 0; }
function updatedMs(t){ return (t&&t.updatedAt) || createdMs(t); }
function sortList(list,tab){
  const key=(SORT&&SORT[tab])||'manual';
  if(key==='manual') return list;
  const arr=list.slice();
  if(key==='created-desc') arr.sort((a,b)=>createdMs(b)-createdMs(a));
  else if(key==='created-asc') arr.sort((a,b)=>createdMs(a)-createdMs(b));
  else if(key==='updated-desc') arr.sort((a,b)=>updatedMs(b)-updatedMs(a));
  else if(key==='updated-asc') arr.sort((a,b)=>updatedMs(a)-updatedMs(b));
  return arr;
}
function sortActive(tab){ return ((SORT&&SORT[tab])||'manual')!=='manual'; }
function dragOK(type){ const tab=type==='habit'?'habits':type==='daily'?'dailies':type==='todo'?'todos':'rewards'; return ((SORT&&SORT[tab])||'manual')==='manual'; }
function setSort(tab,val){ SORT[tab]=val; S.prefs.sort=SORT; save(); render(); }
function cycleSort(tab,base){
  const cur=(SORT&&SORT[tab])||'manual';
  let next;
  if(cur===base+'-desc') next=base+'-asc';
  else if(cur===base+'-asc') next=base+'-desc';
  else next=base+'-desc';   // activate: descending default (newest / latest on top)
  setSort(tab,next);
}
function sortBar(tab){
  if(!SORTOPEN) return '';
  const cur=(SORT&&SORT[tab])||'manual';
  const tog=(base,label)=>{ const active=cur.indexOf(base+'-')===0;
    const arrow=active?(cur===base+'-asc'?' \u2191':' \u2193'):'';
    return '<button class="'+(active?'on':'')+'" onclick="cycleSort(\''+tab+'\',\''+base+'\')">'+label+arrow+'</button>'; };
  return '<div class="filterBar sortBar"><span class="sortLbl">Sort</span>'+
    '<button class="'+(cur==='manual'?'on':'')+'" onclick="setSort(\''+tab+'\',\'manual\')">Manual</button>'+
    tog('created','Created')+tog('updated','Updated')+'</div>';
}
function viewHabits(){
  let habits=S.tasks.filter(t=>t.type==='habit');
  const fl=FILTER.habits;
  const isLog=t=>t.difficulty==='log';
  const logged=t=>((t.cUp||0)+(t.cDown||0))>0;   // tapped this reset period
  if(fl==='log'){
    habits=habits.filter(isLog);                          // Log tab: every Log habit
  } else if(fl==='weak'){
    habits=habits.filter(t=>!isLog(t) && t.value<1);      // Log habits excluded
  } else if(fl==='strong'){
    habits=habits.filter(t=>!isLog(t) && t.value>=1);     // Log habits excluded
  } else { // 'all'
    habits=habits.filter(t=>!isLog(t) || !logged(t));     // hide already-logged Log habits
  }
  const bar=filterBar('habits',[['All','all'],['Weak','weak'],['Strong','strong'],['Log','log']]);
  habits=applyTagFilter(habits,'habits');
  habits=sortList(habits,'habits');
  habits=applySearch(habits,'habits');
  return '<div class="stickyControls">' + colTitle('Habits','habit')+bar+sortBar('habits')+tagFilterBar('habits') + '</div>' +
    (habits.length?habits.map(habitCard).join(''):'<div class="empty">Nothing matches this filter.</div>');
}
function viewDailies(){
  let dailies=S.tasks.filter(t=>t.type==='daily');
  const fl=FILTER.dailies; const dow=new Date().getDay();
  const isScheduledToday=t=> isDailyDueToday(t);
  if(fl==='due') dailies=dailies.filter(t=> isScheduledToday(t) && !t.done);
  else if(fl==='notdue') dailies=dailies.filter(t=> t.done || !isScheduledToday(t));
  const bar=filterBar('dailies',[['All','all'],['Due','due'],['Not Due','notdue']]);
  dailies=applyTagFilter(dailies,'dailies');
  dailies=sortList(dailies,'dailies');
  dailies=applySearch(dailies,'dailies');
  return '<div class="stickyControls">' + colTitle('Dailies','daily')+bar+sortBar('dailies')+tagFilterBar('dailies') + '</div>' +
    (dailies.length?dailies.map(taskCard).join(''):'<div class="empty">Nothing matches this filter.</div>');
}
function viewTodos(){
  const fl=FILTER.todos;
  const bar=filterBar('todos',[['Active','active'],['Complete','complete'],['All','all']]);
  let list;
  if(fl==='complete') list=S.tasks.filter(t=>t.type==='todo' && t.done);
  else if(fl==='all') list=S.tasks.filter(t=>t.type==='todo');
  else list=S.tasks.filter(t=>t.type==='todo' && !t.done);
  list=applyTagFilter(list,'todos');
  list=sortList(list,'todos');
  list=applySearch(list,'todos');
  return '<div class="stickyControls">' + colTitle('To-Dos','todo')+bar+sortBar('todos')+tagFilterBar('todos') + '</div>' +
    (list.length?list.map(taskCard).join(''):'<div class="empty">Nothing matches this filter.</div>');
}
function viewRewards(){
  let h='<div class="colTitle"><h2>Shop</h2></div>'+
    '<div class="small" style="margin:0 4px 10px">Built-in items. Drink a potion to recover HP before a death wipes your gold and level.</div>';
  h+=SHOP_ITEMS.map(i=>'<div class="task shopitem"><div class="valdot" style="background:var(--hp)"></div>'+
    '<div class="check" onclick="buyShopItem(\''+i.id+'\')" title="Buy">'+i.icon+'</div>'+
    '<div class="body" onclick="buyShopItem(\''+i.id+'\')"><div class="ttl">'+i.title+'</div>'+
    '<div class="meta"><span class="pill">'+i.cost+' gold</span><span>'+i.desc+'</span></div></div></div>').join('');
  h+= colTitle('Your Rewards', null, 'rewards') +
    '<div class="small" style="margin:0 4px 10px">Spend gold on real-life rewards you define yourself.</div>'+sortBar('rewards');
  const _rw=sortList(S.rewards,'rewards');
  const searchRw = applySearch(_rw, 'rewards');
  h+= searchRw.length ? searchRw.map(r=>'<div class="task" draggable="'+(dragOK('reward')?'true':'false')+'" data-id="'+r.id+'" data-list="rewards"><div class="valdot" style="background:var(--gold)"></div>'+
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
  if(!a.views){ a.views=[
    {id:uid(),name:'Overview', source:'overview', group:'day', chart:'list', tags:[], types:[]},
    {id:uid(),name:'By tag', source:'tagsummary', group:'tag', chart:'bar', tags:[], types:[]},
    {id:uid(),name:'Completions / day', source:'completed', group:'day', chart:'line', tags:[], types:[]},
    {id:uid(),name:'Created by tag', source:'created', group:'tag', chart:'bar', tags:[], types:[]},
    {id:uid(),name:'Open items by type', source:'incomplete', group:'type', chart:'bar', tags:[], types:[]},
    {id:uid(),name:'Activity heatmap', source:'reps', group:'day', chart:'heatmap', tags:[], types:[]}
  ]; }
  // one-time: give existing users the Overview + By-tag as configurable views
  if(!a._viewsUpgraded){ a._viewsUpgraded=true;
    if(a.views.length<20 && !a.views.some(v=>v.source==='tagsummary')) a.views.unshift({id:uid(),name:'By tag', source:'tagsummary', group:'tag', chart:'bar', tags:[], types:[]});
    if(a.views.length<20 && !a.views.some(v=>v.source==='overview')) a.views.unshift({id:uid(),name:'Overview', source:'overview', group:'day', chart:'list', tags:[], types:[]});
  }
  if(a.activeView===undefined) a.activeView = a.views[0] ? a.views[0].id : null;
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
function typeIcon(ty){ return ty==='habit'?'\uD83D\uDD01':ty==='daily'?'\uD83D\uDCC5':ty==='todo'?'\u2705':ty==='reward'?'\uD83C\uDF81':'\u2022'; }
// Created / updated lifecycle panel for Analytics. Counts respect the date
// window (from,to); the recent lists are all-time. "Updated" = an edit saved
// through the item editor (see saveTask/saveReward), not scoring/completion.
function anLifecycleHTML(from,to){
  const inWin=ms=>!!ms&&ms>=from&&ms<=to;
  const types=[['habit','Habits'],['daily','Dailies'],['todo','To-Dos']];
  let h='<div class="anSection">\uD83D\uDDC2\uFE0F Items created &amp; updated</div>';
  h+='<div class="anCards">';
  types.forEach(function(p){
    const items=(S.tasks||[]).filter(t=>t.type===p[0]);
    const c=items.filter(t=>inWin(createdMs(t))).length;
    const u=items.filter(t=>{const um=updatedMs(t);return um!==createdMs(t)&&inWin(um);}).length;
    h+='<div class="anCard"><div class="k">'+p[1]+'</div><div class="v">'+items.length+'</div><div class="sub">'+c+' new \u00b7 '+u+' upd</div></div>';
  });
  const ritems=(S.rewards||[]);
  const rc=ritems.filter(r=>inWin(createdMs(r))).length;
  const ru=ritems.filter(r=>{const um=updatedMs(r);return um!==createdMs(r)&&inWin(um);}).length;
  h+='<div class="anCard"><div class="k">Rewards</div><div class="v">'+ritems.length+'</div><div class="sub">'+rc+' new \u00b7 '+ru+' upd</div></div>';
  h+='</div>';
  const all=[].concat((S.tasks||[]).map(t=>({title:t.title,type:t.type,c:createdMs(t),u:updatedMs(t)})),
                      ritems.map(r=>({title:r.title,type:'reward',c:createdMs(r),u:updatedMs(r)})));
  const recentC=all.filter(x=>x.c).sort((a,b)=>b.c-a.c).slice(0,8);
  const recentU=all.filter(x=>x.u&&x.u!==x.c).sort((a,b)=>b.u-a.u).slice(0,8);
  h+='<div class="anSection">Recently created</div>';
  h+= recentC.length? recentC.map(x=>'<div class="anStreak"><span class="t">'+typeIcon(x.type)+' '+esc(x.title)+'</span><span class="s">'+fmtDate(x.c)+'</span></div>').join('') : '<div class="anNote">No dated items yet.</div>';
  h+='<div class="anSection">Recently updated</div>';
  h+= recentU.length? recentU.map(x=>'<div class="anStreak"><span class="t">'+typeIcon(x.type)+' '+esc(x.title)+'</span><span class="s">'+fmtDate(x.u)+'</span></div>').join('') : '<div class="anNote">No edits recorded yet (updates are tracked from now on).</div>';
  h+='<div class="anNote">\u201cUpdated\u201d = you opened an item and saved an edit. The new/upd counts respect the date range above; the recent lists are all-time.</div>';
  return h;
}
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
  h+='<div class="anStickyHeader">';
  h+='<div class="anHeaderRow">';
  h+='<h2>&#128202; Analytics</h2>';
  const chips=[['7d','7d'],['30d','30d'],['90d','90d'],['180d','180d'],['1y','365d'],['All','all']];
  h+='<div class="anChips" id="anSnapChips">'+chips.map(c=>'<span class="anChip'+(p.snap===c[1]?' on':'')+'" data-snap="'+c[1]+'">'+c[0]+'</span>').join('')+'</div>';
  h+='</div>';
  h+='<div class="anSubRow">';
  h+='<span class="anRangeLbl" id="anRangeLbl"></span>';
  h+='<div class="anSlider" id="anSlider">'+
       '<div class="anTrack"></div><div class="anFill" id="anFill"></div>'+
       '<div class="anHandle" id="anH0"></div><div class="anHandle" id="anH1"></div>'+
       '<div class="anTicks"><span id="anTickL"></span><span id="anTickR"></span></div>'+
     '</div>';
  h+='</div>';
  h+='</div>';
  h+='<div id="anBody"></div>';
  h+='</div>';
  return h;
}
function updateHeaderHeightVar() {
  const headerEl = document.querySelector('header');
  if (headerEl) {
    document.documentElement.style.setProperty('--header-height', headerEl.getBoundingClientRect().height + 'px');
  }
  const stickyHeaderEl = document.querySelector('.anStickyHeader');
  if (stickyHeaderEl) {
    document.documentElement.style.setProperty('--sticky-header-height', stickyHeaderEl.getBoundingClientRect().height + 'px');
  }
}
let _anBound=false;
function initAnalytics(){
  const p=anPrefs();
  const [mn,mx]=anSpan();
  const slider=document.getElementById('anSlider'); if(!slider)return;
  const h0=document.getElementById('anH0'), h1=document.getElementById('anH1');
  const fill=document.getElementById('anFill');
  const totalDays=Math.max(1,Math.round((mx-mn)/DAY));
  const _span=Math.max(1,mx-mn);
  function offToFrac(off){ const t=Date.now()-off*DAY; return clamp((t-mn)/_span,0,1); }
  function fracToOff(fr){ const t=mn+fr*_span; return Math.round((Date.now()-t)/DAY); }
  function normRange(){
    p.fromOff=clamp(Math.round(p.fromOff==null?totalDays:p.fromOff),0,totalDays);
    p.toOff=clamp(Math.round(p.toOff==null?0:p.toOff),0,totalDays);
    if(p.fromOff<p.toOff){ const t=p.fromOff; p.fromOff=p.toOff; p.toOff=t; }
  }
  function layout(){
    const w=slider.clientWidth||300;
    normRange();
    let f0=offToFrac(p.fromOff), f1=offToFrac(p.toOff);
    if(f0>f1){ const t=f0; f0=f1; f1=t; }
    const PAD=12, tw=Math.max(1,w-2*PAD);   // inset by handle radius so a handle at 0/1 stays fully on-track
    h0.style.left=(PAD+f0*tw)+'px'; h1.style.left=(PAD+f1*tw)+'px';
    fill.style.left=(PAD+f0*tw)+'px'; fill.style.width=(Math.max(0,f1-f0)*tw)+'px';
    const [from,to]=anWindow();
    const lbl=document.getElementById('anRangeLbl');
    if(lbl) lbl.textContent=fmtDate(from)+' → '+fmtDate(to);
    const tickL=document.getElementById('anTickL');
    if(tickL) tickL.textContent=fmtDate(mn);
    const tickR=document.getElementById('anTickR');
    if(tickR) tickR.textContent='today';
  }
  function drag(handle,which){
    const onMove=(clientX)=>{
      const r=slider.getBoundingClientRect();
      const PAD=12; const fr=clamp((clientX-r.left-PAD)/Math.max(1,r.width-2*PAD),0,1);
      let off=fracToOff(fr);
      // constrain handles so they never cross
      if(which===0) p.fromOff=Math.min(Math.max(off, p.toOff||0), totalDays);
      else p.toOff=Math.max(Math.min(off, p.fromOff||totalDays), 0);
      p.snap=null;
      document.querySelectorAll('#anSnapChips .anChip').forEach(c=>c.classList.remove('on'));
      layout();   // cheap: reposition handles + live date label only
    };
    const mm=e=>{ e.preventDefault(); onMove(e.touches?e.touches[0].clientX:e.clientX); };
    const up=()=>{ document.removeEventListener('mousemove',mm); document.removeEventListener('mouseup',up);
      document.removeEventListener('touchmove',mm); document.removeEventListener('touchend',up);
      save(); refreshAnalytics();   // commit the heavier chart re-render once, on release
    };
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
  layout(); save(); refreshAnalytics();
  const ro = new ResizeObserver(() => {
    if (TAB === 'analytics') layout();
  });
  ro.observe(slider);
  requestAnimationFrame(() => {
    if (TAB === 'analytics') layout();
  });
  if(!_anBound){ window.addEventListener('resize',()=>{ if(TAB==='analytics') { layout(); } }); _anBound=true; }
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
let MBUILD=false;   // true while the reps-metric editor is open INSIDE the view-builder sheet
function openMetricEditor(mid){
  const p=anPrefs();
  const src = mid ? p.metrics.find(x=>x.id===mid) : {id:null,name:'',keyword:'',exact:false,habits:[]};
  // deep-ish copy into MEDIT
  MEDIT = { id:src.id, name:src.name||'', keyword:src.keyword||'', exact:!!src.exact,
            habits:(src.habits||[]).map(h=>({id:h.id, reps:(h.reps==null?'':h.reps)})), _mid:mid };
  drawMetricEditor();
}
function drawMetricEditor(){
  const box=document.getElementById(MBUILD?'sheet':'anMetricEdit'); if(!box)return;
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
  document.getElementById('mSave').onclick = MBUILD ? bSaveMetric : saveMetricEditor;
  if(m._mid){ document.getElementById('mDel').onclick=()=>{
    const p=anPrefs();
    delMark(m._mid); p.metrics=p.metrics.filter(x=>x.id!==m._mid);
    if(p.activeMetric===m._mid) p.activeMetric=p.metrics[0]?p.metrics[0].id:null;
    if(MBUILD){ if(VDRAFT && VDRAFT.metricId===m._mid) VDRAFT.metricId=(p.metrics[0]?p.metrics[0].id:null); MEDIT=null; MBUILD=false; save(); drawViewBuilder(); }
    else { MEDIT=null; save(); render(); }
  };}
  document.getElementById('mCancel').onclick=()=>{ if(MBUILD){ bCancelMetric(); } else { MEDIT=null; document.getElementById('anMetricEdit').innerHTML=''; } };
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
// ---- reps-metric editor embedded in the view builder ------------------
function bAddMetric(){ MEDIT={id:null,name:'',keyword:'',exact:false,habits:[],_mid:null}; MBUILD=true; drawMetricEditor(); }
function bEditMetric(id){ const src=(anPrefs().metrics||[]).find(x=>x.id===id); if(!src) return;
  MEDIT={ id:src.id, name:src.name||'', keyword:src.keyword||'', exact:!!src.exact,
          habits:(src.habits||[]).map(h=>({id:h.id, reps:(h.reps==null?'':h.reps)})), _mid:id };
  MBUILD=true; drawMetricEditor(); }
function bCancelMetric(){ MEDIT=null; MBUILD=false; drawViewBuilder(); }
function bSaveMetric(){
  const p=anPrefs(); const m=MEDIT;
  const name=(document.getElementById('mName').value||'').trim();
  if(!name){ toast('Name required'); return; }
  if(m.exact){ if(!m.habits.length){ toast('Pick at least one habit'); return; } }
  else { m.keyword=(document.getElementById('mKw').value||'').trim(); if(!m.keyword){ toast('Keyword required'); return; } }
  const habits=m.habits.map(h=>({id:h.id, reps:(h.reps===''||h.reps==null)?null:Number(h.reps)}));
  let id;
  if(m._mid){ const tgt=p.metrics.find(x=>x.id===m._mid); tgt.name=name; tgt.keyword=m.keyword; tgt.exact=m.exact; tgt.habits=habits; tgt.updatedAt=now(); id=m._mid; }
  else { const nm={id:uid(), name, keyword:m.keyword, exact:m.exact, habits, createdAt:Date.now(), updatedAt:now()}; p.metrics.push(nm); id=nm.id; }
  MEDIT=null; MBUILD=false;
  if(VDRAFT){ VDRAFT.source='metric'; VDRAFT.metricId=id; }
  save(); drawViewBuilder();
}
// clone the view currently open in the builder, inserting it just below
function cloneView(){ if(!VDRAFT) return; const a=anPrefs(); a.views=a.views||[];
  if(a.views.length>=20){ toast('Max 20 view sections'); return; }
  const copy=JSON.parse(JSON.stringify(VDRAFT)); copy.id=uid(); copy.name='clone - '+(VDRAFT.name||'view'); copy.createdAt=Date.now(); copy.updatedAt=now();
  let idx=VDRAFT.id? a.views.findIndex(x=>x.id===VDRAFT.id) : -1; if(idx<0) idx=a.views.length-1;
  a.views.splice(idx+1,0,copy);
  VDRAFT=null; MEDIT=null; MBUILD=false; document.getElementById('scrim').classList.remove('show'); save(); refreshAnalytics();
  toast('Cloned view');
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
    tgt.name=name; tgt.keyword=m.keyword; tgt.exact=m.exact; tgt.habits=habits; tgt.updatedAt=now();
  } else {
    const nm={id:uid(), name, keyword:m.keyword, exact:m.exact, habits, createdAt:Date.now(), updatedAt:now()};
    p.metrics.push(nm); p.activeMetric=nm.id;
  }
  MEDIT=null; save(); render();
}
// ================= Unified analytics: builder + templates =================
// A "view" is a saved template: {id,name,source,group,chart,tags[],types[]}.
// Views live in S.prefs.an.views so the full backup export/import covers them;
// exportViews/importViews additionally move just the templates as a file.
const V_SOURCES=[['Overview','overview'],['Tag summary','tagsummary'],['Completed','completed'],['Created','created'],['Updated','updated'],['Incomplete','incomplete'],['Reps','reps'],['Reps metric','metric'],['Streaks','streaks'],['Tag count','tagcount']];
const V_SPECIAL=['overview','tagsummary'];
const V_GROUPS=[['Day','day'],['Week','week'],['Month','month'],['Tag','tag'],['Type','type']];
const V_CHARTS=[['List','list'],['Bar','bar'],['Line','line'],['Heatmap','heatmap']];
const V_TYPES=[['Habits','habit'],['Dailies','daily'],['To-Dos','todo']];
const V_SNAPSHOT=['incomplete','streaks','tagcount'];   // current-state (no time axis)

function anViewItems(v){
  let items=(S.tasks||[]).slice();
  if(v.types&&v.types.length) items=items.filter(t=>v.types.indexOf(t.type)>=0);
  if(v.tags&&v.tags.length) items=items.filter(t=>{const tt=taskTags(t); return v.tags.some(id=>tt.indexOf(id)>=0);});
  return items;
}
// dated events for time sources -> [{ts,v,item,title}]
function anSourceEvents(v){
  const items=anViewItems(v); const src=v.source; const out=[];
  if(src==='created'){ items.forEach(t=>{ const c=createdMs(t); if(c) out.push({ts:c,v:1,item:t}); }); }
  else if(src==='updated'){ items.forEach(t=>{ const u=updatedMs(t),c=createdMs(t); if(u&&u!==c) out.push({ts:u,v:1,item:t}); }); }
  else if(src==='completed'){
    items.forEach(t=>{ let any=false; (t.history||[]).forEach(p=>{ if(p&&p.completed&&typeof p.date==='number'){ out.push({ts:p.date,v:1,item:t}); any=true; } });
      if(!any && t.type==='todo' && t.completedAt) out.push({ts:t.completedAt,v:1,item:t}); });
  }
  else if(src==='reps'){
    const idset={}; items.forEach(t=>idset[t.id]=t);
    anAllEvents().forEach(e=>{ const it=idset[e.taskId]; if(!it) return; const r=('reps'in e)?(e.reps||0):0; const val=r||e.scoredUp||0; if(val>0) out.push({ts:e.date,v:val,item:it,title:e.title}); });
  }
  else if(src==='metric'){
    const m=anViewMetric(v); if(m){ const M=anMatcher(m);
      anAllEvents().forEach(e=>{ if(!M.match(e)) return; const r=M.reps?M.reps(e):0; const val=(r||0)||e.scoredUp||0; if(val>0) out.push({ts:e.date,v:val,item:null,title:e.title}); }); }
  }
  return out;
}
// the reps-metric a 'metric' view points at (by id), with sensible fallbacks
function anViewMetric(v){ const ms=(anPrefs().metrics||[]); return ms.find(m=>m.id===(v&&v.metricId)) || ms.find(m=>m.id===anPrefs().activeMetric) || ms[0] || null; }
function anBucket(events,group,from,to){
  const ev=events.filter(e=>e.ts>=from&&e.ts<=to);
  if(group==='day'){
    const day={}; ev.forEach(e=>{ const d=Math.floor(e.ts/DAY)*DAY; day[d]=(day[d]||0)+e.v; });
    const series=Object.keys(day).map(Number).sort((a,b)=>a-b).map(d=>({d:d,v:day[d]}));
    return {kind:'day',series:series,dayMap:day};
  }
  if(group==='week'||group==='month'){
    const b={}; ev.forEach(e=>{ const d=new Date(e.ts); let key;
      if(group==='month') key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
      else { const dd=new Date(d); dd.setHours(0,0,0,0); dd.setDate(dd.getDate()-((dd.getDay()+6)%7)); key=fmtDate(dd.getTime()); }
      b[key]=(b[key]||0)+e.v; });
    return {kind:'cat',rows:Object.keys(b).sort().map(k=>({label:k,v:b[k]}))};
  }
  if(group==='tag'){
    ensureTags(); const b={};
    ev.forEach(e=>{ const ids=e.item?taskTags(e.item):[]; if(!ids.length){ b['__none']=(b['__none']||0)+e.v; } else ids.forEach(id=>{ b[id]=(b[id]||0)+e.v; }); });
    return {kind:'cat',rows:anTagRows(b)};
  }
  // type
  const b={}; ev.forEach(e=>{ const ty=e.item?e.item.type:(e.title?'habit':'?'); b[ty]=(b[ty]||0)+e.v; });
  return {kind:'cat',rows:Object.keys(b).map(ty=>({label:ty,v:b[ty]})).sort((a,b)=>b.v-a.v)};
}
function anTagRows(b){
  return Object.keys(b).map(id=>{ const g=id==='__none'?null:tagById(id);
    return {label:g?g.name:'(untagged)', v:b[id], color:g?g.color:'var(--muted)'}; }).sort((a,b)=>b.v-a.v);
}
function anSnapshotRows(v){
  const items=anViewItems(v); const src=v.source; const group=v.group;
  let vals=[];
  if(src==='incomplete'){
    vals=items.filter(t=>{ if(t.type==='todo') return !t.done;
      if(t.type==='daily'){ const due=isDailyDueToday(t); return due&&!t.done; }
      return false; }).map(t=>({item:t,w:1}));
  } else if(src==='streaks'){ vals=items.filter(t=>t.type==='daily').map(t=>({item:t,w:(t.streak||0)})); }
  else if(src==='tagcount'){ vals=items.map(t=>({item:t,w:1})); }
  if(group==='type'){ const b={}; vals.forEach(x=>{ b[x.item.type]=(b[x.item.type]||0)+x.w; });
    return Object.keys(b).map(ty=>({label:ty,v:b[ty]})).sort((a,b)=>b.v-a.v); }
  ensureTags(); const b={};
  vals.forEach(x=>{ const ids=taskTags(x.item); if(!ids.length){ b['__none']=(b['__none']||0)+x.w; } else ids.forEach(id=>{ b[id]=(b[id]||0)+x.w; }); });
  return anTagRows(b);
}
function anSnapshotHistoryBucket(v, from, to){
  const items = anViewItems(v);
  const src = v.source;
  const group = v.group;
  if (group === 'tag' || group === 'type') {
    return {kind: 'cat', rows: anSnapshotRows(v)};
  }
  const midnightFrom = Math.floor(from / DAY) * DAY;
  const midnightTo = Math.floor(to / DAY) * DAY;
  const dayMap = {};
  const series = [];
  for (let d = midnightFrom; d <= midnightTo; d += DAY) dayMap[d] = 0;
  items.forEach(t => {
    if (src === 'streaks' && t.type !== 'daily') return;
    const cMs = createdMs(t) || 0;
    if (cMs > to) return;
    let compMap = null;
    if (t.type === 'daily') {
       compMap = {};
       (t.history || []).forEach(p => {
         if (p.completed && typeof p.date === 'number') {
           compMap[Math.floor(p.date/DAY)*DAY] = true;
         }
       });
    }
    let curStreak = 0;
    let walkD = Math.floor(cMs/DAY)*DAY;
    for (let d = walkD; d <= midnightTo; d += DAY) {
       if (t.type === 'daily') {
          const due = !t.repeat || t.repeat[new Date(d).getDay()];
          if (due) {
             if (compMap[d]) curStreak++;
             else curStreak = 0;
          }
       }
       if (d >= midnightFrom && d <= midnightTo) {
          if (src === 'streaks') {
             dayMap[d] += curStreak;
          } else if (src === 'incomplete') {
             if (t.type === 'todo') {
                if (!t.completedAt || Math.floor(t.completedAt/DAY)*DAY > d) dayMap[d]++;
             } else if (t.type === 'daily') {
                const due = !t.repeat || t.repeat[new Date(d).getDay()];
                if (due && !compMap[d]) dayMap[d]++;
             }
          } else if (src === 'tagcount') {
             dayMap[d]++;
          }
       }
    }
  });
  for (let d = midnightFrom; d <= midnightTo; d += DAY) {
    series.push({d: d, v: dayMap[d]});
  }
  if (group === 'day') {
    return {kind: 'day', series: series, dayMap: dayMap};
  }
  const b = {};
  const counts = {};
  series.forEach(pt => {
    const d = new Date(pt.d);
    let key;
    if (group === 'month') key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    else { const dd=new Date(d); dd.setHours(0,0,0,0); dd.setDate(dd.getDate()-((dd.getDay()+6)%7)); key=fmtDate(dd.getTime()); }
    b[key] = (b[key]||0) + pt.v;
    counts[key] = (counts[key]||0) + 1;
  });
  const rows = Object.keys(b).sort().map(k => ({label: k, v: Math.round(b[k]/counts[k])}));
  return {kind: 'cat', rows: rows};
}
function anListHTML(rows){
  if(!rows.length) return '<div class="anNote">No data in this window.</div>';
  return '<div class="anList">'+rows.map(r=>'<div class="anListRow">'+
    (r.color?'<span class="anDot" style="background:'+r.color+'"></span>':'')+
    '<span class="anListLbl">'+esc(String(r.label))+'</span>'+
    '<span class="anListVal">'+Number(r.v).toLocaleString()+'</span></div>').join('')+'</div>';
}
function anRowLegend(rows){
  if(!rows.some(r=>r.color)) return '';
  return '<div class="anLegendTags">'+rows.filter(r=>r.color).map(r=>'<span class="anLegTag"><i style="background:'+r.color+'"></i>'+esc(r.label)+'</span>').join('')+'</div>';
}
function heatLegend(){ return '<div class="anLegend">Less <i style="background:var(--panel2)"></i><i style="background:#6f4ddb"></i><i style="background:#8a5cff"></i><i style="background:#a98bff"></i><i style="background:#bda8ff"></i> More</div>'; }
function barsCard(rows){ return '<div class="anCard full">'+svgBars(rows.map(r=>({label:r.label,v:r.v})),'var(--accent)')+'</div>'+anRowLegend(rows); }
// Render one view to HTML. Chart types degrade gracefully to what the data supports.
function renderView(v,from,to){
  if(!v) return '';
  if(v.source==='overview') return anOverviewBody(from,to);
  if(v.source==='tagsummary') return anTagSummaryBody(from,to);
  let chart=v.chart;
  let bucket;
  if(V_SNAPSHOT.indexOf(v.source)>=0){
    bucket = anSnapshotHistoryBucket(v, from, to);
    if(chart==='list' && v.source==='streaks' && bucket.kind==='cat'){
      const rows=anViewItems(v).filter(t=>t.type==='daily').map(t=>({label:t.title,v:t.streak||0})).sort((a,b)=>b.v-a.v);
      return anListHTML(rows);
    }
  } else {
    bucket = anBucket(anSourceEvents(v),v.group,from,to);
  }
  if(bucket.kind==='cat'){
    if(chart==='line'||chart==='heatmap') chart='bar';
    return chart==='list'? anListHTML(bucket.rows) : barsCard(bucket.rows);
  }
  // day series
  const series=bucket.series;
  if(chart==='heatmap'){ const max=Math.max(1,...Object.values(bucket.dayMap||{0:0})); return anHeatmapHTML(from,to,bucket.dayMap,max)+heatLegend(); }
  if(chart==='list'){ return anListHTML(series.map(sn=>({label:fmtDate(sn.d),v:sn.v})).reverse()); }
  if(chart==='bar'){ return '<div class="anCard full">'+svgBars(series.map(sn=>({label:fmtDate(sn.d),v:sn.v})),'var(--accent)')+'</div>'; }
  const tips=series.map(sn=>'📅 '+fmtDate(sn.d)+'\n'+sn.v.toLocaleString());
  return '<div class="anCard full">'+svgSpark(series,false,'var(--accent)',80,tips)+'</div>';
}
// ---- auto sections -----------------------------------------------------
function anOverviewBody(from,to){
  const inWin=ms=>!!ms&&ms>=from&&ms<=to;
  const tasks=(S.tasks||[]);
  const created=tasks.filter(t=>inWin(createdMs(t))).length;
  const updated=tasks.filter(t=>{ const u=updatedMs(t); return u!==createdMs(t)&&inWin(u); }).length;
  let completed=0; tasks.forEach(t=>{ (t.history||[]).forEach(p=>{ if(p&&p.completed&&inWin(p.date)) completed++; }); });
  const openTodos=tasks.filter(t=>t.type==='todo'&&!t.done).length;
  const dueDailies=tasks.filter(t=>t.type==='daily'&&isDailyDueToday(t)&&!t.done).length;
  let h='<div class="anCards">';
  h+='<div class="anCard"><div class="k">Habits</div><div class="v">'+tasks.filter(t=>t.type==='habit').length+'</div><div class="sub">total</div></div>';
  h+='<div class="anCard"><div class="k">Dailies</div><div class="v">'+tasks.filter(t=>t.type==='daily').length+'</div><div class="sub">'+dueDailies+' due now</div></div>';
  h+='<div class="anCard"><div class="k">To-Dos</div><div class="v">'+tasks.filter(t=>t.type==='todo').length+'</div><div class="sub">'+openTodos+' open</div></div>';
  h+='<div class="anCard"><div class="k">Created</div><div class="v">'+created+'</div><div class="sub">in window</div></div>';
  h+='<div class="anCard"><div class="k">Updated</div><div class="v">'+updated+'</div><div class="sub">in window</div></div>';
  h+='<div class="anCard"><div class="k">Completed</div><div class="v">'+completed+'</div><div class="sub">in window</div></div>';
  h+='</div>';
  return h;
}
function anTagSummaryBody(from,to){
  ensureTags();
  if(!S.tags.length) return '<div class="anNote">No tags yet. Add tags to tasks (in the task editor) to see per-tag analytics.</div>';
  const inWin=ms=>!!ms&&ms>=from&&ms<=to;
  const rows=S.tags.map(g=>{
    const items=(S.tasks||[]).filter(t=>taskTags(t).indexOf(g.id)>=0);
    let comp=0; items.forEach(t=>{ (t.history||[]).forEach(p=>{ if(p&&p.completed&&inWin(p.date)) comp++; }); });
    const created=items.filter(t=>inWin(createdMs(t))).length;
    return {name:g.name,color:g.color,count:items.length,comp:comp,created:created};
  }).sort((a,b)=>b.count-a.count);
  let h='<div class="anCard full">'+svgBars(rows.map(r=>({label:r.name,v:r.count})),'var(--accent)')+'</div>';
  h+='<div class="anList">'+rows.map(r=>'<div class="anListRow"><span class="anDot" style="background:'+r.color+'"></span><span class="anListLbl">'+esc(r.name)+'</span><span class="anListVal">'+r.count+' items · '+r.comp+' done · '+r.created+' new</span></div>').join('')+'</div>';
  return h;
}
// ---- views UI + builder ------------------------------------------------
let VDRAFT=null;
function selectView(id){ const a=anPrefs(); a.activeView=id; VDRAFT=null; save(); refreshAnalytics(); }
function moveView(id,dir){ const a=anPrefs(); const arr=a.views||[]; const i=arr.findIndex(x=>x.id===id);
  if(i<0) return; const j=i+dir; if(j<0||j>=arr.length) return; const t=arr[i]; arr[i]=arr[j]; arr[j]=t; save(); refreshAnalytics(); }
function newView(){ const a=anPrefs(); if((a.views||[]).length>=20){ toast('Max 20 view sections'); return; } VDRAFT={id:null,name:'',source:'completed',group:'day',chart:'line',tags:[],types:[]}; drawViewBuilder(); }
function editView(id){ const v=anPrefs().views.find(x=>x.id===id); if(!v)return; VDRAFT=JSON.parse(JSON.stringify(v)); if(!VDRAFT.tags)VDRAFT.tags=[]; if(!VDRAFT.types)VDRAFT.types=[]; drawViewBuilder(); }
function vSet(f,val){ if(!VDRAFT)return; const inp=document.getElementById('vName'); if(inp)VDRAFT.name=inp.value; VDRAFT[f]=val;
  if(f==='source' && val==='metric' && !VDRAFT.metricId){ const ms=(anPrefs().metrics||[]); VDRAFT.metricId=ms[0]?ms[0].id:null; }
  drawViewBuilder(); }
function vToggleType(ty){ if(!VDRAFT)return; VDRAFT.types=VDRAFT.types||[]; const i=VDRAFT.types.indexOf(ty); if(i<0)VDRAFT.types.push(ty); else VDRAFT.types.splice(i,1); drawViewBuilder(); }
function vToggleTag(id){ if(!VDRAFT)return; VDRAFT.tags=VDRAFT.tags||[]; const i=VDRAFT.tags.indexOf(id); if(i<0)VDRAFT.tags.push(id); else VDRAFT.tags.splice(i,1); drawViewBuilder(); }
function cancelView(){ VDRAFT=null; document.getElementById('scrim').classList.remove('show'); refreshAnalytics(); }
function saveView(){ if(!VDRAFT)return; const inp=document.getElementById('vName'); if(inp)VDRAFT.name=inp.value.trim();
  if(!VDRAFT.name){ toast('Name required'); return; }
  const a=anPrefs(); a.views=a.views||[];
  VDRAFT.updatedAt=now();
  if(VDRAFT.id){ const i=a.views.findIndex(x=>x.id===VDRAFT.id); if(i>=0)a.views[i]=VDRAFT; else a.views.push(VDRAFT); }
  else { if(a.views.length>=20){ toast('Max 20 view sections'); return; } VDRAFT.id=uid(); VDRAFT.createdAt=Date.now(); a.views.push(VDRAFT); }
  a.activeView=VDRAFT.id; VDRAFT=null; document.getElementById('scrim').classList.remove('show'); save(); refreshAnalytics();
}
function delView(){ if(!VDRAFT||!VDRAFT.id){ cancelView(); return; }
  const a=anPrefs(); delMark(VDRAFT.id); a.views=a.views.filter(x=>x.id!==VDRAFT.id);
  if(a.activeView===VDRAFT.id) a.activeView=a.views[0]?a.views[0].id:null;
  VDRAFT=null; document.getElementById('scrim').classList.remove('show'); save(); refreshAnalytics();
}
function drawViewBuilder(){
  if(!VDRAFT) return;
  const sheet=document.getElementById('sheet'); if(!sheet) return;
  ensureTags();
  const seg=(f,opts)=>'<div class="seg vSeg">'+opts.map(o=>'<button class="'+(VDRAFT[f]===o[1]?'on':'')+'" onclick="vSet(\''+f+'\',\''+o[1]+'\')">'+o[0]+'</button>').join('')+'</div>';
  let h='<h3>'+(VDRAFT.id?'Edit view':'New view')+'</h3>';
  h+='<label>Name</label><input type="text" id="vName" value="'+esc(VDRAFT.name)+'" placeholder="e.g. Weekly completions">';
  h+='<label>Data</label>'+seg('source',V_SOURCES);
  if(VDRAFT.source==='metric'){
    const ms=(anPrefs().metrics||[]);
    h+='<label>Reps metric</label><div class="seg vSeg">'+
       ms.map(m=>'<button class="'+(VDRAFT.metricId===m.id?'on':'')+'" onclick="vSet(\'metricId\',\''+m.id+'\')">'+esc(m.name)+'</button>').join('')+
       '<button onclick="bAddMetric()">+ new metric</button></div>';
    if(VDRAFT.metricId){ h+='<div class="mMetricEditRow"><button class="anMini" onclick="bEditMetric(\''+VDRAFT.metricId+'\')">Edit this metric</button></div>'; }
    else if(!ms.length){ h+='<div class="mHint">No reps metrics yet — tap “+ new metric” to create one.</div>'; }
  }
  if(V_SPECIAL.indexOf(VDRAFT.source)<0){
    h+='<label>Group by</label>'+seg('group',V_GROUPS);
    h+='<label>Chart</label>'+seg('chart',V_CHARTS);
    if(VDRAFT.source!=='metric'){
      h+='<label>Only these types (optional)</label><div class="seg vSeg">'+V_TYPES.map(o=>'<button class="'+((VDRAFT.types||[]).indexOf(o[1])>=0?'on':'')+'" onclick="vToggleType(\''+o[1]+'\')">'+o[0]+'</button>').join('')+'</div>';
      if(S.tags.length){ h+='<label>Only these tags (optional)</label><div class="tagEdit">'+S.tags.map(g=>'<span class="tagChip'+((VDRAFT.tags||[]).indexOf(g.id)>=0?' on':'')+'" style="--tc:'+g.color+'" onclick="vToggleTag(\''+g.id+'\')">'+esc(g.name)+'</span>').join('')+'</div>'; }
    }
  } else {
    h+='<div class="mHint">This view shows a fixed summary layout and ignores grouping, chart and filters.</div>';
  }
  const w=anWindow();
  h+='<label>Preview</label><div class="anViewBody vPreview">'+renderView(VDRAFT,w[0],w[1])+'</div>';
  h+='<div class="rowBtns">'+(VDRAFT.id?'<button class="btn danger" onclick="delView()">Delete</button>':'')+(VDRAFT.id?'<button class="btn ghost" onclick="cloneView()">Clone</button>':'')+'<button class="btn ghost" onclick="cancelView()">Cancel</button><button class="btn primary" onclick="saveView()">Save</button></div>';
  sheet.innerHTML=h;
  document.getElementById('scrim').classList.add('show');
  bindTips('.spkHit'); bindTips('.barHit'); bindHeatTooltips();
}
function viewMetaLabel(v){ if(V_SPECIAL.indexOf(v.source)>=0) return 'summary';
  if(v.source==='metric'){ const m=anViewMetric(v); return 'metric: '+(m?m.name:'\u2014')+' \u00b7 by '+v.group+' \u00b7 '+v.chart; }
  return v.source+' \u00b7 by '+v.group+' \u00b7 '+v.chart; }
// Stacked, fully configurable: renders EVERY saved view as its own section
// (up to 20), each with reorder / edit controls. The builder (#anViewBuilder)
// appears at the top when adding or editing.
function anViewsUI(from,to){
  const a=anPrefs(); const views=a.views||[];
  let h='<div class="anSectionHeader">'+
        '  <span class="anSectionTitle">📐 Custom views ('+views.length+'/20)</span>'+
        '  <div class="anViewToolsCompact">'+
        '    <button class="anBtnCompact" onclick="exportViews()" title="Export views">📥 Export</button>'+
        '    <label class="anBtnCompact" title="Import views">📤 Import <input type="file" accept="application/json" style="display:none" onchange="importViews(event)"></label>'+
        '  </div>'+
        '</div>';
  h+='<div id="anViewBuilder"></div>';
  if(!views.length && !VDRAFT) h+='<div class="anNote">No view sections yet. Tap “+ Add view section” to build one.</div>';
  views.forEach((v,i)=>{
    h+='<div class="anViewSection">';
    h+='<div class="anViewHead"><span class="anViewName">'+esc(v.name)+'</span>'+
       '<span class="anViewMeta">'+esc(viewMetaLabel(v))+'</span>'+
       '<button class="anMini" title="Move up" onclick="moveView(\''+v.id+'\',-1)"'+(i===0?' disabled':'')+'>↑</button>'+
       '<button class="anMini" title="Move down" onclick="moveView(\''+v.id+'\',1)"'+(i===views.length-1?' disabled':'')+'>↓</button>'+
       '<button class="anMini" onclick="editView(\''+v.id+'\')">edit</button></div>';
    h+='<div class="anViewBody">'+renderView(v,from,to)+'</div>';
    h+='</div>';
  });
  if(views.length<20) h+='<div class="anAddView"><button class="anMini anAddBtn" onclick="newView()">+ Add view section</button></div>';
  else h+='<div class="anNote">Maximum of 20 view sections reached.</div>';
  return h;
}
function exportViews(){
  const a=anPrefs();
  const payload={_questaViews:1, appVersion:APP_VERSION, exportedAt:new Date().toISOString(), views:(a.views||[])};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob); const el=document.createElement('a');
  el.href=url; el.download='questa-views.json'; el.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Views exported ('+((a.views||[]).length)+')');
}
function importViews(ev){
  const f=ev.target.files[0]; ev.target.value=''; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>{ try{ const d=JSON.parse(rd.result); const arr=Array.isArray(d)?d:(d.views||[]);
      if(!Array.isArray(arr)||!arr.length) throw 0;
      const a=anPrefs(); a.views=a.views||[]; let n=0;
      arr.forEach(v=>{ if(!v||!v.source) return; a.views.push({id:uid(), name:v.name||'Imported view', source:v.source, group:v.group||'day', chart:v.chart||'line', tags:Array.isArray(v.tags)?v.tags:[], types:Array.isArray(v.types)?v.types:[], metricId:v.metricId||null, createdAt:Date.now(), updatedAt:now()}); n++; });
      if(n){ a.activeView=a.views[a.views.length-1].id; }
      save(); refreshAnalytics(); toast('Imported '+n+' view'+(n===1?'':'s'));
    } catch(e){ alertDialog('Error', 'That file does not look like Questa views.'); } };
  rd.readAsText(f);
}
function refreshAnalytics(){
  const p=anPrefs(); const w=anWindow(); const from=w[0], to=w[1];
  const body=document.getElementById('anBody'); if(!body)return;
  const oldDetails = document.querySelector('.anDetails');
  const wasOpen = oldDetails ? oldDetails.hasAttribute('open') : false;
  const oldEventDetails = document.querySelector('.anEventDetails');
  const eventWasOpen = oldEventDetails ? oldEventDetails.hasAttribute('open') : false;
  let h='';
  h+=anViewsUI(from,to);
  h+='<details class="anDetails"'+(wasOpen?' open':'')+'><summary>🔎 Full activity detail (reps, adherence, streaks, event log)</summary><div class="anDetailWrap">'+anDetailDashboard(from,to)+'</div></details>';
  h+='<details class="anDetails anEventDetails"'+(eventWasOpen?' open':'')+'><summary>&#128203; Event log detail (live)</summary>'+
     '<div id="anEventDetail" class="anCard full"><div class="k">From IndexedDB event log</div>'+
     '<div class="anNote">Loading events&hellip;</div></div></details>';
  body.innerHTML=h;
  bindHeatTooltips();
  bindTips('.spkPt'); bindTips('.spkHit'); bindTips('.barHit');
  if(VDRAFT){ if(MBUILD) drawMetricEditor(); else drawViewBuilder(); }
  bindMetricChips();
  if(MEDIT && !MBUILD) drawMetricEditor();
  renderEventDetail(from,to);
}
function anDetailDashboard(from,to){
  const p=anPrefs();
  const days=Math.max(1,Math.round((to-from)/DAY));
  let h='';
  h+='<div class="anSection">Reps metric</div>';
  h+='<div class="anChips" id="anMetricChips">'+
     p.metrics.map(m=>'<span class="anChip'+(m.id===p.activeMetric?' on':'')+'" data-mid="'+m.id+'">'+esc(m.name)+'</span>').join('')+
     '<span class="anChip" id="anMetricAdd" style="border-style:dashed">+ add</span></div>';
  h+='<div id="anMetricEdit"></div>';
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
  h+=anLifecycleHTML(from,to);
  return h;
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
let _evFilterType='all'; // 'all', 'habit', 'daily', 'todo', 'system'
let _evSearchQuery='';   // search string
let _evPage=0;          // current page
let _evWin=null;        // [from,to] of the last render (to detect window change)
const EV_PAGE_SIZE=25;  // events per page

function evSetFilter(type){
  _evFilterType=type||'all';
  _evPage=0;
  if(_evWin) renderEventDetail(_evWin[0],_evWin[1]);
}
function evSetSearch(query){
  _evSearchQuery=query||'';
  _evPage=0;
  const input = document.querySelector('.evSearchInput');
  if(input) input.value = _evSearchQuery;
  if(_evWin) renderEventDetail(_evWin[0],_evWin[1]);
}
function evGoPage(n){
  _evPage=Math.max(0,n);
  if(_evWin) renderEventDetail(_evWin[0],_evWin[1]);
}

function getEventCategory(e) {
  if (e.kind === 'habitTap' || e.kind === 'habitReps' || e.taskType === 'habit') return 'habit';
  if (e.kind === 'import' || e.kind === 'export' || e.kind === 'devicename') return 'system';
  if (e.taskType === 'daily' || e.kind === 'miss') return 'daily';
  if (e.taskType === 'todo') return 'todo';
  if (e.kind === 'subtask') {
    return e.taskType === 'todo' ? 'todo' : 'daily';
  }
  if (e.kind === 'complete') {
    return e.taskType === 'todo' ? 'todo' : 'daily';
  }
  return 'system';
}
function _evCatBadgeName(cat){ return {habit:'Habit',daily:'Daily',todo:'To-do',system:'System'}[cat]||'Event'; }
function _evCatBadgeClass(cat){ return {habit:'evBadge-habit',daily:'evBadge-daily',todo:'evBadge-todo',system:'evBadge-system'}[cat]||'evBadge-default'; }
function _evDeltaSpan(val,unit){
  if(!val) return '';
  const pos=val>0;
  const num=(unit==='XP'||unit==='MP')?Math.round(Math.abs(val)):Math.abs(val).toFixed(1);
  return '<span style="font-size:10px;font-weight:700;color:'+(pos?'#7ee787':'#f74e52')+'">'+(pos?'+':'-')+num+(unit==='G'?'G':' '+unit)+'</span>';
}
function _evDiffText(from,to){
  const _c=s=>esc(String(s==null?'':s));
  const hasFrom=from!=null&&String(from)!=='';
  const hasTo=to!=null&&String(to)!=='';
  const F='style="color:#f74e52;text-decoration:line-through"';
  const T='style="color:#7ee787"';
  if(!hasFrom&&hasTo) return '<span style="color:#8b96a8;font-style:italic">new</span> \u2192 <span '+T+'>'+_c(to)+'</span>';
  if(hasFrom&&!hasTo) return '<span '+F+'>'+_c(from)+'</span> \u2192 <span style="color:#f74e52;font-style:italic">removed</span>';
  return '<span '+F+'>'+_c(from)+'</span> \u2192 <span '+T+'>'+_c(to)+'</span>';
}

/* BEGIN_DEVICENAME_HELPERS */
// Resolve a device's display name for the event log / Settings: prefer the
// user-set name (S.devices entries, synced across devices the same way as
// tasks/rewards/tags via mergeCollection), fall back to the same truncated
// raw deviceId already shown in Settings so an unnamed device is still
// distinguishable from others instead of showing nothing.
function deviceDisplayName(devices, devId){
  if(!devId) return '';
  const d = (devices||[]).find(x=>x && x.id===devId);
  const name = d && d.name ? String(d.name).trim() : '';
  return name || String(devId).slice(0,6);
}
/* END_DEVICENAME_HELPERS */

// Async, event-driven dashboard section. Redesigned to show a unified
// Activity Feed where users can browse, search and filter ALL events.
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

    // Sort events newest first
    const sorted = all.slice().sort((a,b)=>b.ts - a.ts);

    // Last-known device name per device, derived from the devicename events in
    // this window. `sorted` is newest-first, so the first hit per deviceId is
    // the most recent. Used as a fallback so a rename event alone is enough to
    // label a row correctly even if the live S.devices name is missing/stale
    // (plan §3A/§3B).
    const devNameFromEvents = {};
    all.forEach(ev => {
      if(ev && ev.kind==='devicename' && ev.deviceId && ev.deviceName && ev.deviceName.trim() && !devNameFromEvents[ev.deviceId]){
        devNameFromEvents[ev.deviceId] = ev.deviceName.trim();
      }
    });

    // Filter events
    const filtered = sorted.filter(e=>{
      const cat = getEventCategory(e);
      if(_evFilterType!=='all' && cat!==_evFilterType) return false;
      if(_evSearchQuery.trim()){
        const q=_evSearchQuery.toLowerCase().trim();
        const title=(e.taskTitle||e.taskType||e.kind||e.subText||'').toLowerCase();
        const notes=(e.notes||'').toLowerCase();
        if(!title.includes(q) && !notes.includes(q)) return false;
      }
      return true;
    });

    const synCount=all.filter(e=>e.synthetic).length;

    // Check if controls structure is already rendered to avoid losing focus/destroying inputs
    let feedContent = document.getElementById('evFeedContent');
    if(!feedContent){
      let h='<div class="k">Activity Feed</div>';
      
      // Category chips
      const categories = [
        ['all', 'All'],
        ['habit', 'Habits ⚡'],
        ['daily', 'Dailies 📅'],
        ['todo', 'To-dos ☑️'],
        ['system', 'System 💾']
      ];
      h+='<div class="evFilterRow">';
      categories.forEach(c=>{
        h+='<span class="evFilterChip'+(_evFilterType===c[0]?' active':'')+'" data-filter="'+c[0]+'" onclick="evSetFilter(\''+c[0]+'\')">'+c[1]+'</span>';
      });
      h+='</div>';

      // Search bar
      h+='<div class="evSearchRow">'+
         '<input type="text" class="evSearchInput" placeholder="Search events or tasks..." value="'+esc(_evSearchQuery)+'" oninput="evSetSearch(this.value)">'+
         '<button class="evSearchReset" style="display:'+(_evSearchQuery?'block':'none')+'" onclick="evSetSearch(\'\')">&times;</button>'+
         '</div>';

      h+='<div id="evFeedContent"></div>';
      cur.innerHTML = h;
      feedContent = document.getElementById('evFeedContent');
    } else {
      // Sync filter chips active class without re-rendering controls
      const chips = cur.querySelectorAll('.evFilterChip');
      chips.forEach(chip => {
        if(chip.getAttribute('data-filter') === _evFilterType) {
          chip.classList.add('active');
        } else {
          chip.classList.remove('active');
        }
      });
      
      // Sync search input safely without shifting focus or selection
      const searchInput = cur.querySelector('.evSearchInput');
      if(searchInput && searchInput.value !== _evSearchQuery) {
        searchInput.value = _evSearchQuery;
      }
      
      // Sync search reset button visibility
      const searchReset = cur.querySelector('.evSearchReset');
      if(searchReset) {
        searchReset.style.display = _evSearchQuery ? 'block' : 'none';
      }
    }

    if(!filtered.length){
      feedContent.innerHTML='<div class="anNote" style="text-align:center;padding:16px 0;">No matching events found.</div>';
      return;
    }

    const pages=Math.max(1,Math.ceil(filtered.length/EV_PAGE_SIZE));
    if(_evPage>=pages) _evPage=pages-1;
    const startI=_evPage*EV_PAGE_SIZE;
    const pageEvents=filtered.slice(startI,startI+EV_PAGE_SIZE);

    let listHtml='<div class="evFeed">';
    pageEvents.forEach(e=>{
      let icon = '📝';
      let badgeClass = 'evBadge-default';
      let badgeName = 'Event';
      let desc = '';
      let rightSide = '';

      const cat = getEventCategory(e);
      const titleHtml = e.taskTitle ? '<strong class="evTaskClick" onclick="evSetSearch(\'' + esc(e.taskTitle).replace(/'/g, "\\'") + '\')">' + esc(e.taskTitle) + '</strong>' : '';

      const _NEWK={create:1,edit:1,delete:1,uncomplete:1,rewardCreate:1,rewardEdit:1,rewardDelete:1,purchase:1,restore:1};
      if (e.kind === 'subtask') {
        icon = '↳';
        badgeName = cat === 'todo' ? 'To-do' : 'Daily';
        badgeClass = cat === 'todo' ? 'evBadge-todo' : 'evBadge-daily';
        const fromState = e.done ? 'unchecked' : 'checked';
        const toState   = e.done ? 'checked'   : 'unchecked';
        let note = '';
        if (cat === 'daily') {
          const _t = S.tasks.find(x => x.id === e.taskId);
          note = ' &middot; <span class="evNote" style="opacity:.7">daily ' + (_t && _t.done ? 'complete' : 'not complete') + '</span>';
        }
        desc = 'Subtask <code>' + esc(e.subText || '') + '</code> on ' + titleHtml +
               ' &middot; ' + _evDiffText(fromState, toState) + note;
      }

      else if (_NEWK[e.kind]) {
        badgeName=_evCatBadgeName(cat); badgeClass=_evCatBadgeClass(cat);
        if (e.kind==='create'){ icon='🆕'; desc='Created '+(e.taskType||'task')+' '+titleHtml; }
        else if (e.kind==='edit'){ icon='✏️';
          const _summ=[]; let _detail='';
          if(Array.isArray(e.changes)){
            e.changes.forEach(c=>{
              if(c.field==='title' && c.from!=null){ _summ.push('title: '+esc(c.from)+'→'+esc(c.to)); }
              else if(c.field==='difficulty' && c.from!=null){ _summ.push('difficulty: '+esc(c.from)+'→'+esc(c.to)); }
              else if(c.field==='notes'){ _summ.push('notes');
                if(c.from!=null||c.to!=null){ _detail+='<div style="margin-top:3px;font-size:11px;line-height:1.5"><span style="opacity:.7">notes:</span> '+_evDiffText(c.from,c.to)+'</div>'; }
              }
              else if(c.field==='checklist'){ _summ.push('subtasks');
                if(Array.isArray(c.items)&&c.items.length){
                  const _rows=c.items.map(it=>{
                    if(it.type==='changed') return '<div style="padding-left:8px">&bull; '+_evDiffText(it.from,it.to)+'</div>';
                    if(it.type==='added') return '<div style="padding-left:8px">&bull; '+_evDiffText(null,it.to)+'</div>';
                    if(it.type==='removed') return '<div style="padding-left:8px">&bull; '+_evDiffText(it.from,null)+'</div>';
                    if(it.type==='toggled') return '<div style="padding-left:8px">&bull; <span style="color:#7ee787">'+(it.done?'checked':'unchecked')+'</span> <span style="opacity:.8">'+esc(it.to||'')+'</span></div>';
                    return '';
                  }).join('');
                  _detail+='<div style="margin-top:3px;font-size:11px;line-height:1.5"><span style="opacity:.7">subtasks:</span>'+_rows+'</div>';
                }
              }
              else { _summ.push(esc(c.field)); }
            });
          }
          desc='Edited '+titleHtml+(_summ.length?' &middot; <span class="evNotes">'+_summ.join(', ')+'</span>':'')+_detail;
        }
        else if (e.kind==='delete'){ icon='🗑️'; desc='Deleted '+(e.taskType||'task')+' '+titleHtml; }
        else if (e.kind==='uncomplete'){ icon='↩️'; desc='Reverted '+titleHtml; }
        else if (e.kind==='rewardCreate'){ icon='🎁'; desc='Created reward '+titleHtml; badgeName='System'; badgeClass='evBadge-system'; }
        else if (e.kind==='rewardEdit'){ icon='🎁'; desc='Edited reward '+titleHtml; badgeName='System'; badgeClass='evBadge-system'; }
        else if (e.kind==='rewardDelete'){ icon='🗑️'; desc='Deleted reward '+titleHtml; badgeName='System'; badgeClass='evBadge-system'; }
        else if (e.kind==='purchase'){ icon='🛒'; desc='Bought '+titleHtml+(e.effect?' &middot; <span class="evNotes">'+esc(e.effect)+'</span>':''); badgeName='System'; badgeClass='evBadge-system'; }
        else if (e.kind==='restore'){ icon='♻️'; desc='Restored from snapshot'+(e.notes?' &middot; <span class="evNotes">'+esc(e.notes)+'</span>':''); badgeName='System'; badgeClass='evBadge-system'; }
      } else if (cat === 'habit') {
        icon = e.dir === -1 ? '➖' : '⚡';
        badgeClass = e.dir === -1 ? 'evBadge-habit-down' : 'evBadge-habit';
        badgeName = 'Habit';
        if (e.kind === 'habitReps') {
          const repText = e.reps ? ' ' + Math.abs(e.reps) + ' rep' + (Math.abs(e.reps) === 1 ? '' : 's') : '';
          desc = 'Logged' + repText + (e.dir < 0 ? ' (removed)' : '') + ' on ' + titleHtml;
        } else {
          const repText = e.reps && e.reps > 1 ? ' (' + e.reps + ' reps)' : '';
          if (e.dir === -1) {
            desc = 'Tapped negative on ' + titleHtml;
          } else {
            desc = 'Tapped ' + titleHtml + repText;
          }
        }
      } else if (cat === 'daily') {
        badgeName = 'Daily';
        if (e.kind === 'miss') {
          icon = '❌';
          badgeClass = 'evBadge-daily-miss';
          desc = 'Missed daily ' + titleHtml;
        } else {
          icon = '📅';
          badgeClass = 'evBadge-daily';
          const lateStr = e.late ? ' <span class="evLate">late</span>' : '';
          let detail = '';
          if (Array.isArray(e.checklist) && e.checklist.length) {
            const _rows = e.checklist.map(c =>
              '<div style="padding-left:8px">&bull; ' + (c.done ? '<span style="color:#7ee787">checked</span>' : '<span style="color:#f74e52">unchecked</span>') +
              ' <span style="opacity:.8">' + esc(c.text || '') + '</span></div>'
            ).join('');
            detail = '<div style="margin-top:3px;font-size:11px;line-height:1.5"><span style="opacity:.7">subtasks:</span>' + _rows + '</div>';
          }
          desc = 'Completed daily ' + titleHtml + lateStr + detail;
        }
      } else if (cat === 'todo') {
        badgeName = 'To-do';
        badgeClass = 'evBadge-todo';
        icon = '☑️';
        desc = 'Completed to-do ' + titleHtml;
      } else if (cat === 'system') {
        badgeName = 'System';
        badgeClass = 'evBadge-system';
        if (e.kind === 'import') {
          icon = '📥';
          desc = 'Imported backup data';
          if (e.notes) desc += ' &middot; <span class="evNotes">' + esc(e.notes) + '</span>';
        } else if (e.kind === 'export') {
          icon = '📤';
          desc = 'Exported progress data';
          if (e.notes) desc += ' &middot; <span class="evNotes">' + esc(e.notes) + '</span>';
        } else if (e.kind === 'devicename') {
          icon = '🏷️';
          desc = 'Device name updated';
          if (e.notes) desc += ' &middot; <span class="evNotes">' + esc(e.notes) + '</span>';
        } else if (e.kind === 'conflictResolved') {
          icon = '⚖️';
          var _ct = e.taskTitle || e.charTitle || 'item';
          desc = 'Sync conflict resolved \u00b7 ' + esc(_ct) + ' \u00b7 kept ' + (e.winner === 'remote' ? 'remote' : 'local');
        } else {
          icon = '⚙️';
          desc = esc(e.taskTitle || 'System action');
        }
      }

      if (e.kind === 'purchase') {
        if (e.cost) rightSide = '<div class="evRewardRow">'+_evDeltaSpan(-(e.cost||0),'G')+'</div>';
      } else if (e.kind === 'edit' && e.counter) {
        const _c=e.counter, _pr=[];
        if(_c.xp) _pr.push(_evDeltaSpan(_c.xp,'XP'));
        if(_c.gold) _pr.push(_evDeltaSpan(_c.gold,'G'));
        if(_c.mp) _pr.push(_evDeltaSpan(_c.mp,'MP'));
        if(_c.hp) _pr.push(_evDeltaSpan(_c.hp,'HP'));
        if(_pr.length) rightSide='<div class="evRewardRow">'+_pr.join(' ')+'</div>';
      } else if (e.kind === 'uncomplete' && e.clawback) {
        const _c=e.clawback, _pr=[];
        if(_c.xp) _pr.push(_evDeltaSpan(-_c.xp,'XP'));
        if(_c.gold) _pr.push(_evDeltaSpan(-_c.gold,'G'));
        if(_c.mp) _pr.push(_evDeltaSpan(-_c.mp,'MP'));
        if(_pr.length) rightSide='<div class="evRewardRow">'+_pr.join(' ')+'</div>';
      } else if (e.reward) {
        const parts = [];
        if (e.reward.xp) parts.push('<span class="evGainXp">+' + Math.round(e.reward.xp) + ' XP</span>');
        if (e.reward.gold) parts.push('<span class="evGainGold">+' + (+e.reward.gold).toFixed(1) + 'G</span>');
        if (e.reward.mp) parts.push('<span class="evGainMp">+' + Math.round(e.reward.mp) + ' MP</span>');
        if (parts.length) rightSide = '<div class="evRewardRow">' + parts.join(' ') + '</div>';
      } else if (cat === 'habit' && e.kind === 'habitReps') {
        // bulk reps entry: no scoring, so just surface the rep total
        const r = e.reps ? Math.abs(e.reps) : 0;
        if (r) rightSide = '<div class="evRewardRow"><span class="evGainXp">' + (e.dir < 0 ? '-' : '+') + r + ' reps</span></div>';
      } else if ((cat === 'daily' && e.kind === 'miss') || (e.kind === 'habitTap' && e.dir === -1)) {
        let lossVal = null;
        if (e.dmg !== undefined) {
          lossVal = e.dmg;
        } else {
          const t = S.tasks.find(x => x.id === e.taskId);
          if (t) {
            lossVal = missDamage(t);
          }
        }
        const hpLossStr = lossVal !== null ? '-' + (+lossVal).toFixed(1) + ' HP' : 'HP Loss';
        rightSide = '<div class="evRewardRow"><span class="evLossHp">' + hpLossStr + '</span></div>';
      }

      const date = new Date(e.ts);
      const dateStr = date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
      const timeStr = String(date.getHours()).padStart(2,'0') + ':' + String(date.getMinutes()).padStart(2,'0');
      const fullTime = dateStr + ' @ ' + timeStr;

      const mark = e.synthetic ? ' <span class="anEvSyn" title="Backfilled from Habitica">~ backfill</span>' : '';
      const _devName0 = (typeof deviceDisplayName==="function")?deviceDisplayName(S.devices,e.dev):e.dev.slice(0,6);
      // If the live lookup fell back to the short id, prefer the last-known name
      // recorded in the event log for this device (plan §3A/§3B).
      const _devLabelName = (_devName0===String(e.dev).slice(0,6) && devNameFromEvents[e.dev]) ? devNameFromEvents[e.dev] : _devName0;
      const devLabel = e.dev ? ' <span class="evDevice" style="opacity:.65" title="Device ID: '+esc(e.dev)+'">&middot; '+esc(_devLabelName)+'</span>' : '';

      listHtml+='<div class="evRow">'+
         '  <div class="evColIcon">'+icon+'</div>'+
         '  <div class="evColMain">'+
         '    <div class="evDesc">'+desc+'</div>'+
         '    <div class="evMetaRow">'+
         '      <span class="evBadge '+badgeClass+'">'+badgeName+'</span>'+
         '      <span class="evTime">'+fullTime+'</span>'+
         '      '+mark+devLabel+
         '    </div>'+
         '  </div>'+
         '  <div class="evColRight">'+rightSide+'</div>'+
         '</div>';
    });
    listHtml+='</div>';

    if(pages>1){
      listHtml+='<div class="evPager">'+
         '<button class="evPg" '+(_evPage<=0?'disabled':'')+' onclick="evGoPage('+(_evPage-1)+')">&#8592; Newer</button>'+
         '<span class="evPgLbl">Page '+(_evPage+1)+' / '+pages+' &middot; '+filtered.length+' events</span>'+
         '<button class="evPg" '+(_evPage>=pages-1?'disabled':'')+' onclick="evGoPage('+(_evPage+1)+')">Older &#8594;</button>'+
         '</div>';
    }

    if(synCount){
      listHtml+='<div class="anNote"><b>'+synCount+'</b> event(s) in window backfilled from Habitica history.</div>';
    }

    feedContent.innerHTML=listHtml;
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
  saveFocus();
  // tearing down #view orphans any in-flight drag node; clear all drag state
  // first so a lingering ghost/listeners can't freeze the next screen.
  if(typeof resetDragState==='function') resetDragState();
  renderStats();
  updateHeaderHeightVar();
  const v=document.getElementById('view');
  v.innerHTML = TAB==='habits'?viewHabits() : TAB==='dailies'?viewDailies() : TAB==='todos'?viewTodos() : TAB==='analytics'?viewAnalytics() : viewRewards();
  if(TAB==='analytics') initAnalytics();
  document.body.classList.toggle('tab-analytics', TAB==='analytics');
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('on',b.dataset.tab===TAB));
  if(TAB!=='analytics') enableDragReorder();
  restoreScroll();
  restoreFocus();
}
// persist scroll continuously (lightweight, debounced)
let _scrollT=null;
window.addEventListener('scroll',()=>{ if(_scrollT)return; _scrollT=setTimeout(()=>{ _scrollT=null; saveScroll(); save(); },400); });
// Mobile PWAs (esp. Android Chrome) can freeze/discard a backgrounded page before a
// tap-triggered localStorage write is committed, reverting to an older snapshot on
// relaunch (e.g. filter re-opens). Force a synchronous flush on the durable
// 'page is going away' signals: visibilitychange->hidden and pagehide.
function flushState(){
  if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'flushState', visibilityState:(typeof document!=="undefined"?document.visibilityState:'?')});
  if(_scrollT){ clearTimeout(_scrollT); _scrollT=null; }
  saveScroll();
  save();
}
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
  if(typeof enableSubtaskDragReorder==='function') enableSubtaskDragReorder();
}
// Touch reordering via Touch Events. Long-press picks the card up; once lifted
// we attach non-passive move/end listeners on the document and preventDefault on
// every move so the browser can NEVER turn the gesture into a page scroll (the
// cause of the earlier freeze). A floating ghost follows the finger and the
// other cards slide out of the way (FLIP animation).
let _tDrag=null, _tTimer=null, _tStartY=0, _tStartX=0, _tGhost=null, _tGrabDY=0,
    _tAutoScroll=null, _tPointerY=0, _tActive=false;
// ---- Inertial (momentum) scrolling for the manual card-scroll path --------
// Cards are touch-action:none, so the browser's native fling/inertia never runs
// when a swipe starts on a card. We replicate it: track finger velocity during
// the manual scroll, then on release coast the page with exponential friction.
let _inertiaRAF=null, _scrollVel=0;            // px/frame at 60fps, sign = scrollBy direction
function stopInertia(){ if(_inertiaRAF){ cancelAnimationFrame(_inertiaRAF); _inertiaRAF=null; } _scrollVel=0; }
function startInertia(v0){
  stopInertia();
  // v0 is px/ms (finger speed). Convert to px/frame and cap so a hard flick
  // doesn't launch absurdly fast. Below threshold, don't bother coasting.
  // Tuned 50% stronger: higher launch multiplier + cap, slower friction = longer coast.
  let v=Math.max(-60,Math.min(60, v0*24));
  if(Math.abs(v)<0.6) return;
  const FRICTION=0.96;                          // per-frame decay (slower = farther coast)
  const step=()=>{
    window.scrollBy(0,-v);                       // same sign convention as manual scroll
    v*=FRICTION;
    if(Math.abs(v)<0.25){ _inertiaRAF=null; _scrollVel=0; return; }
    _inertiaRAF=requestAnimationFrame(step);
  };
  _inertiaRAF=requestAnimationFrame(step);
}
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
    const isCheckTouch = !!e.target.closest('.check') || !!e.target.closest('.subFrac') || !!e.target.closest('.subbox');
    const isSubtaskTouch = !!e.target.closest('.subitem');
    if(_tActive || _tGhost || _tDrag) resetDragState();   // clean slate every gesture
    stopInertia();                                // a new touch always halts coasting
    // Long-press lifts the CARD. Skip it when the touch begins on an interactive
    // control or a subtask, so those own their tap/drag. Scrolling still works
    // from these spots below (touch-action:none means native scroll is off; we drive it).
    const skipCardTimer = isCheckTouch || isSubtaskTouch;
    const t=e.touches[0];
    _tStartX=t.clientX; _tStartY=t.clientY; _tPointerY=t.clientY;
    let _lastY=t.clientY, _decided=false, _isScroll=false;
    let _vLastY=t.clientY, _vLastT=(e.timeStamp||performance.now()), _vel=0;
    clearTimeout(_tTimer);
    if(!skipCardTimer){
      _tTimer=setTimeout(()=>{ if(!_isScroll){ _decided=true; beginTouchDrag(card,t); } },longPressMs());
    }

    const onMove=ev=>{
      // Cancel EVERY move from the first one. Card is touch-action:none, but we
      // still cancel defensively so a stationary hold can never let the browser
      // start its own scroll/callout and flip subsequent moves non-cancelable.
      if(ev.cancelable) ev.preventDefault();
      const tt=ev.touches[0]; if(!tt) return;
      // ABORT: if Chrome committed to a native scroll, moves become non-cancelable.
      // If we're in an active drag and can't cancel, the gesture is lost — clean up
      // immediately so the app doesn't freeze with a stuck ghost card.
      if(_tActive && !ev.cancelable){ endTouchDrag(); return; }
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
      if(_isScroll){
        if(_tSubActive) return;                    // subtask drag owns this gesture
        window.scrollBy(0,-dy);
        // exponential-moving-average velocity in px/ms (sign matches finger dir)
        const now=(ev.timeStamp||performance.now()), dt=now-_vLastT;
        if(dt>0){ const v=(tt.clientY-_vLastY)/dt; _vel=_vel*0.7+v*0.3; _vLastY=tt.clientY; _vLastT=now; }
      }
      _lastY=tt.clientY;
    };
    const onEnd=()=>{
      clearTimeout(_tTimer); _tTimer=null;
      card.removeEventListener('touchmove',onMove);
      window.removeEventListener('touchend',onEnd);
      window.removeEventListener('touchcancel',onEnd);
      if(_tActive){ endTouchDrag(); }              // finish an active drag (no fling)
      else if(_isScroll && !_tSubActive){ startInertia(_vel); }    // coast after a manual scroll flick
    };
    card.addEventListener('touchmove',onMove,{passive:false});
    window.addEventListener('touchend',onEnd);
    window.addEventListener('touchcancel',onEnd);
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
  buzz(15);
  // NOTE: no document-level touch listeners. The card's own non-passive touchmove
  // listener (bound at touchstart) drives the active drag, so preventDefault has
  // been in force since the first move of the gesture.
  startAutoScroll();
}
function moveTouchDrag(x,y){
  if(_tGhost) _tGhost.style.top=(y-_tGrabDY)+'px';
  const el=document.elementFromPoint(x,y);       // ghost is pointer-events:none
  const over=el && el.closest('.task[draggable="true"]');
  if(over && over!==_tDrag && over!==_tGhost && over.dataset.list===_dragList){
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
  if(typeof resetSubDragState==='function') resetSubDragState();
  if(typeof resetEditDragState==='function') resetEditDragState();
}
function endTouchDrag(){
  if(!_tActive && !_tDrag){ resetDragState(); return; }  // nothing in flight
  const dropTarget=_tDrag, ghost=_tGhost;
  // detach listeners + clear globals FIRST so the next gesture is never blocked,
  // even though we still animate the ghost snap below using local references.
  _tGhost=null;                                   // hand the ghost to the animation
  if(dropTarget) { try{ commitOrder(); }catch(e){ console.error(e); } }
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

// ---- Subtask Drag & Drop Reordering (Main View) ----
let _dragSubEl = null, _dragSubTaskId = null;
let _tSubDrag = null, _tSubGhost = null, _tSubGrabDY = 0, _tSubActive = false, _tSubTimer = null;

function enableSubtaskDragReorder(){
  const subitems = document.querySelectorAll('#view .subitem');
  subitems.forEach(subitem => {
    // --- Desktop: HTML5 Drag & Drop ---
    subitem.addEventListener('dragstart', e => {
      _dragSubEl = subitem;
      _dragSubTaskId = subitem.dataset.taskId;
      subitem.classList.add('dragging-sub');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', subitem.dataset.idx); } catch (_) {}
      e.stopPropagation(); // Prevent parent task card from dragging
    });

    subitem.addEventListener('dragend', e => {
      subitem.classList.remove('dragging-sub');
      _dragSubEl = null;
      commitSubOrder(_dragSubTaskId);
      e.stopPropagation();
    });

    subitem.addEventListener('dragover', e => {
      if (!_dragSubEl || subitem === _dragSubEl || subitem.dataset.taskId !== _dragSubTaskId) return;
      e.preventDefault();
      e.stopPropagation();
      const r = subitem.getBoundingClientRect();
      const after = (e.clientY - r.top) / r.height > 0.5;
      subitem.parentNode.insertBefore(_dragSubEl, after ? subitem.nextSibling : subitem);
    });

    // --- Mobile/Touch Drag & Drop with long-press ---
    enableSubTouchDrag(subitem);
  });
}

function enableSubTouchDrag(subitem) {
  subitem.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    if (e.target.closest('.subbox')) return; // Checkbox click is immediate, don't drag
    
    if (_tSubActive || _tSubGhost || _tSubDrag) resetSubDragState();
    
    const t = e.touches[0];
    const startX = t.clientX, startY = t.clientY;
    let isScroll = false, decided = false;
    
    clearTimeout(_tSubTimer);
    _tSubTimer = setTimeout(() => {
      if (!isScroll) {
        decided = true;
        beginSubTouchDrag(subitem, t);
      }
    }, longPressMs());

    const onMove = ev => {
      if (ev.cancelable) ev.preventDefault();
      const tt = ev.touches[0];
      if (!tt) return;
      
      if (_tSubActive) {
        if (_tSubGhost) {
          _tSubGhost.style.top = (tt.clientY - _tSubGrabDY) + 'px';
        }
        
        const el = document.elementFromPoint(tt.clientX, tt.clientY);
        const over = el && el.closest('.subitem');
        if (over && over !== _tSubDrag && over !== _tSubGhost && over.dataset.taskId === _dragSubTaskId) {
          const rr = over.getBoundingClientRect();
          const after = (tt.clientY - rr.top) / rr.height > 0.5;
          over.parentNode.insertBefore(_tSubDrag, after ? over.nextSibling : over);
        }
        return;
      }
      
      // Before drag fires: check for drag-vs-scroll decision
      const dx = Math.abs(tt.clientX - startX);
      const dy = Math.abs(tt.clientY - startY);
      if (!decided && (dx > 8 || dy > 8)) {
        decided = true;
        isScroll = true;
        clearTimeout(_tSubTimer);
        _tSubTimer = null;
      }
    };

    const onEnd = () => {
      clearTimeout(_tSubTimer);
      _tSubTimer = null;
      subitem.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      
      if (_tSubActive) {
        commitSubOrder(_dragSubTaskId);
        resetSubDragState();
      }
    };

    subitem.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }, { passive: false });
}

function beginSubTouchDrag(subitem, t) {
  _tSubActive = true;
  _tSubDrag = subitem;
  _dragSubTaskId = subitem.dataset.taskId;
  
  const r = subitem.getBoundingClientRect();
  _tSubGrabDY = t.clientY - r.top;
  
  document.documentElement.classList.add('dragging-active');
  
  _tSubGhost = subitem.cloneNode(true);
  _tSubGhost.classList.add('dragGhost');
  _tSubGhost.classList.add('subitem');
  _tSubGhost.style.width = r.width + 'px';
  _tSubGhost.style.left = r.left + 'px';
  _tSubGhost.style.top = (t.clientY - _tSubGrabDY) + 'px';
  document.body.appendChild(_tSubGhost);
  
  subitem.classList.add('dragging-sub');
  subitem.style.touchAction = 'none';
  
  if (typeof buzz === 'function') buzz(15);
}

function resetSubDragState() {
  clearTimeout(_tSubTimer); _tSubTimer = null;
  document.documentElement.classList.remove('dragging-active');
  if (_tSubGhost) { _tSubGhost.remove(); _tSubGhost = null; }
  if (_tSubDrag) {
    _tSubDrag.style.touchAction = '';
    _tSubDrag.classList.remove('dragging-sub');
    _tSubDrag = null;
  }
  _tSubActive = false;
}

function commitSubOrder(taskId) {
  if (!taskId) return;
  const task = S.tasks.find(x => x.id === taskId);
  if (!task || !task.checklist) return;
  
  // Find all subitems in the DOM for this specific task
  const currentSubitems = [...document.querySelectorAll('#view .subitem[data-task-id="' + taskId + '"]')];
  if (!currentSubitems.length) return;
  
  const newChecklist = [];
  currentSubitems.forEach(subitem => {
    const idx = parseInt(subitem.dataset.idx, 10);
    if (task.checklist[idx]) {
      newChecklist.push(task.checklist[idx]);
    }
  });
  
  task.checklist = newChecklist;
  task.updatedAt = now();
  
  // Save, bump version, and re-render
  save();
  render();
}

// ---- Checklist Drag & Drop Reordering (Edit Dialog) ----
let _dragEditEl = null;
let _tEditDrag = null, _tEditGhost = null, _tEditGrabDY = 0, _tEditActive = false;

function enableEditChecklistDragReorder(){
  const cis = document.querySelectorAll('#eCheck .ci');
  cis.forEach(ci => {
    const handle = ci.querySelector('.ci-drag-handle');
    if (handle) {
      handle.addEventListener('mousedown', () => {
        ci.setAttribute('draggable', 'true');
      });
      handle.addEventListener('mouseup', () => {
        ci.setAttribute('draggable', 'false');
      });
    }

    // --- Desktop: HTML5 Drag & Drop ---
    ci.addEventListener('dragstart', e => {
      _dragEditEl = ci;
      ci.classList.add('dragging-ci');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', ''); } catch (_) {}
    });

    ci.addEventListener('dragend', () => {
      ci.classList.remove('dragging-ci');
      ci.setAttribute('draggable', 'false');
      _dragEditEl = null;
      commitEditChecklistOrder();
    });

    ci.addEventListener('dragover', e => {
      if (!_dragEditEl || ci === _dragEditEl) return;
      e.preventDefault();
      const r = ci.getBoundingClientRect();
      const after = (e.clientY - r.top) / r.height > 0.5;
      ci.parentNode.insertBefore(_dragEditEl, after ? ci.nextSibling : ci);
    });

    // --- Mobile/Touch ---
    if (handle) {
      handle.addEventListener('touchstart', e => {
        if (e.touches.length !== 1) return;
        if (_tEditActive || _tEditGhost || _tEditDrag) resetEditDragState();
        
        const t = e.touches[0];
        _tEditActive = true;
        _tEditDrag = ci;
        
        const r = ci.getBoundingClientRect();
        _tEditGrabDY = t.clientY - r.top;
        
        document.documentElement.classList.add('dragging-active');

        // Create ghost clone of the .ci row
        _tEditGhost = ci.cloneNode(true);
        const originalInput = ci.querySelector('input[type="text"]');
        const ghostInput = _tEditGhost.querySelector('input[type="text"]');
        if(originalInput && ghostInput){ ghostInput.value = originalInput.value; }
        _tEditGhost.classList.add('dragGhost');
        _tEditGhost.classList.add('ci');
        _tEditGhost.style.width = r.width + 'px';
        _tEditGhost.style.left = r.left + 'px';
        _tEditGhost.style.top = (t.clientY - _tEditGrabDY) + 'px';
        document.body.appendChild(_tEditGhost);
        
        ci.classList.add('dragging-ci');
        ci.style.touchAction = 'none';
        
        if (typeof buzz === 'function') buzz(15);
        
        const onMove = ev => {
          if (ev.cancelable) ev.preventDefault();
          const tt = ev.touches[0];
          if (!tt) return;
          
          if (_tEditGhost) {
            _tEditGhost.style.top = (tt.clientY - _tEditGrabDY) + 'px';
          }
          
          const el = document.elementFromPoint(tt.clientX, tt.clientY);
          const over = el && el.closest('#eCheck .ci');
          if (over && over !== _tEditDrag && over !== _tEditGhost) {
            const rr = over.getBoundingClientRect();
            const after = (tt.clientY - rr.top) / rr.height > 0.5;
            
            // Reorder in DOM
            over.parentNode.insertBefore(_tEditDrag, after ? over.nextSibling : over);
          }
        };
        
        const onEnd = () => {
          handle.removeEventListener('touchmove', onMove);
          window.removeEventListener('touchend', onEnd);
          window.removeEventListener('touchcancel', onEnd);
          
          if (_tEditActive) {
            commitEditChecklistOrder();
            resetEditDragState();
          }
        };
        
        handle.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
        window.addEventListener('touchcancel', onEnd);
      }, { passive: true });
    }
  });
}

function commitEditChecklistOrder(){
  const currentCis = [...document.querySelectorAll('#eCheck .ci')];
  const newChecklist = [];
  currentCis.forEach(ci => {
    const idx = parseInt(ci.dataset.idx, 10);
    const inp = ci.querySelector('input[type=text]');
    if (EDIT.checklist[idx]) {
      const item = EDIT.checklist[idx];
      item.text = inp ? inp.value : item.text;
      newChecklist.push(item);
    }
  });

  EDIT.checklist = newChecklist;
  drawSheet();
}

function resetEditDragState() {
  document.documentElement.classList.remove('dragging-active');
  if (_tEditGhost) { _tEditGhost.remove(); _tEditGhost = null; }
  if (_tEditDrag) {
    _tEditDrag.style.touchAction = '';
    _tEditDrag.classList.remove('dragging-ci');
    _tEditDrag = null;
  }
  _tEditActive = false;
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
function toggle(id, ev){
  const t=S.tasks.find(x=>x.id===id); if(!t)return;
  if(t.type==='daily'){
    if(t.done){ uncompleteDaily(t); return; }
    if(!isDailyDueToday(t)){ toast('Not due until '+nextDueWeekday(t)); return; }
    completeTask(t, ev);
  }
  else if(t.type==='todo'){ t.done? uncompleteTodo(t) : completeTask(t, ev); }
  else { completeTask(t, ev); }
}
function openEdit(id,type){
  const t = id? S.tasks.find(x=>x.id===id)
    : {id:null,type:type||'todo',title:'',notes:'',difficulty:'easy',value:0,done:false,
       checklist:[],repeat:[true,true,true,true,true,true,true],up:true,down:true,resetFreq:'daily',tags:[]};
  EDIT = JSON.parse(JSON.stringify(t));
  const hasRem = EDIT.reminders && EDIT.reminders[0] && EDIT.reminders[0].enabled;
  EDIT._reminderEnabled = hasRem;
  if (hasRem) {
    EDIT._tempReminderTime = EDIT.reminders[0].time;
    EDIT._tempReminderDate = EDIT.reminders[0].date || new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0') + '-' + String(new Date().getDate()).padStart(2,'0');
    EDIT._tempReminderDays = EDIT.reminders[0].days || [true,true,true,true,true,true,true];
  } else {
    EDIT._tempReminderTime = "09:00";
    EDIT._tempReminderDate = new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0') + '-' + String(new Date().getDate()).padStart(2,'0');
    EDIT._tempReminderDays = [true,true,true,true,true,true,true];
  }
  drawSheet();
  document.getElementById('scrim').classList.add('show');
}
function drawReminderEditor(t) {
  const dayLabels = ['S','M','T','W','T','F','S'];
  const hasRem = t._reminderEnabled;
  let h = '<label>Reminder</label>';
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
  h += '<input type="checkbox" id="eReminderEnabled" ' + (hasRem ? 'checked' : '') + ' onclick="EDIT._reminderEnabled=this.checked;drawSheet()" style="width:auto;margin:0;cursor:pointer">';
  h += '<label for="eReminderEnabled" style="margin:0;cursor:pointer;font-weight:normal">Enable notification reminder</label>';
  h += '</div>';
  
  if (hasRem) {
    h += '<div id="eReminderControls" style="border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--panel);margin-bottom:12px">';
    
    // Time picker
    h += '<div style="display:flex;gap:12px;align-items:center;margin-bottom:8px">';
    h += '<label style="margin:0;white-space:nowrap;font-size:12px;width:60px">Time</label>';
    h += '<input type="time" id="eReminderTime" value="' + (t._tempReminderTime || '09:00') + '" onchange="EDIT._tempReminderTime=this.value" style="margin:0;flex:1">';
    h += '</div>';
    
    if (t.type === 'todo') {
      // Date picker for to-dos
      h += '<div style="display:flex;gap:12px;align-items:center">';
      h += '<label style="margin:0;white-space:nowrap;font-size:12px;width:60px">Date</label>';
      h += '<input type="date" id="eReminderDate" value="' + (t._tempReminderDate || '') + '" onchange="EDIT._tempReminderDate=this.value" style="margin:0;flex:1">';
      h += '</div>';
    } else if (t.type === 'habit') {
      // Day selector for habits
      h += '<label style="margin:0 0 6px 0;font-size:12px">Repeat reminder on</label>';
      h += '<div class="days" id="eReminderDays" style="margin-top:4px">';
      h += dayLabels.map((d, i) => {
        const active = t._tempReminderDays && t._tempReminderDays[i];
        return '<button type="button" style="border:1px solid var(--line);border-radius:8px;background:' + (active ? 'var(--panel2)' : 'var(--panel)') + ';color:var(--ink);cursor:pointer;padding:6px;font-size:11px" onclick="EDIT._tempReminderDays[' + i + ']=!EDIT._tempReminderDays[' + i + '];drawSheet()">' + d + '</button>';
      }).join('');
      h += '</div>';
    } else if (t.type === 'daily') {
      // Display info for dailies
      const activeDays = t.repeat.map((r, i) => r ? dayLabels[i] : '').filter(Boolean).join(', ');
      h += '<div class="small" style="margin-top:6px;color:var(--muted)">Reminder repeats on daily\'s repeat schedule: <b>' + (activeDays || 'Never') + '</b></div>';
    }
    
    h += '</div>';
  }
  return h;
}

function drawSheet(){
  const t=EDIT; const dayLabels=['S','M','T','W','T','F','S'];
  const sheet=document.getElementById('sheet');
  let h='<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">'+
     '<h3 style="margin:0">'+(t.id?'Edit':'New')+' '+(t.type==='daily'?'Daily':t.type==='habit'?'Habit':'To-Do')+'</h3>';
  if(S.prefs.saveBtnTop){
    h+='<button class="btn primary" type="button" onclick="saveTask()" style="padding:6px 14px;height:auto">Save</button>';
  }
  h+='<button type="button" onclick="pasteEditTask()" title="Paste title, checklist & notes" style="background:none;border:none;cursor:pointer;font-size:14px;opacity:0.3;padding:0 4px;line-height:1;color:inherit">📋</button>';
  h+='<button type="button" onclick="copyEditTask()" title="Copy title, checklist & notes" style="background:none;border:none;cursor:pointer;font-size:14px;opacity:0.3;padding:0 4px;line-height:1;color:inherit">⧉</button></div>';
  h+='<label>Title</label><input type="text" id="eTitle" value="'+esc(t.title)+'" placeholder="What needs doing?">';
  const diffOpts = t.type==='habit' ? ['trivial','easy','medium','hard','log'] : ['trivial','easy','medium','hard'];
  h+='<label>Difficulty</label><div class="seg" id="eDiff">'+
    diffOpts.map(d=>'<button class="'+(t.difficulty===d?'on':'')+'" onclick="EDIT.difficulty=\''+d+'\';drawSheet()">'+d+'</button>').join('')+'</div>';
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
        '<button onclick="adjustCount(-1,1)">−</button>'+
        '<button onclick="adjustCount(1,1)">+</button></div>'+
      '<div class="adj"><span>− '+(t.cDown||0)+'</span>'+
        '<button onclick="adjustCount(-1,-1)">−</button>'+
        '<button onclick="adjustCount(1,-1)">+</button></div></div>'+
      '<div class="small" style="margin-top:6px">Adjusting the + count also adds/removes its XP &amp; gold.</div>';
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
      (t.checklist||[]).map((c,i)=>'<div class="ci" draggable="true" data-idx="'+i+'">'+
        '<div class="ci-drag-handle">☰</div>'+
        '<div class="box '+(c.done?'on':'')+'" onclick="EDIT.checklist['+i+'].done=!EDIT.checklist['+i+'].done;drawSheet()">'+(c.done?'✔':'')+'</div>'+
        '<input type="text" value="'+esc(c.text)+'" oninput="EDIT.checklist['+i+'].text=this.value">'+
        '<button class="del" onclick="EDIT.checklist.splice('+i+',1);drawSheet()">✕</button></div>').join('')+
      '<button class="btn ghost" style="padding:8px" onclick="EDIT.checklist.push({id:uid(),text:\'\',done:false});drawSheet()">+ Add subtask</button></div>';
  }
  h+=drawReminderEditor(t);
  h+='<label>Notes / comments</label><textarea id="eNotes" placeholder="Notes, thoughts, log...">'+esc(t.notes)+'</textarea>';
  h+=tagEditorBlock(t);
  h+='<div class="rowBtns">'+(t.id?'<button class="btn danger" onclick="deleteTask()">Delete</button>':'')+
    '<button class="btn ghost" onclick="closeSheet()">Cancel</button>'+
    (S.prefs.saveBtnTop?'':'<button class="btn primary" onclick="saveTask()">Save</button>')+'</div>';
  sheet.innerHTML=h;
  if(typeof enableEditChecklistDragReorder==='function') enableEditChecklistDragReorder();
}
function saveTask(){
  EDIT.title=document.getElementById('eTitle').value.trim()||'Untitled';
  EDIT.notes=document.getElementById('eNotes').value;
  document.querySelectorAll('#eCheck .ci input[type=text]').forEach((inp,i)=>{ if(EDIT.checklist[i]) EDIT.checklist[i].text=inp.value; });
  EDIT.checklist=(EDIT.checklist||[]).filter(c=>c.text.trim());
  if (EDIT._reminderEnabled) {
    const kind = EDIT.type === 'todo' ? 'once' : (EDIT.type === 'daily' ? 'daily' : 'weekly');
    const r = {
      id: EDIT.reminders && EDIT.reminders[0] ? EDIT.reminders[0].id : uid(),
      enabled: true,
      kind: kind,
      time: EDIT._tempReminderTime || '09:00',
      lastFiredKey: EDIT.reminders && EDIT.reminders[0] ? EDIT.reminders[0].lastFiredKey : ""
    };
    if (kind === 'once') {
      r.date = EDIT._tempReminderDate || new Date().getFullYear() + '-' + String(new Date().getMonth()+1).padStart(2,'0') + '-' + String(new Date().getDate()).padStart(2,'0');
    } else if (kind === 'weekly') {
      r.days = EDIT._tempReminderDays || [true,true,true,true,true,true,true];
    } else if (kind === 'daily') {
      r.days = EDIT.repeat || [true,true,true,true,true,true,true];
    }
    EDIT.reminders = [r];
  } else {
    EDIT.reminders = [];
  }
  delete EDIT._reminderEnabled;
  delete EDIT._tempReminderTime;
  delete EDIT._tempReminderDate;
  delete EDIT._tempReminderDays;
  if(EDIT.id){
    const idx=S.tasks.findIndex(x=>x.id===EDIT.id);
    const orig = S.tasks[idx];
    // F4 (2026-07-11): id-based touchedAt stamping for mergeChecklist (sync.js).
    // Independent of the index-based diff further below (that one only feeds
    // the display-only edit-history event and stays untouched).
    (function(){
      const _origById = new Map((orig.checklist||[]).filter(c=>c&&c.id!=null).map(c=>[c.id,c]));
      (EDIT.checklist||[]).forEach(c=>{
        if(!c) return;
        if(!c.id) c.id = uid(); // defensive backfill (F4 2026-07-11) — mirrors toggleSub, see .omo/plans/2026-07-11-subtask-granular-merge.md §3
        const o = _origById.get(c.id);
        if(!o || (o.text||'')!==(c.text||'') || !!o.done!==!!c.done) c.touchedAt = now();
      });
    })();
    const upDelta = (EDIT.cUp||0) - (orig.cUp||0);
    const downDelta = (EDIT.cDown||0) - (orig.cDown||0);
    S.tasks[idx]=EDIT;
    EDIT.updatedAt=now();
    const t = S.tasks[idx];
    let gainParts=null, loseParts=null, doBump=false;
    let _cXp=0,_cGold=0,_cMp=0,_cHp=0;
    if(upDelta > 0){
      let totalXp=0, totalGold=0;
      for(let i=0; i<upDelta; i++){
        const r=completionReward(t);
        totalXp+=r.xp; totalGold=+(totalGold+r.gold).toFixed(2);
        gainXp(r.xp); S.char.gold=+(S.char.gold+r.gold).toFixed(2); S.char.mp+=r.mp;
        _cXp+=r.xp; _cGold=+(_cGold+r.gold).toFixed(2); _cMp+=r.mp;
        t.value=clamp(t.value+valueDelta(t.value),-47.27,99);
      }
      gainParts=fxGain(totalXp,totalGold); doBump=true;
    } else if(upDelta < 0){
      let totalXp=0, totalGold=0;
      for(let i=0; i>upDelta; i--){
        const r=completionReward(t);
        totalXp+=r.xp; totalGold=+(totalGold+r.gold).toFixed(2);
        S.char.xp=Math.max(0,S.char.xp-r.xp);
        S.char.gold=+Math.max(0,S.char.gold-r.gold).toFixed(2);
        S.char.mp=Math.max(0,S.char.mp-r.mp);
        _cXp-=r.xp; _cGold=+(_cGold-r.gold).toFixed(2); _cMp-=r.mp;
        t.value=clamp(t.value-valueDelta(t.value),-47.27,99);
      }
      const coin='<svg class="fxCoin" viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="10" fill="#ffbe5c" stroke="#c8862f" stroke-width="1.5"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="#c8862f" stroke-width="1.2" opacity="0.7"/><text x="12" y="16" text-anchor="middle" font-size="9" font-weight="700" fill="#7a4d12" font-family="serif">$</text></svg>';
      loseParts=(loseParts?loseParts+' ':'')+'-'+totalXp+' XP '+coin+'-'+(+totalGold).toFixed(1);
    }
    if(downDelta > 0){
      let totalDmg=0;
      for(let i=0; i<downDelta; i++){
        const dmg=missDamage(t);
        totalDmg=+(totalDmg+dmg).toFixed(2);
        takeDamage(dmg);
        _cHp=+(_cHp-dmg).toFixed(2);
        t.value=clamp(t.value-valueDelta(t.value),-47.27,99);
      }
      loseParts=(loseParts?loseParts+' ':'')+'-'+totalDmg.toFixed(1)+'HP';
    } else if(downDelta < 0){
      let totalHeal=0;
      for(let i=0; i>downDelta; i--){
        const heal=missDamage(t);
        totalHeal=+(totalHeal+heal).toFixed(2);
        S.char.hp=+Math.min(S.char.maxHp,(S.char.hp+heal)).toFixed(2);
        _cHp=+(_cHp+heal).toFixed(2);
        t.value=clamp(t.value+valueDelta(t.value),-47.27,99);
      }
      gainParts=(gainParts?gainParts+' ':'')+'+'+totalHeal.toFixed(1)+'HP';
    }
    if(gainParts){ floatFx(gainParts,'pos',null); if(doBump) bumpAvatar(); }
    if(loseParts) floatFx(loseParts,'neg',null);
    if(gainParts) buzz(50);
    else if(downDelta>0) buzz(100);
    else if(upDelta<0||downDelta<0) buzz(50);
    try{
      const _ch=[];
      if((orig.title||'')!==(EDIT.title||'')) _ch.push({field:'title',from:orig.title||'',to:EDIT.title||''});
      if((orig.notes||'')!==(EDIT.notes||'')) _ch.push({field:'notes',from:orig.notes||'',to:EDIT.notes||''});
      if((orig.difficulty||'')!==(EDIT.difficulty||'')) _ch.push({field:'difficulty',from:orig.difficulty||'',to:EDIT.difficulty||''});
      const _oc=(orig&&orig.checklist)||[], _ec=(EDIT&&EDIT.checklist)||[];
      const _items=[];
      for(let _i=0;_i<Math.max(_oc.length,_ec.length);_i++){
        const _o=_oc[_i], _e=_ec[_i];
        if(_o&&_e){
          if((_o.text||'')!==(_e.text||'')) _items.push({type:'changed',from:_o.text||'',to:_e.text||''});
          else if((!!_o.done)!==(!!_e.done)) _items.push({type:'toggled',to:_e.text||'',done:!!_e.done});
        } else if(!_o&&_e){ _items.push({type:'added',to:_e.text||''}); }
        else if(_o&&!_e){ _items.push({type:'removed',from:_o.text||''}); }
      }
      if(_items.length) _ch.push({field:'checklist',items:_items});
      if(JSON.stringify(orig.repeat||[])!==JSON.stringify(EDIT.repeat||[])) _ch.push({field:'schedule'});
      if(JSON.stringify(orig.reminders||[])!==JSON.stringify(EDIT.reminders||[])) _ch.push({field:'reminders'});
      if(upDelta||downDelta) _ch.push({field:'counter'});
      if(_ch.length){
        const _ev={kind:'edit', taskType:t.type, taskId:t.id, taskTitle:t.title, changes:_ch};
        if(upDelta||downDelta) _ev.counter={xp:+(_cXp||0),gold:+(_cGold||0),mp:+(_cMp||0),hp:+(_cHp||0)};
        logEvent(_ev);
      }
    }catch(e){}
  } else {
    EDIT.id=uid(); EDIT.createdAt=Date.now(); EDIT.updatedAt=now(); S.tasks.unshift(EDIT); buzz(50);
    try{ logEvent({kind:'create', taskType:EDIT.type, taskId:EDIT.id, taskTitle:EDIT.title}); }catch(e){}
    setTimeout(() => window.scrollTo({top:0, behavior:'smooth'}), 50);
  }
  closeSheet(); save(); render();
}
function copyEditTask(){
  const title = (document.getElementById('eTitle')||{}).value ?? EDIT.title ?? '';
  const notes = (document.getElementById('eNotes')||{}).value ?? EDIT.notes ?? '';
  const cl = (EDIT.checklist||[]).filter(c=>c && (c.text||'').trim());
  let text = title;
  if(cl.length > 0){
    text += '\n\nChecklist:\n' + cl.map(c => '- [' + (c.done ? 'x' : ' ') + '] ' + c.text).join('\n');
  }
  if(notes.trim()){
    text += '\n\nNotes:\n' + notes;
  }
  function copyToClipboard(t){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(() => toast('Copied')).catch(() => fallbackCopy(t));
    } else { fallbackCopy(t); }
  }
  function fallbackCopy(t){
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch(e) { toast('Copy failed'); }
    document.body.removeChild(ta);
  }
  copyToClipboard(text);
}
async function pasteEditTask(){
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    toast('Clipboard paste is blocked or unsupported in this browser');
    return;
  }
  let text = '';
  let clipboardWorked = false;
  try {
    if (document.body) document.body.focus();
    if (window.focus) window.focus();
    text = (await navigator.clipboard.readText()).trim();
    clipboardWorked = true;
  } catch (err) {
    text = '';
  }
  if (text) {
    applyPaste(text);
    return;
  }
  if (clipboardWorked) {
    toast('Clipboard is empty');
    return;
  }
  const ta = document.createElement('textarea');
  ta.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:90%;max-width:600px;height:300px;z-index:999999;opacity:1;font-size:16px;padding:16px;box-sizing:border-box;background:#fff;border:3px solid #5b3a86;border-radius:12px;outline:none;resize:none;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
  document.body.appendChild(ta);
  ta.focus();
  ta.placeholder = 'Paste task text here (Ctrl+V), then press Enter...';
  toast('Paste into the box, then press Enter');
  const finish = () => {
    ta.removeEventListener('keydown', onKey);
    ta.removeEventListener('paste', onPaste);
    if (ta.parentNode) document.body.removeChild(ta);
    const v = ta.value.trim();
    if (v) applyPaste(v);
    else toast('Paste cancelled');
  };
  const onPaste = () => setTimeout(() => {
    ta.removeEventListener('keydown', onKey);
    ta.removeEventListener('paste', onPaste);
    if (ta.parentNode) document.body.removeChild(ta);
    const v = ta.value.trim();
    if (v) applyPaste(v);
    else toast('Paste cancelled');
  }, 100);
  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish();
    }
    if (e.key === 'Escape') {
      ta.removeEventListener('keydown', onKey);
      ta.removeEventListener('paste', onPaste);
      if (ta.parentNode) document.body.removeChild(ta);
      toast('Paste cancelled');
    }
  };
  ta.addEventListener('paste', onPaste);
  ta.addEventListener('keydown', onKey);
}
function legacyPaste(){
  const ta = document.createElement('textarea');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const ok = document.execCommand('paste');
    if (!ok) return null;
    return ta.value;
  } catch (e) {
    return null;
  } finally {
    document.body.removeChild(ta);
  }
}
function applyPaste(text){
  const lines = text.split(/\r?\n/);
  if (lines.length === 1) {
    EDIT.title = text;
    const titleInp = document.getElementById('eTitle');
    if (titleInp) titleInp.value = text;
    toast('Title pasted');
    return;
  }
  let titleLines = [];
  let checklistItems = [];
  let notesLines = [];
  let parseMode = 'title';
  let hasChecklistMarker = false;
  let hasNotesMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === 'Checklist:') {
      hasChecklistMarker = true;
      parseMode = 'checklist';
      continue;
    } else if (trimmed === 'Notes:') {
      hasNotesMarker = true;
      parseMode = 'notes';
      continue;
    }
    if (parseMode === 'title') {
      titleLines.push(line);
    } else if (parseMode === 'checklist') {
      const match = line.match(/^\s*-\s*\[([ xX]?)\]\s*(.*)$/);
      if (match) {
        const done = match[1].toLowerCase() === 'x';
        checklistItems.push({ id: uid(), text: match[2].trim(), done: done });
      } else if (trimmed !== '') {
        checklistItems.push({ id: uid(), text: trimmed, done: false });
      }
    } else if (parseMode === 'notes') {
      notesLines.push(line);
    }
  }
  if (!hasChecklistMarker && checklistItems.length === 0) {
    const firstSubtaskIdx = lines.findIndex(l => /^\s*-\s*\[([ xX]?)\]/.test(l) || /^\s*-\s/.test(l));
    if (firstSubtaskIdx > 0) {
      titleLines = lines.slice(0, firstSubtaskIdx);
      for (let i = firstSubtaskIdx; i < lines.length; i++) {
        const l = lines[i];
        const t = l.trim();
        if (t === 'Notes:') {
          hasNotesMarker = true;
          notesLines = lines.slice(i + 1);
          break;
        }
        const match = l.match(/^\s*-\s*\[([ xX]?)\]\s*(.*)$/);
        if (match) {
          const done = match[1].toLowerCase() === 'x';
          checklistItems.push({ id: uid(), text: match[2].trim(), done: done });
        } else if (t !== '') {
          checklistItems.push({ id: uid(), text: t, done: false });
        }
      }
    }
  }
  const parsedTitle = titleLines.join(' ').trim();
  if (parsedTitle) EDIT.title = parsedTitle;
  if (checklistItems.length > 0) EDIT.checklist = checklistItems;
  const parsedNotes = notesLines.join('\n').trim();
  if (parsedNotes) EDIT.notes = parsedNotes;
  drawSheet();
  toast('Task pasted');
}
function deleteTask(){
  confirmDialog('Delete Task', 'Delete this task?').then(ok => {
    if(!ok) return;
    const _dt=S.tasks.find(x=>x.id===EDIT.id);
    delMark(EDIT.id); S.tasks=S.tasks.filter(x=>x.id!==EDIT.id);
    if(_dt) try{ logEvent({kind:'delete', taskType:_dt.type, taskId:_dt.id, taskTitle:_dt.title}); }catch(e){}
    closeSheet(); save(); render();
  });
}
function closeSheet(){ document.getElementById('scrim').classList.remove('show'); EDIT=null; if(VDRAFT){ VDRAFT=null; MEDIT=null; MBUILD=false; if(TAB==='analytics') refreshAnalytics(); } }
let REDIT=null;
function openReward(id){
  REDIT = id? JSON.parse(JSON.stringify(S.rewards.find(r=>r.id===id))) : {id:null,title:'',cost:10,notes:''};
  const sheet=document.getElementById('sheet');
  let h='';
  if(S.prefs.saveBtnTop){
    h+='<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">'+
       '<h3 style="margin:0">'+(REDIT.id?'Edit':'New')+' Reward</h3>'+
       '<button class="btn primary" type="button" onclick="saveReward()" style="padding:6px 14px;height:auto">Save</button></div>';
  } else {
    h+='<h3>'+(REDIT.id?'Edit':'New')+' Reward</h3>';
  }
  h+='<label>Reward</label><input type="text" id="rTitle" value="'+esc(REDIT.title)+'" placeholder="e.g. 30 min of gaming">'+
    '<label>Cost (gold)</label><input type="text" id="rCost" value="'+REDIT.cost+'">'+
    '<label>Notes</label><textarea id="rNotes">'+esc(REDIT.notes)+'</textarea>'+
    '<div class="rowBtns">'+(REDIT.id?'<button class="btn danger" onclick="delReward()">Delete</button>':'')+
    '<button class="btn ghost" onclick="closeSheet()">Cancel</button>'+
    (S.prefs.saveBtnTop?'':'<button class="btn primary" onclick="saveReward()">Save</button>')+'</div>';
  sheet.innerHTML=h;
  document.getElementById('scrim').classList.add('show');
}
function saveReward(){
  REDIT.title=document.getElementById('rTitle').value.trim()||'Reward';
  REDIT.cost=Math.max(0,parseFloat(document.getElementById('rCost').value)||0);
  REDIT.notes=document.getElementById('rNotes').value;
  REDIT.updatedAt=now();
  const _rwNew=!REDIT.id;
  if(REDIT.id){ const i=S.rewards.findIndex(r=>r.id===REDIT.id); S.rewards[i]=REDIT; }
  else { REDIT.id=uid(); REDIT.createdAt=Date.now(); S.rewards.push(REDIT); }
  try{ logEvent({kind:_rwNew?'rewardCreate':'rewardEdit', rewardId:REDIT.id, taskTitle:REDIT.title, cost:REDIT.cost}); }catch(e){}
  closeSheet(); save(); render();
}
function delReward(){ try{ logEvent({kind:'rewardDelete', rewardId:REDIT.id, taskTitle:REDIT.title, cost:REDIT.cost}); }catch(e){} delMark(REDIT.id); S.rewards=S.rewards.filter(r=>r.id!==REDIT.id); closeSheet(); save(); render(); }
function buyReward(id){
  const r=S.rewards.find(x=>x.id===id); if(!r)return;
  if(S.char.gold < r.cost){ toast('Not enough gold'); return; }
  S.char.gold=+(S.char.gold-r.cost).toFixed(2);
  try{ logEvent({kind:'purchase', taskTitle:r.title, cost:r.cost}); }catch(e){}
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
  try{ logEvent({kind:'purchase', taskTitle:item.title, cost:item.cost, effect:item.desc}); }catch(e){}
  save(); render();
}
// Small "ⓘ" info icon that surfaces a tooltip (reuses the hoverTip system via
// data-tip; call bindTips('.infoTip') after injecting the markup). First line of
// the tip is the bold title, the rest is the body.
function infoIcon(tip){
  return '<span class="infoTip" tabindex="0" role="img" aria-label="More info" data-tip="'+esc(tip)+'">&#9432;</span>';
}
function openSettings(){
  const sheet=document.getElementById('sheet');
  // Fix 4 (plan §4): a background sync can trigger render()/openSettings() while
  // the user is mid-edit in the device-name field. Capture the in-progress value
  // so a re-render doesn't discard typed text before the field's onchange fires.
  const _dnEl = document.getElementById('setDeviceName');
  const _dnFocused = !!(_dnEl && document.activeElement===_dnEl);
  const _dnVal = _dnFocused ? _dnEl.value : null;
  let h='<div class="settingsHead"><h3>Settings</h3><button class="btn primary" type="button" onclick="closeSheet()">Close</button></div>';
  const avatarTip='Avatar\nType an emoji, or upload a PNG, JPEG or GIF (max 1 MB) to use as your avatar. An uploaded image takes priority over the emoji.';
  h+='<div class="charAvatarRow">'+
       '<div class="caCol caName">'+
         '<div class="caLabelRow"><label>Character name</label></div>'+
         '<input type="text" id="setName" value="'+esc(S.char.name)+'" onchange="setCharName(this.value)">'+
       '</div>'+
       '<div class="caCol caAvatar">'+
         '<div class="caLabelRow">'+
           '<label id="avatarLbl">Avatar</label>'+
           '<div class="caLabelActions">'+
             (S.char.faceImg?'<a href="#" class="caRemove" onclick="removeFace();return false">Remove</a>':'')+
             infoIcon(avatarTip)+
           '</div>'+
         '</div>'+
         '<div class="caAvatarCtl">'+
           '<input type="text" id="setFace" class="caFace" value="'+esc(S.char.face)+'" maxlength="2" placeholder="emoji" onchange="setCharFace(this.value)">'+
           '<div class="browseGroup">'+
             '<button class="btn ghost" type="button" onclick="document.getElementById(\'faceFile\').click()">Browse image</button>'+
           '</div>'+
         '</div>'+
       '</div>'+
     '</div>';
  h+='<input type="file" id="faceFile" accept="image/jpeg,image/png,image/gif,.jpg,.jpeg,.png,.gif" style="display:none" onchange="uploadFace(event)">';

  // Display preferences as tappable rows; each opens a foreground options menu (openOpt).
  const widthLabels={430:'Slim',560:'Medium',720:'Wide',3000:'Full'};
  const wv=(S.prefs.width||480);
  const nl=(S.prefs.notesLines==null?3:S.prefs.notesLines);
  h+='<div class="setList">';
  h+=settingRow('width','Width','Caps the width on a monitor and keeps it centered.',(widthLabels[wv]||'Custom'));
  h+=settingRow('notes','Note lines','Lines of a task\'s notes shown in the list preview.',(nl===0?'Off':(''+nl)));
  h+=settingRow('haptics','Haptics','Vibration on taps and completions.',(S.prefs.haptics===false?'Off':'On'));
  h+=settingRow('cardThick','Card thickness','Minimum height of each card. Short cards grow first; taller cards are only affected at higher values.',(S.prefs.cardThick||0)===0?'Default':('+'+(S.prefs.cardThick||0)+' px'));
  h+=settingRow('saveBtnTop','Save button position','Put the Save button at the top of the edit sheet, centered next to the title, instead of at the bottom.',(S.prefs.saveBtnTop?'Top':'Bottom'));
  h+=settingRow('notifications','Notifications','Browser-based notification permission and status.',(S.prefs.notificationsEnabled?'On':'Off'));
  h+='</div>';
  const syncTip='Sync via Dropbox (your account, no server) keeps this device and your other devices up to date automatically.';
  h+='<div class="colTitle"><h2 style="font-size:13px;flex:none">Sync</h2>'+infoIcon('Sync\n'+syncTip)+'</div>';
  if(typeof syncCfg==="function"){
    const scfg=syncCfg();
    if(!scfg.enabled){
      h+='<div class="settingsRow" style="display:flex;gap:8px;">'+
             '<button class="btn ghost" style="flex:1;" onclick="syncConnect()">Connect Dropbox</button>'+
             '<button class="btn danger" style="flex:1;" onclick="confirmConnectForForcePush()">Connect &amp; Force Push</button>'+
           '</div>';
    } else {
      const rel=(typeof syncRelativeTime==="function")?syncRelativeTime(scfg.lastSyncAt):(scfg.lastSyncAt?new Date(scfg.lastSyncAt).toLocaleString():'never');
      const devId=scfg.deviceId||'';
      const devShort=devId.slice(0,6);
      const myDevEntry=(S.devices||[]).find(x=>x&&x.id===devId);
      const myDevName=(myDevEntry&&myDevEntry.name)?myDevEntry.name:'';
      const myDevLabel=(typeof deviceDisplayName==="function")?deviceDisplayName(S.devices,devId):(myDevName||devShort);
      h+='<div class="devNameWrap">'+
           '<div class="devNameHeader">'+
              '<div class="devSyncStatus">Last sync: '+esc(rel)+
               (scfg.lastError?(' &middot; <span style="color:#f74e52">'+esc(scfg.lastError)+'</span>'):'')+'</div>'+
             '<label class="devNameLbl">Device name</label>'+
             '<div></div>'+
           '</div>'+
           '<div class="devNameRow">'+
             '<button class="btn ghost" onclick="syncNow()">Sync now</button>'+
             '<input type="text" id="setDeviceName" placeholder="'+esc(devShort)+'" value="'+esc(myDevName)+'" onchange="setDeviceName(this.value)">'+
              '<div class="devDisconnectCol">'+
             '<div class="devDisconnectLbl">Device '+esc(myDevLabel)+'</div>'+
             '<button class="btn ghost" onclick="confirmSyncDisconnect()">Disconnect</button>'+
              '</div>'+
           '</div>'+
         '</div>';
      if(typeof confirmForcePush==="function" || typeof confirmForcePull==="function"){
        h+='<div class="settingsRow">'+
           (typeof confirmForcePush==="function"?'<button class="btn danger" onclick="confirmForcePush()">Force push</button>':'')+
           (typeof confirmForcePull==="function"?'<button class="btn danger" onclick="confirmForcePull()">Force pull</button>':'')+
           '</div>';
      }
      const _eid=(S.prefs.exportIntervalDays||0);
      h+='<div class="setList">'+settingRow('exportInterval','Auto-backup to Dropbox','Uploads a full backup file (same as Export) on this schedule, in addition to normal sync.',(_eid?('every '+_eid+'d'):'Off'))+'</div>';
    }
  } else {
    h+='<div class="small">Sync module not loaded.</div>';
  }
  h+='<div class="colTitle"><h2 style="font-size:13px;flex:none">Backup &amp; transfer</h2>'+infoIcon('Backup & transfer\nYour progress lives only on this device. Export a file to back up or move to another phone, then import it there to continue. Export now includes your full event log (subtask/tap/completion history), so one file is a complete backup.')+'</div>';
  h+='<div class="settingsRow"><button class="btn ghost" onclick="exportData()">Export</button>'+
    '<button class="btn ghost" onclick="document.getElementById(\'importFile\').click()">Import</button>'+
    '<button class="btn ghost" onclick="openRestorePicker()">Restore Snapshot</button></div>';
  h+='<input type="file" id="importFile" accept="application/json,.json,text/plain,.txt" style="display:none" onchange="importData(event)">';
  h+='<div class="backupMeta small"><span id="lastFullBackupDate"></span><span id="lastExportDate"></span></div>';
  h+='<div class="resetRow"><button class="btn resetMini" onclick="resetEverything()">Reset everything</button><div class="appVersion" onclick="tapVersionDebug()">'+APP_VERSION+'</div></div>';
  if(IS_DIRTY){
    _flushPromise = takeSnapshot().then(id => { if(id) IS_DIRTY=false; }).finally(()=>{ _flushPromise=null; });
  }
  sheet.innerHTML=h;
  if(_dnFocused){
    const _newDn = document.getElementById('setDeviceName');
    if(_newDn){ _newDn.value = _dnVal; _newDn.focus(); }
  }
  bindTips('.infoTip');
  setTimeout(() => updateLastFullBackupText(), 100);
  setTimeout(() => updateLastExportText(), 100);
  checkExportStaleness();
  document.getElementById('scrim').classList.add('show');
  // Measured AFTER the scrim gets display:flex (was display:none until here) --
  // offsetWidth on a display:none ancestor tree is always 0, which previously
  // collapsed this box to just its CSS padding/border (~20px). Must measure
  // once the sheet is actually laid out.
  const _al=document.getElementById('avatarLbl');
  const _fi=document.getElementById('setFace');
  if(_al&&_fi) _fi.style.width=(_al.offsetWidth+6)+'px';
}
function checkExportStaleness(){
  const btn = document.getElementById('gearBtn');
  if(!btn) return;
  const lastExport = S.prefs.lastExportTs;
  if(!lastExport || (Date.now() - lastExport) > 7*86400000){
    btn.classList.add('stale');
  } else {
    btn.classList.remove('stale');
  }
}
function resetEverything() {
  confirmDialog('Reset Everything', 'Erase ALL progress on this device? This cannot be undone.').then(ok => {
    if(!ok) return;
    // #2 this-device-only reset: disconnect sync, wipe IDB syncmeta base +
    // state mirror, reset __seq so the fresh state starts at seq 1 after
    // save(). NO tombstone-all, NO destructive propagation to other devices.
    // Reconnecting later pulls the world back via keep-by-default merge.
    if(typeof syncDisconnect==='function') syncDisconnect();
    if(typeof syncBasePut==='function') syncBasePut(null);
    if(typeof _idbWriteState==='function') _idbWriteState(null).catch(function(){});
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(STORE_KEY + ".seq");
    // 2026-07-13: dropped the dead `S.__seq = 0` line — it mutated the OLD S
    // one line before S = freshState() discards it entirely; freshState()
    // has no __seq field, so save()'s (S.__seq||0)+1 yields 1 regardless.
    S = freshState();
    save();
    applyWidth();
    applyCardThick();
    closeSheet();
    render();
  });
}
// Tooltip delay is fixed at Instant (0); the user-facing control was removed.
function setWidth(px){ S.prefs.width=px; applyWidth(); save(); closeOpt(); openSettings(); }
function setNotesLines(n){ S.prefs.notesLines=n; save(); closeOpt(); openSettings(); }
function setHaptics(n){ S.prefs.haptics=!!n; save(); closeOpt(); openSettings(); }
function setCardThick(px){ let n=parseInt(px,10); if(!isFinite(n)) n=0; n=Math.min(60,Math.max(0,n)); S.prefs.cardThick=n; applyCardThick(); save(); closeOpt(); openSettings(); }
function setSaveBtnTop(n){ S.prefs.saveBtnTop=!!n; save(); closeOpt(); if(EDIT) drawSheet(); else if(REDIT) openReward(REDIT.id); openSettings(); }
function setExportIntervalDays(n){ let d=parseInt(n,10); if(!isFinite(d)||d<0) d=0; S.prefs.exportIntervalDays=d; save(); closeOpt(); openSettings(); }
function setCharName(v){ S.char.name=(v||'').trim()||'Adventurer'; save(); renderStats(); }
function setDeviceName(v){
  if(typeof syncDeviceId!=="function") return;
  const devId=syncDeviceId();
  const name=(v||'').trim();
  S.devices=Array.isArray(S.devices)?S.devices:[];
  let d=S.devices.find(x=>x&&x.id===devId);
  const prevName=d?(d.name||''):'';
  // No real change (e.g. blur without editing, or clearing a name that was
  // never set) — bail WITHOUT creating a junk {name:'',updatedAt:0} placeholder.
  // Fix: run the no-op check BEFORE pushing any placeholder so a stray empty
  // onchange/blur can never manufacture a blank entry that later sync-clobbers
  // a real name on another device (plan §3D).
  if(prevName===name) return;
  if(!d){
    if(!name) return; // clearing a name that doesn't exist yet — nothing to do
    d={id:devId,name:'',updatedAt:0};
    S.devices.push(d);
  }
  d.name=name;
  d.updatedAt=now();
  save();
  logEvent({kind:'devicename', taskTitle:'Device name',
    notes:'Device '+devId.slice(0,6)+' \u2192 "'+(name||'(cleared)')+'"'+(prevName?' (was "'+prevName+'")':''),
    deviceId:devId, deviceName:name, prevDeviceName:prevName});
  openSettings();
}
function setCharFace(v){ S.char.face=(v||'🧙'); save(); renderStats(); }
// --- Settings rows + foreground options menu -------------------------------
// Build one tappable row: a label + short description on the left, current
// value + chevron on the right. Tapping opens the matching options menu.
function settingRow(key,label,desc,val){
  return '<button class="setItem" type="button" onclick="openOpt(\''+key+'\')">'+
    '<span class="setLabel">'+esc(label)+'</span>'+
    '<span class="setVal">'+esc(val)+'<span class="chev">\u203a</span></span></button>';
}
function closeOpt(){ document.getElementById('optScrim').classList.remove('show'); document.getElementById('optMenu').innerHTML=''; }
function setNotificationsPref(enabled){
  S.prefs.notificationsEnabled = !!enabled;
  save();
  openSettings();
  openOpt('notifications');
}
function requestNotificationPermission(){
  if(!('Notification' in window)){
    toast('Notifications not supported by this browser');
    return;
  }
  Notification.requestPermission().then(perm=>{
    if(perm==='granted'){
      toast('Permission granted!');
      setNotificationsPref(true);
    } else {
      toast('Permission: '+perm);
      setNotificationsPref(false);
    }
  }).catch(()=>{
    toast('Permission request failed');
  });
}
function testNotification(){
  if(typeof Notification==='undefined' || Notification.permission!=='granted'){
    toast('Notification permission not granted');
    return;
  }
  if(navigator.serviceWorker && navigator.serviceWorker.controller){
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      title: 'Questa Test',
      body: 'Notifications are working! ⚔️',
      tag: 'questa-test'
    });
  } else {
    new Notification('Questa Test', { body: 'Notifications are working! ⚔️' });
  }
  toast('Test notification sent');
}
// Render the foreground menu for a given setting key over a dim backdrop.
function openOpt(key){
  let h='';
  if(key==='width'){
    const wv=(S.prefs.width||480);
    h+='<h4>Interface width</h4>';
    h+='<p class="optHint">On a phone it always fills the screen. This caps the width on a monitor and keeps it centered.</p>';
    h+='<div class="optChoices">'+
      [['Slim',430],['Medium',560],['Wide',720],['Full',3000]].map(o=>
        '<button type="button" class="'+(wv===o[1]?'on':'')+'" onclick="setWidth('+o[1]+')"><span>'+o[0]+'</span></button>').join('')+
      '</div>';
  } else if(key==='notes'){
    const nl=(S.prefs.notesLines==null?3:S.prefs.notesLines);
    h+='<h4>Note lines on cards</h4>';
    h+='<p class="optHint">How many lines of a task\'s notes preview on the list (default 3, like Habitica).</p>';
    h+='<div class="optChoices">'+
      [['Off',0],['1 line',1],['2 lines',2],['3 lines',3],['5 lines',5]].map(o=>
        '<button type="button" class="'+(nl===o[1]?'on':'')+'" onclick="setNotesLines('+o[1]+')"><span>'+o[0]+'</span></button>').join('')+
      '</div>';
  } else if(key==='notifications'){
    const ne=S.prefs.notificationsEnabled;
    const perm=typeof Notification!=='undefined'?Notification.permission:'default';
    h+='<h4>Notifications</h4>';
    h+='<p class="optHint">Browser-based persistent local reminders for habits, dailies, and to-dos. On Android, requires Chrome/Firefox to be installed as a PWA.</p>';
    h+='<div class="optChoices">';
    h+='<button type="button" class="'+(ne?'on':'')+'" onclick="setNotificationsPref(true)">On</button>';
    h+='<button type="button" class="'+(ne?'':'on')+'" onclick="setNotificationsPref(false)">Off</button>';
    h+='</div>';
    h+='<p class="optHint" style="margin-top:8px">System Permission: <b>'+perm+'</b></p>';
    if(perm!=='granted'){
      h+='<button type="button" class="btn primary" style="margin-top:10px;width:100%" onclick="requestNotificationPermission()">Request Permission</button>';
    } else {
      h+='<button type="button" class="btn ghost" style="margin-top:10px;width:100%" onclick="testNotification()">Send Test Notification</button>';
    }
  } else if(key==='drag'){
    const ddv=(S.prefs.dragDelay==null?DRAG_DELAY_DEFAULT:Math.min(300,Math.max(100,S.prefs.dragDelay)));
    h+='<h4>Card drag delay</h4>';
    h+='<p class="optHint">How long to hold a card still before it lifts for reordering on touch (default 100\u00a0ms). Lower = quicker pickup; higher values can make the card freeze while the page scrolls on some phones.</p>';
    h+='<div class="optSlide">'+
      '<div class="sVal"><span id="ddVal">'+ddv+'</span> ms</div>'+
      '<input type="range" id="ddRange" min="100" max="300" step="10" value="'+ddv+'" '+
        'oninput="document.getElementById(\'ddVal\').textContent=this.value" '+
        'onchange="setDragDelay(this.value)">'+
      '<div class="sEnds"><span>100</span><span>300</span></div>'+
      '</div>';
  } else if(key==='cardThick'){
    const cp=(S.prefs.cardThick==null?0:Math.min(60,Math.max(0,S.prefs.cardThick)));
    h+='<h4>Card thickness</h4>';
    h+='<p class="optHint">Minimum height of each card. Short cards grow first; taller cards (with streaks, counters) are only affected at higher values.</p>';
    h+='<div class="optSlide">'+
      '<div class="sVal"><span id="cpVal">'+(cp===0?'Default':('+'+cp+' px'))+'</span></div>'+
      '<input type="range" id="cpRange" min="0" max="60" step="1" value="'+cp+'" '+
        'oninput="S.prefs.cardThick=+this.value;applyCardThick();document.getElementById(\'cpVal\').textContent=(this.value===\'0\'?\'Default\':(\'+\'+this.value+\' px\'))" '+
        'onchange="setCardThick(+this.value)">'+
      '<div class="sEnds"><span>Default</span><span>+60 px</span></div>'+
      '</div>';
    h+='<button type="button" class="btn ghost" style="margin-top:10px" onclick="setCardThick(0)">Reset to default</button>';
  }
  if(key==='saveBtnTop'){
    const sv=S.prefs.saveBtnTop;
    h+='<h4>Save button position</h4>';
    h+='<p class="optHint">Where the Save button sits in the edit sheet. "Top" centers it next to the title ("Edit To-Do" / "Edit Daily" / "Edit Habit"); "Bottom" keeps it at the foot of the sheet next to Cancel.</p>';
    h+='<div class="optChoices">';
    h+='<button type="button" class="'+(sv?'on':'')+'" onclick="setSaveBtnTop(true)">Top</button>';
    h+='<button type="button" class="'+(sv?'':'on')+'" onclick="setSaveBtnTop(false)">Bottom</button>';
    h+='</div>';
  } else if(key==='exportInterval'){
    const eid=(S.prefs.exportIntervalDays||0);
    h+='<h4>Auto-backup to Dropbox</h4>';
    h+='<p class="optHint">Uploads a full backup file (the same one Settings \u2192 Export produces \u2014 everything, including your device settings) to Dropbox on this schedule, on top of normal sync. Off by default.</p>';
    h+='<div class="optChoices">'+
      [['Off',0],['Daily',1],['Every 3 days',3],['Weekly',7],['Every 2 weeks',14],['Monthly',30]].map(o=>
        '<button type="button" class="'+(eid===o[1]?'on':'')+'" onclick="setExportIntervalDays('+o[1]+')"><span>'+o[0]+'</span></button>').join('')+
      '</div>';
  }
  if(key==='haptics'){
    const hv=S.prefs.haptics!==false;
    h+='<h4>Haptics</h4>';
    h+='<p class="optHint">Vibration feedback when you tap buttons, check tasks, and complete dailies. Requires device support.</p>';
    h+='<div class="optChoices">';
    h+='<button type="button" class="'+(hv?'on':'')+'" onclick="setHaptics(1)">On</button>';
    h+='<button type="button" class="'+(hv?'':'on')+'" onclick="setHaptics(0)">Off</button>';
    h+='</div>';
    h+='<p class="optHint" style="margin-top:8px">If buzz() returns "accepted" but no vibration is felt: Android DND / Silent mode suppresses vibration silently. The API has no way to detect this.</p>';
    var _bd=getBuzzDiag();
    h+='<div class="small" style="margin-top:6px">API: <b>'+_bd.type+'</b> &middot; Last: <b>'+( _bd.lastResult===null?'(none)':''+_bd.lastResult)+'</b> &middot; Count: <b>'+_bd.count+'</b></div>';
    h+='<button type="button" class="btn ghost" style="margin-top:10px" onclick="var r=buzz(50);toast(\'Vibrate returned: \'+r);openOpt(\'haptics\')">Test vibration</button>';
  }
  h+='<button class="btn ghost optClose" type="button" onclick="closeOpt()">Done</button>';
  document.getElementById('optMenu').innerHTML=h;
  document.getElementById('optScrim').classList.add('show');
}
// Slider commit for card drag delay: clamp to 100-300, persist live, refresh display.
function setDragDelay(v){
  let n=parseInt(v,10); if(!isFinite(n)) n=DRAG_DELAY_DEFAULT;
  n=Math.min(300,Math.max(100,n));
  S.prefs.dragDelay=n; save(); openSettings();
}
// Complete single-file backup: the localStorage S object PLUS the IndexedDB
// event log, embedded under an `events` key. Async because reading IDB is async;
// localStorage stays lean (events are only added to the export blob, never back
// into S — migrate() strips `events` on import). Falls back to S-only if IDB is
// unavailable so export never fails outright.
async function buildBackupFile(eventsArr){
  const backup=Object.assign({}, S, {events: eventsArr||[]});
  const _lastMs=function(arr){let mx=0;(arr||[]).forEach(x=>{const c=(x.createdAt||0),u=(x.updatedAt||0);if(c>mx)mx=c;if(u>mx)mx=u;});return mx;};
  backup._backup={ exportedAt:new Date().toISOString(), appVersion:APP_VERSION,
                   eventCount:(eventsArr||[]).length,
                   items:{ tasks:(S.tasks||[]).length, rewards:(S.rewards||[]).length,
                           tags:(S.tags||[]).length,
                           views:((S.prefs&&S.prefs.an&&S.prefs.an.views)||[]).length,
                           lastActivityAt:new Date(Math.max(_lastMs(S.tasks),_lastMs(S.rewards))||Date.now()).toISOString() } };
  // Compute hash over the backup string (without hash field), then inject it
  let hash = null;
  try{
    const preJson = JSON.stringify(backup);
    hash = await computeHash(preJson);
    backup._backup.hash = hash;
  }catch(e){ /* hash optional; export proceeds without it */ }
  const finalJson = JSON.stringify(backup, null, 2);
  const blob = new Blob([finalJson], {type:'application/json'});
  const d=new Date(); const p=(n)=>String(n).padStart(2,'0');
  const stamp=''+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes());
  const filename = 'questa-backup-'+stamp+'.json';
  return {blob, filename, eventCount: (eventsArr||[]).length};
}

function showExportChooser(blob, filename, eventCount) {
  const sheet = document.getElementById('sheet');
  const shareName = filename.replace(/\.json$/, '.txt');
  const shareFile = new File([blob], shareName, {type: 'text/plain'});
  const canShareFiles = !!(navigator.canShare && navigator.canShare({files: [shareFile]}));

  const dbxAvailable = (typeof syncCfg==="function" && typeof exportSaveDropbox==="function" && syncCfg().enabled);

  let h = '<h3>Export backup</h3>';
  h += '<div class="small" style="margin-bottom:12px">Choose where to save your backup.</div>';
  h += '<div class="settingsRow">';
  h += '<button class="btn ghost" id="exportShareBtn"' + (canShareFiles ? '' : ' disabled') + '>Share</button>';
  h += '<button class="btn ghost" id="exportSaveBtn">Save to this device</button>';
  if (dbxAvailable) {
    h += '<button class="btn ghost" id="exportDropboxBtn">Save to Dropbox</button>';
  }
  h += '<button class="btn ghost" id="exportCancelBtn">Cancel</button>';
  h += '</div>';
  if (!canShareFiles) {
    h += '<div class="small" style="margin-top:8px">Sharing isn\'t available in this browser (needs Android Chrome over HTTPS). Use \'Save to device\'.</div>';
  }
  
  sheet.innerHTML = h;

  document.getElementById('exportShareBtn').onclick = () => {
    if (canShareFiles) exportShare(blob, filename, eventCount);
  };
  document.getElementById('exportSaveBtn').onclick = () => {
    exportSaveDevice(blob, filename, eventCount);
  };
  if (dbxAvailable) {
    document.getElementById('exportDropboxBtn').onclick = () => {
      exportSaveDropbox(blob, filename, eventCount);
    };
  }
  document.getElementById('exportCancelBtn').onclick = () => {
    closeSheet();
  };

  document.getElementById('scrim').classList.add('show');
}

async function exportShare(blob, filename, eventCount) {
  const shareName = filename.replace(/\.json$/, '.txt');
  const shareFile = new File([blob], shareName, {type: 'text/plain'});
  let shared = false;
  try {
    await navigator.share({files: [shareFile]});
    shared = true;
  } catch(e) {
    if (e.name === 'AbortError') {
      closeSheet();
    } else {
      toast('Share failed: ' + e.name);
      closeSheet();
    }
  }
  if (shared) {
    S.prefs.lastExportTs = Date.now();
    save();
    checkExportStaleness();
    toast('Exported' + (eventCount ? (' (' + eventCount + ' events)') : ''));
    closeSheet();
    logEvent({kind: 'export', taskTitle: 'Export Data', notes: 'Created backup file via Share'});
  }
}

function exportSaveDevice(blob, filename, eventCount) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  S.prefs.lastExportTs = Date.now();
  save();
  checkExportStaleness();
  toast('Exported' + (eventCount ? (' (' + eventCount + ' events)') : ''));
  closeSheet();
  logEvent({kind: 'export', taskTitle: 'Export Data', notes: 'Created backup file via Download'});
}

function exportData(){
  // backups are for debugging: user-facing export downloads must include
  // diagnostic-kind events, not just the Activity-Feed-visible subset.
  getEvents({includeDiag:true})
    .then(buildBackupFile)
    .then(({blob, filename, eventCount}) => showExportChooser(blob, filename, eventCount))
    .catch(() => buildBackupFile([]).then(({blob, filename, eventCount}) => showExportChooser(blob, filename, eventCount)));
}
function importData(ev){
  const f=ev.target.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>{ try{ const data=JSON.parse(rd.result);
      if(!data.char||!Array.isArray(data.tasks)) throw 0;
      const doImport = () => {
        const embeddedEvents = Array.isArray(data.events) ? data.events : null;
        confirmDialog('Import Progress', 'Replace current progress with the imported file?').then(ok => {
          if(!ok) return;
          S=migrate(data); save(); applyWidth(); applyCardThick(); closeSheet(); render();
          if(embeddedEvents && typeof indexedDB!=="undefined"){
            clearAllEvents().then(()=>bulkAddEvents(embeddedEvents)).then(n=>{
              logEvent({kind: 'import', taskTitle: 'Import Data', notes: 'Restored ' + n + ' events'});
              toast('Imported · '+n+' events restored');
              if(TAB==='analytics') render();
            });
          } else {
            logEvent({kind: 'import', taskTitle: 'Import Data', notes: 'Imported from backup'});
            toast('Imported');
            if(TAB==='analytics') render();
          }
        });
      };
      if(data._backup && data._backup.hash){
        const expectedHash = data._backup.hash;
        delete data._backup.hash;
        const cleanStr = JSON.stringify(data);
        data._backup.hash = expectedHash;
        computeHash(cleanStr).then(check => {
          if(check !== expectedHash){
            alertDialog('Import Error', 'This file appears to be corrupted or tampered with (hash mismatch). Import cancelled.');
            return;
          }
          doImport();
        }).catch(() => doImport());
      } else {
        doImport();
      }
    }catch(e){ alertDialog('Error', 'That file does not look like a valid Questa backup.'); } };
  rd.readAsText(f); ev.target.value='';
}
// --- Snapshot restore picker & logic ----------------------------------------
async function updateLastFullBackupText(){
  const el = document.getElementById('lastFullBackupDate');
  if(!el) return;
  try {
    const snapshots = await listSnapshots();
    const last = snapshots.find(s => s.type === "full" && s.verified);
    if(last){
      const d = new Date(last.ts);
      el.textContent = 'Last full backup: ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    } else {
      el.textContent = 'Last full backup: None';
    }
  } catch(e) {
    el.textContent = 'Last full backup: (unavailable)';
  }
}

async function updateLastExportText(){
  const el = document.getElementById('lastExportDate');
  if(!el) return;
  const ts = S.prefs && S.prefs.lastExportTs;
  if(ts){
    const d = new Date(ts);
    el.textContent = 'Last export: ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  } else {
    el.textContent = 'Last export: None';
  }
}

function openRestorePicker(){
  (async () => {
    if(_flushPromise) await _flushPromise;
    try {
      const snapshots = await listSnapshots();
      const verified = snapshots.filter(s => s.verified);
      if(verified.length === 0){
        alertDialog('Restore', 'No verified local snapshots found. Save your progress first (it auto-saves), then snapshots are created when you close the app.');
        return;
      }
      const sheet = document.getElementById('sheet');
      let h = '<div class="colTitle"><h2>Select a snapshot to restore</h2></div>';
      h += '<div style="max-height:300px;overflow-y:auto">';
      verified.forEach(s => {
        const d = new Date(s.ts);
        const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        const sizeKB = (s.payload ? (s.payload.length / 1024).toFixed(1) : '?');
        const typeLabel = s.type === 'full' ? 'Full' : 'Delta';
        const items = s.counts ? ' &middot; ' + (s.counts.events||0) + ' events' : '';
        h += '<div style="padding:8px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px">' +
          '<span>&#x2705;</span>' +
          '<span style="flex:1"><strong>' + dateStr + '</strong> &middot; ' + typeLabel + items + ' &middot; ' + sizeKB + 'KB</span>' +
          '<button class="btn ghost" onclick="confirmRestore(' + s.id + ')">Restore</button>' +
          '</div>';
      });
      h += '</div>';
      h += '<div class="small" style="margin-top:8px">Select a snapshot to restore. Your current progress will be replaced.</div>';
      h += '<button class="btn ghost" onclick="closeSheet()" style="margin-top:8px">Cancel</button>';
      sheet.innerHTML = h;
      document.getElementById('scrim').classList.add('show');
    } catch(e) {
      alertDialog('Restore', 'Could not read backup store.');
    }
  })();
}
async function confirmRestore(id){
  try{
    const snap = await readSnapshot(id);
    if(!snap || !snap.verified){
      alertDialog('Restore Error', 'Snapshot not found or not verified.');
      return;
    }
    const ok = await confirmDialog('Confirm Restore', 'This will replace ALL current progress with the snapshot from ' + new Date(snap.ts).toLocaleString() + '. Continue?');
    if(!ok) return;

    let data;
    try{ data = JSON.parse(snap.payload); } catch(e){ alertDialog('Restore Error', 'Snapshot data is corrupted.'); return; }

    const stateSnapshot = data.stateSnapshot;
    const events = data.events || [];

    if(!stateSnapshot || !stateSnapshot.char || !Array.isArray(stateSnapshot.tasks)){
      alertDialog('Restore Error', 'Snapshot does not contain valid state.');
      return;
    }

    // Chain continuity check for delta snapshots
    if(snap.type === 'delta'){
      const allSnapshots = await listSnapshots();
      const hasBaseline = allSnapshots.some(s => s.type === 'full' && s.ts < snap.ts);
      if(!hasBaseline){
        const proceed = await confirmDialog('Warning', 'This delta snapshot has no corresponding baseline. Only partial data may be restored. Continue?');
        if(!proceed) return;
      }
    }

    // Apply state
    S = migrate(stateSnapshot);
    save();
    applyWidth();
    applyCardThick();

    // Restore events
    if(events.length > 0 && typeof indexedDB !== "undefined"){
      await clearAllEvents();
      const n = await bulkAddEvents(events);
      logEvent({kind: 'restore', taskTitle: 'Restore from snapshot', notes: 'Restored ' + n + ' events'});
    }

    closeSheet();
    render();
    toast('Restored snapshot from ' + new Date(snap.ts).toLocaleString());
  } catch(e){
    console.error('Restore failed:', e);
    alertDialog('Restore Error', 'Restore failed: ' + e.message);
  }
}
function uploadFace(ev){
  const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
  if(!/^image\/(jpeg|png|gif)$/.test(f.type)){ alertDialog('Error', 'Please choose a PNG, JPEG or GIF image.'); return; }
  if(f.size>1048576){ alertDialog('Error', 'That image is '+(f.size/1048576).toFixed(1)+' MB. Please use one under 1 MB.'); return; }
  const rd=new FileReader();
  rd.onload=()=>{ S.char.faceImg=rd.result; save(); renderStats(); openSettings(); toast('Avatar image set'); };
  rd.onerror=()=>alertDialog('Error', 'Could not read that file.');
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
  const view=document;   // bind to the whole document so swipes on empty area work regardless of content height
  // Elements that own their own horizontal touch gestures — never swipe-nav from them.
  function inHGesture(t){ return !!(t && t.closest && t.closest('#anSlider, input[type=range], .anSlider, .seg')); }

  view.addEventListener('touchstart',e=>{
    if(e.touches.length!==1){ multi=true; tracking=false; return; }
    multi=false;
    if(inHGesture(e.target)){ tracking=false; return; }
    if(document.querySelector('.scrim.show, .optScrim.show, .yScrim.show')){ tracking=false; return; }
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

// Tier 1 backup: snapshot on visibility change if dirty
document.addEventListener('visibilitychange', () => {
  if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'tier1:visibilitychange', hidden:document.hidden, dirty:IS_DIRTY});
  if(document.hidden && IS_DIRTY){
    _flushPromise = takeSnapshot().then(id => { if(id) IS_DIRTY=false; }).finally(()=>{ _flushPromise=null; });
  }
});
window.addEventListener('pagehide', () => {
  if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'tier1:pagehide', dirty:IS_DIRTY});
  if(IS_DIRTY){
    _flushPromise = takeSnapshot().then(id => { if(id) IS_DIRTY=false; }).finally(()=>{ _flushPromise=null; });
  }
});

document.getElementById('scrim').onclick=e=>{ if(e.target.id==='scrim'){ closeSheet(); closeRepSheet(); } };
// Long-press on a habit's +/− button opens the bulk reps sheet (no scoring).
(function(){
  let timer=null, startX=0, startY=0, targetId=null, sign=0;
  function clear(){ if(timer){ clearTimeout(timer); timer=null; } targetId=null; sign=0; }
  function begin(el, x, y){
    if(el.classList.contains('off')) return;            // disabled +/− button
    const card=el.closest('.habit'); if(!card) return;
    targetId=card.dataset.id; sign=el.classList.contains('down')?-1:1;
    startX=x; startY=y;
    timer=setTimeout(()=>{
      timer=null;
      if(!targetId) return;
      _suppressHabitClick=targetId;                      // swallow the trailing click
      buzz(15);
      openRepSheet(targetId, sign);
    }, REP_LONGPRESS_MS);
  }
  document.addEventListener('touchstart', e=>{
    const el=e.target.closest('.habit .check.hbtn');
    if(!el || e.touches.length!==1) return;
    clear(); begin(el, e.touches[0].clientX, e.touches[0].clientY);
  }, {passive:true});
  document.addEventListener('touchmove', e=>{
    if(!timer) return;
    const t=e.touches[0]; if(!t) return;
    if(Math.abs(t.clientX-startX)>10 || Math.abs(t.clientY-startY)>10) clear();
  }, {passive:true});
  document.addEventListener('touchend', clear, {passive:true});
  document.addEventListener('touchcancel', clear, {passive:true});
  document.addEventListener('mousedown', e=>{
    const el=e.target.closest('.habit .check.hbtn');
    if(!el) return;
    clear(); begin(el, e.clientX, e.clientY);
  });
  document.addEventListener('mouseup', clear);
  document.addEventListener('mouseleave', clear);
  document.addEventListener('dragstart', clear);
  document.addEventListener('contextmenu', e=>{ if(e.target.closest('.habit .check.hbtn')) e.preventDefault(); });
})();
window.addEventListener('resize', updateHeaderHeightVar);
window.addEventListener('touchend', () => { if (typeof _tActive !== 'undefined' && _tActive) endTouchDrag(); }, { passive: true });
window.addEventListener('touchcancel', () => { if (typeof _tActive !== 'undefined' && _tActive) endTouchDrag(); }, { passive: true });
applyWidth();
applyCardThick();
startDay();
updateHeaderHeightVar();
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
    .then(() => { startReminderScheduler(); })
    .catch(()=>{ startReminderScheduler(); });
} else {
  startReminderScheduler();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkReminders();
  }
});

// One-time cleanup (2026-07-11, lifecycle-spam fix): purge any 'lifecycle'
// diagnostic events an earlier build already wrote before getEvents()
// learned to filter them out. Gated the same way as sync.js's
// questa.baseReset.v1 one-time purge -- runs at most once per device.
try{
  if(localStorage.getItem("questa.lifecycleCleanup.v1") !== "done"){
    clearLifecycleEvents().catch(()=>{}).then(()=>{
      try{ localStorage.setItem("questa.lifecycleCleanup.v1", "done"); }catch(e){}
    });
  }
}catch(e){ /* best-effort */ }
checkExportStaleness();
// #11b: Request persistent storage to reduce browser-eviction risk (Safari ITP
// 7-day wipe, Chrome eviction under pressure). PWAs get this automatically;
// browser-tab usage does not (MDN: all-or-nothing per origin).
try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==="function"){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==="function") logEvent({kind:"storagePersist", granted:!!granted}); }).catch(function(){}); } }catch(_){}

setTimeout(()=>{
  if(!_flushPromise){ _flushPromise = takeSnapshot().catch(()=>{}).finally(()=>{ _flushPromise=null; }); }
}, 5000);
