// Questa app logic — extracted from index.html on 2026-06-24 18:48
// APP_VERSION is stamped on every edit; it is shown at the bottom of Settings.
const APP_VERSION = "v2026.09.20-0320";
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
      // 2026-09-18: FAIL CLOSED. This gate fronts resetEverything(), confirmRestore(),
      // doImport() and republishImportedEvents(). Resolving true meant "the user said
      // yes" whenever the dialog markup was missing — e.g. a new app.js served against
      // a cached older index.html — so those destructive paths ran with no prompt.
      resolve(false);
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

function alertDialog(title, text, html) {
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
    // If an HTML body was provided (e.g. a structured import summary), render it
    // as markup; otherwise fall back to the safe plain-text path.
    if (html) { textEl.innerHTML = html; }
    else { textEl.textContent = text || ''; }
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
  // 2026-09-18: actually honour the Settings slider. This returned a hard 200, so
  // S.prefs.dragDelay was stored, migrated, clamped and synced to other devices
  // while changing nothing. Clamp matches migrate()'s own 100-300 range.
  var d = (S && S.prefs && S.prefs.dragDelay != null) ? Number(S.prefs.dragDelay) : NaN;
  return isFinite(d) ? Math.min(300, Math.max(100, d)) : DRAG_DELAY_DEFAULT;
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
    prefs:{ width:480, notesLines:3, lastTab:'habits', haptics:true, cardThick:0, saveBtnTop:false, autoBackupEnabled:{fourHour:false,daily:false,weekly:false,monthly:false}, hideConflictDecisions:false, hideSyncDiag:true, showStreaks:true }
  };
}
// F7 (2026-08-18): the SINGLE future-skew tolerance for the whole app. sync.js's
// MAX_FUTURE_SKEW_MS derives from this constant (app.js loads first and sync.js cannot
// be read from here, so the dependency runs this way round -- the same cross-file
// pattern EVENT_AGE_LIMIT_MS already uses). Before this, ratchetHlc tolerated a full
// hour while the merge clamp tolerated 2 minutes: a remote stamp between the two lost
// every arbitration yet still ratcheted the local clock and persisted to S.__hlcLast,
// and because the clamp measures against the ratcheted clock the error compounded.
// Accepting a value for the clock while rejecting it for merging is incoherent.
const HLC_RATCHET_TOLERANCE_MS = 120000; // future-skew tolerance; sync.js MAX_FUTURE_SKEW_MS derives from this
var lastIssued = 0;
let S = load();
lastIssued = (S && S.__hlcLast) || 0;
_hlcHeal(); // K2: the poison is restored from S.__hlcLast, so heal it at the source
// K2 (2026-09-11): now() HEALS a poisoned clock. `lastIssued` used to move only
// forward, and it is persisted to S.__hlcLast, so ONE forward clock excursion (manual
// change, bad NTP, dual boot, dead RTC) pinned it in the future FOREVER -- surviving
// both the clock correction and a reboot. Every stamp this device minted afterwards
// read as 0 on every peer (sync.js _ua/_ca/_clampFuture zero anything past
// physical+120s), so the device was silently demoted to read-only in every conflict,
// with no UI signal, and only "Reset everything" cleared it.
// Detection is a proof, not a heuristic: above Date.now() + HLC_RATCHET_TOLERANCE_MS
// NO device in the fleet will honour the value -- ratchetHlc below refuses it, and
// sync.js's MAX_FUTURE_SKEW_MS derives from this same constant. There is no ordering
// authority left in it to preserve.
// The DROP is safe for that same reason, and only because of it: every value it
// discards reads as 0 everywhere INCLUDING on this device (as of K2 sync.js's
// _futureCeil is the PHYSICAL clock, not this HLC), so no already-issued stamp can
// out-compete the new lower one. The two halves must stay together -- see
// .omo/plans/K2-hlc-future-lock.md.
// The ratchet band (p < lastIssued <= p + tolerance) is deliberately UNTOUCHED: that
// is a legitimate peer inside tolerance, and this device must still out-stamp it.
// Factored out of now() so it has ONE copy and can be unit-tested on its own return
// value rather than only through a caller (AGENTS.md §4 corollary), and so boot can
// run it too: the poison arrives from S.__hlcLast, and healing it there means
// hlcSkewMs() is honest on the very first render instead of staying stale until the
// user's next edit. Returns true iff it actually healed.
// Tests: tests/hlc-future-lock.test.js (K2-B, K2-E, K2-F).
function _hlcHeal(){ var p=Date.now(); if(!(lastIssued > p + HLC_RATCHET_TOLERANCE_MS)) return false; var _was=lastIssued; lastIssued=p; try{ if(S) S.__hlcLast=lastIssued; }catch(e){} try{ logEvent({kind:'hlcReset', was:_was, to:p, driftMs:_was-p}); }catch(e){} return true; }
// How far this device's clock is AHEAD of wall time, in ms. Above
// HLC_RATCHET_TOLERANCE_MS no peer honours our stamps; that is what Settings warns on.
function hlcSkewMs(){ return lastIssued - Date.now(); }
function now(){ _hlcHeal(); var p=Date.now(); lastIssued=Math.max(p, lastIssued+1); try{ if(S) S.__hlcLast=lastIssued; }catch(e){} return lastIssued; }
function ratchetHlc(maxRemoteTs){ var p=Date.now(); if(maxRemoteTs > p + HLC_RATCHET_TOLERANCE_MS){ try{ logEvent({kind:'clockSkew', remoteTs:maxRemoteTs, localTs:p}); }catch(e){} return; } lastIssued = Math.max(lastIssued, maxRemoteTs); if(S) S.__hlcLast = lastIssued; }
// 2026-09-18 (round 2): a read failure used to be indistinguishable from a first
// run. The catch was empty — no toast, no logEvent, no _qDiagPush, and the raw
// string was not kept anywhere — so a truncated questa.save.v1 (or a migrate()
// throw on a malformed task) silently produced a level-1 character with no tasks,
// and the very next save() wrote that empty state over the recoverable bytes.
// Keep the original blob under a recovery key and make the failure visible.
let LOAD_FAILED = null;   // {key, error} when the stored state could not be read
function load(){
  let raw = null;
  try{ raw = localStorage.getItem(STORE_KEY); }catch(e){ raw = null; }
  if(raw){
    try{ return migrate(JSON.parse(raw)); }
    catch(e){
      const key = STORE_KEY + ".corrupt." + Date.now();
      try{ localStorage.setItem(key, raw); }catch(_){ /* nothing else we can do */ }
      LOAD_FAILED = { key: key, error: String((e && e.message) || e) };
      try{ if(typeof _qDiagPush === "function") _qDiagPush('loadFailed', LOAD_FAILED); }catch(_){}
      try{ if(typeof console !== "undefined") console.error("load() failed; stored state kept at " + key, e); }catch(_){}
    }
  }
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
  out.prefs=Object.assign({width:480, notesLines:3, lastTab:'habits', tipDelay:0, haptics:true, cardThick:0, notificationsEnabled:false, saveBtnTop:false, hideSyncDiag:true, hideConflictDecisions:false}, s.prefs||{});
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
  if(!Array.isArray(out.prefs.pausedDays)) out.prefs.pausedDays = [];
  delete out.events;
  // GFS (grandfather-father-son) snapshot rotation counters — ensure prefs.gfs
  // is a {daily, weekly, monthly} numeric object; coerce any legacy/non-numeric
  // values to 0 so downstream rotation logic can rely on number semantics.
  out.prefs.gfs = (out.prefs.gfs && typeof out.prefs.gfs==="object") ? out.prefs.gfs : {daily:0, weekly:0, monthly:0};
  out.prefs.gfs.daily   = Number(out.prefs.gfs.daily)   || 0;
  out.prefs.gfs.weekly  = Number(out.prefs.gfs.weekly)  || 0;
  out.prefs.gfs.monthly = Number(out.prefs.gfs.monthly) || 0;
  // autoBackupEnabled backfill from legacy exportIntervalDays (2026-07-23)
  if(!out.prefs.autoBackupEnabled){
    const _ebd = parseInt(out.prefs.exportIntervalDays, 10);
    const _ab = {fourHour:false, daily:false, weekly:false, monthly:false};
    if(_ebd===1 || _ebd===3) _ab.daily=true;
    else if(_ebd===7) _ab.weekly=true;
    else if(_ebd===14 || _ebd===30) _ab.monthly=true;
    out.prefs.autoBackupEnabled = _ab;
    if(_ebd===14 && !out.prefs.autoBackupMigratedToast){
      out.prefs.autoBackupMigratedToast = true;
      setTimeout(function(){ try{ toast('Auto-backup upgraded to Monthly tier'); }catch(e){} }, 600);
    }
  }
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
function _charSig(c){ if(!c) return ""; var o={}; for(var k in c){ if(k!=="updatedAt") o[k]=c[k]; } try{ return JSON.stringify(o); }catch(e){ return ""; } }
// 2026-09-18: prime from the LOADED state instead of starting at null. save() only
// stamps char.updatedAt when it already holds a signature, so the FIRST save of every
// session skipped the stamp. A boot that damages HP (runCron -> takeDamage -> save)
// therefore persisted the loss under the PREVIOUS session's updatedAt, lost the next
// both-changed merge arbitration, and the damage was silently undone by the peer.
// S is declared above this line, so the initializer can read it.
var _prevCharSig = _charSig(S && S.char);
// 2026-09-18 (round 2): call this after EVERY wholesale `S = ...` replacement (the
// multi-tab clobber path, the storage-event listener, reconcileDurableState). Those
// three sites swapped S without re-priming the two module-level values that track
// it, so the next save() compared the ADOPTED char against the DISCARDED state's
// signature, found a difference, and stamped char.updatedAt = now() for an edit the
// user never made. sync.js resolves char by newest edit ("char.updatedAt is reliably
// stamped per stat change, app.js save() chokepoint via _charSig"), so that phantom
// stamp beat a peer's real gold spend and silently reverted it. The HLC needs the
// same treatment: the adopted state may carry a higher __hlcLast than this tab has.
function _adoptStateStamps(){
  try{ _prevCharSig = _charSig(S && S.char); }catch(e){}
  try{ if(S && S.__hlcLast) lastIssued = Math.max(lastIssued, S.__hlcLast); }catch(e){}
}
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
    var _quotaHit = false;   // set by the localStorage catch; read by the mirror handlers
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
      // 2026-09-18 (round 2): do NOT promise the backup before it exists. The toast
      // used to fire here, before _idbWriteState was even called, so when both
      // stores failed the user was told the opposite of the truth. The mirror's
      // outcome now drives the message (see the .then/.catch below).
      _quotaHit = true;
      try{ if(typeof logEvent==="function") logEvent({kind:"quotaError", message:String(quotaErr&&quotaErr.message||quotaErr)}); }catch(_){}
    }
    // Fire-and-forget durable mirror. IDB commits (oncomplete) far more
    // reliably than localStorage's batched flush; this is the actual fix, not
    // a backup of one. Exposed as _stateWritePromise so lifecycle handlers can
    // best-effort wait on it.
    // 2026-09-18 (round 2): the mirror's failure used to be a bare swallow — no
    // _qDiagPush, no logEvent, no toast — even though every other IndexedDB failure
    // path in this file records itself. So a device where BOTH stores were failing
    // produced a diagnostic bundle with no evidence at all.
    _stateWritePromise = _idbWriteState(_json).then(function(){
      if(_quotaHit){ try{ if(typeof toast==="function") toast("Storage quota exceeded — saved to the backup store instead"); }catch(_){} }
    }, function(mirrorErr){
      try{ if(typeof _qDiagPush==="function") _qDiagPush('stateMirrorFailed', {error:String((mirrorErr&&mirrorErr.message)||mirrorErr), quota:!!_quotaHit}); }catch(_){}
      if(_quotaHit){ try{ if(typeof toast==="function") toast("Storage full — THIS CHANGE WAS NOT SAVED. Free up space or export a backup."); }catch(_){} }
    });
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
        // 2026-09-18 (round 2): re-prime the char signature and the HLC from the
        // state we just ADOPTED. _prevCharSig was set a few lines above to the
        // signature of the char that is being thrown away, so the very next save()
        // compared the adopted char against a foreign signature, found a
        // difference, and stamped char.updatedAt = now() for a change the user
        // never made -- which then beat a peer's real char edit in the
        // both-changed merge and silently reverted it.
        if(typeof _adoptStateStamps==='function') _adoptStateStamps();
        if(typeof logEvent==='function') logEvent({kind:'multiTabClobberAvoided', preBumpSeq:preBumpSeq, storedSeq:storedSeq});
        // ...and say so. This path DISCARDS the caller's in-memory edit wholesale
        // (completeTask's XP/gold, a habit tap, a subtask toggle) and returns as if
        // save() had persisted it. multiTabClobberAvoided is in DIAGNOSTIC_KINDS, so
        // it is filtered out of the Activity Feed too -- the loss was invisible.
        try{ if(typeof toast==='function') toast('Another tab saved first — your last change here was not kept'); }catch(_){}
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
        if(_stateIsNewer(incoming, S)){   // item 15: __seq, then __savedAt
          S = migrate(incoming);
          if(typeof _adoptStateStamps==='function') _adoptStateStamps();   // 2026-09-18 round 2 — see _adoptStateStamps
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
// 2026-09-19 (round 3, item 15): __seq is a PER-BRANCH counter, not a global
// one. Two tabs that diverged both bump the same preBumpSeq and both arrive at
// N+1 holding different content, so a strict `>` adopted neither and whichever
// copy happened to be written last silently won, with nothing recorded. Break
// the tie on __savedAt, the wall-clock stamp save() writes beside __seq on the
// same line -- same device, same clock, so it is comparable. Equal on both is
// genuinely indistinguishable: keep what we already have rather than churn.
// NOT used by save()'s own clobber check: a tie there means "no newer writer",
// and adopting on a tie would throw away the edit the user is mid-way through.
function _stateIsNewer(cand, cur){
  var cs = Number(cand && cand.__seq) || 0;
  var ls = Number(cur && cur.__seq) || 0;
  if(cs !== ls) return cs > ls;
  var ca = Number(cand && cand.__savedAt) || 0;
  var la = Number(cur && cur.__savedAt) || 0;
  return ca > la;
}
function reconcileDurableState(){
  return _idbReadState().then(function(raw){
    if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'reconcile:read', found: !!raw});
    if(!raw) return;
    var idbS;
    try{ idbS = migrate(JSON.parse(raw)); }catch(e){ return; }
    var idbSeq = Number(idbS.__seq) || 0;
    var liveSeq = Number(S.__seq) || 0;
    if(typeof logEvent==="function") logEvent({kind:'lifecycle', detail:'reconcile:compare', idbSeq:idbSeq, liveSeq:liveSeq});
    if(_stateIsNewer(idbS, S)){   // item 15: __seq, then __savedAt
      S = idbS;
      if(typeof _adoptStateStamps==='function') _adoptStateStamps();   // 2026-09-18 round 2 — see _adoptStateStamps
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
// --- Recent-errors block for the sync debug overlay (W2.5) ----------------
// Renders window.__qDiag.errors (the bounded ring pushed to by logEvent()'s
// IndexedDB failure paths and sync.js's syncEventsPull()) as a read-only,
// newest-first HTML block. Entries carry differing shapes (logEventTxError:
// kind/taskId/msg; evtPullSkip: name/reason; error: message/src/line/col; ...)
// so every own key except t/kind is rendered generically as "key=value" --
// this keeps an unrecognized entry shape useful instead of showing undefined.
// Every interpolated value goes through esc(): entries can contain arbitrary
// strings (exception messages, Dropbox filenames), so unescaped interpolation
// into this overlay's innerHTML would be an injection vector. Read-only --
// never mutates window.__qDiag.errors (copies via slice()/reverse() first).
function _qDiagErrorsHtml(){
  var errs = (typeof window!=="undefined" && window.__qDiag && window.__qDiag.errors) ? window.__qDiag.errors : [];
  var header = '<div style="font-weight:bold;margin-bottom:4px;">Recent errors (last 50)</div>';
  if(!errs.length) return header + '<div>No errors recorded</div>';
  var rows = errs.slice().reverse().map(function(e){
    e = e || {};
    var kind = (e.kind!==undefined && e.kind!==null) ? e.kind : "?";
    var when; try{ when = new Date(e.t).toLocaleString(); }catch(ex){ when = String(e.t); }
    var bits = [];
    try{
      Object.keys(e).forEach(function(k){
        if(k==="t" || k==="kind") return;
        var v = e[k];
        if(v===undefined || v===null) return;
        var vs; try{ vs = (typeof v==="object") ? JSON.stringify(v) : String(v); }catch(ex2){ vs = String(v); }
        bits.push(k + "=" + vs);
      });
    }catch(ex3){}
    return '<div style="border-bottom:1px solid #333;padding:4px 0;">' +
      '<b>[' + esc(String(kind)) + ']</b> ' + esc(when) +
      (bits.length ? ('<br>' + esc(bits.join(" "))) : '') +
      '</div>';
  }).join('');
  return header + rows;
}
// --- Per-device event divergence block for the sync debug overlay (W6.16) --
// Surfaces the failure mode that hid the 2026-07-28 event-sync outage for a
// full month: state sync converged (so the app LOOKED healthy) while
// /events files sat in Dropbox completely unpulled by the other device.
// Nothing in the normal UI would have shown that. For every known device
// (S.devices, plus any dev id only seen locally or only seen in the cached
// Dropbox file listing) this shows the LOCAL event count for that dev
// alongside what the last successful pull recorded for that dev's file(s)
// in Dropbox (cfg.evtFileRevs/evtBadRevs -- see sync.js's syncEventsPull()).
// Read-only and pure: every input (devices/localHist/cfg) is handed in by
// the caller (showSyncDebugOverlay(), below) from already-cached data --
// this function itself never touches IndexedDB, localStorage, or the
// network, so it can't perturb the very sync state it's diagnosing.
// THE SIGNAL: a device with ZERO local events for a dev whose file DOES
// exist in the cached Dropbox listing is exactly the July 28 failure mode.
// That row gets a "*** DIVERGENCE ***" text marker plus a red bordered/
// highlighted style so it's unmistakable at a glance, not something the
// user has to compute by comparing two numbers themselves.
// Every interpolated value goes through esc() -- device names are
// user-supplied and filenames come from Dropbox, so both are attacker-ish
// controlled strings from this app's threat-model perspective.
function _qDivFileDev(name){
  const m = /^(.+)-(\d{6})\.json$/.exec(name || "");
  return m ? m[1] : null;
}
function _qDivTs(ts){
  if(!ts) return "not set";
  try{ return new Date(ts).toLocaleString(); }catch(e){ return String(ts); }
}
function _qDivergenceHtml(devices, localHist, cfg){
  devices = Array.isArray(devices) ? devices : [];
  localHist = localHist || {};
  cfg = cfg || {};
  const fileRevs = cfg.evtFileRevs || {};
  const badRevs = cfg.evtBadRevs || {};
  const filesByDev = {};
  function addFile(name, info){
    const dev = _qDivFileDev(name);
    if(!dev) return;
    (filesByDev[dev] = filesByDev[dev] || []).push(Object.assign({name:name}, info));
  }
  Object.keys(fileRevs).forEach(name=>addFile(name, {rev:fileRevs[name], bad:false}));
  Object.keys(badRevs).forEach(name=>addFile(name, {rev:(badRevs[name]&&badRevs[name].rev)||null, bad:true}));

  const header = '<div style="font-weight:bold;margin-bottom:4px;">Per-device event divergence</div>';
  const connLine = '<div>Dropbox: ' + ((cfg.enabled && cfg.refreshToken) ? 'connected' : 'not connected') +
    ' | evtLastUploadTs: ' + esc(_qDivTs(cfg.evtLastUploadTs)) +
    ' | evtLastPullAt: ' + esc(_qDivTs(cfg.evtLastPullAt)) +
    ' | evtFullScanAt: ' + esc(_qDivTs(cfg.evtFullScanAt)) + '</div>';

  const ids = {};
  devices.forEach(d=>{ if(d && d.id) ids[d.id]=true; });
  Object.keys(localHist).forEach(id=>{ ids[id]=true; });
  Object.keys(filesByDev).forEach(id=>{ ids[id]=true; });
  const idList = Object.keys(ids).sort();
  if(!idList.length) return header + connLine + '<div>No known devices</div>';

  const myDev = cfg.deviceId || null;
  const rows = idList.map(function(id){
    const name = (typeof deviceDisplayName==="function") ? deviceDisplayName(devices, id) : String(id).slice(0,6);
    const localCount = (Object.prototype.hasOwnProperty.call(localHist, id)) ? localHist[id] : 0;
    const files = filesByDev[id] || [];
    const remoteKnown = files.length > 0;
    const flagged = localCount === 0 && remoteKnown;
    const fileBits = files.length
      ? files.map(function(f){ return esc(f.name) + (f.bad ? ' [quarantined]' : '') + ' size=not cached rev=' + esc(String(f.rev)); }).join('; ')
      : '(no file cached)';
    const meLabel = (myDev && id===myDev) ? ' (this device)' : '';
    const rowStyle = flagged
      ? 'border:2px solid #f33;background:#3a0000;padding:4px;margin-bottom:4px;'
      : 'border-bottom:1px solid #333;padding:4px 0;';
    const marker = flagged ? '<b style="color:#f66;">*** DIVERGENCE (local=0, remote file exists) *** </b><br>' : '';
    return '<div style="' + rowStyle + '">' +
      marker +
      '<b>' + esc(name) + '</b> (' + esc(String(id).slice(0,10)) + ')' + esc(meLabel) + '<br>' +
      'local events: ' + esc(String(localCount)) + '<br>' +
      'dropbox cache: ' + fileBits +
      '</div>';
  }).join('');
  return header + connLine + rows;
}
function showSyncDebugOverlay(){
  var cfg = {}; try{ cfg = JSON.parse(localStorage.getItem("questa.sync.v1") || "{}"); }catch(e){}
  function dump(a){ return (a && a.tasks) ? a.tasks.map(function(t){ return {id:t.id, type:t.type, title:t.title, streak:t.streak, done:t.done, updatedAt:t.updatedAt, createdAt:t.createdAt}; }) : "n/a"; }
  function renderOverlay(base, hist){
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
    var errBox = document.createElement("div");
    errBox.style.cssText = "flex-shrink:0;max-height:160px;overflow-y:auto;width:100%;background:#111;color:#0f0;font-family:monospace;font-size:11px;border:1px solid #444;padding:8px;box-sizing:border-box;margin-top:8px;";
    errBox.innerHTML = _qDiagErrorsHtml();
    // W6.16: per-device event divergence readout -- see _qDivergenceHtml()
    // above for the rationale (this is the check that would have caught the
    // 2026-07-28 silent event-sync outage). Built from cfg (already parsed
    // above, read-only from localStorage) + hist (the one-pass local
    // histogram computed below, never a network call) + S.devices.
    var divBox = document.createElement("div");
    divBox.style.cssText = "flex-shrink:0;max-height:200px;overflow-y:auto;width:100%;background:#111;color:#0f0;font-family:monospace;font-size:11px;border:1px solid #444;padding:8px;box-sizing:border-box;margin-top:8px;";
    var liveDevices = (typeof S!=="undefined" && Array.isArray(S.devices)) ? S.devices : [];
    divBox.innerHTML = (typeof _qDivergenceHtml==="function") ? _qDivergenceHtml(liveDevices, hist, cfg) : "divergence readout unavailable";
    // W5.9: one-off recovery control for the output of
    // tools/reconstruct_events_jul28.py ({"events":[...]}, 20 synthetic
    // records, no uid). Wired to importEventsBackfill() -- the only
    // events-only import entry point (never touches S) -- and kept HERE in
    // the debug overlay, deliberately NOT in Settings proper, so it cannot
    // be mistaken for the Settings restore/import pathway. Do not wire this
    // control to that other pathway.
    var backfillBox = document.createElement("div");
    backfillBox.style.cssText = "flex-shrink:0;width:100%;background:#111;color:#0f0;font-family:monospace;font-size:11px;border:1px solid #444;padding:8px;box-sizing:border-box;margin-top:8px;";
    backfillBox.innerHTML = '<div style="font-weight:bold;margin-bottom:4px;">Load reconstructed events (device-local, backfill)</div>';
    var backfillInput = document.createElement("input");
    backfillInput.type = "file";
    backfillInput.accept = "application/json,.json";
    backfillInput.style.cssText = "width:100%;color:#0f0;font-family:monospace;font-size:11px;";
    backfillInput.onchange = function(evt){
      if(typeof importEventsBackfill==="function") importEventsBackfill(evt);
    };
    backfillBox.appendChild(backfillInput);
    // W6.14: opt-in re-publish control for imported (Habitica backfill)
    // event history -- see republishImportedEvents() above for the full
    // rationale and the synthetic-exclusion guarantee. Kept HERE alongside
    // the other recovery controls (errors block, backfill input, divergence
    // readout), deliberately NOT in Settings proper.
    var republishBox = document.createElement("div");
    republishBox.style.cssText = "flex-shrink:0;width:100%;background:#111;color:#0f0;font-family:monospace;font-size:11px;border:1px solid #444;padding:8px;box-sizing:border-box;margin-top:8px;";
    republishBox.innerHTML = '<div style="font-weight:bold;margin-bottom:4px;">Republish imported history (opt-in)</div><div>Imported (Habitica backfill) events are excluded from sync by default. This re-publishes records owned by this device.</div>';
    var republishBtn = document.createElement("button");
    republishBtn.textContent = "Republish Imported Events";
    republishBtn.style.cssText = "width:100%;padding:12px;font-size:16px;margin-top:6px;";
    republishBtn.onclick = function(){
      if(typeof republishImportedEvents==="function") republishImportedEvents();
    };
    republishBox.appendChild(republishBtn);
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
    ov.appendChild(ta); ov.appendChild(errBox); ov.appendChild(divBox); ov.appendChild(backfillBox); ov.appendChild(republishBox); ov.appendChild(btnRow);
    document.body.appendChild(ov);
    ta.focus(); ta.select();
  }
  function finish(base){
    var histFn = (typeof evtDevHistogram==="function") ? evtDevHistogram : function(){ return Promise.resolve({}); };
    Promise.resolve().then(histFn).then(function(hist){ renderOverlay(base, hist||{}); })
      .catch(function(){ renderOverlay(base, {}); });
  }
  try{
    var r = indexedDB.open("questa");
    r.onerror = function(){ finish(null); };
    r.onsuccess = function(){
      try{
        var g = r.result.transaction("syncmeta","readonly").objectStore("syncmeta").get("base");
        g.onsuccess = function(){ finish(g.result ? JSON.parse(g.result) : null); };
        g.onerror = function(){ finish(null); };
      }catch(e){ finish(null); }
    };
  }catch(e){ finish(null); }
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
  // 2026-09-18: REDACT the Dropbox credentials. This bundle is what users are asked
  // to attach to a bug report, and questa.sync.v1 holds a long-lived refreshToken
  // plus a live accessToken — anyone who received the file could read and write the
  // user's Dropbox app folder indefinitely. docs/DIAGNOSTIC-FORMAT.md already
  // specifies "presence only" here, and showSyncDebugOverlay() already obeys that.
  try{
    if(ls["questa.sync.v1"]){
      var _sc = JSON.parse(ls["questa.sync.v1"]);
      _sc.refreshToken = !!_sc.refreshToken;   // presence only
      _sc.accessToken  = !!_sc.accessToken;    // presence only
      delete _sc.accessExpiresAt;
      ls["questa.sync.v1"] = JSON.stringify(_sc);
    }
  }catch(e){ ls["questa.sync.v1"] = "[redacted — unparseable]"; }
  try{ if(ls["questa.sync.pkce"]) ls["questa.sync.pkce"] = "[redacted]"; }catch(e){}
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
      syncEventlogHardeningVersion: 2,
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
    // 2026-09-18 (round 2): an open BLOCKED by an older connection fires neither
    // onsuccess nor onerror, and _idbPromise is memoized — so the promise never
    // settled and every later caller reused the same dead promise for the whole
    // session. Consequences were all silent: the durable state mirror was never
    // written again, logEvent appended nothing, and sync.js's
    // `reconcileDurableState().then(syncInit).catch(syncInit)` never ran EITHER arm
    // (.catch does not fire on a pending promise), so Dropbox sync was simply dead.
    // Reject instead, and clear the cache so a later call can retry.
    req.onblocked = ()=>{ _idbPromise = null; reject(new Error("IndexedDB blocked by another tab — close other Questa tabs and reload")); };
    req.onsuccess = ()=>{
      const db=req.result;
      // Let a NEWER version in another tab upgrade instead of blocking it forever.
      try{ db.onversionchange = ()=>{ try{ db.close(); }catch(e){} _idbPromise = null; }; }catch(e){}
      resolve(db); schedulePrune(db);
    };
    req.onerror = ()=>{ _idbPromise = null; reject(req.error || new Error("IndexedDB open failed")); };
  });
  return _idbPromise;
}
// Fire-and-forget event append. Callers (toggleSub, scoreHabit, completeTask,
// runCron, creditYesterday) stay synchronous; all async + failure handling is
// internal here, so a missing/blocked IDB never breaks task scoring.
function logEvent(ev){
  // 2026-09-18 (round 2): ALWAYS mint a uid. index.html loads app.js before
  // sync.js, so during app.js top-level init syncEventUid/syncDeviceId do not exist
  // yet and this used to store a record with no uid at all -- which
  // eventMergeFilter then rejects outright (`!r.uid` -> skipped) and evtUploadable
  // excludes from upload (`e && e.uid && ...`). Those records are precisely the
  // boot-time diagnostics you need when something goes wrong: hlcReset from
  // _hlcHeal(), storagePersist, the reconcile lifecycle pair. They could never be
  // restored from a backup and never left the device, and the import dialog
  // counted them as "already present, skipped".
  const rec = (typeof syncEventUid==="function" && typeof syncDeviceId==="function")
    ? Object.assign({ts:Date.now(), uid:syncEventUid(), dev:syncDeviceId()}, ev)
    : Object.assign({ts:Date.now(), uid:'loc-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)}, ev);
  // 2026-07-29 hardening (W2.4): wire tx.onabort/tx.onerror so an async IndexedDB
  // transaction failure is no longer invisible -- previously only a synchronous
  // try/catch around the transaction+add call existed, with a silent swallow and
  // NO abort/error handlers at all. Retry happens ONCE, on a fresh transaction,
  // and ONLY from tx.onabort -- abort is a definitive "this transaction did NOT
  // commit" signal, so retrying here can never duplicate a record whose original
  // transaction actually committed late. A timer-based retry could not make that
  // guarantee (the original might commit after the timer fires) and was rejected
  // for that reason. attempt() recurses into the retry at most once: the only
  // call to attempt(db,true) is guarded by "!isRetry", and the isRetry===true
  // branch never calls attempt() again -- so this can never loop.
  // NOTE: this is defensive hardening against a failure mode that has NOT been
  // observed, not the fix for the 2026-07-28 event gap -- on that date this same
  // device successfully wrote 9 events (storagePersist, lifecycle x4, miss x3,
  // purchase) through this identical logEvent() -> IndexedDB path, so IndexedDB
  // was healthy and logEvent() was working that day. A future reader must not
  // mistake this hardening for that root-cause fix.
  function _logEventDiag(kind, data){
    if(typeof _qDiagPush === "function"){ try{ _qDiagPush(kind, data); }catch(e){} }
  }
  function attempt(db, isRetry){
    try{
      const tx = db.transaction(EVENTS_STORE, "readwrite");
      tx.objectStore(EVENTS_STORE).add(rec);
      tx.onabort = function(){
        if(isRetry){
          _logEventDiag('logEventRetryFailed', {kind:rec.kind, taskId:rec.taskId, msg:(tx.error&&tx.error.message)||String(tx.error)});
        } else {
          attempt(db, true);
        }
      };
      tx.onerror = function(){
        _logEventDiag('logEventTxError', {kind:rec.kind, taskId:rec.taskId, msg:(tx.error&&tx.error.message)||String(tx.error)});
      };
    }catch(e){ _logEventDiag('logEventSync', {kind:rec.kind, taskId:rec.taskId, msg:String((e&&e.message)||e)}); }
  }
  idbOpen().then(db=>attempt(db, false)).catch(()=>{ /* IDB unavailable (e.g. private mode) — silently skip logging */ });
}
/* BEGIN_EVENTS_HELPERS */
// Async read API: resolve to events in [from,to] (ms, inclusive) optionally
// filtered by kind and/or taskId. Uses the ts index range so we never load the
// whole store for a windowed query. Returns [] on any failure (never throws).
var DIAGNOSTIC_KINDS = ['lifecycle','storagePersist','webLocksUnavailable','clockSkew','hlcReset','multiTabClobberAvoided','quotaError'];
function getEvents(opts){
  opts = opts || {};
  const from = (opts.from!=null) ? opts.from : -Infinity;
  const to   = (opts.to!=null)   ? opts.to   : Infinity;
  const wantKind = opts.kind || null;
  const wantTask = opts.taskId || null;
  const includeDiag = !!opts.includeDiag;
  // 2026-09-19 (round 3, item 4): opt-in failure reporting. By default every IDB
  // failure here resolves [] -- or, on a mid-cursor error, the PARTIAL rows read so
  // far -- which is right for the read-only UI callers (an empty feed beats a
  // crash) but WRONG for a caller building a duplicate guard: a short list there
  // silently duplicates data. With `strict:true` every failure path resolves null
  // instead, so such a caller can tell "nothing stored" from "could not read".
  // Default stays [] -- no existing caller changes behaviour.
  const strict = !!opts.strict;
  return idbOpen().then(db=>new Promise((resolve)=>{
    const out=[];
    let tx;
    try{ tx = db.transaction(EVENTS_STORE, "readonly"); }
    catch(e){ resolve(strict ? null : []); return; }
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
    cursorReq.onerror = ()=>resolve(strict ? null : out);
  })).catch(()=>strict ? null : []);
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
// One-pass per-`dev` local event histogram (W6.16 divergence readout). A
// single cursor scan over the WHOLE store, not a scan repeated per known
// device -- the store holds ~7,250 records, so one pass building a
// histogram here is cheap while a per-device rescan would not be. Counts
// EVERY stored record regardless of kind (including diagnostic kinds),
// because the quantity being compared against a Dropbox event file for
// that dev is "how many raw records does this device hold", not a
// UI-filtered subset. Read-only, no network I/O. Resolves {} on any
// failure (missing IDB, missing store, etc.) -- never throws.
function evtDevHistogram(){
  if(typeof idbOpen !== "function" || typeof EVENTS_STORE === "undefined") return Promise.resolve({});
  return idbOpen().then(db=>new Promise((resolve)=>{
    const counts = {};
    let tx;
    try{ tx = db.transaction(EVENTS_STORE,"readonly"); }catch(e){ resolve(counts); return; }
    let cur;
    try{ cur = tx.objectStore(EVENTS_STORE).openCursor(); }catch(e){ resolve(counts); return; }
    cur.onsuccess = ()=>{
      const c = cur.result;
      if(!c){ resolve(counts); return; }
      const dev = (c.value && c.value.dev!=null) ? String(c.value.dev) : "(no dev)";
      counts[dev] = (counts[dev]||0) + 1;
      c.continue();
    };
    cur.onerror = ()=>resolve(counts);
  })).catch(()=>({}));
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
// --- opt-in re-publish of imported (Habitica backfill) event history -----
// (2026-07-29 W6.14) evtUploadable()/evtOwnMonthRecords() (sync.js) now
// exclude `imported` records (reparentEventsForImport(), above) the same
// way they have always excluded `synthetic` ones -- otherwise re-uploading
// an imported record republishes ANOTHER device's history under THIS
// device's uid, a duplicate no uid-based dedup can collapse (the concrete
// harm this task exists to remove). That default means imported history
// (5,629 records measured 2026-07-29, the pre-2026-07 Habitica backfill)
// will never reach another device via sync, with no migration bringing it
// across. This is the explicit, user-triggered opt-in escape hatch: it sets
// `republish: true` on every imported record OWNED BY THIS DEVICE, which
// flips the sync.js gate back to including them. It deliberately does NOT
// strip `imported` -- doing so would destroy provenance and re-create the
// exact upload ambiguity this task removes.
//
// GUARANTEE: a `synthetic` (reconstructed/backfilled, see
// importEventsBackfill()) record can NEVER become republishable. This
// function's own eligibility filter excludes `!e.synthetic` records only
// (never sets republish on a synthetic one), AND -- independently, as a
// second, unconditional line of defense -- evtUploadable()/
// evtOwnMonthRecords() in sync.js check `!e.synthetic` as a separate,
// unconditional filter term that is never combined with the republish
// clause. So even if a `republish:true` flag were ever set on a synthetic
// record by some other code path, sync.js would still refuse to upload it.
// See tests/no-republish-imported.test.js for the regression test.
//
// Gated behind confirmDialog() (Promise-based; toast() is fire-and-forget
// and cannot ask "Continue?") because this permanently expands what leaves
// the device -- it must never fire silently as a side effect of anything
// else. Exposed only from showSyncDebugOverlay() (below), not Settings
// proper, consistent with the other recovery controls added there.
function countRepublishEligible(myDev){
  return idbOpen().then(db=>new Promise((resolve)=>{
    let n=0, tx;
    try{ tx = db.transaction(EVENTS_STORE,"readonly"); }catch(e){ resolve(0); return; }
    const cur = tx.objectStore(EVENTS_STORE).openCursor();
    cur.onsuccess = ()=>{ const c=cur.result;
      if(!c){ resolve(n); return; }
      const v = c.value;
      if(v && v.imported===true && v.dev===myDev && !v.synthetic && !v.republish) n++;
      c.continue();
    };
    cur.onerror = ()=>resolve(n);
  })).catch(()=>0);
}
function republishImportedEvents(){
  const myDev = (typeof syncDeviceId==='function') ? syncDeviceId() : null;
  if(!myDev){ toast('Cannot republish: no device id set.'); return Promise.resolve(0); }
  return countRepublishEligible(myDev).then(n=>{
    if(n===0){ toast('No imported records on this device are eligible to republish.'); return 0; }
    const msg = 'Republish '+n+' imported event'+(n===1?'':'s')+' to Dropbox sync? This will make them visible to your other devices.';
    return confirmDialog('Republish Imported History', msg).then(ok=>{
      if(!ok){ toast('Republish cancelled.'); return 0; }
      return idbOpen().then(db=>new Promise((resolve)=>{
        let updated=0, tx;
        try{ tx = db.transaction(EVENTS_STORE,"readwrite"); }catch(e){ resolve({updated:0, ok:false}); return; }
        const cur = tx.objectStore(EVENTS_STORE).openCursor();
        cur.onsuccess = ()=>{ const c=cur.result;
          if(!c){ return; }
          const v = c.value;
          if(v && v.imported===true && v.dev===myDev && !v.synthetic && !v.republish){
            v.republish = true;
            try{ c.update(v); }catch(e){}
            updated++;
          }
          c.continue();
        };
        tx.oncomplete = ()=>resolve({updated:updated, ok:true});
        // ROUND-1 FINDING 8 (2026-09-19), second half. All three handlers used to
        // resolve the SAME `updated` count, so an aborted transaction toasted a
        // success. An IndexedDB abort rolls the whole transaction back, so the
        // records the cursor walked were NOT flagged — the honest count is 0, and
        // the caller must not go on to push or claim anything happened. Same shape
        // as finding 7 (evtInsertNew) in a lower-stakes place.
        tx.onerror = ()=>resolve({updated:0, ok:false});
        tx.onabort = ()=>resolve({updated:0, ok:false});
      })).then(res=>{
        if(!res.ok){
          toast('Republish failed: nothing was changed.');
          return 0;
        }
        const updated = res.updated;
        const label = 'Republished '+updated+' imported event'+(updated===1?'':'s');
        if(updated===0){ toast(label+'.'); return 0; }
        // ROUND-1 FINDING 8, first half: flagging is not publishing. These records
        // are historical, so they sit BELOW the sync watermark and no ordinary push
        // selects them; syncEventsRepublishPush() re-scans from zero. Everything is
        // `typeof`-guarded because sync.js is a separate script loaded AFTER app.js
        // (and tests/no-republish-imported.test.js extracts this function on its
        // own, with neither global defined) — an unguarded reference here is a
        // ReferenceError in exactly the path the user just opted into.
        const scfg = (typeof syncCfg==='function') ? (syncCfg()||{}) : {};
        const canPush = !!scfg.enabled && typeof syncEventsRepublishPush==='function';
        if(!canPush){
          toast(label+'. They will go out when Dropbox sync is connected.');
          return updated;
        }
        toast(label+'. Pushing to Dropbox…');
        return Promise.resolve().then(()=>syncEventsRepublishPush()).then(()=>{
          toast(label+' and pushed them to Dropbox.');
          return updated;
        }).catch(e=>{
          // The flags are committed and durable, so the next ordinary round still
          // carries them. Say that instead of implying the opt-in was lost.
          if(typeof _qDiagPush==='function') _qDiagPush('republishPushFailed', { n: updated, err: (e && e.message) || String(e) });
          toast(label+', but the push failed. They will go out on the next sync.');
          return updated;
        });
      });
    });
  }).catch(()=>0);
}
// Merge-filter for incoming sync/import events: a pure union-insert used to
// decide which records from an incoming batch (a downloaded sync file, or an
// imported/reparented list) are genuinely new versus already known. Dedupes
// on TWO independent keys -- the stable event uid, AND a content signature --
// because reparentEventsForImport() (below) rewrites e.dev and rehashes
// e.uid via eventUidOf() on the import path, and eventUidOf() hashes dev as
// one of its input fields. So the SAME logical event can arrive once via
// import (reparented, new uid) and once via cross-device sync (original
// uid) -- two different uids for one real tap. uid-only dedup would let the
// duplicate through; the signature catches it. Modeled on evtIncomingFilter
// (sync.js) but pure: no IDB, no S, no globals, no mutation of inputs.
//
// Residual, accepted risk: sig() can in principle collide for two genuinely
// distinct taps on the same task, same direction, same rep count, in the
// same millisecond. That is not real user behaviour.
function eventMergeSig(r){
  // 2026-09-18 (round 2): include the fields that actually distinguish two records
  // logged in the same millisecond. The old five-field signature omitted `detail`,
  // `subId` and `done`, and the app emits same-ts pairs synchronously from ONE DOM
  // event: flushState() and the Tier-1 snapshot handler are both bound to
  // visibilitychange, and again to pagehide, so each backgrounding writes two
  // lifecycle records with the same Date.now() and different `detail`. On a restore
  // the second was dropped by the signature gate and counted as "already present",
  // which is also why the dialog could say "N already present" against an empty
  // store. The documented residual risk (two identical taps in one millisecond)
  // is unchanged.
  return [r.ts, r.kind, r.taskId || '', r.dir || 0, r.reps || 0,
          r.detail || '', r.subId || '', (r.done === undefined ? '' : (r.done ? 1 : 0))].join('|');
}
// Deterministic tie-breaker for a uid COLLISION -- two logically different
// events that hashed to the same 'rep-...' uid. Derived from the content
// signature, so the same colliding record always lands on the same re-minted
// uid: a second import of the same file dedupes normally instead of piling up
// a fresh uid per attempt. Kept out of eventUidOf()'s own hash space by the
// '~' separator, which eventUidOf() never emits.
function eventUidDisambiguate(uid, sig){
  let h = 0x811c9dc5;
  const s = String(sig);
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return String(uid) + '~' + (h>>>0).toString(16);
}
// `existingUids` may be either a Set of uids (legacy callers, no collision
// handling) or a Map uid -> eventMergeSig(record). With a Map, a uid that is
// already known but whose CONTENT SIGNATURE differs is treated as a hash
// COLLISION, not a duplicate: the record is kept under a re-minted uid rather
// than dropped. Before 2026-09-18 the uid check ran first and returned
// immediately, so the content-signature safety net below never saw a colliding
// record and the event was lost permanently. eventUidOf()'s digest was widened
// to 64 bits in the same edit, which makes collisions vanishingly unlikely --
// this branch is the net for the ones that still happen, and for the legacy
// 32-bit uids already sitting in every existing store.
function eventMergeFilter(incoming, existingUids, existingSigSet){
  const add = []; let skipped = 0;
  const seenUid = new Set(); const seenSig = new Set();
  const uidSigs = (existingUids && typeof existingUids.get === 'function') ? existingUids : null;
  (Array.isArray(incoming) ? incoming : []).forEach(r=>{
    if(!r || typeof r !== "object" || !r.uid || typeof r.ts !== "number"){ skipped++; return; }
    const sig = eventMergeSig(r);
    if(existingSigSet && existingSigSet.has(sig)){ skipped++; return; }
    if(seenSig.has(sig)){ skipped++; return; }
    let uid = r.uid;
    if(existingUids && existingUids.has(uid)){
      // No Map => no signature to compare against => keep the old, lossy
      // behaviour rather than guess. With a Map, an equal signature is a real
      // duplicate and an unequal one is a collision.
      if(!uidSigs || uidSigs.get(uid) === sig){ skipped++; return; }
      uid = eventUidDisambiguate(uid, sig);
      if(existingUids.has(uid)){ skipped++; return; }
    }
    if(seenUid.has(uid)){
      uid = eventUidDisambiguate(uid, sig);
      if(seenUid.has(uid) || (existingUids && existingUids.has(uid))){ skipped++; return; }
    }
    seenUid.add(uid); seenSig.add(sig);
    add.push(uid === r.uid ? r : Object.assign({}, r, { uid: uid }));
  });
  return { add: add, skipped: skipped };
}
/* END_EVENTS_HELPERS */
// Stable, synchronous event uid derived from content. Used when re-parenting
// imported events so a re-import of the same merged file dedupes via the
// existing uploaded-uid set (evtIncomingFilter) instead of doubling. FNV-1a
// over the fields that define a unique event; a changed field => new uid.
function eventUidOf(rec, idx){
  if(!rec || typeof rec!=='object') return '';
  // Content hash, 64 bits. The ORIGINAL fields are included so the SAME record
  // always hashes the same (idempotent re-import), and enough distinct fields
  // are covered -- including the original record id and stable array position
  // -- that two logically different events are very unlikely to share a uid.
  //
  // 2026-09-18: this comment used to claim collisions were IMPOSSIBLE and the
  // digest was 32 bits. Measured on the real generator: 1 collision at 60k
  // events, 3 at 120k, against a 200k hard cap -- and a collision made
  // evtIncomingFilter/eventMergeFilter drop the losing event forever. Widened
  // to 64 bits (expected collisions at 200k: ~1e-9). "Very unlikely" is still
  // not "impossible", so both dedup filters now compare the content signature
  // on a uid hit and keep a colliding record under a re-minted uid.
  //
  // MIGRATION NOTE. Only re-parented import records carry a 'rep-' uid; real
  // taps get a random uid from syncEventUid(). Stores written by earlier builds
  // keep their 32-bit 'rep-xxxxxxxx' uids and are NOT rewritten -- nothing
  // reads a uid's width. A re-import of the same backup on this build mints a
  // wider uid for an event already stored under the old one; the content
  // signature catches that on both the import path (eventMergeFilter) and the
  // sync ingest path (evtIncomingFilter), so it dedupes instead of doubling.
  const ts = (typeof rec.ts==='number') ? rec.ts : 0;
  const kind = rec.kind || '';
  const taskId = rec.taskId || '';
  const taskTitle = rec.taskTitle || '';
  const dir = rec.dir || '';
  const dev = rec.dev || '';
  const uid = rec.uid || '';
  const value = (typeof rec.value==='number') ? rec.value : '';
  const reps = (typeof rec.reps==='number') ? rec.reps : '';
  const src = rec.source || '';
  const subId = rec.subId || '';
  const subText = rec.subText || '';
  const notes = rec.notes || '';
  const origId = rec.id || '';
  const pos = (typeof idx==='number') ? idx : -1;
  const str = [ts,kind,taskId,taskTitle,dir,dev,uid,value,reps,src,subId,subText,notes,origId,pos].join('\u0001');
  // Lane A: plain FNV-1a, forward. Lane B: a different constant set, walked
  // BACKWARDS with the position mixed in and an avalanche step per character,
  // so the two lanes do not move together on small input changes. Concatenated
  // as two fixed-width 8-hex-digit halves -- fixed width matters, otherwise a
  // short lane A would blur the boundary and cost real bits.
  let a = 0x811c9dc5;
  for(let i=0;i<str.length;i++){
    a ^= str.charCodeAt(i);
    a = Math.imul(a, 0x01000193);
  }
  let b = (0x9e3779b9 ^ str.length) >>> 0;
  for(let i=str.length-1;i>=0;i--){
    b ^= (str.charCodeAt(i) + (i & 0xff));
    b = Math.imul(b, 0x85ebca6b);
    b ^= b >>> 13;
  }
  b = Math.imul(b ^ (b >>> 16), 0xc2b2ae35);
  b ^= b >>> 16;
  // Padded inline rather than via a helper on purpose: several tests extract
  // eventUidOf() on its own with tests/_extract.js, and a new free-function
  // dependency would make every one of them throw ReferenceError.
  const hexA = ('00000000' + ((a>>>0).toString(16))).slice(-8);
  const hexB = ('00000000' + ((b>>>0).toString(16))).slice(-8);
  return 'rep-' + hexA + hexB;
}
// Re-parent imported events to THIS device so they pass the normal sync
// upload/ingest gates (evtUploadable / evtIncomingFilter) and propagate to
// other devices. Records already owned by this device (real taps) are left
// untouched. Synthetic / dev:null / dev:undefined / other-device records are
// stamped with this device id, given a stable content-hash uid, and cleared of
// the synthetic flag so they become first-class owned data. History content
// (ts/kind/taskId/taskTitle/value/reps/source/...) is preserved verbatim.
function reparentEventsForImport(list){
  if(!Array.isArray(list)) return list;
  const myDev = (typeof syncDeviceId==='function') ? syncDeviceId() : null;
  for(let i=0;i<list.length;i++){
    const e = list[i];
    if(!e || typeof e!=='object') continue;
    delete e.id;
    const owned = myDev && e.dev===myDev && e.uid;
    if(owned) continue; // preserve original uid/dev for my own real taps
    // (2026-07-29 W6.14) Preserve provenance: origDev keeps the record's
    // PRE-reparenting dev (the device that actually generated it), captured
    // before e.dev is overwritten below, so the true origin stays
    // recoverable even though e.dev now reads as this device.
    e.origDev = e.dev;
    if(myDev) e.dev = myDev;
    e.uid = eventUidOf(e, i);
    if('synthetic' in e) delete e.synthetic;
    // 2026-09-18 (round 2): drop the republish opt-in too. evtUploadable lifts the
    // imported-exclusion only for `e.republish === true`, and that flag used to
    // survive export -> import onto a NEW device. Device C would then re-upload
    // device A's history under C's own device id -- "publishing ANOTHER device's
    // history under THIS device's uid, permanently duplicating it", exactly what
    // the guard exists to prevent -- with no opt-in ever given on C. The opt-in
    // must be re-given per device.
    if('republish' in e) delete e.republish;
    e.imported = true;
  }
  return list;
}
// Summarise a reparented event list so the import report can reconcile the
// stored count against what the Activity Feed will actually show. The feed
// hides DIAGNOSTIC_KINDS and applies a date window, so a raw 'N events'
// count can look like a discrepancy vs the visible feed. This makes the
// breakdown explicit: total stored, system/diagnostic hidden, user-visible,
// and a per-category split (habit/daily/todo/system).
function eventImportSummary(list){
  const arr = Array.isArray(list) ? list : [];
  let total = 0, diag = 0;
  const byCat = { habit: 0, daily: 0, todo: 0, system: 0 };
  for(const e of arr){
    if(!e || typeof e!=='object') continue;
    total++;
    const isDiag = DIAGNOSTIC_KINDS.indexOf(e.kind) >= 0;
    if(isDiag){ diag++; continue; }
    const cat = getEventCategory(e);
    if(byCat[cat] != null) byCat[cat]++; else byCat.system++;
  }
  const visible = total - diag;
  return { total: total, diagnostic: diag, visible: visible, byCat: byCat };
}
function eventImportSummaryText(sum){
  if(!sum) return '';
  const c = sum.byCat || {};
  return sum.total + ' stored total \u00b7 ' + sum.visible + ' visible in feed \u00b7 '
    + sum.diagnostic + ' system/diagnostic hidden \u00b7 '
    + 'Habits ' + (c.habit||0) + ', Dailies ' + (c.daily||0) + ', To-dos ' + (c.todo||0) + ', System ' + (c.system||0);
}
// Compact, mobile-friendly HTML summary for the import-completion dialog.
// Uses a small two-column table so the stored/visible/diagnostic split and the
// per-category counts are scannable at a glance, and explains why the feed
// count can be lower than the stored total without looking like a bug.
function eventImportSummaryHTML(sum){
  if(!sum) return '';
  const c = sum.byCat || {};
  const row = (k,v) => '<tr><td class="evsK">'+k+'</td><td class="evsV">'+v+'</td></tr>';
  return '<div class="evSummary">'
    + '<table class="evSummaryTbl">'
    + row('Stored total', sum.total)
    + row('Visible in feed', sum.visible)
    + row('System / diagnostic hidden', sum.diagnostic)
    + '</table>'
    + '<div class="evSummaryCat">'
    + '<span>Habits <b>'+(c.habit||0)+'</b></span>'
    + '<span>Dailies <b>'+(c.daily||0)+'</b></span>'
    + '<span>To-dos <b>'+(c.todo||0)+'</b></span>'
    + '<span>System <b>'+(c.system||0)+'</b></span>'
    + '</div>'
    + '<p class="evSummaryNote">The feed hides '+sum.diagnostic+' system/diagnostic events and follows the date window, so its count (under \u201cAll\u201d) may be lower than stored. Imported events stay on this device \u2014 they are not synced to your other devices unless you use \u201cRepublish imported events\u201d, and events older than about 18 months are pruned.</p>'
    + '</div>';
}
function bulkAddEvents(list){
  // Returns {added, failed, aborted} on ALL paths (including 4 failure paths):
  // 0. synchronous db.transaction() throw (store missing, DB closing)
  // 1. tx.onerror (constraint violation, quota, etc.)
  // 2. tx.onabort (explicit abort)
  // 3. idbOpen() rejection (DB unavailable)
  // Pushes _qDiagPush('bulkAddEventsFailed', {...}) on paths 1-3 for diagnostics.
  return idbOpen().then(db=>new Promise((resolve)=>{
    let added=0, failed=0, aborted=false, tx;
    try{ tx = db.transaction(EVENTS_STORE,"readwrite"); }catch(e){
      // Path 0: synchronous transaction throw
      if(typeof _qDiagPush === "function"){
        _qDiagPush('bulkAddEventsFailed', { attempted: (list||[]).length, added: 0, failed: (list||[]).length, aborted: true, path: 'txThrow' });
      }
      resolve({added:0, failed:(list||[]).length, aborted:true});
      return;
    }
    const store = tx.objectStore(EVENTS_STORE);
    list.forEach(ev=>{
      if(!ev || typeof ev!=="object") return;
      const rec = Object.assign({}, ev); delete rec.id;
      if(typeof rec.ts!=="number") rec.ts = Date.now();
      const req = store.add(rec);
      req.onsuccess = ()=>{ added++; };
      req.onerror = ()=>{ failed++; };
    });
    tx.oncomplete = ()=>resolve({added, failed, aborted:false});
    tx.onerror = ()=>{
      // Path 1: transaction error
      if(typeof _qDiagPush === "function"){
        _qDiagPush('bulkAddEventsFailed', { attempted: (list||[]).length, added, failed, aborted: false, path: 'txError' });
      }
      resolve({added, failed, aborted:false});
    };
    tx.onabort = ()=>{
      // Path 2: transaction abort
      if(typeof _qDiagPush === "function"){
        _qDiagPush('bulkAddEventsFailed', { attempted: (list||[]).length, added, failed, aborted: true, path: 'txAbort' });
      }
      resolve({added, failed, aborted:true});
    };
  })).catch(()=>{
    // Path 3: idbOpen() rejection
    if(typeof _qDiagPush === "function"){
      _qDiagPush('bulkAddEventsFailed', { attempted: (list||[]).length, added: 0, failed: (list||[]).length, aborted: true, path: 'idbOpenReject' });
    }
    return {added:0, failed:(list||[]).length, aborted:true};
  });
}
// SHA-256 hash for backup integrity verification. Falls back to a simple
// length-based digest when Web Crypto is unavailable (e.g. insecure context).
//
// 2026-09-19 (round 3, review item 6): the fallback used to be INVISIBLE. A
// backup written on a plain-HTTP origin (not a secure context, so no
// crypto.subtle) got the weak 32-bit digest, the file recorded only the digest
// and never which algorithm made it, and importing that same file over HTTPS
// re-hashed it with SHA-256, mismatched, and refused it as "corrupted or
// tampered with". The user's own backup became unrestorable. The algorithm is
// now a named, selectable thing: hashAlgoName() reports what THIS context can
// do, and computeHashWith() reproduces a named algorithm on demand.
//
// Best-effort digest. Behaviour is UNCHANGED on purpose: writeSnapshot() hashes
// and verifies inside one session, so it can never straddle two algorithms and
// needs no algorithm record.
async function computeHash(str){
  if(typeof crypto!=="undefined" && crypto.subtle && crypto.subtle.digest){
    try{
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
    }catch(e){ /* fall through */ }
  }
  // Fallback: deterministic string-length-based hash when crypto unavailable
  return _hashFallback32(str);
}
function _hashFallback32(str){
  let h = 0;
  for(let i=0; i<str.length; i++){ h = ((h<<5)-h)+str.charCodeAt(i); h |= 0; }
  return 'fallback-' + Math.abs(h).toString(16).padStart(8,'0');
}
// 'sha256' when this context has Web Crypto, otherwise 'fallback32'.
function hashAlgoName(){
  return (typeof crypto!=="undefined" && crypto.subtle && crypto.subtle.digest)
    ? 'sha256' : 'fallback32';
}
// Hash with a NAMED algorithm. Unlike computeHash() this never silently
// downgrades: asking for sha256 where Web Crypto is missing rejects, so the
// caller can decide (importData skips the integrity gate rather than calling a
// good backup corrupt). The gate is a corruption check, not a signature.
async function computeHashWith(str, algo){
  if(algo === 'fallback32') return _hashFallback32(str);
  if(algo !== 'sha256'){
    const e = new Error('Unknown hash algorithm "' + algo + '"');
    e.code = 'QUESTA_HASH_ALGO_UNKNOWN';
    throw e;
  }
  if(!(typeof crypto!=="undefined" && crypto.subtle && crypto.subtle.digest)){
    const e = new Error('SHA-256 is unavailable in this context (not a secure origin)');
    e.code = 'QUESTA_HASH_ALGO_UNAVAILABLE';
    throw e;
  }
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
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
// F6 (2026-08-18): decide whether the startup snapshot is worth writing.
// Fires when ANY of: state changed this session; OR no snapshot exists at all;
// OR the newest snapshot is older than 12 h. Matches docs/BACKUP-USER-GUIDE.md:30-34.
// The "no snapshots" clause is NOT about fresh installs — it is the once-per-session
// backstop for browsers where visibilitychange/pagehide never fire before the page is
// killed (iOS Safari class, AGENTS.md §5). Do not remove it as redundant.
// Cost: the "backups" store has no index and listSnapshots() cursors every record
// pushing the whole value, payload included — using it here would deserialise every
// snapshot on every boot. So read the newest ts with a REVERSE cursor and stop at the
// first record. No IDB_VERSION bump: a reverse cursor needs no new index.
async function _shouldStartupSnapshot(){
  if(IS_DIRTY) return true;
  try{
    const db = await idbOpen();
    const tx = db.transaction("backups","readonly");
    const store = tx.objectStore("backups");
    const newestTs = await new Promise((resolve,reject)=>{
      const req = store.openCursor(null,"prev");
      req.onsuccess = ()=>{ const c=req.result;
        if(!c){ resolve(null); return; }
        resolve(Number(c.value && c.value.ts) || 0); }; // first record only — never c.continue()
      req.onerror = ()=>reject(req.error);
    });
    if(newestTs === null) return true;            // empty store: once-per-session backstop
    return (Date.now() - newestTs) > 43200000;    // 12 h
  }catch(e){ return true; }                        // cannot tell: prefer having a backup
}
// ---- avatar de-duplication (2026-09-19, round 3, item 15) -----------------
// S.char.faceImg is a base64 data URL, and every snapshot used to carry its own
// full copy: one ~100 KB image multiplied by the whole GFS snapshot set, in the
// same IndexedDB the event log competes for. The image is now written ONCE per
// distinct hash into the syncmeta store and each snapshot carries only the hash.
//
// Why syncmeta and not a new object store: a new store needs an IDB_VERSION
// bump, and a bumped database cannot be opened by an older build at all -- a
// service-worker rollback would take the whole app down, not just the avatar.
// syncmeta already exists at version 4, so nothing about the schema changes.
//
// Forward/backward shape: the reference lives in a NEW top-level `avatarRef`
// field on the payload and `char.faceImg` is simply absent. An older build
// restoring a newer snapshot ignores the unknown field and finds no avatar, so
// the user sees a blank avatar and re-picks one -- it does not see a broken
// image, and nothing throws. A newer build restoring an OLDER snapshot finds
// faceImg inline exactly as before and never consults avatarRef.
const AVATAR_KEY_PREFIX = "avatar:";
// Below this, the indirection costs more than it saves.
const AVATAR_INLINE_MAX = 2048;
// Distinct avatars to retain. The user has one at a time; this is headroom for
// a few changes of mind so older snapshots stay restorable.
const AVATAR_KEEP_MAX = 5;

async function avatarPut(hash, dataUrl){
  try{
    const db = await idbOpen();
    if(!db) return false;
    const tx = db.transaction("syncmeta","readwrite");
    const store = tx.objectStore("syncmeta");
    store.put({ img: dataUrl, at: Date.now() }, AVATAR_KEY_PREFIX + hash);
    // Prune by age, oldest first, and ONLY our own keys -- syncmeta also holds
    // 'base', the last synced sync baseline, which must never be touched here.
    //
    // Both reads are issued in the SAME synchronous turn on purpose. Awaiting
    // getAllKeys() and then issuing a store.get() per key from the resulting
    // microtask is the classic way to meet TransactionInactiveError, and here it
    // would fail silently -- the catch returns false and the avatar just stays
    // inline. getAllKeys() and getAll() return their results in the same order
    // by spec, so one paired wait replaces N follow-up reads.
    const pairs = await new Promise(res=>{
      const rk = store.getAllKeys();
      const rv = store.getAll();
      let ks = null, vs = null;
      const settle = ()=>{ if(ks !== null && vs !== null) res({ keys: ks, vals: vs }); };
      rk.onsuccess = ()=>{ ks = rk.result || []; settle(); };
      rk.onerror   = ()=>{ ks = []; settle(); };
      rv.onsuccess = ()=>{ vs = rv.result || []; settle(); };
      rv.onerror   = ()=>{ vs = []; settle(); };
    });
    const mine = [];
    pairs.keys.forEach((k, i)=>{
      if(typeof k === "string" && k.indexOf(AVATAR_KEY_PREFIX) === 0){
        mine.push({ k: k, at: Number(pairs.vals[i] && pairs.vals[i].at) || 0 });
      }
    });
    if(mine.length > AVATAR_KEEP_MAX){
      mine.sort((a,b)=>a.at - b.at);
      mine.slice(0, mine.length - AVATAR_KEEP_MAX).forEach(e=>{
        // Never evict the one we just wrote, whatever its stamp says.
        if(e.k !== AVATAR_KEY_PREFIX + hash) store.delete(e.k);
      });
    }
    return await new Promise(res=>{ tx.oncomplete=()=>res(true); tx.onerror=()=>res(false); tx.onabort=()=>res(false); });
  }catch(e){ return false; }
}

async function avatarGet(hash){
  try{
    const db = await idbOpen();
    if(!db) return null;
    return await new Promise(res=>{
      const rq = db.transaction("syncmeta","readonly").objectStore("syncmeta").get(AVATAR_KEY_PREFIX + hash);
      rq.onsuccess = ()=>{ const v = rq.result; res(v && typeof v.img === "string" ? v.img : null); };
      rq.onerror = ()=>res(null);
    });
  }catch(e){ return null; }
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
    // 2026-09-19 (round 3, item 15): park the avatar instead of inlining it.
    // Two rules this must never break. (1) The live S is NEVER mutated -- the
    // faceImg is removed from a shallow clone, because writeSnapshot runs
    // alongside ordinary use and stripping the real object would blank the
    // user's avatar on screen. (2) If parking FAILS for any reason, the inline
    // copy stays. A fatter snapshot is a cost; a snapshot that silently lost the
    // avatar is data loss.
    let _snapState = S;
    let _avatarRef = null;
    const _face = (S && S.char && typeof S.char.faceImg === "string") ? S.char.faceImg : "";
    if(_face && _face.length > AVATAR_INLINE_MAX){
      try{
        const _h = await computeHash(_face);
        if(_h && await avatarPut(_h, _face)){
          _avatarRef = _h;
          _snapState = Object.assign({}, S, { char: Object.assign({}, S.char) });
          delete _snapState.char.faceImg;
        }
      }catch(e){ _avatarRef = null; _snapState = S; }
    }
    const payload = JSON.stringify({stateSnapshot: _snapState, events, avatarRef: _avatarRef});
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
    // 2026-09-18 (round 2): distinguish COMMIT from abort. This used to resolve the
    // same way on oncomplete, onerror and onabort, so an add that succeeded at
    // request level but failed at commit (quota) still reached `return id` below.
    // takeSnapshot's guard -- "advance markers ONLY if the write actually succeeded
    // (writeSnapshot returns the new id, or null on failure)... a transient IDB
    // error must NOT permanently skip a tier" -- was therefore defeated: the tier
    // marker advanced with no baseline written, that GFS slot was consumed until
    // the next boundary, and rotateSnapshots then pruned older baselines against a
    // keep-set assuming the new one existed.
    const _committed = await new Promise(r=>{ tx.oncomplete=()=>r(true); tx.onerror=()=>r(false); tx.onabort=()=>r(false); });
    if(!_committed){ console.error("writeSnapshot: transaction did not commit", id); return null; }
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
          return null;   // 2026-09-18 round 2: the record is gone, so this is a failure
        }
      } else {
        console.error("Snapshot verification failed - record not found after commit", id);
        return null;     // 2026-09-18 round 2
      }
    }catch(e){ console.error("Snapshot verification error:",e); return null; /* 2026-09-18 round 2 */ }
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
    // 2026-09-18 (round 2): with no fulls at all, dailyKeptFulls is empty, the floor
    // stays Infinity and `s.ts >= Infinity` matches NOTHING -- so every delta except
    // the single newest (kept by the snaps[0] seed above) was deleted on every
    // rotation. That state is reachable: restore a backup onto a device whose
    // backups store is empty and S.prefs.gfs already marks today/this week/this
    // month as done, so takeSnapshot picks tier=null and writes only deltas until
    // the next month boundary. There is no "no fulls -> keep everything" guard.
    if(!dailyKeptFulls.length){ for(const s of deltas) keep.add(s.id); }
    else for(const s of deltas){ if(s.ts >= oldestDailyFullTs) keep.add(s.id); }
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
      const reparented = reparentEventsForImport(list);
      // reparentEventsForImport() strips the synthetic flag (by design -- the
      // normal Settings->Import path wants imported history to become
      // first-class owned data). This backfill path must NOT inherit that:
      // re-stamp synthetic=true here so these reconstructed records stay
      // excluded from evtUploadable/evtOwnMonthRecords (sync.js) and keep
      // showing the "~ backfill" badge in the Activity Feed.
      reparented.forEach(e=>{ if(e && typeof e==="object") e.synthetic = true; });
      clearSyntheticEvents().then(removedCount=>{
        if(removedCount>0) toast('Replacing '+removedCount+' previously reconstructed events.');
        return bulkAddEvents(reparented);
      }).then(result=>{
        const added = result.added;
        if(result.failed > 0 || result.aborted){
          toast('Loaded ' + added + ' of ' + (reparented||[]).length + ' events (some failed)');
        } else {
          toast('Loaded '+added+' events');
        }
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
  // 2) hard-count backstop: if STILL over cap, drop oldest by ts until under.
  // 2026-09-18: measure AFTER the age pass, not before. store.count() used to be
  // queued on the same transaction immediately after openCursor(), so it returned
  // the PRE-prune total — and the backstop then deleted that many MORE records.
  // With 250k events of which 100k were old, the age pass left 150k (already under
  // the 200k cap) but `over` was computed as 50k, so 50k in-window events were
  // destroyed as well. Counting from tx.oncomplete measures the shrunk store.
  tx.oncomplete = ()=>{
    try{
      const tx2 = db.transaction(EVENTS_STORE,"readwrite");
      const store2 = tx2.objectStore(EVENTS_STORE);
      const cReq = store2.count();
      cReq.onsuccess = ()=>{
        const over = (cReq.result||0) - EVENT_HARD_CAP;
        if(over <= 0) return;
        let removed=0;
        const cur2 = store2.index("ts").openCursor();
        cur2.onsuccess = ()=>{ const c=cur2.result; if(c && removed<over){ try{c.delete();}catch(e){} removed++; c.continue(); } };
      };
    }catch(e){}
  };
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
  // 2026-09-18 (round 2): measure from week 1's THURSDAY, not from Jan 4 itself.
  // `d` has already been shifted to its own week's Thursday, so the divisor only
  // gives whole weeks when the origin is also a Thursday. In the 3 years in 7 where
  // 4 January falls on Fri/Sat/Sun, week 1's Thursday PRECEDES Jan 4, the numerator
  // went negative for week 1 and Math.floor rounded to -1 — every week in that ISO
  // year came out one low. Measured: 2026-06-15 returned 202624 for ISO week 25,
  // and 2026-01-01 returned 202600, which is not a valid ISO week at all. The GFS
  // keys stayed injective, so this mislabels rather than loses data.
  var wk1Thu = new Date(isoYear, 0, 4);
  wk1Thu.setDate(wk1Thu.getDate() - ((wk1Thu.getDay() + 6) % 7) + 3);
  wk1Thu.setHours(0,0,0,0);
  d.setHours(0,0,0,0);   // so a DST hour cannot perturb the division
  var weekNo = 1 + Math.round((d - wk1Thu) / 604800000);
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

function reminderFireKey(r, now) {
  return `${now.getFullYear()}${String(now.getMonth()+1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${r.time}`;
}

// Shared day/date gate for isReminderDue and isReminderMissed: is this reminder
// supposed to run at all on the calendar day that `now` falls in, and has it not
// already fired for that day's slot?
function reminderAppliesToday(t, r, now) {
  if (!r.enabled) return false;
  if (t.type === 'todo' && t.done) return false;
  if (!r.time) return false;

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

  return r.lastFiredKey !== reminderFireKey(r, now);
}

function isReminderDue(t, r, now) {
  if (!reminderAppliesToday(t, r, now)) return false;

  const currentHour = String(now.getHours()).padStart(2, '0');
  const currentMin = String(now.getMinutes()).padStart(2, '0');
  const currentTimeStr = `${currentHour}:${currentMin}`;
  return r.time === currentTimeStr;
}

// A PWA cannot fire a local notification while the page is closed: the 60s
// scheduler dies with the tab and Notification Triggers never shipped. So a slot
// that passed while Questa was shut is reported late, exactly once, on next open
// rather than being dropped in silence.
function isReminderMissed(t, r, now) {
  if (!reminderAppliesToday(t, r, now)) return false;

  const currentHour = String(now.getHours()).padStart(2, '0');
  const currentMin = String(now.getMinutes()).padStart(2, '0');
  const currentTimeStr = `${currentHour}:${currentMin}`;
  return r.time < currentTimeStr;
}

function getReminderNotificationPayload(t, r, missed) {
  let title = t.title || 'Questa Reminder';
  let body = '';
  if (t.type === 'habit') {
    body = t.notes ? `Nudge: ${t.notes}` : 'Time to score your habit!';
  } else if (t.type === 'daily') {
    body = t.notes ? `Daily reminder: ${t.notes}` : 'Check off your daily task!';
  } else {
    body = t.notes ? `To-Do due: ${t.notes}` : 'Complete your to-do!';
  }
  if (missed) {
    body = 'Missed at ' + r.time + ' - ' + body;
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
      const due = isReminderDue(t, r, now);
      // A slot that passed while the app was closed still fires, once, marked late.
      const missed = !due && isReminderMissed(t, r, now);
      if (!due && !missed) return;

      const payload = getReminderNotificationPayload(t, r, missed);
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

      r.lastFiredKey = reminderFireKey(r, now);
      tasksChanged = true;
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
// atMs (2026-09-18 round 2): optional, for a point that belongs to a day other than
// today. runCron's miss record is the case that needed it — it was stamped
// Date.now(), so yesterday's miss landed in TODAY's bucket, and when the user then
// completed that same daily today logHistory merged into the very same point and set
// completed = true, erasing the miss. History then showed no record of the missed day
// even though HP had been charged for it. creditYesterday already hand-rolled a
// backdated push for the mirror-image reason.
function logHistory(t, patch, atMs){
  t.history = t.history || [];
  const now = (typeof atMs === 'number' && atMs > 0) ? atMs : Date.now();
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
    // A backdated point must not leave the series out of order — analytics and the
    // snapshot walk both read it ascending.
    const n = t.history.length;
    if(n > 1 && (t.history[n-2].date || 0) > now) t.history.sort((a,b)=>(a.date||0)-(b.date||0));
  }
}
function completeTask(t, ev){
  if(t.done) return;
  if(t.type==='daily' && !isDailyDueToday(t)) return; // non-due dailies must never complete (blocks streak/reward/isDue inflation)
  const r = completionReward(t);
  const delta = valueDelta(t.value);
  gainXp(r.xp); S.char.gold = +(S.char.gold + r.gold).toFixed(2); S.char.mp += r.mp;
  // 2026-09-18: record the REALIZED delta, not the requested one. At the 99 ceiling
  // (or the -47.27 floor) the clamp grants nothing, but reverseGrant subtracted the
  // full requested delta — so a complete/un-complete round trip at cap walked the
  // habit value down ~0.58 per cycle.
  const _valueBefore = t.value;
  t.value = clamp(t.value + delta, -47.27, 99);
  const _realizedDelta = t.value - _valueBefore;
  t.done = true;
  t.updatedAt = now();
  t.doneAt = Date.now(); // F3 (2026-07-11): completion-day channel for cron-aware merge; see sync.js resolveDailyConflict/.omo/plans/2026-07-11-cron-merge-recency.md
  // 2026-09-18: freeze the completion DAY in THIS device's timezone, the same way
  // runCron freezes t.missedOn. sync.js's resolveDailyConflict compared
  // dayStampOf(doneAt) — re-derived in the MERGING device's timezone — against
  // missedOn, a frozen int from the RECORDING device's. Two devices in different
  // zones therefore read the same pair of records differently and picked opposite
  // winners, so a completion survived on one device and was replaced by a miss
  // (streak zeroed, damage charged) on the other, forever ping-ponging.
  t.doneDay = dayStamp(new Date());
  delete t.missedOn;
  buzz(50);
  t._gr = { xp:r.xp, gold:r.gold, mp:r.mp, delta:_realizedDelta };  // remember exactly what was granted
  if(t.type==='daily'){ if(!S.prefs.paused) t.streak = (t.streak||0) + 1;
    const cl=(t.checklist||[]); const snap = cl.length? {checklist:cl.map(c=>({text:c.text,done:!!c.done}))} : {};
    // 2026-09-18 (round 2): record whether THIS completion created the day's history
    // point or merged into one that already existed (runCron's miss record, an
    // imported row). unlogToday may only pop a point it created — see unlogToday.
    const _hLen = (t.history||[]).length;
    logHistory(t,Object.assign({value:t.value,completed:true,isDue:true,reward:Object.assign({},t._gr),repeat:(t.repeat||[]).slice()},snap));
    t._histCreated = ((t.history||[]).length > _hLen);
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
    // 2026-09-18 (round 2): only drop a point THIS completion created. logHistory is
    // a merge -- "same-day events merge... so the series stays one-point-per-day" --
    // so `last` is frequently a point somebody else wrote: runCron's miss record
    // (isDue/repeat/value), or an imported history row dated today. The old guard
    // tested only scoredUp/scoredDown/completed, none of which those carry, so
    // un-ticking a daily deleted the whole day's record. `_new` is stamped by
    // logHistory on the push branch and cleared here.
    if(t._histCreated && !last.scoredUp && !last.scoredDown && !last.completed) t.history.pop();
    else { last.value = t.value; delete last.reward; }
    delete t._histCreated;
  }
}
function uncompleteDaily(t){
  const _gr=t._gr?Object.assign({},t._gr):null;
  reverseGrant(t);
  unlogToday(t);
  t.done = false;
  delete t.doneAt; // F3 (2026-07-11): unchecking retracts the completion-day claim
  delete t.doneDay; // 2026-09-18: retract the frozen day claim with it
  // 2026-09-18: gate the decrement on paused exactly like completeTask gates the
  // increment (app.js completeTask / creditYesterday). Without this, ticking and
  // un-ticking a daily while paused bled one streak day per cycle.
  if(t.type==='daily' && t.streak && !(S.prefs && S.prefs.paused)){ t.streak = Math.max(0, t.streak - 1); }
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
  delete t.doneDay; // 2026-09-18: see uncompleteDaily
  t.updatedAt = now(); // F1 (2026-07-11): see uncompleteDaily
  toast('Reverted');
  try{ logEvent(Object.assign({kind:'uncomplete', taskType:t.type, taskId:t.id, taskTitle:t.title}, _gr?{clawback:{xp:_gr.xp,gold:_gr.gold,mp:_gr.mp}}:{})); }catch(e){}
  save(); render();
}
/* BEGIN_QUICKLOG_HELPERS */
function parseQuickParams(search){
  try{
    var q='';
    if(typeof search==='string'){ q=search; }
    else if(typeof location!=='undefined' && location && typeof location.search==='string'){ q=location.search; }
    var sp=null;
    try{ sp=new URLSearchParams(q.charAt(0)==='?'?q.slice(1):q); }catch(e){ return null; }
    if(sp.get('code')) return null;
    var quick=sp.get('quick');
    var dirRaw=(sp.get('dir')||'').toLowerCase();
    var dir=(dirRaw==='-1'||dirRaw==='down'||dirRaw==='-')?-1:1;
    var tabRaw=sp.get('tab');
    if(quick!==null && quick!==undefined && String(quick)!==''){
      if(String(quick).toLowerCase()==='today') return {kind:'sheet', id:null, dir:1, tab:null};
      return {kind:'habit', id:String(quick), dir:dir, tab:null};
    }
    if(tabRaw!==null && tabRaw!==undefined && String(tabRaw)!==''){
      var tab=String(tabRaw);
      var ok=false;
      try{ ok=(typeof TABS!=='undefined' && TABS && typeof TABS.indexOf==='function') ? TABS.indexOf(tab)!==-1 : false; }catch(e){ ok=false; }
      if(!ok) return null;
      return {kind:'tab', id:null, dir:1, tab:tab};
    }
    return null;
  }catch(e){ return null; }
}
function buildQuickUrl(base, id, dir){
  var b=String(base||'');
  if(!id || String(id).toLowerCase()==='today') return b+'?quick=today';
  return b+'?quick='+encodeURIComponent(String(id))+'&dir='+((dir||0)<0?-1:1);
}
function quickLogTargetOk(t, dir){
  if(!t || t.type!=='habit') return false;
  if(dir!==1 && dir!==-1) return false;
  return true;
}
var QUICKLOG_DEDUPE_MS=3000;
function _quickDedupeKey(id, dir){ return 'quicklog:'+String(id)+':'+String(dir); }
function quickLogDedupe(id, dir, nowMs){
  try{
    var store=null;
    try{ store=(typeof sessionStorage!=='undefined')?sessionStorage:null; }catch(e){ store=null; }
    if(!store || typeof store.getItem!=='function') return false;
    var k=_quickDedupeKey(id, dir);
    var prev=0;
    try{ prev=parseInt(store.getItem(k)||'0',10)||0; }catch(e){ prev=0; }
    var t=(typeof nowMs==='number'&&nowMs>0)?nowMs:0;
    if(!t){ try{ t=(typeof now==='function')?now():Date.now(); }catch(e){ try{ t=Date.now(); }catch(e2){ t=0; } } }
    if(prev>0 && t>0 && (t-prev)<QUICKLOG_DEDUPE_MS) return true;
    try{ store.setItem(k, String(t)); }catch(e){}
    return false;
  }catch(e){ return false; }
}
function quickLogClearDedupe(id, dir){
  try{
    var store=null;
    try{ store=(typeof sessionStorage!=='undefined')?sessionStorage:null; }catch(e){ store=null; }
    if(!store || typeof store.removeItem!=='function') return;
    store.removeItem(_quickDedupeKey(id, dir));
  }catch(e){}
}
var _pendingQuickLog=null;
function _drainPendingQuickLog(){
  var p=null;
  try{
    if(!_pendingQuickLog) return null;
    p=_pendingQuickLog; _pendingQuickLog=null;
  }catch(e){ return null; }
  try{ applyQuickIntent(p, {fromDrain:true}); }catch(e){}
  return p;
}
function toastAction(msg, label, fn){
  try{
    var w=(typeof document!=='undefined')?document.getElementById('toast'):null;
    if(!w || typeof toast!=='function'){ try{ toast(msg); }catch(e){} return null; }
    var e=document.createElement('div');
    e.className='toastMsg';
    var span=document.createElement('span'); span.textContent=msg; e.appendChild(span);
    var fired=false;
    var b=document.createElement('button');
    b.type='button'; b.textContent=label||'Undo';
    b.onclick=function(){ if(fired) return; fired=true; try{ e.remove(); }catch(x){} try{ fn(); }catch(x){} };
    e.appendChild(b); w.appendChild(e);
    setTimeout(function(){ try{ e.remove(); }catch(x){} fired=true; }, 4500);
    return e;
  }catch(e2){ try{ toast(msg); }catch(e3){} return null; }
}
function quickCleanUrl(){
  try{
    if(typeof history!=='undefined' && history && typeof history.replaceState==='function'){
      history.replaceState(null,'','./');
    }
  }catch(e){}
}
function applyQuickIntent(intent, opts){
  try{
    if(!intent || !intent.kind) return null;
    if(intent.kind==='tab'){
      TAB=intent.tab;
      try{ if(typeof render==='function') render(); }catch(e){}
      try{ quickCleanUrl(); }catch(e){}
      return intent;
    }
    if(intent.kind==='sheet'){
      try{ if(typeof drawQuickSheet==='function') drawQuickSheet(); }catch(e){}
      try{ quickCleanUrl(); }catch(e){}
      return intent;
    }
    if(intent.kind==='habit'){
      var id=intent.id, dir=(intent.dir===-1)?-1:1;
      var t=null;
      try{ t=(typeof S!=='undefined' && S && S.tasks)?S.tasks.find(function(x){ return x&&x.id===id; }):null; }catch(e){ t=null; }
      if(!quickLogTargetOk(t, dir)) return null;
      var gated=false;
      try{ gated=(typeof bootGateBlocksInput==='function')?!!bootGateBlocksInput():false; }catch(e){ gated=false; }
      if(gated){ _pendingQuickLog={kind:'habit', id:id, dir:dir, tab:null}; return _pendingQuickLog; }
      var nowMs=0;
      try{ nowMs=(opts&&typeof opts.nowMs==='number'&&opts.nowMs>0)?opts.nowMs:((typeof now==='function')?now():Date.now()); }catch(e){ nowMs=0; }
      if(quickLogDedupe(id, dir, nowMs)) return null;
      try{ TAB='habits'; }catch(e){}
      try{ scoreHabit(id, dir, null); }catch(e){ return null; }
      try{ quickCleanUrl(); }catch(e){}
      try{
        if(typeof toastAction==='function'){
          toastAction((dir>0?'+1 · ':'−1 · ')+(t.title||'habit'), 'Undo', function(){
            try{ scoreHabit(id,-1,null); }catch(e){}
            try{ quickLogClearDedupe(id, dir); }catch(e){}
          });
        }
      }catch(e){}
      return {kind:'habit', id:id, dir:dir, tab:null};
    }
    return null;
  }catch(e){ return null; }
}
/* END_QUICKLOG_HELPERS */
function scoreHabit(id, dir, ev){
  if(bootGateBlocksInput()){ toast('Syncing…'); return; } // D3 todo 11: MUST stay the first statement
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
  // 2026-09-18: mirror runCron's own two gates exactly, or the modal threatens
  // miss damage that runCron will never apply. (a) ordering, not equality — see
  // runCron; (b) the live paused flag, which runCron early-returns on before any
  // damage, while pausedDays only records days cron has already processed.
  if(S.prefs && S.prefs.paused) return [];
  if(dayStamp(new Date()) <= S.lastCron) return []; // already crossed today
  const _yStamp=dayStamp(new Date(Date.now()-86400000)); if((S.prefs.pausedDays||[]).includes(_yStamp)) return [];
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
// Returns TRUE only when it actually credited (t.done flipped false->true), FALSE on
// either skip. J4 (2026-08-19): the yester-check toast counts credits, and this return
// value is its single source of truth -- the call site must not re-derive the two skip
// predicates below (review finding 9).
function creditYesterday(t){
  if(t.done) return false;
  if(t.type==='daily' && !isDailyDueOn(t, (new Date().getDay()+6)%7)) return false; // only credit dailies actually due yesterday; missedYesterdayDailies already filters, this is defense-in-depth
  const r = completionReward(t);
  const delta = valueDelta(t.value);
  gainXp(r.xp); S.char.gold = +(S.char.gold + r.gold).toFixed(2); S.char.mp += r.mp;
  // 2026-09-18: realized-delta, same reason as completeTask above.
  const _valueBefore = t.value;
  t.value = clamp(t.value + delta, -47.27, 99);
  const _realizedDelta = t.value - _valueBefore;
  t.done = true;
  t.updatedAt = now();
  t.doneAt = Date.now() - 86400000; // F3: backdated to match the history point below (yMs) — this IS yesterday's completion
  t.doneDay = dayStamp(new Date(Date.now() - 86400000)); // 2026-09-18: frozen local day, see completeTask
  delete t.missedOn;
  t._gr = { xp:r.xp, gold:r.gold, mp:r.mp, delta:_realizedDelta };
  if(!S.prefs.paused) t.streak = (t.streak||0) + 1;
  const cl=(t.checklist||[]);
  const yMs = Date.now() - 86400000; // backdate the point to yesterday
  t.history = t.history || [];
  const snap = cl.length ? {checklist:cl.map(c=>({text:c.text,done:true}))} : {};
  t.history.push(Object.assign({date:yMs,value:t.value,completed:true,isDue:true,
    reward:Object.assign({},t._gr),repeat:(t.repeat||[]).slice()},snap));
  logEvent({kind:'complete', taskType:'daily', taskId:t.id, taskTitle:t.title,
            streak:t.streak, reward:Object.assign({},t._gr), repeat:(t.repeat||[]).slice(),
            late:true, checklist:cl.map(c=>({id:c.id||null,text:c.text,done:true}))});
  return true;
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
  // 2026-08-18: re-resolve each ticked id against the LIVE S.tasks before crediting.
  // _yesterMissed holds object references captured when the modal opened, and any sync
  // round that lands while it is open replaces them: syncApply deep-copies the subset
  // (new identities) and then assigns S.tasks wholesale. Crediting the captured object
  // would mutate a detached orphan and the user's credit would be silently lost.
  // Pre-existing bug, not introduced by the boot gate: the online/visibilitychange
  // listeners in sync.js can fire a round at any time, not just the first one.
  // J4 (2026-08-19): count the CREDIT, not the tick. `credited` used to be
  // _yesterMissed.filter(t=>_yesterTick[t.id]).length, so a task that vanished
  // mid-modal was still counted and the toast said "Credited 2 dailies" when one was
  // credited. A tick can fail to credit for three distinct reasons -- the id is gone
  // from live S.tasks, creditYesterday()'s `if(t.done) return`, or the daily was not
  // actually due yesterday -- so its boolean return is the single source of truth
  // rather than re-deriving those predicates here. The data outcome was already
  // correct (see the 2026-08-18 note above); only the number was wrong.
  let credited = 0;
  _yesterMissed.forEach(t=>{
    if(!_yesterTick[t.id]) return;
    const live = S.tasks.find(x=>x.id===t.id);
    if(!live) return; // id no longer exists -- skip cleanly, never throw
    if(creditYesterday(live)) credited++;
  });
  document.getElementById('yScrim').classList.remove('show');
  document.getElementById('yScrim').innerHTML='';
  _yesterMissed=[]; _yesterTick={};
  // 2026-09-18 (round 2): persist unconditionally. creditYesterday() is documented
  // as staying silent for batch use, so persistence is the caller's job, and this
  // used to delegate it entirely to runCron() below. But runCron()'s FIRST
  // statement is `if(today <= S.lastCron) return;` with no save() -- and a sync
  // round landing while the modal is open merges lastCron up to today, which is
  // exactly the case this function's own 2026-08-18 note describes. Every credit
  // (XP, gold, MP, value, streak, done, doneDay, the history point) then existed
  // only in memory, and a reload before the next save-triggering action lost them
  // all, under a toast that said "Credited N dailies".
  if(credited>0 && typeof save==='function') save();
  runCron();            // finalize the day; corrected dailies are now done, so cron skips them
  render();
  if(credited>0) toast('Credited '+credited+' daily'+(credited===1?'':'s')+' from yesterday');
}
// ---- boot gate, layer 1: keep task cards inert until the first sync round settles ----
// D3 / todo 11, direction C. The first paint stays synchronous and UNGATED and
// _resetDailies() stays inside runCron() behind the gate, so a daily completed
// yesterday is still painted TICKED for up to BOOT_ROLLOVER_TIMEOUT_MS. That tick is
// stale-looking but correct; what must not happen is a tap on it reaching
// uncompleteDaily(), which decrements t.streak, stamps t.updatedAt, save()s (pushing
// to the other device) and flips t.done false so the later missedYesterdayDailies()
// reports a genuine completion as missed. See the plan's todo 11 constraint 2.
// `var`, not `let`: render()/toggle() are declared far above this line, so a TDZ
// window here would be reachable if anything ever paints earlier in boot.
// Set true ONLY by bootStartDay()'s deferring branch and cleared ONLY by its
// once-only runner (todo 13), which is the single entry point to startDay() on both
// boot branches -- so no boot path can leave a card permanently untappable.
var _bootRolloverPending = false;
// Pure predicate; guards the mutating card entry points as their FIRST statement.
function bootGateBlocksInput(){ return _bootRolloverPending; }
// Pure; prepended to the view HTML at render()'s single v.innerHTML assignment so the
// gate is visible and assertable from the rendered string. Layer 2's CSS rule
// (body.bootSyncing .task) lives in index.html and covers the whole card surface.
function _bootGateBanner(){ return _bootRolloverPending ? '<div class="syncGate">syncing…</div>' : ''; }
// Mirrors the connected gate defined in sync.js:18 (SYNC_KEY = "questa.sync.v1") and
// enforced in sync.js by `if(!cfg.enabled || !cfg.refreshToken) return Promise.resolve();`
// inside syncNow(). The localStorage read is INLINED rather than calling syncCfg(),
// because sync.js has not loaded yet at this point in boot -- same pattern as
// showSyncDebugOverlay() further up this file. If those sync.js lines ever diverge from
// this check, update this too: otherwise the boot gate silently stops waiting.
// Must never throw -- it runs on the boot path.
function _syncConfiguredForBoot(){
  var cfg = {}; try{ cfg = JSON.parse(localStorage.getItem("questa.sync.v1") || "{}"); }catch(e){}
  return !!(cfg && cfg.enabled && cfg.refreshToken);
}
// Pure: no globals, no DOM. Extracted so the boot gate's decision is unit-testable on
// its own return value (AGENTS.md §4), not merely covered through its caller.
// 2026-09-19 (round 3, item 15): the round-1 note called `elapsedMs`/`timeoutMs`
// dead. They are not dead IN HERE -- the body reads both, and
// tests/boot-gate-predicates.test.js exercises the predicate across real values
// and pins this exact signature by regex. What is degenerate is the ONE call
// site: bootStartDay() sets _bootRolloverT0 = Date.now() and passes
// Date.now() - _bootRolloverT0 on the very next statement, so elapsedMs is
// always ~0 and `0 < 8000` can never be false. The predicate therefore reduces
// to !!cfgConnected there. That is not a bug -- the real timeout is enforced by
// the scheduled timer further down, not by this call -- but a reader who
// assumes the elapsed check is live at boot will misread the gate. Left as a
// pure predicate on purpose: it is the testable unit, and the signature is
// pinned. Do not "simplify" it to take cfgConnected alone.
function shouldDeferDayRollover(cfgConnected, elapsedMs, timeoutMs){
  return !!cfgConnected && elapsedMs < timeoutMs;
}
// ---- boot gate, the decision (D3 / todo 13) ----
// Only the miss/credit DECISION is deferred, never the first paint. startDay()'s body
// is unchanged, so the decision path is identical whether it ran gated or ungated, and
// both IMPORT call sites of startDay() keep working untouched.
// Timeout rationale: sync.js waits 2000 ms before its first syncNow(), leaving ~6 s for
// the round trip -- inside SYNC_TRANSIENT_RETRY_DELAYS_MS[0] (1000) and never exposing
// the user to the 5 s / 25 s tiers. REASONED, NOT MEASURED: todo 16's on-device check
// (b) measures real boot-to-rollover latency and may raise this.
var BOOT_ROLLOVER_TIMEOUT_MS = 8000;
var _bootRolloverT0 = 0, _dayRolloverDone = false;
// Once-only runner. Whichever trigger fires first wins; the second is a no-op.
// THIS IS THE SINGLE ENTRY POINT TO startDay() ON THE BOOT PATH -- both branches of
// bootStartDay() go through it, configured and not, so _dayRolloverDone is always set
// and _bootRolloverPending is always cleared. Why that matters: sync.js's boot gate
// calls syncInit() UNCONDITIONALLY and syncInit() ends in setTimeout(syncNow, 2000),
// with syncNow() resolving immediately when not configured -- so onQuestaFirstSyncRound()
// fires ~2 s after EVERY boot, config or none. If the unconfigured branch called
// startDay() directly, that callback would run startDay() a second time, re-enter
// openYesterCheck() and its `_yesterTick = {}` would wipe every tick the user already
// made: streak zeroed and HP damage on a daily they actually completed.
function _runDayRollover(){
  if(_dayRolloverDone) return;
  _dayRolloverDone = true;
  _bootRolloverPending = false; // release the inert-card gate (todo 11) before painting
  startDay();
  try{ if(typeof _drainPendingQuickLog==='function') _drainPendingQuickLog(); }catch(e){} // android-quick-habit-log todo 1: apply a deep-link log stashed while the gate was closed
}
// The callback sync.js invokes when the first round settles. Top-level declaration so it
// is both a global sync.js can find and extractable for tests. Name is fixed by the plan.
function onQuestaFirstSyncRound(){ _runDayRollover(); }
// Replaces the straight-line boot `startDay();` call. Named so tests/_extract.js can
// reach it -- top-level script statements are not extractable.
function bootStartDay(){
  _bootRolloverT0 = Date.now();
  // Defensive per the handover: if this predicate ever throws, both the timer and the
  // synchronous fallback are skipped and the day NEVER rolls over -- the worst failure
  // mode in this plan. A throw is treated as "not configured". Also satisfies
  // AGENTS.md S1: a missing or broken sync.js must never break the app.
  var cfgConnected = false;
  try{ cfgConnected = _syncConfiguredForBoot(); }catch(e){ cfgConnected = false; }
  if(shouldDeferDayRollover(cfgConnected, Date.now() - _bootRolloverT0, BOOT_ROLLOVER_TIMEOUT_MS)){
    _bootRolloverPending = true; // ONLY in the branch that actually defers (todo 11)
    render();                    // constraint 1: first paint stays synchronous and ungated
    // Scheduled unconditionally here, BEFORE anything can await -- it is the only real
    // guarantee. sync.js's `reconcileDurableState().then(syncInit).catch(syncInit)` never
    // schedules syncInit()'s own 2000 ms timer if that promise never settles, so the
    // sync-side callback can simply never arrive. One guaranteed trigger plus one
    // best-effort early exit, not two equal triggers.
    setTimeout(_runDayRollover, BOOT_ROLLOVER_TIMEOUT_MS);
    return;
  }
  // Not configured (or already past the timeout): roll over synchronously, exactly as
  // before -- but THROUGH THE RUNNER, never by calling startDay() directly.
  // 2026-09-18 (round 2): even with sync NOT configured, the rollover must wait for
  // reconcileDurableState(). _runDayRollover -> startDay -> runCron ends in save(),
  // and save() rewrites the IndexedDB mirror with __seq = preBumpSeq + 1. Since
  // app.js runs to completion before sync.js reaches
  // `reconcileDurableState().then(syncInit)`, that write's transaction is created
  // FIRST, so reconcile then reads back the value save() just wrote: idbSeq equals
  // liveSeq, `idbSeq > liveSeq` is false, and the newer copy the mirror existed to
  // rescue -- every save the OS killed before flushing localStorage -- is gone, with
  // a reconcile:compare log entry reporting agreement. The gate's own comment says
  // reconcile "MUST resolve before syncInit()'s first sync round"; the real
  // precondition is before ANY save(). _runDayRollover is idempotent
  // (_dayRolloverDone), so the timer and the promise can both fire.
  if(typeof reconcileDurableState === "function"){
    _bootRolloverPending = true;
    render();                                       // first paint stays synchronous
    setTimeout(_runDayRollover, BOOT_ROLLOVER_TIMEOUT_MS);   // guaranteed trigger
    try{ reconcileDurableState().then(_runDayRollover, _runDayRollover); }
    catch(e){ _runDayRollover(); }
    return;
  }
  _runDayRollover();
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
function _resetDailies(){
  S.tasks.forEach(t=>{
    if(t.type==='daily'){
      t.done = false;
      (t.checklist||[]).forEach(c=>c.done=false);
    }
  });
}
function runCron(){
  const today = dayStamp(new Date());
  // 2026-09-18: ORDERING test, not equality. dayStamp ints sort, and a device's
  // local calendar day can move BACKWARDS (westward travel across a date line, a
  // user correcting a wrong clock, a pre-NTP boot clock that read ahead). With
  // `===` that rewind re-ran the whole reset: _resetDailies() cleared today's real
  // completions and checklist ticks, lastCron was written backwards, and when the
  // day returned cron ran a second time for it and applied miss damage + zeroed
  // the streak. sync.js:1374-1390 hardened mergedLastCron against exactly this;
  // runCron was never hardened. Regression test: tests/cron-day-rewind.test.js.
  if(today <= S.lastCron) return;
  if(S.prefs.paused){
    // 2026-09-18 (round 2): capture the PREVIOUS stamp before overwriting it. The
    // loop below used to read S.lastCron after this line had already set it to
    // today, so periodBoundaryCrossed was always called as (freq, today, today):
    // false for 'weekly' and 'monthly', true only via the 'daily' fall-through.
    // A weekly or monthly habit therefore never cleared its +/- tallies for the
    // whole pause window, and cResetOn was never stamped, so sync.js's
    // _accumCounter had no reset marker for those periods either.
    const _prevCron = S.lastCron;
    S.lastCron = today;
    S.prefs.pausedDays=((S.prefs.pausedDays||[]).concat([today])).filter((v,i,a)=>a.indexOf(v)===i).slice(-7);
    // 2026-09-18: habit +/- tallies are "this reset period" counters, not streak
    // state. Pause freezes streaks and miss damage only, so they must still clear
    // on their own boundary; the old early-return skipped the loop below and let
    // them accumulate for the whole pause window.
    S.tasks.forEach(t=>{
      if(t.type==='habit' && periodBoundaryCrossed(t.resetFreq||'daily', _prevCron, new Date())){ t.cUp=0; t.cDown=0; t.cResetOn=today; }
    });
    _resetDailies();
    save();
    return;
  }
  const dow = new Date().getDay();
  const yesterdayStamp = dayStamp(new Date(Date.now() - 86400000)); // F3: device-local calendar day before today, for t.missedOn
  const _cov=(S.prefs.pausedDays||[]).includes(yesterdayStamp);
  let totalDmg = 0;
  S.tasks.forEach(t=>{
    // 2026-09-18: t.cResetOn records WHICH local day cron last zeroed this habit's
    // tallies. sync.js's _accumCounter used to infer "cron reset it" from
    // `value < base`, which is both ambiguous (a user decrement looks identical)
    // and joint (it only fired when BOTH sides were below base). In the ordinary
    // staggered case — one device has crossed its boundary, the other has not —
    // the reset side's whole post-reset count was discarded. A frozen day stamp
    // makes the reset observable per side. Still no updatedAt bump: cron is a
    // deterministic day-boundary transform, not a user edit.
    if(t.type==='habit'){ if(periodBoundaryCrossed(t.resetFreq||'daily', S.lastCron, new Date())){ t.cUp=0; t.cDown=0; t.cResetOn=today; } return; } // F3 (2026-07-11): cron no longer bumps updatedAt — see .omo/plans/2026-07-11-cron-merge-recency.md §3.1.4
    if(t.type!=='daily') return;
    const scheduledYesterday = isDailyDueOn(t, (dow+6)%7);  // intentional YESTERDAY test — do NOT use isDailyDueToday
    if(scheduledYesterday && !t.done && !_cov){
      const dmg = missDamage(t);
      totalDmg += dmg;
      t.value = clamp(t.value - valueDelta(t.value), -47.27, 99);
      t.streak = 0;
      t.missedOn = yesterdayStamp; // F3 (2026-07-11): recency channel for cron-aware merge — cleared on completion/credit
      // 2026-09-18 (round 2): stamp the miss on YESTERDAY, the day it belongs to —
      // the same day t.missedOn records one line above. See logHistory's atMs note.
      logHistory(t,{value:t.value,completed:false,isDue:true,repeat:(t.repeat||[]).slice()}, Date.now()-86400000);
      const cl=(t.checklist||[]);
      logEvent({kind:'miss', taskType:'daily', taskId:t.id, taskTitle:t.title,
                dmg: dmg,
                repeat:(t.repeat||[]).slice(),
                checklist:cl.map(c=>({id:c.id||null,text:c.text,done:!!c.done}))});
    }
    // F3 (2026-07-11): no updatedAt bump here any more — cron is a deterministic
    // day-boundary transform, not a user edit; recency must encode user intent
    // only, or it swallows same-day completions in mergeCollection's both-changed
    // tiebreak (see .omo/plans/2026-07-11-cron-merge-recency.md §1-§3).
  });
  _resetDailies(); // F4 (2026-07-11): never stamps touchedAt here either — cron is not a user edit; see mergeChecklist (sync.js)
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
// Pristine copy of the task as it was when the edit sheet opened, so saveTask()
// can tell "the user changed this field" from "this field is just old"
// (2026-09-18 round 2 — see openEdit / saveTask).
let EDIT_BASE=null;
// FILTER, FILTEROPEN, and per-tab scroll positions persist in S.prefs
function ensureUiPrefs(){
  S.prefs = S.prefs || {};
  if(!S.prefs.filter) S.prefs.filter = {habits:'all', dailies:'all', todos:'active'};
  if(!S.prefs.sort) S.prefs.sort = {habits:'manual', dailies:'manual', todos:'manual', rewards:'manual'};
  if(!S.prefs.tagFilter) S.prefs.tagFilter = {habits:[], dailies:[], todos:[]};
  if(S.prefs.filterOpen===undefined) S.prefs.filterOpen=false;
  if(!S.prefs.scroll) S.prefs.scroll = {};
  if(S.prefs.paused===undefined) S.prefs.paused=false;
  if(!Array.isArray(S.prefs.pausedDays)) S.prefs.pausedDays = [];
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
  if(bootGateBlocksInput()){ toast('Syncing…'); return; } // D3 todo 11: MUST stay the first statement
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
    else { a.style.backgroundImage=''; a.textContent=c.face; }
    // Pause indicator: sleeping avatar
    const avatarContainer = a.closest('.avatar');
    if(avatarContainer){
      if(S.prefs.paused){ avatarContainer.classList.add('paused'); }
      else { avatarContainer.classList.remove('paused'); }
    }
  })();
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
  // Pause badge near stats
  const statsContainer = document.getElementById('statGold')?.parentElement;
  if(statsContainer){
    let badge = statsContainer.querySelector('.pauseBadge');
    if(S.prefs.paused){
      if(!badge){
        badge = document.createElement('span');
        badge.className = 'pauseBadge';
        badge.textContent = '⏸️ Paused';
        statsContainer.appendChild(badge);
      }
    } else if(badge){
      badge.remove();
    }
  }
}
function metaRow(t){
  const tagsHtml = tagChips(t);
  const notesPreview = (t.notes && S.prefs.notesLines>0)
    ? '<div class="notes" style="-webkit-line-clamp:'+(Number(S.prefs.notesLines)||0)+';line-clamp:'+(Number(S.prefs.notesLines)||0)+'">'+esc(t.notes)+'</div>' : '';
  const chk = checklistBlock(t);
  if(!tagsHtml && !notesPreview && !chk) return '';
  const metaHtml = tagsHtml ? '<div class="meta">'+tagsHtml+'</div>' : '';
  return metaHtml+notesPreview+chk;
}
// the right-side rail: counter/streak + subtask toggle, pinned to top of card
function rail(t){
  let items = [];
  items.push('<span class="railItem diff-'+esc(t.difficulty)+'">'+esc(t.difficulty)+'</span>');
  const hasRem = t.reminders && t.reminders[0] && t.reminders[0].enabled;
  if(hasRem){
    items.push('<span class="railItem bell" title="Reminder set" style="color:var(--accent);border-color:transparent;background:transparent;padding:0 2px;font-size:11px">🔔</span>');
  }
  if(t.type==='daily'){
    // Display-only gate (prefs.showStreaks, default on). Streaks keep being
    // counted, reset and synced while hidden — this only omits the badge.
    if(S.prefs.showStreaks !== false){
      items.push('<span class="railItem streak" title="Day streak">🔥 '+(t.streak||0)+'</span>');
    }
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
  // 2026-09-18: sortActive has no dependency on FILTER, so computing it inside the
  // FILTER[tabKey] guard left the Rewards column's sort icon permanently un-lit —
  // FILTER only carries habits/dailies/todos, while Rewards does have a real sort.
  if(tabKey) sortActive = sortActiveFunc(tabKey);
  if(tabKey && FILTER[tabKey]){
    const defaultVal = tabKey==='todos'?'active':'all';
    filterActive = FILTER[tabKey]!==defaultVal || (S.tags && S.tags.length > 0 && S.prefs.tagFilter && S.prefs.tagFilter[tabKey] && S.prefs.tagFilter[tabKey].length > 0);
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
// 2026-09-18: renameTag() removed. It had no callers anywhere (app.js, sync.js,
// index.html, tests/) and it would not have refreshed the UI if wired up, since it
// called save() without render(). Re-add it WITH a render() if a rename control is
// ever built.
// 2026-09-19 (round 3, item 14): deleteTag() removed for the same two reasons, and the
// line above used to claim "the tag editor offers add, toggle and delete only" -- it
// does not. deleteTag() had zero callers repo-wide, so that sentence described a
// control that has never existed, and it also called save() without render(). Its body
// is the recipe if the control is ever built: delMark(id) for the tombstone, drop the
// id from S.tags, strip it from every task's tags array, strip it from every TAGFILTER
// list, then save() AND render(). The tag editor offers add and toggle only.
function tagChips(t){ const ids=taskTags(t); if(!ids.length) return '';
  return '<span class="tagChips">'+ids.map(id=>{ const g=tagById(id); if(!g) return '';
    return '<span class="tagChip" style="--tc:'+esc(g.color)+'">'+esc(g.name)+'</span>'; }).join('')+'</span>'; }
// tag filter (per screen, OR)
function toggleTagFilter(tab,id){ TAGFILTER[tab]=TAGFILTER[tab]||[]; const i=TAGFILTER[tab].indexOf(id);
  if(i<0) TAGFILTER[tab].push(id); else TAGFILTER[tab].splice(i,1); S.prefs.tagFilter=TAGFILTER; save(); render(); }
function clearTagFilter(tab){ TAGFILTER[tab]=[]; S.prefs.tagFilter=TAGFILTER; save(); render(); }
function tagFilterActive(tab){ return ((TAGFILTER[tab]||[]).length>0); }
function applyTagFilter(list,tab){ const sel=(TAGFILTER[tab]||[]); if(!sel.length) return list;
  // 2026-09-18: resolve before counting. "None" means "shows no tag chips", and
  // tagChips() already drops an id with no matching S.tags entry. Keying on the raw
  // array length made a task whose only tags are DANGLING ids (device A deletes a
  // tag while device B edits a task still carrying it — a normal merge outcome)
  // render with no chips yet be hidden by the None filter too, so it was
  // unreachable from every filter.
  return list.filter(t=>{ const tt=taskTags(t).filter(id=>tagById(id)); return sel.some(id=>id==='none'?tt.length===0:tt.indexOf(id)>=0); }); }
function tagFilterBar(tab){
  if(!FILTEROPEN) return ''; ensureTags(); if(!S.tags.length) return '';
  const sel=(TAGFILTER[tab]||[]);
  const noneActive = sel.indexOf('none') >= 0;
  const noneBtn = '<button class="tagBtn' + (noneActive ? ' on' : '') + '" style="--tc:var(--muted)" onclick="toggleTagFilter(\''+tab+'\',\'none\')">None</button>';
  return '<div class="filterBar tagFilterBar"><span class="sortLbl">Tags</span>'+
    noneBtn+
    S.tags.map(g=>'<button class="tagBtn'+(sel.indexOf(g.id)>=0?' on':'')+'" style="--tc:'+esc(g.color)+'" onclick="toggleTagFilter(\''+jsq(tab)+'\',\''+jsq(g.id)+'\')">'+esc(g.name)+'</button>').join('')+
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
      return '<span class="tagChip on" style="--tc:'+esc(g.color)+'" onclick="toggleEditTag(\''+jsq(id)+'\')">'+esc(g.name)+' \u00d7</span>'; }).join('')
    : '<span class="tagNone">No tags yet.</span>';
  h+='</div>';
  const others=S.tags.filter(g=>own.indexOf(g.id)<0);
  if(others.length){ h+='<div class="tagEdit tagPick">'+others.map(g=>'<span class="tagChip" style="--tc:'+esc(g.color)+'" onclick="toggleEditTag(\''+jsq(g.id)+'\')">+ '+esc(g.name)+'</span>').join('')+'</div>'; }
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
    '<div class="meta"><span class="pill">'+esc(String(r.cost))+' gold</span>'+(r.notes?'<span>📝</span>':'')+'</div></div></div>').join('')
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
// Local-calendar-day key (device timezone). The heatmap and all date labels
// use device-local days (see dayStamp/runCron), so day buckets MUST key on
// LOCAL midnight, not UTC midnight, or events shift by the tz offset.
function localDayKey(ms){ const d=new Date(ms); d.setHours(0,0,0,0); return d.getTime(); }
// 2026-09-18 (round 2): step to the NEXT local midnight. Walking a day grid with
// `d += 86400000` from a local midnight is only correct in a zone with no DST: a
// 23-hour or 25-hour day leaves the cursor an hour off, and from then on the keys
// are no longer local midnights at all. Everything that looks them up (compMap,
// the pre-seeded dayMap, the heatmap cells) keys on localDayKey, so the walk
// silently stopped matching — NaN totals from `undefined + n`, a flat all-zero
// series, a duplicated or missing heatmap cell, and every weekday row shifted by
// one from that column on.
function nextLocalDay(ms){ const d=new Date(ms); d.setHours(0,0,0,0); d.setDate(d.getDate()+1); return d.getTime(); }
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
  // 2026-09-18: no metric configured means MATCH NOTHING. A null/undefined arg used
  // to fall through to the default branch with kw='', and `title.includes('')` is
  // true for every string — so after the user deleted their last metric the
  // dashboard section titled "(no metric)" silently totalled the reps of every habit
  // in the app and listed them all under "Matched habits".
  if(arg==null){
    return { match: () => false, reps: () => 0, keyword: '' };
  }
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
      // 2026-09-18 (round 2): the override is a reps-per-TAP multiplier, so it only
      // applies where there are taps. scoredUp is written by exactly one path
      // (scoreHabit's scored dir>0 branch); bulk reps from the rep sheet (addReps)
      // and Log habits record `reps` with NO scoredUp, so `ov*(e.scoredUp||0)` was
      // `ov*0` — every precisely logged rep read as 0, and the dashboard total for
      // that habit dropped to zero the moment an override was set.
      reps:  e => { const ov=map[e.taskId]; return (ov==null || !e.scoredUp) ? e.reps : ov*e.scoredUp; },
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
function anWindow(noFloor){
  const p=anPrefs(); const now=Date.now();
  const [mn]=anSpan();
  let to=now - (p.toOff||0)*DAY;
  let from=now - (p.fromOff||90)*DAY;
  if(p.snap==='all'){ 
    if(noFloor){ from=0; to=now; } else { from=mn; to=now; }
  }
  if(!noFloor && from<mn) from=mn;
  if(to>now) to=now;
  if(from>to) from=to;
  return [from,to];
}
/**
 * @note Feed-only noFloor mode creates a deliberate chart/feed x-axis divergence — charts use clamped window, feed uses unclamped.
 */
// 2026-09-19 (round 3, item 15): the rule is "the FIRST digit run anywhere in
// the title", and the round-1 note is right that it is loose -- "Read 2 chapters
// of book 3" gives 2, and "Chapter 3 review x10" gives 3 rather than 10.
// Owner's call 2026-09-19: LEAVE IT. Every habit already in the wild was named
// under this rule, and tightening it to an explicit marker ("x10" / "10x")
// would silently drop any bare-number habit back to 1 rep per tap -- a change
// to counts the user never asked for, applied retroactively to their history.
// If this is ever revisited it needs a migration, not a parser swap.
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
    const day=localDayKey(e.date);
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
    const d=localDayKey(e.date);
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
    day[localDayKey(e.date)]=1;
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
    const d=localDayKey(e.date);
    day[d]=day[d]||{done:0,tot:0};
    day[d].tot++; if(e.completed) day[d].done++;
  });
  return Object.keys(day).sort((a,b)=>a-b).map(d=>({d:+d,pct:day[d].tot?day[d].done/day[d].tot:0,done:day[d].done,tot:day[d].tot}));
}
function anIntensity(from,to){
  const day={};
  anAllEvents().forEach(e=>{
    if(e.date<from||e.date>to)return;
    const d=localDayKey(e.date);
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
      // 2026-09-18 (round 2): null-aware, not `||`. A legitimate fromOff of 0 (window
      // start = today) is falsy, so `p.fromOff||totalDays` replaced it with totalDays
      // and the "never cross" clamp became a no-op: normRange then SWAPPED the
      // handles and a one-day nudge of the right handle silently committed a
      // full-history window, persisted for the next visit.
      if(which===0) p.fromOff=Math.min(Math.max(off, (p.toOff==null?0:p.toOff)), totalDays);
      else p.toOff=Math.max(Math.min(off, (p.fromOff==null?totalDays:p.fromOff)), 0);
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
      // 2026-09-18 (round 2): clearing the markup alone was a guard that did not
      // guard. MEDIT stayed populated with the OLD metric's _mid, and the
      // refreshAnalytics() on the next line rebuilds #anBody and then runs
      // `if(MEDIT && !MBUILD) drawMetricEditor()` — re-rendering the previous
      // metric's editor underneath the newly selected chip. The user edits what
      // looks like the new metric and Save resolves _mid to the old one, destroying
      // its keyword / habit list with no undo. mCancel already nulls MEDIT here.
      MEDIT=null;
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
    // 2026-09-18 (round 2): keep SIGNED values. addReps is documented as "n is
    // signed: positive adds, negative removes" and anCumulativeReps honours that
    // with `total += r`. `if(val>0)` discarded the correcting event entirely, so a
    // +50 followed by a -50 read as 50 in every custom reps view while the
    // dashboard card correctly read 0.
    anAllEvents().forEach(e=>{ const it=idset[e.taskId]; if(!it) return; const r=('reps'in e)?(e.reps||0):0; const val=r||e.scoredUp||0; if(val) out.push({ts:e.date,v:val,item:it,title:e.title}); });
  }
  else if(src==='metric'){
    const m=anViewMetric(v); if(m){ const M=anMatcher(m);
      // signed, same reason as the 'reps' branch above (2026-09-18 round 2)
      anAllEvents().forEach(e=>{ if(!M.match(e)) return; const r=M.reps?M.reps(e):0; const val=(r||0)||e.scoredUp||0; if(val) out.push({ts:e.date,v:val,item:null,title:e.title}); }); }
  }
  return out;
}
// the reps-metric a 'metric' view points at (by id), with sensible fallbacks
function anViewMetric(v){ const ms=(anPrefs().metrics||[]); return ms.find(m=>m.id===(v&&v.metricId)) || ms.find(m=>m.id===anPrefs().activeMetric) || ms[0] || null; }
function anBucket(events,group,from,to){
  const ev=events.filter(e=>e.ts>=from&&e.ts<=to);
  if(group==='day'){
    const day={}; ev.forEach(e=>{ const d=localDayKey(e.ts); day[d]=(day[d]||0)+e.v; });
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
  // 2026-09-18: LOCAL midnight, matching localDayKey() — which is what the walk
  // below and compMap already use. Math.floor(ms/DAY)*DAY is UTC midnight, so in
  // any non-UTC timezone the pre-seeded keys and the written keys never matched:
  // every write landed on an uninitialised key (undefined + n = NaN) while the
  // seeded keys stayed 0. Result: a flat all-zero series for every day/week/month
  // Incomplete/Streaks/Tag-count view, and a NaN max that broke heatmap colours.
  const midnightFrom = localDayKey(from);
  const midnightTo = localDayKey(to);
  const dayMap = {};
  const series = [];
  for (let d = midnightFrom; d <= midnightTo; d = nextLocalDay(d)) dayMap[d] = 0;
  items.forEach(t => {
    if (src === 'streaks' && t.type !== 'daily') return;
    const cMs = createdMs(t) || 0;
    if (cMs > to) return;
    let compMap = null;
    if (t.type === 'daily') {
       compMap = {};
       (t.history || []).forEach(p => {
         if (p.completed && typeof p.date === 'number') {
           compMap[localDayKey(p.date)] = true;
         }
       });
    }
    let curStreak = 0;
    let walkD = localDayKey(cMs);
    for (let d = walkD; d <= midnightTo; d = nextLocalDay(d)) {
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
                if (!t.completedAt || localDayKey(t.completedAt) > d) dayMap[d]++;
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
  for (let d = midnightFrom; d <= midnightTo; d = nextLocalDay(d)) {
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
  h+='<label>Name</label><input type="text" id="vName" value="'+esc(VDRAFT.name)+'" oninput="VDRAFT.name=this.value" placeholder="e.g. Weekly completions">';
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
      const a=anPrefs(); a.views=a.views||[]; let n=0, capped=0;
      // 2026-09-18: honour the same 20-view cap cloneView/newView/saveView enforce.
      // Import was the one path with no check, so a file with 50 views produced a
      // "Custom views (50/20)" header and silently broke the invariant.
      arr.forEach(v=>{ if(!v||!v.source) return; if(a.views.length>=20){ capped++; return; } a.views.push({id:uid(), name:v.name||'Imported view', source:v.source, group:v.group||'day', chart:v.chart||'line', tags:Array.isArray(v.tags)?v.tags:[], types:Array.isArray(v.types)?v.types:[], metricId:v.metricId||null, createdAt:Date.now(), updatedAt:now()}); n++; });
      if(n){ a.activeView=a.views[a.views.length-1].id; }
      save(); refreshAnalytics(); toast('Imported '+n+' view'+(n===1?'':'s')+(capped?(' · '+capped+' skipped (max 20)'):''));
    } catch(e){ alertDialog('Error', 'That file does not look like Questa views.'); } };
  rd.readAsText(f);
}
function refreshAnalytics(){
  const p=anPrefs(); const w=anWindow(); const from=w[0], to=w[1];
  const wf = anWindow(true); // unclamped window for feed
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
  renderEventDetail(wf[0], wf[1]);
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
  if (e.kind === 'conflictResolved') return CONFLICT_CATEGORY;
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
function isFeedNoise(e){
  return DIAGNOSTIC_KINDS.indexOf(e.kind) >= 0;
}
const CONFLICT_CATEGORY = 'conflict';
function _evCatBadgeName(cat){ return {habit:'Habit',daily:'Daily',todo:'To-do',system:'System',conflict:'Conflict'}[cat]||'Event'; }
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
// 2026-09-19 (round 3, item 15): split out so a caller can ask "is there a
// REGISTERED name?" without being handed the truncated-id fallback. Returns ''
// when the device is unknown or its name is blank/whitespace.
function deviceRegisteredName(devices, devId){
  if(!devId) return '';
  const d = (devices||[]).find(x=>x && x.id===devId);
  return d && d.name ? String(d.name).trim() : '';
}
// Unchanged contract: a truthy devId always yields something printable. The
// truncated id is the LAST resort, which is exactly why the event-log fallback
// below had to stop going through this function -- see the call site.
function deviceDisplayName(devices, devId){
  if(!devId) return '';
  // Deliberately NOT delegating to deviceRegisteredName: several tests pull
  // this function out of app.js by name with _extract.js and run it alone, so
  // it has to stay self-contained. The three lines are duplicated on purpose.
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
    // T7: Build device name cache Map for this render pass (avoids repeated deviceDisplayName calls)
    const deviceNameCache = new Map();
    function getCachedDeviceName(devId){
      if(!devId) return '';
      if(deviceNameCache.has(devId)) return deviceNameCache.get(devId);
      // 2026-09-19 (round 3, item 15): this used to start with
      // deviceDisplayName(), whose own `|| String(devId).slice(0,6)` is never
      // falsy for a truthy devId -- so the `|| devNameFromEvents[devId]` rung
      // could never be reached and the feed showed a 6-character id even when
      // the device had broadcast its real name in a `devicename` event. Ask for
      // the REGISTERED name only, so the intended precedence actually runs:
      // registered name, then the event-sourced name, then the truncated id.
      const name = deviceRegisteredName(S.devices, devId) || devNameFromEvents[devId] || String(devId).slice(0,6);
      deviceNameCache.set(devId, name);
      return name;
    }

    // Filter events
    const filtered = sorted.filter(e=>{
      const cat = getEventCategory(e);
      // T7: conflictResolved has its own toggle, separate from hideSyncDiag
      if(cat === CONFLICT_CATEGORY){
        if(S.prefs && S.prefs.hideConflictDecisions) return false;
      } else if(S.prefs && S.prefs.hideSyncDiag && isFeedNoise(e)){
        return false;
      }
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
      h+='<div id="evOverview" class="evOverview"></div>';
      
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

    // 2026-09-18 (round 2): update the summary on EVERY pass. This assignment used
    // to live inside the `if(!feedContent)` build branch, so it ran only on the
    // first render: after any chip, search or page change the list below updated
    // while the header still reported the original unfiltered count.
    {
      const eo = document.getElementById('evOverview');
      if(eo) eo.textContent = filtered.length + ' events shown in feed';
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
      const titleHtml = e.taskTitle ? '<strong class="evTaskClick" onclick="evSetSearch(\'' + jsq(e.taskTitle) + '\')">' + esc(e.taskTitle) + '</strong>' : '';

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
        } else {
          icon = '⚙️';
          desc = esc(e.taskTitle || 'System action');
        }
      } else if (cat === 'conflict') {
        badgeName = 'Conflict';
        badgeClass = 'evBadge-conflict';
        if (e.kind === 'conflictResolved') {
          icon = '⚖️';
          var _ct = e.taskTitle || e.charTitle || 'item';
          // T4/T7: prefer new winnerDev/loserDev/reason fields, fall back to legacy winner/loser
          // F5 (2026-08-18): resolve winnerDev to a DISPLAY NAME, never print a raw
          // device id. getCachedDeviceName wraps deviceDisplayName and memoises per
          // render pass; it truncates with .slice(0,6) -- the display convention. Do NOT
          // use sync.js's .slice(-6), which is the backup-FILENAME convention.
          // A device id is absolute, so this now reads the SAME on both devices. That is
          // the fix: the relative word "remote" meant a different device on each side.
          // An old-shape event has no winnerDev and still falls through the || chain to
          // the legacy wording, unchanged.
          var _winner = (e.winnerDev ? getCachedDeviceName(e.winnerDev) : '') || e.winnerDev || e.winner || 'remote';
          // _loser is emitted for tools/join_exports.py, which documents and maps it.
          // It is deliberately not rendered -- do not delete it as unused.
          var _loser = e.loserDev || e.loser || 'local';
          var _reason = e.reason ? ' \u00b7 ' + esc(e.reason) : '';
          desc = 'Sync conflict resolved \u00b7 ' + esc(_ct) + ' \u00b7 kept ' + esc(_winner) + '\'s copy' + _reason;
        } else {
          icon = '⚖️';
          desc = esc(e.taskTitle || 'Conflict event');
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
      const _devLabelName = getCachedDeviceName(e.dev);
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
  }).catch((e)=>{
    // 2026-09-19 (round 3): this was a bare `catch(()=>{})`. It threw the cause
    // away and then printed a message BLAMING IndexedDB, so an ordinary
    // TypeError in the row-building code above looked exactly like private
    // browsing. That is not hypothetical: tests/debug-pager.test.js rendered
    // nothing for months and reported "Event log unavailable" while the real
    // fault was a missing dependency, and there was no way to tell from the
    // screen or from a diagnostics bundle. Record the cause.
    //
    // Diagnostics ring ONLY, deliberately not logEvent(): this runs inside the
    // event-feed render, and writing an event from here would both feed the
    // list being rendered and need a new entry in DIAGNOSTIC_KINDS to avoid
    // showing up as ordinary user activity.
    try{
      if(typeof _qDiagPush==="function"){
        _qDiagPush('eventFeedRenderFailed', { error: String((e && e.stack) || (e && e.message) || e).slice(0, 400) });
      }
    }catch(_){}
    const cur=document.getElementById('anEventDetail'); if(!cur) return;
    cur.innerHTML='<div class="k">From IndexedDB event log</div>'+
      '<div class="anNote">Event log unavailable. This is usually IndexedDB being blocked (private browsing), but it can also be a rendering fault \u2014 the reason is recorded in the diagnostics bundle. History-based charts above are unaffected.</div>';
  });
}
function anHeatmapHTML(from,to,inten,maxI){
  // 2026-09-18: derive the grid bounds from LOCAL midnight directly. The old
  // two-step (floor to UTC midnight, THEN setHours(0,0,0,0)) landed on the previous
  // local day whenever the window edge's local time-of-day fell in the early-morning
  // band that maps to the prior UTC day — shifting the whole heatmap by one column
  // for every timezone ahead of UTC. The cell lookup below already uses localDayKey.
  const start=new Date(localDayKey(from));
  start.setDate(start.getDate()-((start.getDay()+6)%7)); // week starts Monday: top cell = Mon, bottom = Sun
  const end=new Date(localDayKey(to));
  let cols='', col='', dow=0;
  for(let t=start.getTime(); t<=end.getTime(); t=nextLocalDay(t)){
    const v=inten[localDayKey(t)]||0;
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
  v.innerHTML = _bootGateBanner() + (TAB==='habits'?viewHabits() : TAB==='dailies'?viewDailies() : TAB==='todos'?viewTodos() : TAB==='analytics'?viewAnalytics() : viewRewards());
  if(TAB==='analytics') initAnalytics();
  document.body.classList.toggle('tab-analytics', TAB==='analytics');
  document.body.classList.toggle('bootSyncing', _bootRolloverPending); // D3 todo 11 layer 2
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
// 2026-09-19 (round 3, item 15): backgrounding a tab fires BOTH
// visibilitychange(hidden) and pagehide -- that is the normal mobile sequence,
// not an edge case -- so one user action ran flushState twice: two save()
// round trips (each a full JSON.stringify(S) plus a localStorage write and an
// IndexedDB mirror), two saveScroll() writes, and two 'lifecycle' rows in the
// diagnostic ring, which made the ring's own history read as if the user had
// backgrounded twice. Coalesce repeats inside a short window. This cannot lose
// a write: the second call is redundant precisely because the first one
// already flushed the same state microseconds earlier, and a genuinely later
// flush (a real second backgrounding, or a beforeunload after some work) is
// always outside the window. The sibling pair at the bottom of this file fires
// takeSnapshot(), not flushState, and is already deduplicated by IS_DIRTY --
// do not conflate the two.
var _lastFlushAt = 0;
var FLUSH_COALESCE_MS = 400;
function flushState(){
  var _t = Date.now();
  if((_t - _lastFlushAt) < FLUSH_COALESCE_MS) return;
  _lastFlushAt = _t;
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
    // 2026-09-18 (round 2): in-place permutation of the VISIBLE rows only, the same
    // shape the task branch below was given. `sort((a,b)=>order.indexOf(a.id)-...)`
    // gives every reward missing from `order` an index of -1, which sorts it ahead
    // of everything on screen — so dragging one reward while the Rewards search box
    // was active silently hoisted every hidden reward to the top and persisted it.
    // dragOK('reward') only disables dragging for an active SORT, not for a search.
    const orderSet = new Set(order);
    const moved = order.map(id => S.rewards.find(r => r && r.id === id)).filter(Boolean);
    let mi = 0;
    S.rewards = S.rewards.map(r => (r && orderSet.has(r.id)) ? (moved[mi++] || r) : r);
  } else {
    // Reorder ONLY the same-type tasks that are actually on screen, in place.
    // 2026-09-18: the old rebuild was `S.tasks = others.concat(sameType)`, where
    // sameType came solely from the rendered cards. Every same-type task hidden
    // by the active filter/search/tag filter was in neither list and was DELETED
    // — reachable on defaults (the To-Dos tab hides completed items, so one drag
    // erased them all). Now hidden tasks keep their slots and only the visible
    // slots are permuted. Regression test: tests/commit-order-hidden.test.js.
    const typeOfTab = TAB==='habits'?'habit':TAB==='dailies'?'daily':'todo';
    const orderSet = new Set(order);
    const moved = order.map(id=>S.tasks.find(t=>t.id===id))
                       .filter(t=>t && t.type===typeOfTab);
    let _mi = 0;
    S.tasks = S.tasks.map(t=>{
      if(t.type!==typeOfTab || !orderSet.has(t.id)) return t; // hidden or other type — untouched
      return moved[_mi++] || t;
    });
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
// Heatmap cells: tap selects & pins a tooltip, but we must NOT capture touchmove
// (no preventDefault) so the browser can natively pan the .anHeat container
// horizontally. The slide-to-preview behavior from bindTips() would kill scrolling.
function bindHeatTooltips(){
  bindGlobalDismiss();
  document.querySelectorAll('.anHeatCell[data-tip]').forEach(el=>{
    const hover=e=>{ if(_selEl) return; clearTimeout(_tipTimer);
      const x=e.clientX, y=e.clientY, delay=tipDelayMs();
      if(delay<=0) showTip(el.dataset.tip,x,y,false);
      else _tipTimer=setTimeout(()=>{ if(!_selEl) showTip(el.dataset.tip,x,y,false); },delay);
    };
    el.addEventListener('mouseenter',hover);
    el.addEventListener('mousemove',hover);
    el.addEventListener('mouseleave',()=>{ if(!_selEl) hideTip(); });
    el.addEventListener('click',e=>{ e.stopPropagation(); selectEl(el,false); });
    // touch: a tap (no significant move) selects; a drag is left for native pan-x scroll
    let sx=0, sy=0;
    el.addEventListener('touchstart',e=>{ const t=e.touches&&e.touches[0]; if(!t)return; sx=t.clientX; sy=t.clientY; },{passive:true});
    el.addEventListener('touchend',e=>{ const t=e.changedTouches&&e.changedTouches[0]; if(!t)return;
      if(Math.abs(t.clientX-sx)<10 && Math.abs(t.clientY-sy)<10) selectEl(el,true); },{passive:true});
  });
}
function toggle(id, ev){
  if(bootGateBlocksInput()){ toast('Syncing…'); return; } // D3 todo 11: MUST stay the first statement
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
  // 2026-09-18: a card can be tapped after a background sync merge tombstoned its
  // task but before the next render(). find() then returns undefined and
  // JSON.parse(JSON.stringify(undefined)) throws a SyntaxError, so the sheet never
  // opens and nothing tells the user why. Fail visibly instead.
  if(id && !t){ toast('That task no longer exists'); render(); return; }
  EDIT = JSON.parse(JSON.stringify(t));
  // 2026-09-18 (round 2): keep a pristine copy of what the record looked like when
  // the sheet opened. saveTask() used to do `S.tasks[idx]=EDIT`, writing this whole
  // stale clone back over the live record and stamping it updatedAt=now(), so
  // anything a background sync merged into the task while the sheet was open --
  // a peer's new subtask, a streak, a completion -- was erased AND won every
  // downstream merge. Worse, a subtask present in base and remote but now missing
  // locally reads to mergeChecklist as a local deletion, so it is deleted fleet-wide.
  // With this baseline, saveTask writes back only the fields the sheet changed.
  EDIT_BASE = JSON.parse(JSON.stringify(t));
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
      // (t.repeat||[]) — same missing-array case as the Repeat-on grid below
      const activeDays = (t.repeat||[]).map((r, i) => r ? dayLabels[i] : '').filter(Boolean).join(', ');
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
  h+='<label>Title</label><input type="text" id="eTitle" value="'+esc(t.title)+'" oninput="EDIT.title=this.value" placeholder="What needs doing?">';
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
    // 2026-09-18 (round 2): `t.repeat[i]` threw on a daily with no repeat array, and
    // openEdit calls drawSheet() BEFORE it shows the scrim -- so the sheet never
    // opened, no error, nothing happened at all. Because Delete lives inside the
    // sheet, such a task could no longer be edited OR deleted from the UI. migrate()
    // normalises reminders, checklist ids and updatedAt but never repeat, and every
    // other reader in this file already defends it with `(t.repeat||[])`.
    if(!Array.isArray(t.repeat)) t.repeat = [true,true,true,true,true,true,true];
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
  h+='<label>Notes / comments</label><textarea id="eNotes" oninput="EDIT.notes=this.value" placeholder="Notes, thoughts, log...">'+esc(t.notes)+'</textarea>';
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
  // 2026-09-18 (round 2): guard the item and its text, matching copyEditTask's
  // `c && (c.text||'').trim()`. mergeChecklist only filters on `x && x.id != null`,
  // so a peer or an imported backup can land a text-less subtask in S.tasks; the
  // bare `c.text.trim()` then threw a TypeError out of saveTask BEFORE anything was
  // written, so Save did nothing at all and the whole edit was lost with no message.
  EDIT.checklist=(EDIT.checklist||[]).filter(c=>c && (c.text||'').trim());
  if (EDIT._reminderEnabled) {
    const kind = EDIT.type === 'todo' ? 'once' : (EDIT.type === 'daily' ? 'daily' : 'weekly');
    const _prevRem = (EDIT.reminders && EDIT.reminders[0]) || null;
    const r = {
      id: _prevRem ? _prevRem.id : uid(),
      enabled: true,
      kind: kind,
      time: EDIT._tempReminderTime || '09:00',
      lastFiredKey: _prevRem ? _prevRem.lastFiredKey : ""
    };
    // A reminder that is brand new, or that just moved to a different time of day,
    // must not instantly fire as "missed" for a slot that passed before it existed.
    // Burn today's key for that slot so the first real fire is tomorrow's.
    if (!_prevRem || _prevRem.time !== r.time) {
      const _now = new Date();
      const _nowStr = String(_now.getHours()).padStart(2,'0') + ':' + String(_now.getMinutes()).padStart(2,'0');
      r.lastFiredKey = (r.time < _nowStr) ? reminderFireKey(r, _now) : "";
    }
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
    // 2026-09-18: bail before touching `orig`. When a concurrent sync merge tombstoned
    // this task while its sheet was open, idx was -1 and the next line's
    // `(orig.checklist||[])` threw a TypeError — aborting saveTask() before anything
    // was persisted or the sheet closed, so the whole edit was lost silently.
    if(idx<0){ toast('That task no longer exists'); closeSheet(); render(); return; }
    const orig = S.tasks[idx];
    // F4 (2026-07-11): id-based touchedAt stamping for mergeChecklist (sync.js).
    // Independent of the index-based diff further below (that one only feeds
    // the display-only edit-history event and stays untouched).
    // 2026-09-18 (round 2): the sheet's OPEN-TIME baseline. Every "did the user
    // change this?" test below measures against it, never against the live record —
    // a background sync merge may have moved the live record since the sheet opened.
    const _base = EDIT_BASE || orig;
    (function(){
      const _baseById = new Map((_base.checklist||[]).filter(c=>c&&c.id!=null).map(c=>[c.id,c]));
      (EDIT.checklist||[]).forEach(c=>{
        if(!c) return;
        if(!c.id) c.id = uid(); // defensive backfill (F4 2026-07-11) — mirrors toggleSub, see .omo/plans/2026-07-11-subtask-granular-merge.md §3
        const o = _baseById.get(c.id);
        if(!o || (o.text||'')!==(c.text||'') || !!o.done!==!!c.done) c.touchedAt = now();
      });
    })();
    // Counter deltas are the user's own +/- on the sheet. Against the live record a
    // peer's taps merged in mid-edit would be rewarded (or charged) as if the user
    // had made them.
    const upDelta = (EDIT.cUp||0) - (_base.cUp||0);
    const downDelta = (EDIT.cDown||0) - (_base.cDown||0);
    // Write back ONLY what the sheet changed. `S.tasks[idx]=EDIT` replaced the live
    // record with the open-time clone, silently discarding everything a concurrent
    // sync merge had written into it (see openEdit's EDIT_BASE comment).
    (function(){
      const _eq = (a,b) => JSON.stringify(a===undefined?null:a) === JSON.stringify(b===undefined?null:b);
      const _liveChecklist = Array.isArray(orig.checklist) ? orig.checklist.slice() : null;
      Object.keys(EDIT).forEach(k=>{
        if(k==='id') return;
        if(!_eq(EDIT[k], _base[k])) orig[k] = EDIT[k];     // the user touched this field
      });
      Object.keys(_base).forEach(k=>{
        if(k==='id') return;
        if(!(k in EDIT) && (k in orig)) delete orig[k];    // the sheet removed it
      });
      // A subtask that is in the LIVE record but was never in the baseline arrived
      // from a sync while the sheet was open. The user cannot have meant to delete
      // something they never saw, and dropping it here would make mergeChecklist read
      // "in base and remote, gone locally" as a deletion and remove it fleet-wide.
      if(_liveChecklist && Array.isArray(orig.checklist) && orig.checklist !== _liveChecklist){
        const seen = new Set(orig.checklist.filter(c=>c&&c.id!=null).map(c=>c.id));
        const known = new Set((_base.checklist||[]).filter(c=>c&&c.id!=null).map(c=>c.id));
        _liveChecklist.forEach(c=>{
          if(c && c.id!=null && !seen.has(c.id) && !known.has(c.id)) orig.checklist.push(c);
        });
      }
    })();
    EDIT = orig;                      // the rest of saveTask() keeps operating on EDIT
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
// 2026-09-18: a dead legacyPaste() used to sit between this function and
// applyPaste(). It had no callers anywhere in the repo, pasteEditTask carries its
// own inline textarea-prompt fallback, and document.execCommand('paste') is not
// permitted from script in any current browser. Removed. Note that
// tests/paste-edit-task.test.js matches these two functions as ONE adjacent span,
// so nothing may be inserted between them.
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
  // 2026-09-18: same stale-id guard as openEdit — a concurrently deleted reward made
  // JSON.parse(JSON.stringify(undefined)) throw before the sheet could open.
  const _r = id ? S.rewards.find(r=>r.id===id) : null;
  if(id && !_r){ toast('That reward no longer exists'); render(); return; }
  REDIT = id? JSON.parse(JSON.stringify(_r)) : {id:null,title:'',cost:10,notes:''};
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
    '<label>Cost (gold)</label><input type="text" id="rCost" value="'+esc(String(REDIT.cost))+'">'+
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
  // 2026-09-18: guard the -1. S.rewards[-1]=REDIT does NOT insert into an array, so a
  // reward deleted by a concurrent sync while its sheet was open swallowed the edit
  // with a success-looking close+save+render and no message at all.
  if(REDIT.id){
    const i=S.rewards.findIndex(r=>r.id===REDIT.id);
    if(i<0){ toast('That reward no longer exists'); closeSheet(); render(); return; }
    S.rewards[i]=REDIT;
  }
  else { REDIT.id=uid(); REDIT.createdAt=Date.now(); S.rewards.push(REDIT); }
  try{ logEvent({kind:_rwNew?'rewardCreate':'rewardEdit', rewardId:REDIT.id, taskTitle:REDIT.title, cost:REDIT.cost}); }catch(e){}
  closeSheet(); save(); render();
}
function delReward(){ try{ logEvent({kind:'rewardDelete', rewardId:REDIT.id, taskTitle:REDIT.title, cost:REDIT.cost}); }catch(e){} delMark(REDIT.id); S.rewards=S.rewards.filter(r=>r.id!==REDIT.id); closeSheet(); save(); render(); }
function buyReward(id){
  const r=S.rewards.find(x=>x.id===id); if(!r)return;
  // 2026-09-18 (round 2): validate the cost. A relational comparison with NaN is
  // always false, so `S.char.gold < r.cost` let a non-numeric cost through the
  // affordability guard and the subtraction turned S.char.gold into NaN --
  // permanently, since every later reward, purchase and death penalty is another
  // arithmetic op on NaN, it is saved, and it syncs to every device. migrate()
  // does not validate reward cost, so an imported backup or a synced peer can
  // deliver one. There is no UI to reset gold.
  const cost = Number(r.cost);
  if(!Number.isFinite(cost) || cost < 0){ toast('That reward has an invalid cost'); return; }
  if(!Number.isFinite(Number(S.char.gold))){ toast('Gold is corrupted — restore a backup'); return; }
  if(S.char.gold < cost){ toast('Not enough gold'); return; }
  S.char.gold=+(S.char.gold-cost).toFixed(2);
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

  // Category buttons for grouped settings (replaces horizontal setList)
  h+='<div class="catBtnRow">';
  h+='<button class="catBtn" type="button" onclick="openCat(\'appearance\')"><span class="catIcon">🎨</span><span class="catLabel">Appearance</span><span class="catChev">›</span></button>';
  h+='<button class="catBtn" type="button" onclick="openCat(\'interaction\')"><span class="catIcon">⚙️</span><span class="catLabel">Interaction</span><span class="catChev">›</span></button>';
  h+='<button class="catBtn" type="button" onclick="openCat(\'activityFeed\')"><span class="catIcon">📋</span><span class="catLabel">Activity Feed</span><span class="catChev">›</span></button>';
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
      h+='<div class="devNameWrap">'+
           '<div class="devNameHeader">'+
              '<div class="devSyncStatus">Last sync: '+esc(rel)+
               (scfg.lastError?(' &middot; <span style="color:#f74e52">'+esc(scfg.lastError)+'</span>'):'')+
               // 2026-09-18 (round 2): auto-backup failures have their own key now, so
               // a failed backup no longer reports itself as a sync error. Show it as
               // its own line rather than hiding it.
               (scfg.lastBackupError?('<br><span style="color:#f7a24e">'+esc(scfg.lastBackupError)+'</span>'):'')+'</div>'+
             '<label class="devNameLbl">Device name</label>'+
             '<div></div>'+
           '</div>'+
           '<div class="devNameRow">'+
             '<button class="btn ghost" onclick="syncNow()">Sync now</button>'+
             '<input type="text" id="setDeviceName" placeholder="'+esc(devShort)+'" value="'+esc(myDevName)+'" onchange="setDeviceName(this.value)">'+
              '<div class="devDisconnectCol">'+
             '<div class="devDisconnectLbl">Device '+esc(devShort)+'</div>'+
             '<button class="btn ghost" onclick="confirmSyncDisconnect()">Disconnect</button>'+
              '</div>'+
           '</div>'+
         '</div>';
      if(typeof confirmForcePush==="function" || typeof confirmForcePull==="function"){
        h+='<div class="settingsRow">'+
           (typeof confirmForcePush==="function"?'<button class="btn danger" onclick="confirmForcePush()">Force push</button>':'')+
           (typeof confirmForcePull==="function"?'<button class="btn danger" onclick="confirmForcePull()">Force pull</button>':'')+
           // F4 (2026-08-18): label must match the shrink-block toast (sync.js) word for
           // word, so the instruction the app gives is literally followable. Always shown
           // when connected: evtPushBlocked is unreliable exactly when it matters, and the
           // toast's instruction must survive a reload.
           (typeof confirmEventsForcePush==="function"?'<button class="btn danger" onclick="confirmEventsForcePush()">Force Push Events</button>':'')+
           '</div>';
      }
      const _abtiers = S.prefs.autoBackupEnabled || {fourHour:false,daily:false,weekly:false,monthly:false};
      const _abLabels = [];
      if(_abtiers.fourHour) _abLabels.push('4-hourly');
      if(_abtiers.daily) _abLabels.push('Daily');
      if(_abtiers.weekly) _abLabels.push('Weekly');
      if(_abtiers.monthly) _abLabels.push('Monthly');
      const _abSummary = _abLabels.length ? _abLabels.join(', ') : 'Off';
      h+='<div class="setList">'+settingRow('autoBackup','Auto-backup tiers','Uploads a full backup file to Dropbox on each enabled cadence.',_abSummary)+'</div>';
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
  // K2 (2026-09-11): until now a forward clock excursion demoted this device to
  // read-only in every sync conflict with NO signal at all -- which is why it went
  // unnoticed for so long. No "resync clock" button on purpose: now() heals itself in
  // one call, so a button would have nothing left to do, and the real action lives in
  // the OS clock settings, not here. Plain language, no HLC jargon.
  if(typeof hlcSkewMs === "function" && hlcSkewMs() > HLC_RATCHET_TOLERANCE_MS){
    h+='<div class="small" style="color:#f74e52;margin-top:6px">This device’s clock is ahead of your other devices. Edits made here may lose to them until you correct the clock in your device settings.</div>';
  }
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
  confirmDialog('Reset Everything', 'Erase ALL progress on this device? This cannot be undone.').then(async ok => {
    if(!ok) return;
    // #2 this-device-only reset: disconnect sync, wipe IDB syncmeta base +
    // state mirror, reset __seq so the fresh state starts at seq 1 after
    // save(). NO tombstone-all, NO destructive propagation to other devices.
    // Reconnecting later pulls the world back via keep-by-default merge.
    // 2026-07-15 event-log fix: a reset must also truly erase the event
    // log -- locally AND this device's own /events files in Dropbox -- or a
    // later reconnect resurrects the old Activity Feed entries. Other devices
    // keep their own copies (this-device-only scope, like the task reset).
    const oldDev = (typeof syncDeviceId==='function') ? syncDeviceId() : null;
    const cfgAtReset = (typeof syncCfg==='function') ? syncCfg() : {};
    if(oldDev && cfgAtReset.refreshToken && typeof syncEventsDeleteDevice==='function'){
      // Still connected: token is valid, so delete the remote own files now.
      await syncEventsDeleteDevice(oldDev).catch(function(){});
    } else if(oldDev && typeof localStorage!=='undefined'){
      // Disconnected at reset time: stash so the delete runs on next connect.
      try{ localStorage.setItem("questa.events.pendingPurgeDev", oldDev); }catch(e){}
    }
    // Wipe the local event log (IndexedDB events store). resetEverything used
    // to leave it intact, contradicting "erase ALL progress".
    if(typeof clearAllEvents==='function'){ await clearAllEvents().catch(function(){}); }
    // Reset event-sync watermarks so no stale ts/rev state survives the reset.
    if(typeof syncCfgSave==='function') syncCfgSave({ evtLastUploadTs: 0, evtFileRevs: {} });
    // Keep deviceId (same device) -- do NOT null it. syncDisconnect preserves it.
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
  }).catch(e => {
    // 2026-09-18 (round 2): the async body had no .catch, so its rejection was
    // unobserved. The destructive steps run FIRST — the remote /events files are
    // deleted and the local event store is cleared — while the state reset is last.
    // Anything in between (syncCfgSave, syncDisconnect, syncBasePut,
    // localStorage.removeItem) can throw on a storage-blocked origin such as Safari
    // private mode, and then the whole event log was already gone, locally and in
    // Dropbox, with the sheet still open, no toast and nothing in the log. The user
    // would reasonably conclude nothing had happened.
    try{ if(typeof _qDiagPush === "function") _qDiagPush('resetFailed', {error:(e && e.message) || String(e)}); }catch(_){}
    alertDialog('Reset Error',
      'The reset did not finish: ' + ((e && e.message) || String(e)) +
      '\n\nSome data may already have been erased. Check Settings before continuing.');
  });
}
// Tooltip delay is fixed at Instant (0); the user-facing control was removed.
function setWidth(px){ S.prefs.width=px; applyWidth(); save(); closeOpt(); openSettings(); }
function setNotesLines(n){ S.prefs.notesLines=n; save(); closeOpt(); openSettings(); }
function setHaptics(n){ S.prefs.haptics=!!n; save(); closeOpt(); openSettings(); }
function setHideSyncDiag(n){ S.prefs.hideSyncDiag=!!n; save(); closeOpt(); openSettings(); render(); }
function setHideConflictDecisions(n){ S.prefs.hideConflictDecisions=!!n; save(); closeOpt(); openSettings(); render(); }
function setShowStreaks(n){ S.prefs.showStreaks=!!n; save(); closeOpt(); openSettings(); render(); }
function setCardThick(px){ let n=parseInt(px,10); if(!isFinite(n)) n=0; n=Math.min(60,Math.max(0,n)); S.prefs.cardThick=n; applyCardThick(); save(); closeOpt(); openSettings(); }
function setSaveBtnTop(n){ S.prefs.saveBtnTop=!!n; save(); closeOpt(); if(EDIT) drawSheet(); else if(REDIT) openReward(REDIT.id); openSettings(); }
function setExportIntervalDays(){ /* retained as defensive no-op; no live callers after autoBackup migration */ }
function setAutoBackupTiers(patch){ S.prefs.autoBackupEnabled = Object.assign({}, S.prefs.autoBackupEnabled||{fourHour:false,daily:false,weekly:false,monthly:false}, patch); save(); closeOpt(); openSettings(); }
function setPause(n){ S.prefs.paused=!!n; S.prefs.pausedAt=now(); if(n && !Array.isArray(S.prefs.pausedDays)) S.prefs.pausedDays=[]; save(); closeOpt(); openSettings(); renderStats(); }
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
// Category definitions for Level 2 settings modal
const CATS = {
  appearance: {
    title: '🎨 Appearance',
    settings: [
      { key: 'width', type: 'multi', label: 'Interface width', desc: 'Caps the width on a monitor and keeps it centered.' },
      { key: 'notes', type: 'multi', label: 'Note lines', desc: 'Lines of a task\'s notes shown in the list preview.' },
      { key: 'cardThick', type: 'slider', label: 'Card thickness', desc: 'Minimum height of each card.', min: 0, max: 60, step: 1, unit: 'px', defLabel: 'Default' },
      { key: 'showStreaks', type: 'toggle', label: 'Streak badges', desc: 'Show the \u{1F525} streak count on daily cards. Streaks keep counting either way.' }
    ]
  },
  interaction: {
    title: '⚙️ Interaction',
    settings: [
      { key: 'haptics', type: 'toggle', label: 'Haptics', desc: 'Vibration on taps and completions.' },
      { key: 'saveBtnTop', type: 'toggle', label: 'Save button position', desc: 'Top = centered next to title; Bottom = at foot of sheet.' },
      { key: 'notifications', type: 'multi', label: 'Notifications', desc: 'Browser-based notification permission and status.' }
    ]
  },
  activityFeed: {
    title: '📋 Activity Feed',
    settings: [
      { key: 'hideSyncDiag', type: 'toggle', label: 'Hide sync & diagnostic events', desc: 'Hide background sync (conflict resolved) and diagnostic events from the Activity Feed.' },
      { key: 'hideConflictDecisions', type: 'toggle', label: 'Hide conflict decisions', desc: 'Hide sync conflict resolution events from the Activity Feed.' },
      { key: 'pause', type: 'toggle', label: 'Pause tracking', desc: 'Prevent HP loss and streak breaks when away. Dailies still give rewards.' }
    ]
  }
};

// Render the category modal (Level 2) for grouped settings
function openCat(catKey){
  const cat = CATS[catKey];
  if(!cat) return;
  let h = '<h4>'+cat.title+'</h4>';
  cat.settings.forEach(function(s){
    if(s.type === 'toggle'){
      let val;
      if(s.key === 'pause') val = !!S.prefs.paused;
      else if(s.key === 'haptics') val = (S.prefs.haptics !== false);
      else if(s.key === 'showStreaks') val = (S.prefs.showStreaks !== false);
      else val = !!S.prefs[s.key];
      h += '<div class="catSetting">'+
        '<div class="catSettingMain">'+
          '<div class="catSettingLabel">'+esc(s.label)+'</div>'+
          '<label class="toggle"><input type="checkbox" '+(val?'checked':'')+' onchange="setCatToggle(\''+s.key+'\',this.checked);openCat(\''+catKey+'\')"><span class="slider"></span></label>'+
        '</div>'+
        '<div class="catSettingDesc">'+esc(s.desc)+'</div>'+
      '</div>';
    } else if(s.type === 'multi'){
      let curVal = '';
      if(s.key === 'width'){
        const widthLabels={430:'Slim',560:'Medium',720:'Wide',3000:'Full'};
        const wv=(S.prefs.width||480);
        curVal = widthLabels[wv]||'Custom';
      } else if(s.key === 'notes'){
        const nl=(S.prefs.notesLines==null?3:S.prefs.notesLines);
        curVal = nl===0?'Off':(nl+' line'+(nl===1?'':'s'));
      } else if(s.key === 'notifications'){
        curVal = S.prefs.notificationsEnabled?'On':'Off';
      }
      h += '<div class="catSetting" onclick="openOpt(\''+s.key+'\')">'+
        '<div class="catSettingMain">'+
          '<div class="catSettingLabel">'+esc(s.label)+'</div>'+
          '<div class="catSettingVal">'+esc(curVal)+' ›</div>'+
        '</div>'+
        '<div class="catSettingDesc">'+esc(s.desc)+'</div>'+
      '</div>';
    } else if(s.type === 'slider'){
      const cp = (S.prefs.cardThick==null?0:Math.min(60,Math.max(0,S.prefs.cardThick)));
      const disp = cp===0?s.defLabel:('+'+cp+' '+s.unit);
      h += '<div class="catSetting">'+
        '<div class="catSettingMain">'+
          '<div class="catSettingLabel">'+esc(s.label)+'</div>'+
          '<div class="catSettingSlider">'+
            '<input type="range" min="'+s.min+'" max="'+s.max+'" step="'+s.step+'" value="'+cp+'" id="catCardThick" oninput="S.prefs.cardThick=+this.value;applyCardThick();document.getElementById(\'catSliderVal\').textContent=(this.value===\'0\'?\''+esc(s.defLabel)+'\':(\'\'+this.value+\''+esc(s.unit)+'\'))">'+
            '<span class="catSliderVal" id="catSliderVal">'+esc(disp)+'</span>'+
          '</div>'+
        '</div>'+
        '<div class="catSettingDesc">'+esc(s.desc)+'</div>'+
      '</div>';
    }
  });
  h += '<button class="btn ghost optClose" type="button" onclick="closeOpt()">Done</button>';
  document.getElementById('optMenu').innerHTML = h;
  document.getElementById('optScrim').classList.add('show');
}

// Helper to set toggle values from category modal
function setCatToggle(key, val){
  if(key === 'haptics') setHaptics(val?1:0);
  else if(key === 'saveBtnTop') setSaveBtnTop(val);
  else if(key === 'hideSyncDiag') setHideSyncDiag(val?1:0);
  else if(key === 'hideConflictDecisions') setHideConflictDecisions(val?1:0);
  else if(key === 'pause') setPause(val?1:0);
  else if(key === 'showStreaks') setShowStreaks(val?1:0);
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
    h+='<p class="optHint">Local reminders for habits, dailies, and to-dos. These fire only while Questa is open — a web app cannot wake itself once you close it. Any reminder whose time passed while Questa was shut is shown, marked <b>Missed</b>, the next time you open it that same day.</p>';
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
  } else if(key==='autoBackup'){
    const _ab=S.prefs.autoBackupEnabled||{fourHour:false,daily:false,weekly:false,monthly:false};
    h+='<h4>Auto-backup to Dropbox</h4>';
    h+='<p class="optHint">A full backup (same as Export) goes to Dropbox on each cadence you check. Each tier keeps its own cycling window on this device. Multiple devices each keep separate files (by device id). Missed windows don\u2019t stack.</p>';
    h+='<div class="optTiers">';
    [['fourHour','4-hourly','Fires at most once per sync, ~4h apart','keeps last 10'],
     ['daily','Daily','Runs on first sync after local midnight','keeps last 7'],
     ['weekly','Weekly','Runs on first sync after Monday midnight','keeps last 4'],
     ['monthly','Monthly','Runs on first sync after 1st-of-month','keeps last 4']].forEach(function(t){
      h+='<div class="optTier" onclick="setAutoBackupTiers({'+t[0]+':!S.prefs.autoBackupEnabled.'+t[0]+'})">'+
        '<span class="optTierCheck">'+(_ab[t[0]]?'\u2611':'\u2610')+'</span>'+
        '<span class="optTierLabel">'+t[1]+'</span>'+
        '<span class="optTierMeta">('+t[3]+')</span>'+
        '<div class="optTierDesc">'+t[2]+'</div>'+
        '</div>';
    });
    h+='</div>';
    h+='<p class="optHint" style="margin-top:12px">Local IndexedDB snapshots (automatic) are separate from these Dropbox export backups.</p>';
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
  if(key==='hideSyncDiag'){
    const hd=!!S.prefs.hideSyncDiag;
    h+='<h4>Hide sync & diagnostic events</h4>';
    h+='<p class="optHint">When On, background sync (conflict resolved) and diagnostic events are hidden from the Activity Feed. Your task activity and exports stay visible. Turn Off to see everything for debugging.</p>';
    h+='<div class="optChoices">';
    h+='<button type="button" class="'+(hd?'on':'')+'" onclick="setHideSyncDiag(1)">On</button>';
    h+='<button type="button" class="'+(hd?'':'on')+'" onclick="setHideSyncDiag(0)">Off</button>';
    h+='</div>';
  } else if(key==='hideConflictDecisions'){
    const hc=!!S.prefs.hideConflictDecisions;
    h+='<h4>Hide conflict decisions</h4>';
    h+='<p class="optHint">When On, sync conflict resolution events are hidden from the Activity Feed. This is independent of "Hide sync & diagnostic events". Turn Off to see conflict history for debugging.</p>';
    h+='<div class="optChoices">';
    h+='<button type="button" class="'+(hc?'on':'')+'" onclick="setHideConflictDecisions(1)">On</button>';
    h+='<button type="button" class="'+(hc?'':'on')+'" onclick="setHideConflictDecisions(0)">Off</button>';
    h+='</div>';
  }
  else if(key==='pause'){
    const pv=!!S.prefs.paused;
    h+='<h4>Pause tracking</h4>';
    h+='<p class="optHint">When On, your character does not lose HP and your streak counters do not break while you are away. Dailies can still be completed for rewards.</p>';
    h+='<div class="optChoices">';
    h+='<button type="button" class="'+(pv?'on':'')+'" onclick="setPause(1)">On</button>';
    h+='<button type="button" class="'+(pv?'':'on')+'" onclick="setPause(0)">Off</button>';
    h+='</div>';
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
// --- Tokenized export (schema 2) -----------------------------------------
// Shrinks the on-disk backup without zip: replace repeated field names,
// enum strings (kind/source) and task titles/ids with dictionary indices.
// Tokenized form lives ONLY in the export file; IndexedDB keeps full objects.
// See .kilo/plans/1784185676821-tokenized-export-archiving-handover.md.
const _EXPORT_FIELD_MAP = {
  ts:'t', uid:'u', dev:'d', kind:'k', taskTitle:'n', notes:'no', id:'i',
  taskType:'ty', taskId:'ti', streak:'st', reward:'rw', repeat:'rp',
  checklist:'cl', changes:'ch', subId:'si', subText:'sx', done:'do',
  clawback:'cb', deviceId:'di', deviceName:'dn', prevDeviceName:'pn',
  createdAt:'ca', completedAt:'co', dir:'dr', reps:'rs', value:'v',
  dmg:'dg', cost:'ct', effect:'ef', counter:'cr', preBumpSeq:'ps',
  storedSeq:'ss', granted:'gr', log:'lg', detail:'dt', visibilityState:'vs',
  hidden:'hd', dirty:'dy', found:'fd', idbSeq:'is', liveSeq:'ls',
  winner:'wn', loser:'lo', charTitle:'ctt', day:'dyy', late:'lt',
  source:'o', synthetic:'sy', repCounted:'rc', inferred:'in'
};
function _tokenizeEvents(eventsArr){
  const events = eventsArr||[];
  const kindArr=[], srcArr=[], tidArr=[], titleArr=[];
  // Object.create(null): no inherited keys, so a task titled "constructor" or
  // "__proto__" behaves like any other string. See idx() below (2026-09-18 round 2).
  const kindIdx=Object.create(null), srcIdx=Object.create(null), tidIdx=Object.create(null), titleIdx=Object.create(null);
  // 2026-09-18: -1 means "this field was null". _detokenizeEvents restores it AS
  // null instead of indexing past the end of the dictionary. Previously K[-1] was
  // undefined, JSON.stringify dropped the key entirely, and because the integrity
  // hash is computed on the DETOKENIZED object the backup then failed its own hash
  // gate and was refused with "corrupted or tampered with".
  // 2026-09-18 (round 2): OWN-property lookup, not `v in map`. `in` walks the
  // prototype chain, so a taskTitle of "constructor", "toString", "valueOf",
  // "hasOwnProperty", "isPrototypeOf", "toLocaleString" or "propertyIsEnumerable"
  // was already "in" a plain {} — never added to the dictionary — and map[v]
  // returned the inherited FUNCTION, which JSON.stringify drops. "__proto__" was
  // worse: map[v]=n is a silent prototype write and map[v] reads back
  // Object.prototype. Task titles are free user text, so this is user-reachable,
  // and because the integrity hash is computed on the DETOKENIZED object the
  // result is that EVERY backup that user ever writes is refused on import as
  // "corrupted or tampered with" — the restore path is gone entirely.
  // The maps below are Object.create(null); the emitted token dictionary is
  // unchanged, so older builds still read these files.
  function idx(arr,map,v){ if(v==null) return -1; if(!Object.prototype.hasOwnProperty.call(map,v)){ map[v]=arr.length; arr.push(v); } return map[v]; }
  const out = events.map(function(e){
    const o={};
    for(const f in e){
      const v=e[f];
      if(f==='uid'||f==='dev'||f==='id'){ o[f]=v; continue; }
      const sk=_EXPORT_FIELD_MAP[f];
      if(!sk){ o[f]=v; continue; }
      if(f==='kind') o[sk]=idx(kindArr,kindIdx,v);
      else if(f==='source') o[sk]=idx(srcArr,srcIdx,v);
      else if(f==='taskId') o[sk]=idx(tidArr,tidIdx,v);
      else if(f==='taskTitle') o[sk]=idx(titleArr,titleIdx,v);
      // 2026-09-19 (round 3, review item 7): an explicit null used to be
      // squashed to 0 and read back as false, so "not known" became "no". It
      // is now carried as JSON null. A -1 sentinel was the obvious fix and is
      // the WRONG one: an older build's detokenizer is `e[f] = !!v`, and
      // !!(-1) is TRUE, so every null would have flipped to yes on an older
      // device. !!null is false, so an older build degrades to exactly the
      // lossy-but-safe behaviour it has today instead of inventing a value.
      else if(f==='synthetic'||f==='repCounted'||f==='inferred'||f==='done') o[sk]=(v==null)?null:(v?1:0);
      else o[sk]=v;
    }
    return o;
  });
  return { E: out, K: kindArr, SRC: srcArr, TID: tidArr, TT: titleArr };
}
// Reverse _tokenizeEvents. Returns an array of full event objects.
function _detokenizeEvents(env){
  if(!env || !Array.isArray(env.E)) return [];
  const K=env.K||[], SRC=env.SRC||[], TID=env.TID||[], TT=env.TT||[];
  const RM = (function(){ const m={}; for(const k in _EXPORT_FIELD_MAP) m[_EXPORT_FIELD_MAP[k]]=k; return m; })();
  return env.E.map(function(o){
    const e={};
    for(const sk in o){
      const v=o[sk];
      if(sk==='uid'||sk==='dev'||sk==='id'){ e[sk]=v; continue; }
      // 2026-09-19 (round 3, review item 5): this was `RM[sk] || sk`, which
      // RENAMED an unknown code instead of rejecting it. A newer build adds a
      // field code, this build does not know it, and `|| sk` kept the raw token
      // as the field name -- so the record silently changed shape and imported
      // as a half-readable ghost with no warning at all.
      //
      // `|| sk` was doing TWO jobs, which is why it looked harmless. A key in E
      // is either a SHORT CODE (a value of _EXPORT_FIELD_MAP) or a LONG field
      // name that the tokenizer passed through untouched, because
      // _tokenizeEvents writes `o[f]=v` for any field the map does not cover
      // (e.g. `winnerDev`). Only the first kind can be 'from a newer build'.
      //
      // The two namespaces are told apart by shape: EVERY value in
      // _EXPORT_FIELD_MAP is 1-3 lowercase letters, and no long event field
      // name is. So a key that LOOKS like a short code but is not in the map
      // can only come from a build that knows a code this one does not.
      // INVARIANT: keep every _EXPORT_FIELD_MAP value inside /^[a-z]{1,3}$/ and
      // keep every long event field name outside it (AGENTS.md section 6).
      let f = RM[sk];
      if(f === undefined){
        if(/^[a-z]{1,3}$/.test(sk)){
          const err = new Error('Unknown export field code "' + sk + '"');
          err.code = 'QUESTA_UNKNOWN_FIELD_CODE';
          err.fieldCode = sk;
          throw err;
        }
        f = sk;   // untokenized long field name: carried through as it always was
      }
      // 2026-09-18: `v === -1` is the tokenizer's encoding of null (see idx() in
      // _tokenizeEvents). Restore null rather than reading past the dictionary,
      // which yielded undefined and silently dropped the key — breaking the
      // round-trip the hash gate depends on.
      if(sk==='k') e.kind = (v===-1) ? null : K[v];
      else if(sk==='o') e.source = (v===-1) ? null : SRC[v];
      else if(sk==='ti') e.taskId = (v===-1) ? null : TID[v];
      else if(sk==='n') e.taskTitle = (v===-1) ? null : TT[v];
      // 2026-09-19 (round 3, review item 7): null means null. `!!v` alone
      // turned the tokenizer's null into false and lost the distinction.
      else if(sk==='sy'||sk==='rc'||sk==='in'||sk==='do') e[f] = (v===null) ? null : !!v;
      else e[f]=v;
    }
    return e;
  });
}
// Generic recursive field-name tokenizer for the snapshot. Builds a
// frequency-ordered field map (most common field names get the shortest codes)
// so the embedded map is small and the hash stays stable across re-exports.
// Applied recursively to tasks/rewards/tags/charHistory/history/deletions/
// devices/monthlyBackups/habiticaHistory/prefs.an/_joinConflicts etc. This is
// what actually shrinks the multi-MB snapshot (tasks + habiticaHistory dominate).
// Tokenized form is export-only; live S / IndexedDB keep full field names, and
// importData detokenizes fully before migrate() consumes the object.
function _buildFieldMap(snap){
  // Object.create(null) for the same reason as _tokenizeEvents' dictionaries
  // (2026-09-18 round 2): a snapshot key named __proto__ or constructor otherwise
  // never becomes an own property, so it silently drops out of the field map.
  const freq=Object.create(null);
  (function walk(o){
    if(Array.isArray(o)){ for(let i=0;i<o.length;i++) walk(o[i]); }
    else if(o && typeof o==='object'){ for(const k in o){ freq[k]=(freq[k]||0)+1; walk(o[k]); } }
  })(snap);
  const keys=Object.keys(freq).sort(function(a,b){ return freq[b]-freq[a]; });
  const map={}; let i=0;
  function nextCode(){ let s='', n=i; do{ s=String.fromCharCode(97+(n%26))+s; n=Math.floor(n/26); }while(n>0); i++; return s; }
  for(let j=0;j<keys.length;j++) map[keys[j]]=nextCode();
  return map;
}
function _tokDeep(o, fm){
  if(Array.isArray(o)){ const r=[]; for(let i=0;i<o.length;i++) r.push(_tokDeep(o[i], fm)); return r; }
  if(o && typeof o==='object'){ const r={}; for(const k in o){ r[fm[k]||k]=_tokDeep(o[k], fm); } return r; }
  return o;
}
function _detDeep(o, rmap){
  if(Array.isArray(o)){ const r=[]; for(let i=0;i<o.length;i++) r.push(_detDeep(o[i], rmap)); return r; }
  if(o && typeof o==='object'){ const r={}; for(const k in o){ r[rmap[k]||k]=_detDeep(o[k], rmap); } return r; }
  return o;
}
function _tokenizeSnapshot(s){
  const snap={};
  for(const k in s){ if(k!=='events') snap[k]=s[k]; }
  const fm=_buildFieldMap(snap);
  return { S: _tokDeep(snap, fm), FM: fm };
}
function _detokenizeSnapshot(tok){
  const fm = (tok && tok.FM) || {};
  // Reverse the long->short field map into short->long for detokenization.
  const rmap={}; for(const k in fm) rmap[fm[k]]=k;
  const s = (tok && tok.S) || {};
  return _detDeep(s, rmap);
}

/* BEGIN_GRANULAR_IO_HELPERS */
// --- Granular export / import sections ---------------------------------------
// ONE registry drives both directions: the export picker, the import picker, the
// counts shown in each, slicing a snapshot down to the ticked boxes, and applying
// a file's section back onto live state. A new section means ONE new entry here.
//
// Load-bearing design notes:
//  * pick(src) returns ONLY the top-level keys its section owns, and returns an
//    EMPTY object when it owns nothing in that state. A partial export therefore
//    OMITS an unselected key entirely instead of writing an empty array --
//    absence is exactly how detectExportSections() decides "that box is not in
//    this file". Writing `tasks: []` would read back as "import zero tasks",
//    which on Replace means "delete them all".
//  * has(data) must succeed on a legacy schema-1 file that carries no
//    _backup.sections manifest, so the three task sections key off the presence
//    of the `tasks` ARRAY, not off a non-zero count. A full backup holding zero
//    habits still offers the Habits box, so Replace can legitimately empty it.
//  * merge never treats a missing timestamp as a losing value. Unknown resolves
//    to "keep the local record", never to "drop it" -- the same polarity rule the
//    sync.js merge sites live under, where clamping to 0 destroys data rather
//    than losing a tiebreak.
function _tasksOfType(list, ty){
  return (list||[]).filter(function(t){ return t && t.type===ty; });
}
// Recency score for one record. Absent stamps score 0, and 0 can only ever LOSE
// a comparison below (strictly-greater), never win one -- so an unstamped
// incoming record can never evict a local one.
function _ioRecTs(r){
  if(!r) return 0;
  const u = (typeof r.updatedAt==='number') ? r.updatedAt : 0;
  const c = (typeof r.createdAt==='number') ? r.createdAt : 0;
  return u>c ? u : c;
}
// Union two id-keyed lists. Incoming replaces local ONLY when strictly newer; a
// tie -- including the 0/0 "neither side is stamped" case -- keeps local. Records
// present only locally are always kept, so this can never shrink a list. That is
// the whole point of Merge mode.
function _ioMergeById(local, incoming){
  const out = (local||[]).slice();
  const at = {};
  out.forEach(function(r,i){ if(r && r.id!=null) at[String(r.id)]=i; });
  (incoming||[]).forEach(function(r){
    if(!r) return;
    if(r.id==null){ out.push(r); return; }
    const k = String(r.id);
    const i = at[k];
    if(i===undefined){ at[k]=out.length; out.push(r); return; }
    if(_ioRecTs(r) > _ioRecTs(out[i])) out[i] = r;
  });
  return out;
}
// Object sections under Merge: LOCAL wins field by field, incoming only fills
// keys the local object does not already have. Nothing the user can see on this
// device changes value; the file can only add what is missing.
function _ioMergeObj(local, incoming){
  const out = Object.assign({}, incoming||{});
  const l = local||{};
  for(const k in l) out[k] = l[k];
  return out;
}
// Replace/merge one task TYPE without disturbing the other two. The new block is
// dropped in at the position the first task of that type occupied, so manual
// ordering of the surrounding types survives an import of just one type.
function _ioApplyTaskType(tgt, data, ty, mode){
  const inc = _tasksOfType(data.tasks, ty);
  const cur = tgt.tasks || [];
  const next = (mode==='merge') ? _ioMergeById(_tasksOfType(cur, ty), inc) : inc;
  const out = []; let placed = false;
  cur.forEach(function(t){
    if(t && t.type===ty){
      if(!placed){ placed = true; next.forEach(function(x){ out.push(x); }); }
      return;
    }
    out.push(t);
  });
  if(!placed) next.forEach(function(x){ out.push(x); });
  tgt.tasks = out;
}
// Concat + de-duplicate a plain log array by JSON identity. Used for the history
// group, whose records carry no stable id.
function _ioMergeLog(local, incoming){
  const out = (local||[]).slice();
  const seen = {};
  out.forEach(function(r){ try{ seen[JSON.stringify(r)]=1; }catch(e){} });
  (incoming||[]).forEach(function(r){
    let k; try{ k = JSON.stringify(r); }catch(e){ k = null; }
    if(k!==null && seen[k]) return;
    if(k!==null) seen[k]=1;
    out.push(r);
  });
  return out;
}
const IO_SECTIONS = [
  { key:'char', label:'Character', hint:'Level, XP, gold, HP and class.',
    count:function(s){ return (s && s.char) ? 1 : 0; },
    has:function(d){ return !!(d && d.char && typeof d.char==='object'); },
    pick:function(s){ return (s && s.char) ? {char:s.char} : {}; },
    apply:function(tgt, d, mode){ tgt.char = (mode==='merge') ? _ioMergeObj(tgt.char, d.char) : d.char; } },

  { key:'habits', label:'Habits', hint:'Repeatable good/bad habit buttons.',
    count:function(s){ return _tasksOfType(s && s.tasks, 'habit').length; },
    has:function(d){ return !!(d && Array.isArray(d.tasks)); },
    pick:function(s){ const a=_tasksOfType(s && s.tasks,'habit'); return a.length?{tasks:a}:{tasks:[]}; },
    apply:function(tgt, d, mode){ _ioApplyTaskType(tgt, d, 'habit', mode); } },

  { key:'dailies', label:'Dailies', hint:'Tasks that repeat on a schedule, with streaks.',
    count:function(s){ return _tasksOfType(s && s.tasks, 'daily').length; },
    has:function(d){ return !!(d && Array.isArray(d.tasks)); },
    pick:function(s){ const a=_tasksOfType(s && s.tasks,'daily'); return a.length?{tasks:a}:{tasks:[]}; },
    apply:function(tgt, d, mode){ _ioApplyTaskType(tgt, d, 'daily', mode); } },

  { key:'todos', label:'To-dos', hint:'One-off tasks and their checklists.',
    count:function(s){ return _tasksOfType(s && s.tasks, 'todo').length; },
    has:function(d){ return !!(d && Array.isArray(d.tasks)); },
    pick:function(s){ const a=_tasksOfType(s && s.tasks,'todo'); return a.length?{tasks:a}:{tasks:[]}; },
    apply:function(tgt, d, mode){ _ioApplyTaskType(tgt, d, 'todo', mode); } },

  { key:'rewards', label:'Rewards', hint:'Things you spend gold on.',
    count:function(s){ return ((s && s.rewards)||[]).length; },
    has:function(d){ return !!(d && Array.isArray(d.rewards)); },
    pick:function(s){ return {rewards:((s && s.rewards)||[])}; },
    apply:function(tgt, d, mode){ tgt.rewards = (mode==='merge') ? _ioMergeById(tgt.rewards, d.rewards) : (d.rewards||[]); } },

  { key:'tags', label:'Tags', hint:'Labels you sort tasks by.',
    count:function(s){ return ((s && s.tags)||[]).length; },
    has:function(d){ return !!(d && Array.isArray(d.tags)); },
    pick:function(s){ return {tags:((s && s.tags)||[])}; },
    apply:function(tgt, d, mode){ tgt.tags = (mode==='merge') ? _ioMergeById(tgt.tags, d.tags) : (d.tags||[]); } },

  { key:'prefs', label:'Settings', hint:'Layout, sync options and app preferences.',
    count:function(s){ return (s && s.prefs) ? Object.keys(s.prefs).length : 0; },
    has:function(d){ return !!(d && d.prefs && typeof d.prefs==='object'); },
    pick:function(s){ const o={}; if(s && s.prefs) o.prefs=s.prefs; if(s && s.lastCron!=null) o.lastCron=s.lastCron; return o; },
    apply:function(tgt, d, mode){
      tgt.prefs = (mode==='merge') ? _ioMergeObj(tgt.prefs, d.prefs) : (d.prefs||{});
      if(mode!=='merge' && d.lastCron!=null) tgt.lastCron = d.lastCron;
    } },

  { key:'history', label:'History', hint:'Daily/character history and monthly backup records.',
    count:function(s){ return (((s&&s.history)||[]).length) + (((s&&s.charHistory)||[]).length) + (((s&&s.monthlyBackups)||[]).length); },
    has:function(d){ return !!(d && (Array.isArray(d.history) || Array.isArray(d.charHistory) || Array.isArray(d.monthlyBackups))); },
    pick:function(s){ const o={};
      if(s && Array.isArray(s.history)) o.history=s.history;
      if(s && Array.isArray(s.charHistory)) o.charHistory=s.charHistory;
      if(s && Array.isArray(s.monthlyBackups)) o.monthlyBackups=s.monthlyBackups;
      return o; },
    apply:function(tgt, d, mode){
      if(Array.isArray(d.history)) tgt.history = (mode==='merge') ? _ioMergeLog(tgt.history, d.history) : d.history;
      if(Array.isArray(d.charHistory)) tgt.charHistory = (mode==='merge') ? _ioMergeLog(tgt.charHistory, d.charHistory) : d.charHistory;
      if(Array.isArray(d.monthlyBackups)) tgt.monthlyBackups = (mode==='merge') ? _ioMergeLog(tgt.monthlyBackups, d.monthlyBackups) : d.monthlyBackups;
    } },

  { key:'devices', label:'Devices', hint:'Known devices and deletion tombstones.',
    count:function(s){ return (((s&&s.devices)||[]).length) + (((s&&s.deletions)||[]).length); },
    has:function(d){ return !!(d && (Array.isArray(d.devices) || Array.isArray(d.deletions))); },
    pick:function(s){ const o={};
      if(s && Array.isArray(s.devices)) o.devices=s.devices;
      if(s && Array.isArray(s.deletions)) o.deletions=s.deletions;
      return o; },
    apply:function(tgt, d, mode){
      if(Array.isArray(d.devices)) tgt.devices = (mode==='merge') ? _ioMergeById(tgt.devices, d.devices) : d.devices;
      // Tombstones are never merged away: dropping a deletion record resurrects a
      // task the user deleted, so even Replace keeps the union of both sides.
      if(Array.isArray(d.deletions)) tgt.deletions = _ioMergeLog(tgt.deletions, d.deletions);
    } },

  { key:'events', label:'Event log', hint:'Every tap, completion and subtask change.',
    count:function(s){ return ((s && s.events)||[]).length; },
    has:function(d){ return !!(d && Array.isArray(d.events)); },
    pick:function(){ return {}; },  // events ride in their own envelope slot, not the snapshot
    // Events are written to IndexedDB by the async union-add path in
    // applyImportSections(), never from here. Both modes append; neither removes.
    apply:function(){} }
];
function ioSectionByKey(k){
  for(let i=0;i<IO_SECTIONS.length;i++){ if(IO_SECTIONS[i].key===k) return IO_SECTIONS[i]; }
  return null;
}
function ioAllSectionKeys(){ return IO_SECTIONS.map(function(s){ return s.key; }); }
function ioIsFullSelection(keys){
  const sel={}; (keys||[]).forEach(function(k){ sel[k]=true; });
  return IO_SECTIONS.every(function(s){ return !!sel[s.key]; });
}
// Build the export snapshot from only the ticked sections. Arrays contributed by
// more than one section under the same key (the three task types all write
// `tasks`) are concatenated, not overwritten.
function sliceStateForExport(s, keys){
  const sel={}; (keys||[]).forEach(function(k){ sel[k]=true; });
  const out={};
  if(s && s.version!=null) out.version = s.version;   // schema marker; join_exports.py reads it
  IO_SECTIONS.forEach(function(sec){
    if(!sel[sec.key]) return;
    const part = sec.pick(s) || {};
    for(const k in part){
      const v = part[k];
      if(Array.isArray(v) && Array.isArray(out[k])) out[k] = out[k].concat(v);
      else out[k] = v;
    }
  });
  return out;
}
// Which boxes does this FILE contain? A manifest (_backup.sections, written by
// this build) is authoritative. Without one -- every legacy schema-1 and schema-2
// full backup -- fall back to inspecting the payload, which is why has() keys off
// container presence rather than item counts.
function detectExportSections(data){
  const out=[];
  if(!data || typeof data!=='object') return out;
  const man = (data._backup && Array.isArray(data._backup.sections)) ? data._backup.sections : null;
  IO_SECTIONS.forEach(function(sec){
    if(man){ if(man.indexOf(sec.key)!==-1) out.push(sec.key); return; }
    if(sec.has(data)) out.push(sec.key);
  });
  return out;
}
// Item count for one section AS IT SITS IN A FILE. Same shape as count(), which
// reads live state -- the file is just another state-shaped object.
function countExportSection(key, data){
  const sec = ioSectionByKey(key);
  if(!sec || !data) return 0;
  try{ return sec.count(data)||0; }catch(e){ return 0; }
}
// Apply the ticked sections of `data` onto `tgt` (live state) in the given mode.
// Returns the same object. Sections NOT ticked are never read and never written,
// which is the guarantee the import dialog makes to the user.
function applySectionsToState(tgt, data, keys, mode){
  const sel={}; (keys||[]).forEach(function(k){ sel[k]=true; });
  IO_SECTIONS.forEach(function(sec){
    if(!sel[sec.key]) return;
    if(!sec.has(data)) return;
    sec.apply(tgt, data, (mode==='merge') ? 'merge' : 'replace');
  });
  return tgt;
}
/* END_GRANULAR_IO_HELPERS */

// `sectionKeys` omitted (or listing every section) reproduces the historic full
// backup byte-for-byte: same filename prefix, same envelope, no partial flag, so
// nothing downstream that already reads these files has to change.
async function buildBackupFile(eventsArr, sectionKeys){
  const keys = (Array.isArray(sectionKeys) && sectionKeys.length) ? sectionKeys.slice() : ioAllSectionKeys();
  const isFull = ioIsFullSelection(keys);
  const wantEvents = keys.indexOf('events') !== -1;
  const evts = wantEvents ? (eventsArr||[]) : [];
  const src = isFull ? S : sliceStateForExport(S, keys);
  const backup=Object.assign({}, src, {events: evts});
  const _lastMs=function(arr){let mx=0;(arr||[]).forEach(x=>{const c=(x.createdAt||0),u=(x.updatedAt||0);if(c>mx)mx=c;if(u>mx)mx=u;});return mx;};
  // Counts describe what is IN THE FILE, not what is on the device. On a partial
  // export `src` is the slice, so a file holding only To-dos reports only those.
  backup._backup={ schema:2, exportedAt:new Date().toISOString(), appVersion:APP_VERSION,
                   eventCount:evts.length,
                   items:{ tasks:(src.tasks||[]).length, rewards:(src.rewards||[]).length,
                           tags:(src.tags||[]).length,
                           views:((src.prefs&&src.prefs.an&&src.prefs.an.views)||[]).length,
                           lastActivityAt:new Date(Math.max(_lastMs(src.tasks),_lastMs(src.rewards))||Date.now()).toISOString() } };
  // The manifest is what makes a partial file self-describing: detectExportSections()
  // trusts it over payload inspection, so a section the user ticked but that happened
  // to be empty is still offered on import (and can therefore be Replaced with empty).
  if(!isFull){
    backup._backup.partial = true;
    backup._backup.sections = keys;
  }
  // Compute hash over the DETOKENIZED (legacy-shaped) backup string (without hash
  // field), then inject it. Hashing the detokenized form keeps the hash stable
  // across re-exports regardless of dictionary ordering, and keeps old schema-1
  // backups valid (their hash was always on the detokenized form).
  // 2026-09-19 (round 3, review item 6): record WHICH algorithm produced the
  // hash. hashAlgo is written BEFORE the hash is computed, so it is inside the
  // hashed bytes and importData can trust it. Older files carry no hashAlgo;
  // importData infers those from the fallback digest's own prefix.
  let hash = null;
  try{
    backup._backup.hashAlgo = hashAlgoName();
    const preJson = JSON.stringify(backup);
    hash = await computeHashWith(preJson, backup._backup.hashAlgo);
    backup._backup.hash = hash;
  }catch(e){ /* hash optional; export proceeds without it */ }
  // Build the schema-2 tokenized envelope (tokenized form is export-only).
  // Tokenize the SLICE, not S: the envelope must carry exactly what the hash was
  // computed over, or a partial export fails its own integrity gate on import.
  const tok = _tokenizeEvents(evts);
  const snapTok = _tokenizeSnapshot(src);
  const env = {
    _backup: backup._backup,
    K: tok.K, SRC: tok.SRC, TID: tok.TID, TT: tok.TT, FM: snapTok.FM,
    S: snapTok.S,
    E: tok.E
  };
  const finalJson = JSON.stringify(env, null, 2);
  const blob = new Blob([finalJson], {type:'application/json'});
  const stamp=_fileStamp();
  // A partial file is named differently on purpose: it is NOT a backup, and the
  // filename is the only thing the user sees in their downloads folder a year later.
  const filename = (isFull ? 'questa-backup-' : 'questa-partial-')+stamp+'.json';
  return {blob, filename, eventCount: evts.length, partial: !isFull, sections: keys};
}

// --- Plain-text exports (CSV / Markdown) -------------------------------------
// A SIBLING of the backup path, never a replacement. These files are for OTHER
// apps -- spreadsheets, Todoist, Asana, Obsidian, Notion. They are lossy and
// cannot be imported back, which is why they are never hashed, never tokenized,
// and never clear the "back up your data" reminder.
//
// Nothing here may touch _EXPORT_FIELD_MAP, the snapshot tokenizer or
// computeHash: adding a field code makes new files unreadable by older builds,
// and tools/join_exports.py depends on that map not moving.
const PLAIN_TASK_SECTIONS = ['todos','dailies','habits'];
const _PLAIN_DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function ioHasTaskSection(keys){
  return (keys||[]).some(function(k){ return PLAIN_TASK_SECTIONS.indexOf(k) !== -1; });
}

// Shared filename stamp: local time, YYYYMMDD-HHMM. Used by the backup builder
// too, so a backup and a CSV written in the same minute carry the same stamp.
function _fileStamp(d){
  d = d || new Date();
  const p = (n)=>String(n).padStart(2,'0');
  return ''+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes());
}

// RFC 4180 cell. EVERY cell is quoted: an unquoted cell that later gains a
// comma, a quote or a newline is the classic silent column shift, and quoting
// unconditionally costs only bytes. Inner quotes are doubled.
function _csvCell(v){
  if(v==null) return '""';
  return '"' + String(v).replace(/"/g,'""') + '"';
}

// Tag ids -> human names. An importing app cannot resolve a Questa uid, so the
// id form is useless outside this app; an unknown id is dropped rather than
// leaked as a raw uid.
function _tagNames(ids){
  const all = (S && S.tags) || [];
  return (ids||[]).map(function(id){
    const t = all.find(function(x){ return x && x.id===id; });
    return t ? t.name : null;
  }).filter(Boolean);
}

// repeat[] is 7 booleans, index 0 = Sunday, and it is the ONLY recurrence
// Questa stores. There is no due-date field anywhere in the model, so this
// column is the closest honest answer to "when" -- which is also why there is
// no iCalendar export: it would have nothing real to put in DTSTART.
function _repeatText(t){
  const r = (t && t.repeat) || [];
  if(!Array.isArray(r) || r.length!==7) return '';
  const on = [];
  for(let i=0;i<7;i++) if(r[i]) on.push(_PLAIN_DAY_NAMES[i]);
  if(on.length===0) return '';
  if(on.length===7) return 'Every day';
  return on.join(',');
}

function _reminderText(t){
  return ((t && t.reminders) || []).map(function(r){
    if(!r) return null;
    if(r.kind==='once')   return (r.date||'') + (r.time ? (' ' + r.time) : '');
    if(r.kind==='weekly') return 'weekly ' + ((r.days||[]).map(function(d){ return _PLAIN_DAY_NAMES[d]||d; }).join(',')) + (r.time ? (' ' + r.time) : '');
    return 'daily' + (r.time ? (' ' + r.time) : '');
  }).filter(Boolean).join('; ');
}

function _checklistText(t){
  return ((t && t.checklist) || []).map(function(c){
    if(!c) return null;
    return (c.done ? '[x] ' : '[ ] ') + (c.text||'');
  }).filter(Boolean).join(' | ');
}

// difficulty -> a 1..4 priority most importers understand (1 = highest).
// 'log' is a habit-only no-score marker and has no priority meaning.
function _priorityOf(t){
  const d = (t && t.difficulty) || '';
  if(d==='hard')    return '1';
  if(d==='medium')  return '2';
  if(d==='easy')    return '3';
  if(d==='trivial') return '4';
  return '';
}

function _listLabel(t){
  const ty = (t && t.type) || '';
  if(ty==='todo')  return 'To-dos';
  if(ty==='daily') return 'Dailies';
  if(ty==='habit') return 'Habits';
  return ty;
}

function _isoOrEmpty(ms){
  if(typeof ms!=='number' || !isFinite(ms) || ms<=0) return '';
  try{ return new Date(ms).toISOString(); }catch(e){ return ''; }
}

const _CSV_HEADERS = ['title','notes','type','status','list','priority','tags',
                      'repeat','reminder','checklist','streak','created','completed','id'];

// `src` is the slice from sliceStateForExport(S, keys) -- the SAME input
// buildBackupFile() consumes, which is what lets one section picker drive both
// paths. That slice already concatenates the ticked task types into src.tasks.
function buildTasksCsv(src){
  const rows = [];
  rows.push(_CSV_HEADERS.map(_csvCell).join(','));
  ((src && src.tasks) || []).forEach(function(t){
    if(!t) return;
    rows.push([
      t.title || '',
      t.notes || '',
      t.type || '',
      t.done ? 'completed' : 'needs action',
      _listLabel(t),
      _priorityOf(t),
      _tagNames(t.tags).join('; '),
      _repeatText(t),
      _reminderText(t),
      _checklistText(t),
      (typeof t.streak==='number' ? String(t.streak) : ''),
      _isoOrEmpty(t.createdAt),
      _isoOrEmpty(t.completedAt),
      t.id || ''
    ].map(_csvCell).join(','));
  });
  // CRLF row ends: what RFC 4180 asks for and what Excel is happiest with.
  return rows.join('\r\n') + '\r\n';
}

// Markdown title text. Square brackets would break the "- [ ] " checkbox and a
// backtick or pipe can break a title out of its line, so those are escaped and
// embedded newlines are flattened.
function _mdEsc(s){
  return String(s==null?'':s).replace(/([\\`*_\[\]|])/g, '\\$1').replace(/\r?\n/g,' ');
}

function buildTasksMarkdown(src){
  const out = [];
  out.push('# Questa export - ' + new Date().toISOString().slice(0,10));
  out.push('');
  PLAIN_TASK_SECTIONS.forEach(function(key){
    const ty = (key==='todos') ? 'todo' : (key==='dailies') ? 'daily' : 'habit';
    const list = _tasksOfType((src && src.tasks) || [], ty);
    if(!list.length) return;
    const sec = (typeof ioSectionByKey==='function') ? ioSectionByKey(key) : null;
    out.push('## ' + ((sec && sec.label) || key));
    out.push('');
    list.forEach(function(t){
      const tags = _tagNames(t.tags).map(function(n){ return '`#' + n + '`'; }).join(' ');
      const bits = [];
      const rep = _repeatText(t); if(rep) bits.push(rep);
      if(typeof t.streak==='number' && t.streak>0) bits.push('streak ' + t.streak);
      const doneDay = t.done ? _isoOrEmpty(t.completedAt).slice(0,10) : '';
      if(doneDay) bits.push('done ' + doneDay);
      out.push('- [' + (t.done?'x':' ') + '] ' + _mdEsc(t.title||'(untitled)') +
               (tags ? ('  ' + tags) : '') +
               (bits.length ? ('  - ' + bits.join(' | ')) : ''));
      (t.notes||'').split(/\r?\n/).forEach(function(line){
        if(line.trim()) out.push('  - ' + _mdEsc(line));
      });
      ((t.checklist)||[]).forEach(function(c){
        if(!c) return;
        out.push('  - [' + (c.done?'x':' ') + '] ' + _mdEsc(c.text||''));
      });
    });
    out.push('');
  });
  return out.join('\r\n') + '\r\n';
}

// fmt is 'csv' or 'md'. Returns the {blob, filename} shape buildBackupFile
// returns, so showExportChooser() consumes it unchanged.
function buildPlainExportFile(src, fmt){
  const stamp = _fileStamp();
  if(fmt==='csv'){
    // The BOM is not decoration: without it Excel reads the file in the local
    // ANSI code page and every accented task title comes out mangled.
    const text = '\uFEFF' + buildTasksCsv(src);
    return { blob: new Blob([text], {type:'text/csv;charset=utf-8'}),
             filename: 'questa-tasks-'+stamp+'.csv' };
  }
  const md = buildTasksMarkdown(src);
  return { blob: new Blob([md], {type:'text/markdown;charset=utf-8'}),
           filename: 'questa-tasks-'+stamp+'.md' };
}

// opts (all optional): {isBackup, title, hint, logNote}. Defaults keep the
// historic backup behaviour for every existing caller.
function showExportChooser(blob, filename, eventCount, opts) {
  opts = opts || {};
  const isBackup = (opts.isBackup !== false);
  const sheet = document.getElementById('sheet');
  const shareName = filename.replace(/\.(json|csv|md)$/, '.txt');
  const shareFile = new File([blob], shareName, {type: 'text/plain'});
  const canShareFiles = !!(navigator.canShare && navigator.canShare({files: [shareFile]}));

  // Dropbox uploads to the fixed backup path in sync.js, so it is offered for
  // backups only -- a CSV must never land where a restore looks for a backup.
  const dbxAvailable = (isBackup && typeof syncCfg==="function" && typeof exportSaveDropbox==="function" && syncCfg().enabled);

  let h = '<h3>' + esc(opts.title || 'Export backup') + '</h3>';
  h += '<div class="small" style="margin-bottom:12px">' + esc(opts.hint || 'Choose where to save your backup.') + '</div>';
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
    if (canShareFiles) exportShare(blob, filename, eventCount, opts);
  };
  document.getElementById('exportSaveBtn').onclick = () => {
    exportSaveDevice(blob, filename, eventCount, opts);
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

async function exportShare(blob, filename, eventCount, opts) {
  opts = opts || {};
  const isBackup = (opts.isBackup !== false);
  const shareName = filename.replace(/\.(json|csv|md)$/, '.txt');
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
    // A CSV or Markdown file is NOT a backup: it is lossy and cannot be
    // imported. Stamping lastExportTs here would silence the "back up your
    // data" nag on the strength of a file that can restore nothing.
    if (isBackup) {
      S.prefs.lastExportTs = Date.now();
      save();
      checkExportStaleness();
    }
    toast('Exported' + (eventCount ? (' (' + eventCount + ' events)') : ''));
    closeSheet();
    logEvent({kind: 'export', taskTitle: 'Export Data', notes: (opts.logNote || 'Created backup file via Share')});
  }
}

function exportSaveDevice(blob, filename, eventCount, opts) {
  opts = opts || {};
  const isBackup = (opts.isBackup !== false);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  // See exportShare: only a real backup may clear the staleness nag.
  if (isBackup) {
    S.prefs.lastExportTs = Date.now();
    save();
    checkExportStaleness();
  }
  toast('Exported' + (eventCount ? (' (' + eventCount + ' events)') : ''));
  closeSheet();
  logEvent({kind: 'export', taskTitle: 'Export Data', notes: (opts.logNote || 'Created backup file via Download')});
}

// --- Section picker dialogs (export + import) --------------------------------
// Both pickers render from IO_SECTIONS, so a new section appears in both dialogs
// with no dialog code change. Checkbox state is held in a plain object and mutated
// in place by the change handler rather than by repainting, so ticking a box never
// steals focus or scrolls the list back to the top on a long list.
function _ioRowsHTML(keys, counts, sel){
  let h='<div class="ioPick">';
  keys.forEach(function(k){
    const sec = ioSectionByKey(k); if(!sec) return;
    const n = counts[k];
    h+='<label class="ioPickRow">'+
       '<input type="checkbox" class="ioPickBox" data-iokey="'+esc(k)+'"'+(sel[k]?' checked':'')+'>'+
       '<span class="ioPickMain"><strong>'+esc(sec.label)+'</strong>'+
       '<span class="small">'+esc(sec.hint)+'</span></span>'+
       '<span class="ioPickCount small">'+(n==null?'…':n)+'</span>'+
       '</label>';
  });
  h+='</div>';
  return h;
}
function _ioBindRows(sel, onChange){
  const boxes = document.querySelectorAll('.ioPickBox');
  for(let i=0;i<boxes.length;i++){
    boxes[i].onchange = function(){
      sel[this.getAttribute('data-iokey')] = this.checked;
      if(onChange) onChange();
    };
  }
}
function _ioSetAll(sel, keys, val, onChange){
  keys.forEach(function(k){ sel[k]=val; });
  const boxes = document.querySelectorAll('.ioPickBox');
  for(let i=0;i<boxes.length;i++) boxes[i].checked = val;
  if(onChange) onChange();
}
function _ioSelected(sel, keys){ return keys.filter(function(k){ return !!sel[k]; }); }

function showExportSectionPicker(){
  const sheet = document.getElementById('sheet');
  const keys = ioAllSectionKeys();
  const sel = {}; keys.forEach(function(k){ sel[k]=true; });
  const counts = {};
  keys.forEach(function(k){
    if(k==='events'){ counts[k]=null; return; }   // filled in async below
    const sec = ioSectionByKey(k);
    try{ counts[k] = sec.count(S)||0; }catch(e){ counts[k] = 0; }
  });

  let h = '<h3>What do you want to export?</h3>';
  h += '<div class="small" style="margin-bottom:10px">Everything is ticked, which writes a normal full backup. Untick a box to leave it out.</div>';
  h += _ioRowsHTML(keys, counts, sel);
  h += '<div class="settingsRow" style="margin-top:10px">'+
       '<button class="btn ghost" id="ioExpAll">All</button>'+
       '<button class="btn ghost" id="ioExpNone">None</button>'+
       '<button class="btn ghost" id="ioExpGo">Continue</button>'+
       '<button class="btn ghost" id="ioExpCancel">Cancel</button>'+
       '</div>';
  h += '<div class="small" id="ioExpNote" style="margin-top:8px"></div>';
  sheet.innerHTML = h;

  function refresh(){
    const picked = _ioSelected(sel, keys);
    const note = document.getElementById('ioExpNote');
    const go = document.getElementById('ioExpGo');
    if(go) go.disabled = (picked.length===0);
    if(!note) return;
    if(picked.length===0){
      note.textContent = 'Tick at least one box.';
    } else if(ioIsFullSelection(picked)){
      note.textContent = 'Full backup · questa-backup-….json';
    } else {
      note.textContent = 'Partial export · questa-partial-….json · restores only the ticked boxes.';
    }
  }
  _ioBindRows(sel, refresh);
  document.getElementById('ioExpAll').onclick = function(){ _ioSetAll(sel, keys, true, refresh); };
  document.getElementById('ioExpNone').onclick = function(){ _ioSetAll(sel, keys, false, refresh); };
  document.getElementById('ioExpCancel').onclick = function(){ closeSheet(); };
  document.getElementById('ioExpGo').onclick = function(){
    const picked = _ioSelected(sel, keys);
    if(!picked.length) return;
    showExportFormatPicker(picked);
  };
  refresh();
  // Event count needs IndexedDB, so the row shows an ellipsis until it lands. A
  // failure leaves the ellipsis rather than a wrong "0" the user would read as
  // "my history is gone".
  if(typeof countEvents === 'function'){
    countEvents().then(function(n){
      counts.events = n;
      const rows = document.querySelectorAll('.ioPickRow');
      for(let i=0;i<rows.length;i++){
        const box = rows[i].querySelector('.ioPickBox');
        if(box && box.getAttribute('data-iokey')==='events'){
          const c = rows[i].querySelector('.ioPickCount');
          if(c) c.textContent = String(n);
        }
      }
    }).catch(function(){});
  }
  document.getElementById('scrim').classList.add('show');
}

// Public entry point kept under its historic name: the Settings button, and
// anything else already wired to it, now opens the picker instead of exporting
// straight away.
function exportData(){ showExportSectionPicker(); }

function runExport(sectionKeys){
  const keys = (Array.isArray(sectionKeys) && sectionKeys.length) ? sectionKeys : ioAllSectionKeys();
  const wantEvents = keys.indexOf('events') !== -1;
  // backups are for debugging: user-facing export downloads must include
  // diagnostic-kind events, not just the Activity-Feed-visible subset.
  //
  // 2026-09-18: two ways this used to hand the user a backup that was quietly
  // incomplete, and no later check could ever detect it.
  //
  //  (a) getEvents() is documented to return [] on any failure and never throw.
  //      It also resolves a PARTIAL array when the IDB cursor errors mid-scan.
  //      buildBackupFile then stamps _backup.eventCount from whatever it got, so
  //      the file is internally self-consistent: 300 of 7,250 events, labelled
  //      "300 events", verifying fine on import. Now cross-checked against
  //      countEvents(), which counts the store directly, and the user is asked
  //      before a short export is written.
  //
  //  (b) the .catch was chained AFTER showExportChooser, so a throw inside the
  //      chooser (missing DOM node, navigator.canShare throwing) discarded the
  //      real backup and re-opened the chooser with a 0-event one. The recovery
  //      path now wraps only the build, never the chooser.
  //
  // 2026-09-18 (granular): when the Event log box is UNTICKED the store is never
  // read, so the short-read guard below has nothing to guard and must not fire —
  // otherwise leaving events out would always prompt "0 of 7,250 events missing".
  Promise.all([ wantEvents ? getEvents({includeDiag:true}) : Promise.resolve([]),
                wantEvents ? countEvents().catch(()=>null) : Promise.resolve(null) ])
    .then(([events, stored]) => {
      const got = (events||[]).length;
      if(wantEvents && stored != null && got < stored){
        const missing = stored - got;
        return confirmDialog('Incomplete backup',
          'Only ' + got + ' of ' + stored + ' events could be read from this device (' +
          missing + ' missing). The backup file would be incomplete.\n\n' +
          'Write it anyway?').then(ok => {
            if(!ok){ toast('Export cancelled'); return null; }
            return events;
          });
      }
      return events;
    })
    .then(events => {
      if(events === null) return null;             // user declined a short export
      // 2026-09-18 (round 2): NO empty-shell fallback. This used to be
      // `.catch(() => buildBackupFile([]))`, which turned any build failure — a
      // RangeError from JSON.stringify on a huge store, an OOM in new Blob() on a
      // low-memory phone — into a backup containing ZERO events, stamped
      // `_backup.eventCount: 0`, handed to the chooser as a normal success. It
      // passed its own hash gate, exportSaveDevice toasted a plain "Exported"
      // because 0 is falsy, lastExportTs was stamped and the staleness nag cleared.
      // That is precisely the undetectable-truncation failure the guard above asks
      // the user about, taken to 100% loss. Let it reach the outer .catch, which
      // already shows an Export Error dialog and pushes a diagnostic.
      return buildBackupFile(events, keys);
    })
    .then(res => { if(res) showExportChooser(res.blob, res.filename, res.eventCount); })
    .catch(e => {
      try{ if(typeof _qDiagPush === "function") _qDiagPush('exportFailed', { error: (e && e.message) || String(e) }); }catch(_){}
      alertDialog('Export Error', 'Could not create the backup file: ' + ((e && e.message) || String(e)));
    });
}
// --- Format step -------------------------------------------------------------
// Sits between the section picker and the save chooser. Backup JSON is the
// default and takes the byte-for-byte path that already existed; CSV and
// Markdown are a separate, read-only branch that cannot be imported back.
function showExportFormatPicker(keys){
  const sheet = document.getElementById('sheet');
  const hasTasks = ioHasTaskSection(keys);
  let h = '<h3>What kind of file?</h3>';
  h += '<div class="small" style="margin-bottom:12px">Backup restores Questa. The other two are for other apps.</div>';
  h += '<div class="ioPick">';
  h += '<div class="ioPickRow"><span class="ioPickMain"><strong>Backup (JSON)</strong>'+
       '<span class="small">Restores Questa. Only Questa can read it.</span></span>'+
       '<button class="btn ghost" id="expFmtJson">Choose</button></div>';
  h += '<div class="ioPickRow"><span class="ioPickMain"><strong>Spreadsheet (CSV)</strong>'+
       '<span class="small">Opens in Excel or Sheets. Most task apps import this.</span></span>'+
       '<button class="btn ghost" id="expFmtCsv"'+(hasTasks?'':' disabled')+'>Choose</button></div>';
  h += '<div class="ioPickRow"><span class="ioPickMain"><strong>Checklist (Markdown)</strong>'+
       '<span class="small">Plain text checklist for Obsidian, Notion or GitHub.</span></span>'+
       '<button class="btn ghost" id="expFmtMd"'+(hasTasks?'':' disabled')+'>Choose</button></div>';
  h += '</div>';
  if(!hasTasks){
    h += '<div class="small" style="margin-top:8px">CSV and Markdown hold tasks only. Tick To-dos, Dailies or Habits to use them.</div>';
  }
  h += '<div class="settingsRow" style="margin-top:10px">'+
       '<button class="btn ghost" id="expFmtBack">Back</button>'+
       '<button class="btn ghost" id="expFmtCancel">Cancel</button>'+
       '</div>';
  sheet.innerHTML = h;
  document.getElementById('expFmtJson').onclick = function(){ runExport(keys); };
  if(hasTasks){
    document.getElementById('expFmtCsv').onclick = function(){ runPlainExport(keys, 'csv'); };
    document.getElementById('expFmtMd').onclick  = function(){ runPlainExport(keys, 'md'); };
  }
  document.getElementById('expFmtBack').onclick = function(){ showExportSectionPicker(); };
  document.getElementById('expFmtCancel').onclick = function(){ closeSheet(); };
  document.getElementById('scrim').classList.add('show');
}

function runPlainExport(sectionKeys, fmt){
  const keys = (Array.isArray(sectionKeys) && sectionKeys.length) ? sectionKeys : ioAllSectionKeys();
  // No IndexedDB read and no short-read guard here: a plain export never
  // carries events, so there is nothing that could come back truncated. A
  // failure still reaches the same diagnostic + dialog path runExport uses --
  // an export that dies silently is the one failure this file cannot afford.
  try{
    const src = sliceStateForExport(S, keys);
    const n = ((src && src.tasks) || []).length;
    if(!n){ toast('Nothing to export'); return; }
    const res = buildPlainExportFile(src, fmt);
    const label = (fmt==='csv') ? 'CSV' : 'Markdown';
    showExportChooser(res.blob, res.filename, 0, {
      isBackup: false,
      title: 'Export ' + label,
      hint: 'For other apps. This file cannot be imported back into Questa.',
      logNote: 'Created ' + label + ' export'
    });
  }catch(e){
    try{ if(typeof _qDiagPush === "function") _qDiagPush('exportFailed', { error: (e && e.message) || String(e), fmt: fmt }); }catch(_){}
    alertDialog('Export Error', 'Could not create the ' + String(fmt).toUpperCase() + ' file: ' + ((e && e.message) || String(e)));
  }
}

// --- Granular import ---------------------------------------------------------
// Applies ONLY the ticked sections of `data`, in the chosen mode. A section the
// user left unticked is never read and never written -- that is the promise the
// import dialog makes, and it is the whole reason offering a partial restore is
// safe. Async so the caller can report a failure exactly once, in one place.
async function applyImportSections(data, keys, mode){
  const sel = {}; (keys||[]).forEach(function(k){ sel[k]=true; });
  const full = ioIsFullSelection(keys||[]);
  const replacing = (mode !== 'merge');
  const embeddedEvents = (sel.events && Array.isArray(data.events)) ? data.events : null;

  if(full && replacing){
    // Every box ticked + Replace is the historic whole-file import, kept verbatim
    // including the clobber-guard reset: an imported backup legitimately carries a
    // lower (or absent) __seq, which save() would otherwise read as "a newer writer
    // exists" and discard the import.
    S = migrate(data);
    delete S.__seq;
    try{ localStorage.removeItem(STORE_KEY + ".seq"); }catch(e){}
  } else {
    // Anything narrower keeps the LIVE object as the base, so __seq, the HLC and
    // every unticked key survive by construction, and there is no clobber to guard
    // against -- on this path the local writer really is the newest one.
    applySectionsToState(S, data, keys, replacing ? 'replace' : 'merge');
    S = migrate(S);
  }
  save(); applyWidth(); applyCardThick(); closeSheet(); render();

  if(embeddedEvents && typeof indexedDB!=="undefined"){
    // Read the existing local event store BEFORE reparenting, same house
    // pattern as confirmRestore(): getEvents() reads IndexedDB directly and is
    // unaffected by the S/migrate() reassignment above, so this is read first
    // purely to capture the pre-import baseline.
    // Union-insert only -- clearAllEvents() must NEVER be called on this path;
    // that used to wipe every local event absent from the import. Neither Replace
    // nor Merge removes an event: the Event log box means "add these", never
    // "make my log look like this file".
    const existing = await getEvents({includeDiag:true});
    // uid -> content signature, not a bare uid Set: eventMergeFilter() needs the
    // signature of the record ALREADY holding a uid so it can tell a real
    // duplicate from a hash collision (see eventUidOf()).
    const existingUidSet = new Map(); const existingSigSet = new Set();
    (existing||[]).forEach(r=>{ const s = eventMergeSig(r); if(r && r.uid) existingUidSet.set(r.uid, s); existingSigSet.add(s); });
    const reparented = reparentEventsForImport(embeddedEvents);
    const impSum = eventImportSummary(reparented);
    // The signature key (eventMergeSig; ts/kind/taskId/dir/reps) is MANDATORY
    // here, not optional: reparentEventsForImport() above overwrites e.dev to
    // THIS device and rehashes e.uid via eventUidOf(), which hashes dev as one
    // of its input fields. A foreign event that already arrived locally via sync
    // carries its ORIGINATING device's uid, while the SAME logical event coming
    // in via THIS import path gets a fresh 'rep-...' uid -- the two never
    // uid-match, so uid-only dedup would let the duplicate through.
    // Residual, accepted risk: the signature (ts,kind,taskId,dir,reps) could in
    // principle collide for two genuinely distinct taps on the same
    // task/direction/rep-count within the same millisecond -- not real user
    // behaviour.
    const merge = eventMergeFilter(reparented, existingUidSet, existingSigSet);
    const add = merge.add, skipped = merge.skipped;
    // Report what bulkAddEvents ACTUALLY wrote. It returns {added, failed,
    // aborted} on every path including its four failure paths; using add.length
    // instead told a user whose IndexedDB quota was exhausted that 4000 events
    // were restored when zero were, so they deleted the backup file.
    const bulkRes = await bulkAddEvents(add);
    const added = (bulkRes && typeof bulkRes.added === 'number') ? bulkRes.added : add.length;
    const note = 'Restored ' + added + ' events (' + eventImportSummaryText(impSum) + '; ' + skipped + ' already present, skipped) [' +
                 (full ? 'all sections' : keys.join('+')) + '; ' + (replacing ? 'replace' : 'merge') + ']';
    logEvent({kind: 'import', taskTitle: 'Import Data', notes: note});
    toast('Imported \u00b7 ' + added + ' events restored');
    if(bulkRes && (bulkRes.aborted || bulkRes.failed)){
      alertDialog('Import incomplete',
        'The sections you picked were restored, but only ' + added + ' of ' + add.length +
        ' events could be written to this device. Keep your backup file and free up storage, then import again.',
        eventImportSummaryHTML(impSum));
    } else {
      alertDialog('Import complete',
        added + ' events restored to this device.',
        eventImportSummaryHTML(impSum));
    }
    if(TAB==='analytics') render();
    // F-import: run the same startup day-rollover the app runs on normal load
    // (app.js startDay) so imported dailies get reset / the missed-yesterday
    // prompt fires if the device calendar has advanced. Without this, importing
    // a state that still carried done:true dailies from a prior day showed stale
    // "yesterday" completion with no start-of-day correction.
    startDay();
  } else {
    const what = full ? 'Imported from backup'
                      : ('Imported sections: ' + keys.join('+') + ' (' + (replacing ? 'replace' : 'merge') + ')');
    logEvent({kind: 'import', taskTitle: 'Import Data', notes: what});
    toast('Imported');
    if(TAB==='analytics') render();
    if(!full){
      alertDialog('Import complete',
        'Restored: ' + keys.map(function(k){ const s=ioSectionByKey(k); return s?s.label:k; }).join(', ') +
        '.\n\nEverything else on this device was left as it was.');
    }
    startDay();
  }
}

// The import counterpart of showExportSectionPicker(). Offers only the sections
// the FILE actually contains, names the ones it does not, and makes the user pick
// Replace or Merge before anything is touched.
function showImportSectionPicker(data, detected){
  const sheet = document.getElementById('sheet');
  const keys = (detected||[]).slice();
  const sel = {}; keys.forEach(function(k){ sel[k]=true; });
  const counts = {}; keys.forEach(function(k){ counts[k] = countExportSection(k, data); });
  const missing = ioAllSectionKeys().filter(function(k){ return keys.indexOf(k)===-1; });
  const isPartialFile = !!(data._backup && data._backup.partial);
  const MODE = {v:'replace'};

  let h = '<h3>What do you want to restore?</h3>';
  h += '<div class="small" style="margin-bottom:10px">'+
       (isPartialFile ? 'This is a partial export. ' : 'This is a full backup. ')+
       'Only the parts found in the file are listed. Everything is ticked; untick anything you want to keep as it is now.</div>';
  h += _ioRowsHTML(keys, counts, sel);
  if(missing.length){
    h += '<div class="small" style="margin-top:8px">Not in this file, so it will not be touched: '+
         esc(missing.map(function(k){ const s=ioSectionByKey(k); return s?s.label:k; }).join(', '))+'.</div>';
  }
  h += '<div class="colTitle" style="margin-top:12px"><h2 style="font-size:13px;flex:none">How should it be applied?</h2></div>';
  h += '<div class="ioPick">'+
       '<label class="ioPickRow"><input type="radio" class="ioModeRadio" name="ioImpMode" value="replace" checked>'+
       '<span class="ioPickMain"><strong>Replace</strong><span class="small">Each ticked part is swapped for the copy in the file. Unticked parts stay exactly as they are now.</span></span></label>'+
       '<label class="ioPickRow"><input type="radio" class="ioModeRadio" name="ioImpMode" value="merge">'+
       '<span class="ioPickMain"><strong>Merge</strong><span class="small">Nothing is removed. Items are matched by id and the newer one wins; anything that exists only on this device is kept.</span></span></label>'+
       '</div>';
  h += '<div class="settingsRow" style="margin-top:10px">'+
       '<button class="btn ghost" id="ioImpAll">All</button>'+
       '<button class="btn ghost" id="ioImpNone">None</button>'+
       '<button class="btn ghost" id="ioImpGo">Import</button>'+
       '<button class="btn ghost" id="ioImpCancel">Cancel</button>'+
       '</div>';
  h += '<div class="small" id="ioImpNote" style="margin-top:8px"></div>';
  sheet.innerHTML = h;

  function refresh(){
    const picked = _ioSelected(sel, keys);
    const note = document.getElementById('ioImpNote');
    const go = document.getElementById('ioImpGo');
    if(go) go.disabled = (picked.length===0);
    if(!note) return;
    if(picked.length===0){ note.textContent = 'Tick at least one part.'; return; }
    let t = picked.length + (picked.length===1 ? ' part' : ' parts') + ' \u00b7 ' + (MODE.v==='merge' ? 'Merge' : 'Replace') + '.';
    if(sel.events) t += ' Your event log is only added to, never cleared.';
    note.textContent = t;
  }
  _ioBindRows(sel, refresh);
  const radios = document.querySelectorAll('.ioModeRadio');
  for(let i=0;i<radios.length;i++){
    radios[i].onchange = function(){ if(this.checked) MODE.v = this.value; refresh(); };
  }
  document.getElementById('ioImpAll').onclick = function(){ _ioSetAll(sel, keys, true, refresh); };
  document.getElementById('ioImpNone').onclick = function(){ _ioSetAll(sel, keys, false, refresh); };
  document.getElementById('ioImpCancel').onclick = function(){ closeSheet(); };
  document.getElementById('ioImpGo').onclick = function(){
    const picked = _ioSelected(sel, keys);
    if(!picked.length) return;
    const label = picked.length + (picked.length===1 ? ' part' : ' parts');
    confirmDialog('Import',
      (MODE.v==='merge'
        ? 'Merge ' + label + ' from this file into your current data? Nothing will be removed.'
        : 'Replace ' + label + ' with the copy in this file? Anything you did not tick stays as it is.')
    ).then(function(ok){
      if(!ok) return;
      return applyImportSections(data, picked, MODE.v);
    }).catch(function(e){
      // The outer try/catch around importData only covers the SYNCHRONOUS parse +
      // hash gate. Everything below runs in an async callback whose promise would
      // otherwise be discarded, so a throw after the state was already replaced
      // left the live state persisted, the event store untouched, the sheet closed
      // and startDay() never run -- with no dialog, no toast and nothing in the log.
      try{ if(typeof _qDiagPush === "function") _qDiagPush('importFailed', { error: (e && e.message) || String(e) }); }catch(_){}
      alertDialog('Import Error',
        'The import did not finish: ' + ((e && e.message) || String(e)) +
        '\n\nSome of your data may already have been replaced. Keep your backup file and try importing it again.');
    });
  };
  refresh();
  document.getElementById('scrim').classList.add('show');
}

function importData(ev){
  const f=ev.target.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>{ try{ const parsed=JSON.parse(rd.result);
      // Detect tokenized schema-2 export and expand it to the legacy shape
      // (full event objects + long snapshot keys) BEFORE any validation or
      // consumption. Schema-1 files (no _backup.schema===2) pass through.
      let data;
      if(parsed && parsed._backup && parsed._backup.schema===2){
        data = _detokenizeSnapshot(parsed);
        data.events = _detokenizeEvents(parsed);
        if(parsed._backup){
          data._backup = Object.assign({}, parsed._backup);
        }
      } else {
        data = parsed;
      }
      const detected = detectExportSections(data);
      // Was `if(!data.char||!Array.isArray(data.tasks)) throw 0;`. That gate refused
      // every legitimate partial export -- a file holding only To-dos has no `char`
      // and carries no `tasks` array at all. A file is valid when it carries AT LEAST
      // ONE recognised section. detectExportSections() trusts the _backup.sections
      // manifest when one is present and otherwise infers the sections from the
      // payload, so legacy schema-1 files and schema-2 full backups pass exactly as
      // they did before, and both are now granularly importable.
      if(!detected.length) throw 0;
      const doImport = () => { showImportSectionPicker(data, detected); };
      // Hash check: re-stringify the DETOKENIZED legacy-shaped object. For
      // schema-2 this is the same canonical form that buildBackupFile hashed
      // (it hashes the legacy-shaped backup, not the tokenized envelope).
      if(data._backup && data._backup.hash){
        const expectedHash = data._backup.hash;
        delete data._backup.hash;
        const cleanStr = JSON.stringify(data);
        data._backup.hash = expectedHash;
        // 2026-09-19 (round 3, review item 6): verify with the algorithm the
        // FILE used, not with the best one this context happens to offer. A
        // backup written over plain HTTP was re-hashed with SHA-256 here and
        // refused as corrupt. computeHashWith rejects when the named algorithm
        // is unavailable, and the existing .catch() below then SKIPS the gate
        // rather than condemning a good backup.
        const hashAlgo = data._backup.hashAlgo
          || (/^fallback-/.test(String(expectedHash)) ? 'fallback32' : 'sha256');
        computeHashWith(cleanStr, hashAlgo).then(check => {
          if(check !== expectedHash){
            alertDialog('Import Error', 'This file appears to be corrupted or tampered with (hash mismatch). Import cancelled.');
            return;
          }
          doImport();
        }).catch(() => doImport());
      } else {
        doImport();
      }
    }catch(e){
      // 2026-09-19 (round 3, review item 5): an unrecognised export field code
      // can only mean the file came from a NEWER build. Say so. The old
      // `RM[sk] || sk` said nothing and imported a reshaped record instead.
      if(e && e.code === 'QUESTA_UNKNOWN_FIELD_CODE'){
        alertDialog('Import Error', 'This backup was made by a newer version of'
          + ' Questa. It uses a field this build does not understand ("'
          + e.fieldCode + '"). Update Questa, then import it again.');
        return;
      }
      // A CSV or Markdown export is text, not JSON, so it lands here as a
      // parse error. Name it, rather than saying "not valid", which reads as
      // "your file is broken".
      let head = '';
      try{ head = String(rd.result||'').replace(/^\uFEFF/,'').replace(/^\s+/,'').charAt(0); }catch(_){}
      if(head && head !== '{'){
        alertDialog('Error', 'That looks like a CSV or Markdown export. Those are for other apps and cannot be imported. Only a backup .json file can be imported.');
      } else {
        alertDialog('Error', 'That file does not look like a valid Questa backup.');
      }
    } };
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

    // 2026-09-19 (round 3, item 15): rehydrate a parked avatar. Older snapshots
    // carry faceImg inline and have no avatarRef, so they skip this untouched.
    // A missing parked image is NOT a restore failure -- the avatar is
    // decoration, and refusing to restore a user's tasks over a lost picture
    // would be the wrong trade. It restores blank and they pick a new one.
    if(data.avatarRef && !stateSnapshot.char.faceImg){
      try{
        const _img = await avatarGet(data.avatarRef);
        if(_img) stateSnapshot.char.faceImg = _img;
      }catch(e){ /* restore proceeds without the avatar */ }
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

    // Read the existing event store BEFORE touching anything else. getEvents()
    // reads IndexedDB directly and is unaffected by the S/migrate() reassignment
    // below (migrate() is a synchronous in-memory state normalizer that makes
    // zero IDB calls and explicitly deletes any .events field -- events live
    // only in IndexedDB). This is read first purely so the merge below has the
    // pre-restore baseline; not because migrate() would otherwise empty it.
    const existing = await getEvents({includeDiag:true});
    // uid -> content signature (see the twin at importData()): a Map lets
    // eventMergeFilter() separate a duplicate from a uid collision.
    const existingUidSet = new Map(); const existingSigSet = new Set();
    (existing||[]).forEach(r=>{ const s = eventMergeSig(r); if(r && r.uid) existingUidSet.set(r.uid, s); existingSigSet.add(s); });

    // Apply state
    S = migrate(stateSnapshot);
    if(typeof _adoptStateStamps==='function') _adoptStateStamps();   // 2026-09-18 round 2 — see _adoptStateStamps
    // 2026-09-18: a restore deliberately installs an OLDER __seq (snapshots carry
    // the whole state, __seq included). save()'s multi-tab clobber guard reads a
    // lower __seq as "another tab wrote something newer", re-adopts the pre-restore
    // localStorage blob and returns WITHOUT writing — silently undoing the restore
    // with only a filtered-out diagnostic event to show for it. resetEverything()
    // already clears the companion key for exactly this reason; do the same here.
    delete S.__seq;
    try{ localStorage.removeItem(STORE_KEY + ".seq"); }catch(e){}
    save();
    applyWidth();
    applyCardThick();

    // Merge events: do NOT clear the local store here. clearAllEvents()
    // followed by bulkAddEvents(events) used to destroy every local event not
    // present in the restored backup -- this is the mechanism that wiped
    // independent per-device event history when a stale backup was restored.
    // Union-insert only: existing local events are left untouched, and only
    // genuinely new backup events (by uid, falling back to content signature)
    // are added.
    if(events.length > 0 && typeof indexedDB !== "undefined"){
      const merge = eventMergeFilter(events, existingUidSet, existingSigSet);
      const add = merge.add, skipped = merge.skipped;
      const bulkResult = await bulkAddEvents(add);
      // 2026-09-18 (round 2): read the RESULT, the way the import path does. This
      // reported bulkResult.added unguarded and never looked at .failed/.aborted, so
      // a quota-exhausted or aborted transaction still produced a cheerful "Restored
      // snapshot from ..." toast with an empty Activity Feed — the same failure that
      // made a user delete their backup file believing 4000 events had landed.
      const added = (bulkResult && typeof bulkResult.added === 'number') ? bulkResult.added : 0;
      logEvent({kind: 'restore', taskTitle: 'Restore from snapshot', notes: 'Restored ' + added + ' events (' + skipped + ' already present, skipped)'});
      if(bulkResult && (bulkResult.aborted || bulkResult.failed)){
        alertDialog('Restore incomplete',
          'The character and tasks were restored, but only ' + added + ' of ' + add.length +
          ' events could be written to this device. Keep the snapshot and free up storage, then restore again.');
      }
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
// Escape a value that lands inside a SINGLE-quoted JS string literal within a
// double-quoted inline handler, e.g. onclick="f('<here>')". esc() is not enough:
// the HTML parser decodes entities BEFORE the JS is compiled, so &#39; becomes a
// live quote again. Escape for JS first (backslash, then quote), then for HTML.
// Order matters — the backslash pass must run before the quote pass.
function jsq(s){
  return String(s==null?'':s)
    .replace(/\\/g,'\\\\')
    .replace(/'/g,"\\'")
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
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
  function inHGesture(t){ return !!(t && t.closest && t.closest('#anSlider, input[type=range], .anSlider, .seg, .anHeat')); }

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
// 2026-09-18 (round 2): if load() could not read the stored state, say so. The
// original bytes are kept under LOAD_FAILED.key so they can still be recovered by
// hand; without this the user just saw a brand-new empty character.
if(LOAD_FAILED){
  setTimeout(function(){
    try{ toast('Saved data could not be read. The original is kept in this browser as "' + LOAD_FAILED.key + '". Restore a backup before adding anything.'); }catch(e){}
  }, 600);
}
bootStartDay(); // D3 todo 13: gates only the day-rollover decision, never the paint
try{ if(typeof location!=='undefined' && location && typeof location.search==='string' && typeof parseQuickParams==='function' && typeof applyQuickIntent==='function'){ var _ql=parseQuickParams(location.search); if(_ql) applyQuickIntent(_ql); } }catch(e){} // android-quick-habit-log todo 1: kick off a deep-link quick log at boot (stashes while the rollover gate is closed)
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
  // 2026-09-18: set the "done" flag only on SUCCESS. The .catch(()=>{}) used to sit
  // BEFORE the .then(), converting a rejection into a fulfilment, so a boot where
  // IndexedDB was briefly unavailable marked the purge done and the stale lifecycle
  // spam it exists to remove stayed on that device forever.
  if(localStorage.getItem("questa.lifecycleCleanup.v1") !== "done"){
    clearLifecycleEvents().then(()=>{
      try{ localStorage.setItem("questa.lifecycleCleanup.v1", "done"); }catch(e){}
    }).catch(()=>{});
  }
}catch(e){ /* best-effort */ }
checkExportStaleness();
// #11b: Request persistent storage to reduce browser-eviction risk (Safari ITP
// 7-day wipe, Chrome eviction under pressure). PWAs get this automatically;
// browser-tab usage does not (MDN: all-or-nothing per origin).
try{ if(navigator&&navigator.storage&&typeof navigator.storage.persist==="function"){ navigator.storage.persist().then(function(granted){ if(typeof logEvent==="function") logEvent({kind:"storagePersist", granted:!!granted}); }).catch(function(){}); } }catch(_){}

setTimeout(()=>{
  if(_flushPromise) return;
  // F6 (2026-08-18): a no-op open no longer writes a snapshot. See _shouldStartupSnapshot().
  _shouldStartupSnapshot().then(go=>{
    if(!go) return;
    if(!_flushPromise){ _flushPromise = takeSnapshot().catch(()=>{}).finally(()=>{ _flushPromise=null; }); }
  }).catch(()=>{});
}, 5000);
