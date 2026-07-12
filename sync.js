// ============================================================================
// sync.js — Dropbox-backed cross-device sync for Questa
// ============================================================================
// Loads AFTER app.js (see index.html). References app.js globals directly:
// S, save, uid, idbOpen, toast, render, esc, STORE_KEY. Every entry point that
// app.js calls into this file is guarded with typeof checks on the app.js
// side, so if this file fails to load (or is deliberately removed) the app
// keeps working with sync simply disabled.
//
// Design reference: .omo/plans/2026-07-10-dropbox-sync.md (read that first).
// Nothing here should surprise you if you've read the plan; comments below
// mostly flag the handful of places where this implementation had to make a
// judgment call the plan didn't pin down exactly.
// ============================================================================

// ---- 2.1 Constants ---------------------------------------------------------
const DBX_APP_KEY = "9bmdhb7j1b5nuke"; // not a secret — public PKCE client_id
const SYNC_KEY = "questa.sync.v1";
const PKCE_KEY = "questa.sync.pkce";
const STATE_PATH = "/state.json";
const SYNC_DEBOUNCE_MS = 5000;
const SYNC_CONFLICT_RETRY_LIMIT = 3;
const SYNC_TRANSIENT_RETRY_DELAYS_MS = [1000, 5000, 25000]; // 429/5xx backoff

// ---- 2.2 Config read/patch --------------------------------------------------
function syncCfgDefaults(){
  return {
    enabled: false,
    appKey: DBX_APP_KEY,
    refreshToken: null,
    accessToken: null,
    accessExpiresAt: 0,
    lastRev: null,
    lastSyncAt: null,
    lastError: null,
    deviceId: null,
    evtLastUploadTs: 0,   // watermark: max ts of own events already uploaded
    evtFileRevs: {},      // filename -> Dropbox rev of last successfully pulled version
    evtLastPullAt: 0      // throttle: last time we ran a pull
  };
}
function syncCfg(){
  try{
    const raw = localStorage.getItem(SYNC_KEY);
    if(raw){ return Object.assign(syncCfgDefaults(), JSON.parse(raw)); }
  }catch(e){ /* fall through to defaults */ }
  return syncCfgDefaults();
}
function syncCfgSave(patch){
  const next = Object.assign(syncCfg(), patch);
  try{ localStorage.setItem(SYNC_KEY, JSON.stringify(next)); }catch(e){ /* quota etc — non-fatal */ }
  return next;
}

// ---- 2.3 Device id / event uid ---------------------------------------------
function syncDeviceId(){
  const cfg = syncCfg();
  if(cfg.deviceId) return cfg.deviceId;
  const id = (typeof uid === "function")
    ? uid()
    : (Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
  syncCfgSave({ deviceId: id });
  return id;
}
function syncEventUid(){
  return syncDeviceId() + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

// ---- 2.4 PKCE helpers -------------------------------------------------------
function b64url(bufferLike){
  const bytes = new Uint8Array(bufferLike);
  let str = "";
  for(let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  const b64 = (typeof btoa === "function") ? btoa(str) : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pkceVerifier(){
  const arr = new Uint8Array(64);
  crypto.getRandomValues(arr);
  return b64url(arr); // ~86 chars, within the 43-128 char PKCE range
}
async function pkceChallenge(verifier){
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return b64url(digest);
}

// ---- 2.5 syncConnect() — full-page redirect (no popups) --------------------
async function syncConnect(){
  try{
    const verifier = pkceVerifier();
    const challenge = await pkceChallenge(verifier);
    const redirectUri = location.origin + location.pathname;
    // Persist the EXACT redirect_uri used for this authorize call alongside the
    // verifier, and reuse it verbatim during token exchange in
    // syncHandleRedirect(). Recomputing location.pathname fresh at redirect time
    // is fragile: static servers/browsers can normalize "/index.html" vs "/" or
    // trailing slashes differently between the two moments, and Dropbox's
    // /oauth2/token endpoint requires the redirect_uri to match byte-for-byte
    // what was used at /oauth2/authorize — a mismatch here fails the token
    // exchange silently (caught, logged to lastError) even though the user
    // already saw and approved the consent screen.
    localStorage.setItem(PKCE_KEY, JSON.stringify({ v: verifier, r: redirectUri }));
    const params = new URLSearchParams({
      client_id: DBX_APP_KEY,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: challenge,
      token_access_type: "offline",
      redirect_uri: redirectUri
    });
    location.href = "https://www.dropbox.com/oauth2/authorize?" + params.toString();
  }catch(e){
    syncCfgSave({ lastError: "connect failed: " + (e && e.message || e) });
    if(typeof toast === "function") toast("Dropbox connect failed");
  }
}

// ---- 2.6 syncHandleRedirect() — exchange ?code= for tokens -----------------
async function syncHandleRedirect(){
  let params;
  try{ params = new URLSearchParams(location.search); }catch(e){ return; }
  const code = params.get("code");
  const pkce = (function(){
    try{
      const raw = localStorage.getItem(PKCE_KEY);
      if(!raw) return null;
      const parsed = JSON.parse(raw);
      // tolerate the pre-2026-07-10 plain-string format (verifier only, no
      // stored redirectUri) in case a connect attempt was in flight during
      // the upgrade — falls back to recomputing, same as before.
      if(typeof parsed === "string") return { v: parsed, r: null };
      return parsed;
    }catch(e){ return null; }
  })();
  const verifier = pkce && pkce.v;
  if(!code || !verifier) return;

  const redirectUri = (pkce && pkce.r) || (location.origin + location.pathname);
  try{
    const body = new URLSearchParams({
      code: code,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_id: DBX_APP_KEY,
      redirect_uri: redirectUri
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok || !data.access_token){
      throw new Error((data && (data.error_description || data.error)) || ("token exchange failed: " + res.status));
    }
    syncCfgSave({
      refreshToken: data.refresh_token,
      accessToken: data.access_token,
      accessExpiresAt: Date.now() + Math.max(0, (data.expires_in || 14400) - 60) * 1000,
      enabled: true,
      lastError: null
    });
    localStorage.removeItem(PKCE_KEY);
    history.replaceState(null, "", location.pathname);
    if(typeof toast === "function") toast("Dropbox connected");
    syncNow();
  }catch(e){
    try{ localStorage.removeItem(PKCE_KEY); }catch(e2){}
    syncCfgSave({ lastError: "connect failed: " + (e && e.message || e) });
    if(typeof toast === "function") toast("Dropbox connect failed");
  }
}

// ---- 2.7 syncToken() — valid access token, refreshing as needed -----------
async function syncToken(forceRefresh){
  const cfg = syncCfg();
  if(!cfg.refreshToken) throw new Error("not connected");
  if(!forceRefresh && cfg.accessToken && cfg.accessExpiresAt && Date.now() < cfg.accessExpiresAt){
    return cfg.accessToken;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: cfg.refreshToken,
    client_id: DBX_APP_KEY
  });
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok || !data.access_token){
    if(data && data.error === "invalid_grant"){
      syncCfgSave({ enabled: false, lastError: "reconnect required" });
    }
    throw new Error((data && (data.error_description || data.error)) || ("refresh failed: " + res.status));
  }
  const patched = syncCfgSave({
    accessToken: data.access_token,
    accessExpiresAt: Date.now() + Math.max(0, (data.expires_in || 14400) - 60) * 1000
  });
  return patched.accessToken;
}

// ---- 2.8 Dropbox API wrappers -----------------------------------------------
function dbxArgHeader(obj){
  return JSON.stringify(obj).replace(/[-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
class ConflictError extends Error{ constructor(msg){ super(msg); this.name = "ConflictError"; } }
class HttpError extends Error{ constructor(msg, status){ super(msg); this.name = "HttpError"; this.status = status; } }

async function dbxDownload(path, _retriedAuth){
  const tok = await syncToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + tok,
      "Dropbox-API-Arg": dbxArgHeader({ path: path })
    }
  });
  if(res.status === 401 && !_retriedAuth){
    await syncToken(true);
    return dbxDownload(path, true);
  }
  if(res.status === 409){
    // F6 (2026-07-11): only path/not_found means "nothing uploaded yet". Any
    // other 409 (e.g. restricted_content) must surface as an error, not be
    // misread as an empty remote. Unreadable body keeps legacy behavior.
    let summary = "";
    try{ summary = String((((await res.json()) || {}).error_summary) || ""); }catch(e){}
    if(!summary || summary.indexOf("not_found") !== -1) return null;
    throw new HttpError("download failed: 409 " + summary.slice(0, 200), 409);
  }
  if(!res.ok){
    // Surface Dropbox's actual error body (e.g. "missing_scope",
    // "invalid_access_token") instead of a bare status code — this is the
    // difference between a self-diagnosing error message in Settings and a
    // round of "check DevTools and paste what you see" back-and-forth.
    let detail = "";
    try{ detail = (await res.text()).slice(0, 200); }catch(e){}
    throw new HttpError("download failed: " + res.status + (detail ? " " + detail : ""), res.status);
  }

  const metaHeader = res.headers.get("dropbox-api-result");
  let meta = {};
  try{ meta = metaHeader ? JSON.parse(metaHeader) : {}; }catch(e){ /* ignore */ }

  const text = await res.text();
  let wrapper;
  try{ wrapper = JSON.parse(text); }
  catch(e){ throw new Error("remote corrupt"); }
  if(!wrapper || typeof wrapper !== "object" || typeof wrapper.state !== "object"){
    throw new Error("remote corrupt");
  }
  return { state: wrapper.state, savedAt: wrapper.savedAt || 0, deviceId: wrapper.deviceId || null, rev: meta.rev || null };
}

async function dbxUpload(path, wrapperObj, rev, _retriedAuth){
  const tok = await syncToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + tok,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": dbxArgHeader({
        path: path,
        mode: rev ? { ".tag": "update", "update": rev } : { ".tag": "add" },
        autorename: false,
        mute: true
      })
    },
    body: JSON.stringify(wrapperObj)
  });
  if(res.status === 401 && !_retriedAuth){
    await syncToken(true);
    return dbxUpload(path, wrapperObj, rev, true);
  }
  if(res.status === 409) throw new ConflictError("upload conflict");
  if(!res.ok){
    let detail = "";
    try{ detail = (await res.text()).slice(0, 200); }catch(e){}
    throw new HttpError("upload failed: " + res.status + (detail ? " " + detail : ""), res.status);
  }
  return await res.json();
}

function syncDisconnect(){
  const cfg = syncCfg();
  syncCfgSave(Object.assign(syncCfgDefaults(), {
    deviceId: cfg.deviceId || null,
    lastSyncAt: cfg.lastSyncAt || null
  }));
}

// ============================================================================
// PHASE 3 — sync engine: subset extraction, merge, orchestration
// ============================================================================

// ---- stable deep-equal (key-order independent) -----------------------------
function stableClone(o, seen){
  if(o === null || typeof o !== "object") return o;
  seen = seen || new WeakSet();
  if(seen.has(o)) return null; // circular guard — should never trigger on plain JSON data
  seen.add(o);
  if(Array.isArray(o)) return o.map(x => stableClone(x, seen));
  const out = {};
  Object.keys(o).sort().forEach(k => { out[k] = stableClone(o[k], seen); });
  return out;
}
function stableStringify(o){ return JSON.stringify(stableClone(o)); }
function deepEqual(a, b){ return stableStringify(a) === stableStringify(b); }

// ---- 3.1 syncSubset() -------------------------------------------------------
// NOTE: S.history (top-level) exists in freshState() but is never populated —
// per-task history lives at t.history and rides along with each task object,
// which already merges by id/updatedAt as part of `tasks` below. We still
// carry the top-level `history` key for forward schema compatibility even
// though today it is always []. Do not confuse this with t.history.
function syncSubset(){
  const an = (S.prefs && S.prefs.an) ? { views: S.prefs.an.views || [], metrics: S.prefs.an.metrics || [] } : { views: [], metrics: [] };
  const raw = {
    char: S.char || {},
    tasks: S.tasks || [],
    rewards: S.rewards || [],
    tags: S.tags || [],
    devices: cleanDevices(S.devices || []),
    lastCron: S.lastCron || 0,
    history: S.history || [],
    charHistory: S.charHistory || [],
    an: an,
    monthlyBackups: S.monthlyBackups || [],
    deletions: S.deletions || []
  };
  return JSON.parse(JSON.stringify(raw)); // deep copy, strips functions/undefined
}

// ---- 3.2 syncApply(subset) --------------------------------------------------
// Goes through the real save() (not a raw localStorage write) so IS_DIRTY and
// the Tier-1 backup-snapshot system behave exactly as they do for any other
// mutation. The re-entrancy guard (SYNC_APPLYING) is read by app.js's save()
// hook to skip scheduling another sync while we're applying one.
let SYNC_APPLYING = false;
function syncIsApplying(){ return SYNC_APPLYING; }
function syncApply(subset){
  if(!subset || !Array.isArray(subset.tasks)){
    syncCfgSave({ lastError: "merge produced invalid state; sync aborted" });
    return false;
  }
  // Snapshot the on-screen state BEFORE we overwrite it, so an ordinary
  // no-op sync (remote identical to local — the common case, and the case a
  // 5s post-save debounce fires on every scroll) does NOT re-run save()/
  // render(). render() rebuilds #view and restoreScroll()s, which was
  // collapsing an open analytics event-detail and jumping the page up every
  // few seconds. Only touch state + repaint when the merge actually changed
  // something.
  const _before = (typeof syncSubset === "function") ? stableStringify(syncSubset()) : null;
  SYNC_APPLYING = true;
  try{
    // FIX 2026-07-11: deep-copy the incoming subset so S never shares object
    // identity with the caller's merged state. Without this, user edits during
    // an in-flight upload mutate the pending base snapshot (base poisoning —
    // see .omo/plans/2026-07-11-todo-completion-revert-analysis.md §2).
    subset = JSON.parse(JSON.stringify(subset));
    S.char = subset.char || S.char;
    S.tasks = subset.tasks;
    S.rewards = Array.isArray(subset.rewards) ? subset.rewards : [];
    S.tags = Array.isArray(subset.tags) ? subset.tags : [];
    S.devices = cleanDevices(Array.isArray(subset.devices) ? subset.devices : []);
    if(subset.lastCron) S.lastCron = subset.lastCron;
    S.history = Array.isArray(subset.history) ? subset.history : [];
    S.charHistory = Array.isArray(subset.charHistory) ? subset.charHistory : [];
    S.monthlyBackups = Array.isArray(subset.monthlyBackups) ? subset.monthlyBackups : [];
    S.deletions = Array.isArray(subset.deletions) ? subset.deletions : (S.deletions || []);
    S.prefs = S.prefs || {};
    S.prefs.an = S.prefs.an || {};
    S.prefs.an.views = (subset.an && Array.isArray(subset.an.views)) ? subset.an.views : [];
    S.prefs.an.metrics = (subset.an && Array.isArray(subset.an.metrics)) ? subset.an.metrics : [];
    const _after = (typeof syncSubset === "function") ? stableStringify(syncSubset()) : null;
    const _changed = (_before === null || _after === null) ? true : (_before !== _after);
    if(_changed){
      if(typeof save === "function") save();
      else if(typeof STORE_KEY !== "undefined") localStorage.setItem(STORE_KEY, JSON.stringify(S));
      if(typeof render === "function") render();
    }
  } finally {
    SYNC_APPLYING = false;
  }
  return true;
}

// ---- 3.3 base snapshot (IndexedDB `syncmeta` store, key "base") -----------
function syncBaseGet(){
  if(typeof idbOpen !== "function") return Promise.resolve(null);
  return idbOpen().then(db => new Promise((resolve) => {
    try{
      const tx = db.transaction("syncmeta", "readonly");
      const req = tx.objectStore("syncmeta").get("base");
      req.onsuccess = () => {
        try{ resolve(req.result ? JSON.parse(req.result) : null); }
        catch(e){ resolve(null); }
      };
      req.onerror = () => resolve(null);
    }catch(e){ resolve(null); }
  })).catch(() => null);
}
function syncBasePut(subset){
  // Accepts an object OR a pre-serialized JSON string (fix 2026-07-11).
  // Serializing HERE, before the idbOpen await, also closes the small window
  // where object callers could be mutated during that await.
  const payload = (typeof subset === "string") ? subset : JSON.stringify(subset);
  if(typeof idbOpen !== "function") return Promise.resolve(false);
  return idbOpen().then(db => new Promise((resolve) => {
    try{
      const tx = db.transaction("syncmeta", "readwrite");
      tx.objectStore("syncmeta").put(payload, "base");
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    }catch(e){ resolve(false); }
  })).catch(() => false);
}

// ---- 3.4 merge(base, local, remote, remoteSavedAt) -------------------------
// Implements plan §2.2 per-id three-way merge for id-keyed collections, plus
// the scalar/section rules from the §2.1 table.
//
// JUDGMENT CALL (flagged, not silently assumed): §2.1 says S.char uses
// "changed-side wins; both-changed -> newer savedAt wins", but nothing in the
// codebase stamps a per-edit savedAt on S.char (Phase 1 only added
// updatedAt to tasks/rewards/tags/views/metrics, not char — the plan didn't
// ask for it either). Rather than silently invent a new char.savedAt field
// (more app.js surgery, more risk, for a case the plan's own §0 already
// accepts as lossy), the both-changed char tiebreak below uses the *pushed
// snapshot* timestamp: remote's wrapper savedAt (when that device last
// pushed) vs Date.now() (this device, pushing now). In practice this means
// "whichever device syncs most recently wins the tie" — a reasonable proxy
// given the plan already classifies a few lost XP/gold here as acceptable.
// ---- F3 (2026-07-11) daily-aware conflict resolution -----------------------
// See .omo/plans/2026-07-11-cron-merge-recency.md. Cron (app.js runCron) no
// longer bumps t.updatedAt on reset/miss -- it is a deterministic day-boundary
// transform, not a user edit. That means updatedAt alone can no longer
// arbitrate a completion-vs-reset conflict for dailies in mergeCollection's
// both-changed branch; these two fields carry that signal instead:
//   t.doneAt   -- ms timestamp of the last time this daily was marked done
//                 (completeTask / creditYesterday backdated); cleared on uncheck.
//   t.missedOn -- dayStamp() int of the last day runCron judged this daily
//                 missed; cleared on completion/credit.
function dayStampOf(ms){
  if(!ms) return 0;
  const d = new Date(ms);
  return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
}
function dailyEventDay(x){
  if(!x) return 0;
  return Math.max(dayStampOf(x.doneAt || 0), x.missedOn || 0);
}
// Both-changed-both-present tiebreak for type==='daily' entries only (called
// from mergeCollection below). Pure function of (l, r) -- no S/base access --
// so conflict-retry re-merges stay convergent (analysis Sec5/Sec8 invariant).
function resolveDailyConflict(l, r){
  const led = dailyEventDay(l), red = dailyEventDay(r);
  if(led !== red) return led > red ? l : r; // rule 1: newer event day wins
  // rule 2: same event day -- a completion beats a miss recorded for that same
  // day (the miss was, by definition, computed from stale data on that side).
  const lDoneToday = !!(l && led && dayStampOf(l.doneAt || 0) === led);
  const rDoneToday = !!(r && red && dayStampOf(r.doneAt || 0) === red);
  const lMissToday = !!(l && led && (l.missedOn || 0) === led);
  const rMissToday = !!(r && red && (r.missedOn || 0) === red);
  if(lDoneToday && rMissToday && !rDoneToday){
    if(typeof logEvent === "function") logEvent({kind:'missReverted', taskType:'daily', taskId:l.id, taskTitle:l.title, day:led});
    return l;
  }
  if(rDoneToday && lMissToday && !lDoneToday){
    if(typeof logEvent === "function") logEvent({kind:'missReverted', taskType:'daily', taskId:r.id, taskTitle:r.title, day:red});
    return r;
  }
  // rule 3: no day-level signal distinguishes them -- fall back to the original
  // updatedAt tiebreak (remote wins on tie/missing), unchanged from before F3.
  const lu = (l && l.updatedAt) || 0, ru = (r && r.updatedAt) || 0;
  return lu > ru ? l : r;
}
// Idempotent post-decision overlay applied to EVERY merged daily regardless of
// which mergeCollection branch produced it (one-sided branches can also carry
// a stale done=true from a device that hasn't cronned past it yet). Pure: does
// not mutate its input.
function normalizeDailyResets(tasks, mergedLastCron){
  if(!Array.isArray(tasks)) return tasks;
  return tasks.map(t=>{
    if(!t || t.type!=='daily' || !t.done) return t;
    if(dayStampOf(t.doneAt || 0) < (mergedLastCron || 0)){
      const nt = Object.assign({}, t, {done:false});
      if(Array.isArray(t.checklist)) nt.checklist = t.checklist.map(c=>Object.assign({}, c, {done:false}));
      return nt;
    }
    return t;
  });
}

// ---- F4 (2026-07-11) subtask-granular merge --------------------------------
// Base-aware three-way per-subtask merge, keyed by stable item id. Called
// from mergeCollection's both-changed-both-present branch (below) in place of
// letting the whole-task winner silently discard the losing side's entire
// checklist. Plan: .omo/plans/2026-07-11-subtask-granular-merge.md
//
// preferLocal: which side WON the enclosing task's whole-object tiebreak
// (mergeCollection passes true iff its chosen winner === l). Used only (a) as
// the last-resort tiebreak when a genuine same-field conflict has no usable
// touchedAt evidence, and (b) to pick primary ordering. Defaults to false
// (prefer remote) — matches the remote-wins-exact-ties convention used
// throughout this file (resolveDailyConflict, mergeCollection, mergeDevices).
function mergeChecklist(baseArr, localArr, remoteArr, preferLocal){
  const baseMap = new Map((baseArr || []).filter(x => x && x.id != null).map(x => [x.id, x]));
  const localArrSafe = (localArr || []).filter(x => x && x.id != null);
  const remoteArrSafe = (remoteArr || []).filter(x => x && x.id != null);
  const localMap = new Map(localArrSafe.map(x => [x.id, x]));
  const remoteMap = new Map(remoteArrSafe.map(x => [x.id, x]));
  // Union of LOCAL + REMOTE ids only -- base ids are never unioned in here,
  // so an item deleted on both sides simply never appears (matches
  // mergeCollection's own "both deleted -> stays deleted" rule).
  const ids = new Set([...localMap.keys(), ...remoteMap.keys()]);

  const resultMap = new Map();
  ids.forEach(id => {
    // null/undefined baseArr (first sync, post-force-push) -> baseMap is
    // empty -> b is always null here -> every id below falls into "pure
    // addition" (never "deletion"), per plan §1: no deletion inference
    // without base evidence.
    const b = baseMap.has(id) ? baseMap.get(id) : null;
    const l = localMap.has(id) ? localMap.get(id) : null;
    const r = remoteMap.has(id) ? remoteMap.get(id) : null;

    if(l && r){
      if(deepEqual(l, r)){ resultMap.set(id, l); return; }
      const bText = b ? b.text : undefined;
      const bDone = b ? !!b.done : undefined;
      const lTextChanged = l.text !== bText, rTextChanged = r.text !== bText;
      const lDoneChanged = !!l.done !== bDone, rDoneChanged = !!r.done !== bDone;
      const lt = l.touchedAt || 0, rt = r.touchedAt || 0;
      // text: exactly one side changed it from base -> take that side
      // (matches mergeCollection's own one-sided-change rule, at field
      // granularity); both changed it to the SAME value -> no conflict;
      // both changed it to DIFFERENT values -> genuine conflict, resolved by
      // touchedAt (higher wins; equal/missing falls back to preferLocal).
      let text;
      if(lTextChanged && !rTextChanged) text = l.text;
      else if(!lTextChanged && rTextChanged) text = r.text;
      else if(!lTextChanged && !rTextChanged) text = (bText !== undefined ? bText : (r.text != null ? r.text : l.text));
      else if(l.text === r.text) text = l.text;
      else if(lt !== rt) text = lt > rt ? l.text : r.text;
      else text = preferLocal ? l.text : r.text;
      // done: see the design note above -- a shared boolean base can't
      // produce a genuine two-sided disagreement once both sides "changed"
      // it; the touchedAt fallback below only fires for an inconsistent
      // legacy/imported state, defensively.
      let done;
      if(lDoneChanged && !rDoneChanged) done = !!l.done;
      else if(!lDoneChanged && rDoneChanged) done = !!r.done;
      else if(!lDoneChanged && !rDoneChanged) done = (bDone !== undefined ? bDone : !!r.done);
      else if(!!l.done === !!r.done) done = !!l.done;
      else if(lt !== rt) done = lt > rt ? !!l.done : !!r.done;
      else done = preferLocal ? !!l.done : !!r.done;
      const touchedAt = Math.max(lt, rt);
      const merged = Object.assign({}, preferLocal ? l : r, { id: id, text: text, done: done });
      if(touchedAt) merged.touchedAt = touchedAt; else delete merged.touchedAt;
      resultMap.set(id, merged);
      return;
    }

    // present on exactly one side only
    const survivor = l || r;
    if(!b){ resultMap.set(id, survivor); return; } // pure addition, or null base -- never a deletion (plan §1)
    // was in base, missing on the other side -> deletion, UNLESS the
    // surviving side edited it strictly after the base snapshot -- edit wins.
    const survivorTouchedAt = survivor.touchedAt || 0;
    const baseTouchedAt = b.touchedAt || 0;
    if(survivorTouchedAt > baseTouchedAt){ resultMap.set(id, survivor); return; }
    // else: deletion wins -- item dropped, nothing added to resultMap
  });

  // Ordering: the winning parent's array order first, then the other side's
  // pure additions appended in their original relative order.
  const winnerArr = preferLocal ? localArrSafe : remoteArrSafe;
  const otherArr = preferLocal ? remoteArrSafe : localArrSafe;
  const out = [];
  const placed = new Set();
  winnerArr.forEach(x => { if(resultMap.has(x.id) && !placed.has(x.id)){ out.push(resultMap.get(x.id)); placed.add(x.id); } });
  otherArr.forEach(x => { if(resultMap.has(x.id) && !placed.has(x.id)){ out.push(resultMap.get(x.id)); placed.add(x.id); } });
  return out;
}

// recency helpers (2026-07-11 recency-guard). _ua = effective edit time,
// _ca = creation time. Numeric-safe; missing fields -> 0. Clamped (D3): a
// timestamp more than 2 min ahead of Date.now() is untrusted -> treated as 0
// so a future-skewed clock cannot win a guard or mint an undeletable record.
function _ua(x){ var v = (x && (Number(x.updatedAt) || Number(x.createdAt) || 0)) || 0; return v > Date.now() + 120000 ? 0 : v; }
function _ca(x){ var v = (x && Number(x.createdAt)) || 0; return v > Date.now() + 120000 ? 0 : v; }
function mergeCollection(baseArr, localArr, remoteArr, remoteSavedAt, localSavedAt, tombstoneMap){
  const baseMap = new Map((baseArr || []).map(x => [x.id, x]));
  const localMap = new Map((localArr || []).map(x => [x.id, x]));
  const remoteMap = new Map((remoteArr || []).map(x => [x.id, x]));
  const ids = new Set([].concat([...baseMap.keys()], [...localMap.keys()], [...remoteMap.keys()]));
  const resultMap = new Map();

  ids.forEach(id => {
    const b = baseMap.has(id) ? baseMap.get(id) : null;
    const localHad = localMap.has(id), remoteHad = remoteMap.has(id);
    const l = localHad ? localMap.get(id) : null;
    const r = remoteHad ? remoteMap.get(id) : null;
    const localChanged = !deepEqual(l, b);
    const remoteChanged = !deepEqual(r, b);

    if(!localChanged && !remoteChanged){
      if(b) resultMap.set(id, b);
      return;
    }
    if(localChanged && !remoteChanged){
      // GUARD 3 (2026-07-11 persistence-loss fix, Phase B): `local` here is
      // the WHOLE captured S snapshot, which on Android can be a stale
      // localStorage revert (the disk flush the OS never got to run before a
      // kill -- see .omo/plans/2026-07-11-persistence-loss-fix-plan.md §1).
      // Without this guard, a reverted local looks exactly like a genuine
      // edit/deletion and this branch happily propagates it -- including
      // uploading it to Dropbox, i.e. permanent cross-device loss (the
      // "amplifier" in the plan §1.2). Only fires when the caller supplies a
      // real localSavedAt AND base's own record is at least as new as that
      // whole-snapshot timestamp, i.e. local could not possibly have known
      // about this record's current state -- so its disagreement is stale,
      // not authoritative. A genuine edit/deletion always comes from a local
      // snapshot saved AFTER the record it touched, so this never suppresses
      // real user changes.
      if(b && localSavedAt != null){
        const staleLocal = localHad ? (_ua(b) >= Number(localSavedAt)) : (_ca(b) >= Number(localSavedAt));
        if(staleLocal){ resultMap.set(id, b); return; }
      }
      if(localHad) resultMap.set(id, l);
      else if(b) resultMap.set(id, b); // TOMBSTONE MODEL (2026-07-12): local absence is NOT a deletion signal; keep -- the S.deletions overlay removes it iff a real tombstone exists
      return;
    }
    if(!localChanged && remoteChanged){
      if(remoteHad){
        // Both sides still have it; remote differs from base. GUARD 1 (recency):
        // never let an OLDER remote overwrite a NEWER local. When base is honest,
        // an untouched local has updatedAt == base < any real remote edit, so
        // remote still wins -- identical to old behavior. Only a poisoned base
        // (base == new local, remote older) is changed, and that is the bug.
        if(localHad && _ua(l) > _ua(r)){
          let w = l;
          if(Array.isArray(l && l.checklist) || Array.isArray(r && r.checklist)){
            // still merge subtasks so a remote toggle is not lost (F4 parity)
            w = Object.assign({}, l, { checklist: mergeChecklist(b && b.checklist, (l&&l.checklist)||[], (r&&r.checklist)||[], true) });
          }
          resultMap.set(id, w);
        } else {
          resultMap.set(id, r);
        }
      } else {
        // Remote no longer has it (deletion) while local is unchanged vs base.
        // GUARD 2: never drop a record CREATED AFTER the remote snapshot was
        // written -- the remote simply never saw it, so its absence is not a
        // deletion. Only applies when caller supplied a real remoteSavedAt.
        // TOMBSTONE MODEL (2026-07-12): a record merely absent from the remote
        // snapshot is NOT proof of deletion -- a stale/partial remote must never
        // silently drop it (this was the bug that lost 500+ day dailies). Keep
        // the local copy; real deletions are applied by the S.deletions overlay.
        if(localHad) resultMap.set(id, l);
      }
      return;
    }
    // both changed relative to base
    if(localHad && !remoteHad){ resultMap.set(id, l); return; }   // remote deleted, local modified -> modification wins
    if(!localHad && remoteHad){ resultMap.set(id, r); return; }   // local deleted, remote modified -> modification wins
    if(!localHad && !remoteHad){ if(b) resultMap.set(id, b); return; } // TOMBSTONE MODEL (2026-07-12): keep; only the S.deletions overlay deletes
    // both modified and both still present -> daily-aware tiebreak (F3, 2026-07-11):
    // cron no longer bumps updatedAt (app.js runCron), so a plain updatedAt race
    // can't arbitrate completion-vs-reset conflicts for dailies any more; hand
    // those off to resolveDailyConflict (doneAt/missedOn channel). Every other
    // type (todos, habits, rewards, tags, an.views/metrics) is unaffected.
    let winner;
    if((l && l.type==='daily') || (r && r.type==='daily')){
      winner = resolveDailyConflict(l, r);
    } else {
      const lu = (l && l.updatedAt) || 0;
      const ru = (r && r.updatedAt) || 0;
      winner = lu > ru ? l : r;
    }
    // F4 (2026-07-11): the whole-object winner above still discards the
    // OTHER side's checklist wholesale. Splice in a per-subtask merge
    // whenever either side carries a checklist array (todos and dailies;
    // habits carry an always-empty one; rewards/tags/an.views/an.metrics have
    // no checklist field at all, so Array.isArray guards them out here --
    // this is intentionally NOT gated on task `type`).
    if(Array.isArray(l && l.checklist) || Array.isArray(r && r.checklist)){
      winner = Object.assign({}, winner, {
        checklist: mergeChecklist(b && b.checklist, (l && l.checklist) || [], (r && r.checklist) || [], winner === l)
      });
    }
    resultMap.set(id, winner);
    return;
  });

  // ---- TOMBSTONE OVERLAY (2026-07-12) --------------------------------------
  // Deletion is driven ONLY by explicit tombstones (S.deletions), never by an
  // entity being absent from one side. Remove an id iff a tombstone's timestamp
  // is >= the surviving entity's own effective edit time, so an edit/re-create
  // made AFTER the delete still wins (resurrects).
  if(tombstoneMap && tombstoneMap.size){
    resultMap.forEach((v, id) => {
      const ts = tombstoneMap.get(id);
      if(ts != null && Number(ts) >= _ua(v)) resultMap.delete(id);
    });
  }

  // Preserve LOCAL order; append remote-only entities at the end (plain end —
  // acceptable per plan §3.4, same-type-group placement skipped as optional).
  const out = [];
  const placed = new Set();
  (localArr || []).forEach(x => { if(resultMap.has(x.id) && !placed.has(x.id)){ out.push(resultMap.get(x.id)); placed.add(x.id); } });
  (remoteArr || []).forEach(x => { if(resultMap.has(x.id) && !placed.has(x.id)){ out.push(resultMap.get(x.id)); placed.add(x.id); } });
  resultMap.forEach((v, id) => { if(!placed.has(id)){ out.push(v); placed.add(id); } });
  return out;
}

// Devices merge: a device name is a single scalar the user sets. The generic
// mergeCollection() above takes "remote unconditionally" whenever the local side
// didn't change (plan 2026-07-10-device-name-sync-revert-fix.md §3C) — so a stale
// blank {name:'',updatedAt:0} from one device could silently wipe a real name on
// every other device (the reported revert). This rule instead:
//   - never lets a junk placeholder (blank name AND updatedAt:0, i.e. an entry
//     that was never actually named) win over a real name,
//   - otherwise picks the most-recently-updated entry (updatedAt), so a
//     deliberate clear (updatedAt>0) still propagates by recency.
function cleanDevices(arr){
  if(!Array.isArray(arr)) return [];
  const byId = new Map();
  arr.forEach(d => {
    if(!d || !d.id) return;
    const prev = byId.get(d.id);
    if(!prev){ byId.set(d.id, d); return; }
    const nameOf = x => x && typeof x.name === "string" ? x.name.trim() : "";
    const isJunk = x => !nameOf(x) && ((x.updatedAt) || 0) === 0;
    const score = x => isJunk(x) ? -1 : ((x.updatedAt) || 0) + (nameOf(x) ? 0.5 : 0);
    if(score(d) > score(prev)) byId.set(d.id, d);
  });
  return [...byId.values()];
}

function mergeDevices(baseArr, localArr, remoteArr){
  const baseMap = new Map((baseArr || []).map(x => [x.id, x]));
  const localMap = new Map((localArr || []).map(x => [x.id, x]));
  const remoteMap = new Map((remoteArr || []).map(x => [x.id, x]));
  const ids = new Set([].concat([...baseMap.keys()], [...localMap.keys()], [...remoteMap.keys()]));
  const resultMap = new Map();
  const nameOf = d => d && typeof d.name === "string" ? d.name.trim() : "";
  const isJunk = d => !nameOf(d) && ((d && d.updatedAt) || 0) === 0;
  const score = d => !d ? -2 : (isJunk(d) ? -1 : ((d.updatedAt) || 0) + (nameOf(d) ? 0.5 : 0));
  ids.forEach(id => {
    const b = baseMap.has(id) ? baseMap.get(id) : null;
    const l = localMap.has(id) ? localMap.get(id) : null;
    const r = remoteMap.has(id) ? remoteMap.get(id) : null;
    const localChanged = !deepEqual(l, b);
    const remoteChanged = !deepEqual(r, b);
    if(!localChanged && !remoteChanged){
      if(b) resultMap.set(id, b);
      return;
    }
    // Winner: junk never wins; otherwise most-recent (updatedAt) wins, real
    // names get a tiny bonus so an equal-timestamp name beats an equal-timestamp
    // blank. Local breaks any remaining tie.
    const sl = score(l), sr = score(r);
    let winner;
    if(sl > sr) winner = l;
    else if(sr > sl) winner = r;
    else {
      const lu = (l && l.updatedAt) || 0, ru = (r && r.updatedAt) || 0;
      winner = lu >= ru ? l : r;
    }
    if(winner) resultMap.set(id, winner);
  });
  const out = [];
  const placed = new Set();
  (localArr || []).forEach(x => { if(resultMap.has(x.id) && !placed.has(x.id)){ out.push(resultMap.get(x.id)); placed.add(x.id); } });
  (remoteArr || []).forEach(x => { if(resultMap.has(x.id) && !placed.has(x.id)){ out.push(resultMap.get(x.id)); placed.add(x.id); } });
  resultMap.forEach((v, id) => { if(!placed.has(id)){ out.push(v); placed.add(id); } });
  return cleanDevices(out);
}

// Union-by-day merge for history-style arrays ({date:<ms>, ...numeric fields,
// ...array fields whose entries have an id}). Used for S.charHistory (and the
// always-empty top-level S.history, harmlessly).
function mergeDayArray(localArr, remoteArr){
  const dayOf = ms => Math.floor((ms || 0) / 86400000);
  const buckets = new Map(); // dayKey -> merged entry

  function fold(entry){
    const key = dayOf(entry.date);
    if(!buckets.has(key)){ buckets.set(key, Object.assign({}, entry)); return; }
    const cur = buckets.get(key);
    Object.keys(entry).forEach(k => {
      if(k === "date"){ cur.date = Math.max(cur.date || 0, entry.date || 0); return; }
      const cv = cur[k], ev = entry[k];
      if(typeof ev === "number" && typeof cv === "number"){ cur[k] = Math.max(cv, ev); }
      else if(Array.isArray(ev) && Array.isArray(cv)){
        const byId = new Map(cv.map(x => [x && x.id, x]));
        ev.forEach(x => { if(x && x.id != null) byId.set(x.id, x); });
        cur[k] = [...byId.values()];
      } else if(cv === undefined){ cur[k] = ev; }
      // else: leave cur[k] as-is (non-numeric, non-array scalar collision — keep local/base value already present)
    });
  }
  (localArr || []).forEach(fold);
  (remoteArr || []).forEach(fold);
  return [...buckets.values()].sort((a, b) => (a.date || 0) - (b.date || 0));
}

function merge(base, local, remote, remoteSavedAt, localSavedAt){
  base = base || {};
  local = local || {};
  remote = remote || {};
  const baseAn = base.an || {}, localAn = local.an || {}, remoteAn = remote.an || {};

  const mergedLastCron = (function(){
    const l = local.lastCron || 0, r = remote.lastCron || 0;
    return l >= r ? l : r; // dayStamp() is a lexically-sortable integer (YYYYMMDD-ish) -> plain max
  })();

  // Union all tombstones (base+local+remote), keeping the newest 'at' per id.
  // Passed into every id-keyed mergeCollection so deletion is tombstone-driven.
  const mergedDeletions = (function(){
    const acc = new Map();
    [].concat(base.deletions||[], remote.deletions||[], local.deletions||[]).forEach(d=>{
      if(!d || d.id==null) return;
      const at = Number(d.at)||0;
      const prev = acc.get(d.id);
      if(prev==null || at>prev) acc.set(d.id, at);
    });
    return acc; // Map(id -> at)
  })();
  const _tomb = mergedDeletions;

  const merged = {
    tasks: normalizeDailyResets(mergeCollection(base.tasks, local.tasks, remote.tasks, remoteSavedAt, localSavedAt, _tomb), mergedLastCron), // F3 (2026-07-11): reset overlay keyed to merged lastCron
    rewards: mergeCollection(base.rewards, local.rewards, remote.rewards, remoteSavedAt, localSavedAt, _tomb),
    tags: mergeCollection(base.tags, local.tags, remote.tags, remoteSavedAt, localSavedAt, _tomb),
    devices: mergeDevices(base.devices, local.devices, remote.devices),
    an: {
      views: mergeCollection(baseAn.views, localAn.views, remoteAn.views, remoteSavedAt, localSavedAt, _tomb),
      metrics: mergeCollection(baseAn.metrics, localAn.metrics, remoteAn.metrics, remoteSavedAt, localSavedAt, _tomb)
    },
    history: mergeDayArray(local.history, remote.history),
    charHistory: mergeDayArray(local.charHistory, remote.charHistory),
    monthlyBackups: (function(){
      const l = local.monthlyBackups || [];
      const r = remote.monthlyBackups || [];
      return Array.from(new Set([...l, ...r])).sort();
    })(),
    lastCron: mergedLastCron,
    deletions: Array.from(mergedDeletions, ([id, at]) => ({id: id, at: at})),
    char: (function(){
      const b = base.char || {}, l = local.char || {}, r = remote.char || {};
      const localChanged = !deepEqual(l, b);
      const remoteChanged = !deepEqual(r, b);
      if(!localChanged && !remoteChanged) return b;
      if(localChanged && !remoteChanged) return l;
      if(!localChanged && remoteChanged){
        // GUARD (recency): accept remote char only if it is not OLDER than local.
        return ((Number(r.updatedAt)||0) >= (Number(l.updatedAt)||0)) ? r : l;
      }
      // F2 (2026-07-11): the old expression `Date.now() > remoteSavedAt` was
      // always true for any past savedAt, so both-changed char ALWAYS took
      // local in practice. Made explicit — local wins. (This also removes the
      // pathological case where a future-skewed remote clock silently won.)
      return l;
    })()
  };
  return merged;
}

function wrap(subset){
  return { schema: 1, savedAt: Date.now(), deviceId: syncDeviceId(), state: subset };
}

// ---- 3.5 syncNow() — the only orchestrator ---------------------------------
let _syncInFlight = null;
let _syncRerunQueued = false;

function syncNow(){
  if(!navigator.onLine) return Promise.resolve();
  const cfg = syncCfg();
  if(!cfg.enabled || !cfg.refreshToken) return Promise.resolve();

  if(_syncInFlight){
    _syncRerunQueued = true;
    return _syncInFlight;
  }
  _syncInFlight = _syncNowAttempt(0)
    .catch(e => {
      syncCfgSave({ lastError: (e && e.message) || String(e) });
    })
    .then(() => {
      _syncInFlight = null;
      // Only piggyback the auto-export check onto a sync that actually
      // succeeded — a failed sync's lastError would otherwise get clobbered
      // by an unrelated "auto backup failed" if the same underlying
      // connectivity problem hit both.
      if(!syncCfg().lastError && typeof syncMaybeAutoExport==="function") syncMaybeAutoExport();
      if(!syncCfg().lastError && typeof syncEventsSync==="function") syncEventsSync();
      if(typeof syncRefreshSettingsUI==="function") syncRefreshSettingsUI();
      if(_syncRerunQueued){
        _syncRerunQueued = false;
        syncNow();
      }
    });
  return _syncInFlight;
}

async function _syncNowAttempt(transientRetryCount){
  try{
    const remote = await dbxDownload(STATE_PATH);
    const base = await syncBaseGet();
    // Phase B (2026-07-11 persistence-loss fix): captured from the live S
    // object (app.js global) BEFORE syncSubset() builds the whitelisted
    // upload payload -- syncSubset() never copies __savedAt, by design, so it
    // must be read here or not at all.
    const localSavedAt = (typeof S !== "undefined" && S && S.__savedAt) || null;
    const local = syncSubset();
    const merged = remote ? merge(base, local, remote.state, remote.savedAt, localSavedAt) : local;

    if(!merged || !Array.isArray(merged.tasks)){
      syncCfgSave({ lastError: "merge produced invalid state; sync aborted" });
      return;
    }

    syncApply(merged);

    // FIX 2026-07-11: freeze ONE serialization of merged before any await.
    // This exact string is the single source for BOTH the upload body and the
    // base snapshot, so base ≡ uploaded remote content by construction.
    const mergedJson = JSON.stringify(merged);

    const baseStr = base ? stableStringify(base) : null;
    const remoteStr = remote ? stableStringify(remote.state) : null;
    const mergedStr = stableStringify(merged);
    const nothingToPush = (mergedStr === remoteStr) && (mergedStr === baseStr);

    if(nothingToPush){
      const baseOk = await syncBasePut(mergedJson);
      syncCfgSave({ lastSyncAt: Date.now(), lastRev: remote ? remote.rev : cfgRevOrNull(),
                    lastError: baseOk ? null : "base snapshot write failed — sync degraded" });
      return;
    }

    await _pushWithConflictRetry(mergedJson, remote ? remote.rev : null, 0);
  }catch(e){
    if(e && e.status && (e.status === 429 || e.status >= 500) && transientRetryCount < SYNC_TRANSIENT_RETRY_DELAYS_MS.length){
      await new Promise(r => setTimeout(r, SYNC_TRANSIENT_RETRY_DELAYS_MS[transientRetryCount]));
      return _syncNowAttempt(transientRetryCount + 1);
    }
    throw e;
  }
}

function cfgRevOrNull(){ return syncCfg().lastRev || null; }

async function _pushWithConflictRetry(mergedJson, knownRev, attempt){
  try{
    // mergedJson is a FROZEN string (fix 2026-07-11). The upload body wraps a
    // detached parse of it, and the base snapshot stores the string verbatim —
    // nothing the user does mid-upload can make the two diverge.
    const up = await dbxUpload(STATE_PATH, wrap(JSON.parse(mergedJson)), knownRev);
    const baseOk = await syncBasePut(mergedJson);
    syncCfgSave({ lastRev: up.rev || null, lastSyncAt: Date.now(),
                  lastError: baseOk ? null : "base snapshot write failed — sync degraded" });
  }catch(e){
    if(e instanceof ConflictError && attempt < SYNC_CONFLICT_RETRY_LIMIT){
      const fresh = await dbxDownload(STATE_PATH);
      const base = await syncBaseGet();
      const localSavedAt = (typeof S !== "undefined" && S && S.__savedAt) || null;
      const local = syncSubset();
      const reMerged = fresh ? merge(base, local, fresh.state, fresh.savedAt, localSavedAt) : local;
      syncApply(reMerged);
      return _pushWithConflictRetry(JSON.stringify(reMerged), fresh ? fresh.rev : null, attempt + 1);
    }
    if(e instanceof ConflictError){
      syncCfgSave({ lastError: "sync conflict — retry later" });
      return;
    }
    throw e;
  }
}

// ---- 3.55 syncForcePush() — overwrite remote with THIS device's data ------
// Bypasses merge entirely: local state becomes the new remote baseline, full
// stop. Used to recover from "remote has stale/test data, a fresh real
// device should replace it" situations (see SYNC-USER-GUIDE.md). Destructive
// to whatever anyone else has on the remote that this device doesn't have —
// the Settings UI gates this behind a confirmation dialog and this function
// does NOT re-confirm, so any caller must have already confirmed with the
// user (see confirmForcePush() below, which is the only intended caller).
async function syncForcePush(){
  if(typeof navigator!=="undefined" && navigator.onLine===false){
    syncCfgSave({ lastError: "offline — can't force push right now" });
    if(typeof syncRefreshSettingsUI==="function") syncRefreshSettingsUI();
    return;
  }
  const cfg = syncCfg();
  if(!cfg.enabled || !cfg.refreshToken) return;
  if(_syncInFlight){
    syncCfgSave({ lastError: "a sync is already running — try force push again in a moment" });
    if(typeof syncRefreshSettingsUI==="function") syncRefreshSettingsUI();
    return;
  }
  _syncInFlight = _syncForcePushAttempt(0)
    .then(() => {
      _syncInFlight = null;
      if(typeof syncRefreshSettingsUI==="function") syncRefreshSettingsUI();
    });
  return _syncInFlight;
}

async function _syncForcePushAttempt(attempt){
  try{
    const local = syncSubset();
    // Look up whatever rev is currently on the remote so the upload can use
    // mode:update against it — we still overwrite its CONTENT unconditionally
    // with `local`, this is only so the write itself succeeds instead of
    // bouncing off Dropbox's own conflict check.
    let rev = null;
    try{
      const remote = await dbxDownload(STATE_PATH);
      rev = remote ? remote.rev : null;
    }catch(e){ /* proceed with rev=null; an add-mode upload 409s harmlessly into the retry below if something actually exists */ }
    const up = await dbxUpload(STATE_PATH, wrap(local), rev);
    await syncBasePut(local); // this device's data is now truthfully "the last synced state"
    syncCfgSave({ lastRev: up.rev || null, lastSyncAt: Date.now(), lastError: null });
  }catch(e){
    if(e instanceof ConflictError && attempt < SYNC_CONFLICT_RETRY_LIMIT){
      // remote changed again between our rev lookup and our upload — the
      // overwrite is still what was asked for, just retry with a fresh rev.
      return _syncForcePushAttempt(attempt + 1);
    }
    syncCfgSave({ lastError: "force push failed: " + ((e && e.message) || String(e)) });
  }
}

// ---- 3.56 syncForcePull() — overwrite THIS device with remote's data ------
// Mirror of syncForcePush(): bypasses merge entirely, remote becomes this
// device's new local state, full stop. Used for the opposite recovery case —
// this device is the one with stale/test/empty data, and a known-good copy
// already sits in Dropbox (e.g. pushed there by force push from another
// device). Same rule as force push: this function does NOT confirm with the
// user itself — see confirmForcePull() below, the only intended caller.
async function syncForcePull(){
  if(typeof navigator!=="undefined" && navigator.onLine===false){
    syncCfgSave({ lastError: "offline — can't force pull right now" });
    if(typeof syncRefreshSettingsUI==="function") syncRefreshSettingsUI();
    return;
  }
  const cfg = syncCfg();
  if(!cfg.enabled || !cfg.refreshToken) return;
  if(_syncInFlight){
    syncCfgSave({ lastError: "a sync is already running — try force pull again in a moment" });
    if(typeof syncRefreshSettingsUI==="function") syncRefreshSettingsUI();
    return;
  }
  _syncInFlight = _syncForcePullAttempt()
    .then(() => {
      _syncInFlight = null;
      if(typeof syncRefreshSettingsUI==="function") syncRefreshSettingsUI();
    });
  return _syncInFlight;
}

async function _syncForcePullAttempt(){
  try{
    const remote = await dbxDownload(STATE_PATH);
    if(!remote){
      syncCfgSave({ lastError: "nothing in Dropbox yet to pull" });
      return;
    }
    if(!remote.state || !Array.isArray(remote.state.tasks)){
      syncCfgSave({ lastError: "remote corrupt — force pull aborted, local data untouched" });
      return;
    }
    syncApply(remote.state);           // local becomes remote's content, unconditionally
    await syncBasePut(remote.state);   // remote's state is now truthfully "the last synced state"
    syncCfgSave({ lastRev: remote.rev || null, lastSyncAt: Date.now(), lastError: null });
  }catch(e){
    syncCfgSave({ lastError: "force pull failed: " + ((e && e.message) || String(e)) });
  }
}

// ---- 3.8 Automatic Dropbox export backup -----------------------------------
// A SEPARATE feature from the state.json sync above: uploads the exact same
// full backup file Settings -> Export produces (the entire S state,
// including device-local UI prefs, PLUS the full IndexedDB event log) to a
// fixed Dropbox path, overwritten in place each run — one file, not
// versioned/dated copies, so Dropbox storage stays bounded (state.json +
// this one export file, nothing more). Two ways in:
//   1. Manually, via the "Save to Dropbox" button in the Export dialog
//      (exportSaveDropbox() below, wired from app.js's showExportChooser).
//   2. Automatically, on a user-configured day interval
//      (S.prefs.exportIntervalDays, 0 = off, set via Settings), checked
//      opportunistically at the end of every successful ordinary sync
//      (syncNow()) rather than on its own timer — ordinary sync already
//      runs often enough (on change, tab focus, coming back online, boot)
//      that a day-granularity interval never needs a separate clock.
// Both paths stamp S.prefs.lastExportTs — the SAME field the manual local
// export buttons in app.js already use — so Settings' "Last export" line
// reflects whichever export (local file or Dropbox, manual or automatic)
// happened most recently, without needing two separate trackers.
const EXPORT_BACKUP_PATH = "/export-backup.json";

async function dbxUploadText(path, text, _retriedAuth){
  const tok = await syncToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + tok,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": dbxArgHeader({
        path: path,
        mode: { ".tag": "overwrite" }, // fixed single file, always overwrite — no rev/conflict handling needed
        autorename: false,
        mute: true
      })
    },
    body: text
  });
  if(res.status === 401 && !_retriedAuth){
    await syncToken(true);
    return dbxUploadText(path, text, true);
  }
  if(!res.ok){
    let detail = "";
    try{ detail = (await res.text()).slice(0, 200); }catch(e){}
    throw new HttpError("Dropbox backup upload failed: " + res.status + (detail ? " " + detail : ""), res.status);
  }
  return await res.json();
}

async function syncUploadBackupBlob(blob){
  const text = await blob.text();
  await dbxUploadText(EXPORT_BACKUP_PATH, text);
  if(typeof S !== "undefined"){
    S.prefs = S.prefs || {};
    S.prefs.lastExportTs = Date.now();
    if(typeof save === "function") save();
  }
}

// Manual "Save to Dropbox" button in the Export dialog (app.js's
// showExportChooser). Mirrors exportShare()/exportSaveDevice() there, but
// lives here since it needs the Dropbox upload machinery above.
function exportSaveDropbox(blob, filename, eventCount){
  if(typeof toast === "function") toast("Uploading backup to Dropbox\u2026");
  syncUploadBackupBlob(blob).then(() => {
    if(typeof checkExportStaleness === "function") checkExportStaleness();
    if(typeof toast === "function") toast("Backup saved to Dropbox" + (eventCount ? (" (" + eventCount + " events)") : ""));
    if(typeof logEvent === "function") logEvent({ kind: "export", taskTitle: "Export Data", notes: "Saved backup to Dropbox" });
    if(typeof closeSheet === "function") closeSheet();
  }).catch(e => {
    if(typeof toast === "function") toast("Dropbox backup failed: " + ((e && e.message) || e));
  });
}

// Opportunistic scheduler — see the block comment above for why this rides
// on syncNow()'s success path instead of its own timer. Best-effort: any
// failure here must never break ordinary sync, hence the try/catch wrapping
// even the synchronous read of S.prefs.
function syncMaybeAutoExport(){
  try{
    const days = (typeof S !== "undefined" && S.prefs && S.prefs.exportIntervalDays) || 0;
    if(!days) return;
    if(typeof buildBackupFile !== "function") return; // app.js not loaded/ready

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const monthKey = `${year}-${month}`;
    S.monthlyBackups = S.monthlyBackups || [];

    const monthlyBackupNeeded = !S.monthlyBackups.includes(monthKey);
    const last = (S.prefs && S.prefs.lastExportTs) || 0;
    const regularBackupNeeded = Date.now() - last >= days * 86400000;

    if (monthlyBackupNeeded) {
      const p = (n) => String(n).padStart(2, '0');
      const stamp = '' + now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) + '-' + p(now.getHours()) + p(now.getMinutes());
      const filename = 'questa-backup-' + stamp + '.json';
      const path = '/' + filename;

      const eventsP = (typeof getEvents === "function") ? getEvents({}).catch(() => []) : Promise.resolve([]);
      eventsP.then(buildBackupFile).then(({blob}) => {
        return blob.text().then(text => dbxUploadText(path, text));
      }).then(() => {
        if (typeof S !== "undefined") {
          S.prefs = S.prefs || {};
          S.prefs.lastExportTs = Date.now();
          S.monthlyBackups = S.monthlyBackups || [];
          if (!S.monthlyBackups.includes(monthKey)) {
            S.monthlyBackups.push(monthKey);
          }
          if (typeof save === "function") save();
        }
        if (typeof logEvent === "function") {
          logEvent({ kind: "export", taskTitle: "Monthly Auto Backup", notes: "Saved monthly backup " + filename + " to Dropbox" });
        }
      }).catch(e => {
        syncCfgSave({ lastError: "monthly backup failed: " + ((e && e.message) || String(e)) });
      });
    } else if (regularBackupNeeded) {
      const eventsP = (typeof getEvents === "function") ? getEvents({}).catch(() => []) : Promise.resolve([]);
      eventsP.then(buildBackupFile).then(({blob}) => syncUploadBackupBlob(blob)).catch(e => {
        syncCfgSave({ lastError: "auto backup failed: " + ((e && e.message) || String(e)) });
      });
    }
  }catch(e){ /* best-effort only, never throw into syncNow()'s chain */ }
}

// ---- 3.9 Event-log sync (plan: .omo/plans/2026-07-10-eventlog-sync.md) ----
const EVENTS_DIR = "/events";
const EVT_PULL_MIN_INTERVAL_MS = 60000; // list_folder at most once/min

/* BEGIN_EVTSYNC_HELPERS */
// UTC month key for an event timestamp: 1467-style ms -> "YYYYMM".
function evtMonthKey(ts){
  const d = new Date(ts);
  return String(d.getUTCFullYear()).padStart(4,"0") + String(d.getUTCMonth()+1).padStart(2,"0");
}
// "YYYYMM" -> {from,to} ms, both inclusive (getEvents uses inclusive bounds).
function evtMonthRange(key){
  const y = parseInt(key.slice(0,4),10), m = parseInt(key.slice(4,6),10);
  return { from: Date.UTC(y, m-1, 1), to: Date.UTC(y, m, 1) - 1 };
}
// "<deviceId>-<YYYYMM>.json" -> {dev, month} | null. Greedy (.+) means the
// month is always the LAST 6-digit group — safe even if a deviceId contains
// digits or hyphens.
function evtParseFileName(name){
  const m = /^(.+)-(\d{6})\.json$/.exec(name || "");
  return m ? { dev: m[1], month: m[2] } : null;
}
// Own not-yet-uploaded events: stamped, mine, real (not synthetic), newer than
// the watermark.
function evtUploadable(events, myDev, sinceTs){
  // 'lifecycle' is a local-only diagnostic kind (Phase C, 2026-07-11) and
  // must never be pushed to Dropbox -- it would spam every other device's
  // Activity Feed too (see app.js getEvents() for the read-side filter and
  // the matching fix note).
  return (events || []).filter(e => e && e.uid && e.dev === myDev && !e.synthetic
    && e.kind !== "lifecycle" && typeof e.ts === "number" && e.ts > sinceTs);
}
// Full-month rebuild set for upload: same ownership rule, no watermark, local
// IDB `id` stripped (meaningless on other devices).
function evtOwnMonthRecords(events, myDev){
  return (events || [])
    .filter(e => e && e.uid && e.dev === myDev && !e.synthetic && e.kind !== "lifecycle" && typeof e.ts === "number")
    .map(e => { const r = Object.assign({}, e); delete r.id; return r; });
}
// Filter a downloaded file's records down to what should be inserted locally:
// stamped, not synthetic, not ours, inside the prune window, uid not already
// present (in IDB — caller passes the set — or earlier in this same batch).
function evtIncomingFilter(records, existingUidSet, myDev, nowMs, ageLimitMs){
  const out = []; const seen = new Set();
  (records || []).forEach(r => {
    if(!r || typeof r !== "object") return;
    if(!r.uid || typeof r.ts !== "number") return;
    if(r.synthetic) return;
    if(r.kind === "lifecycle") return; // defense-in-depth: reject even if an old build uploaded one
    if(r.dev === myDev) return;
    if(nowMs - r.ts > ageLimitMs) return;
    if(existingUidSet.has(r.uid) || seen.has(r.uid)) return;
    seen.add(r.uid);
    const rec = Object.assign({}, r); delete rec.id;
    out.push(rec);
  });
  return out;
}
// Is this whole month older than the prune window? (Compared against month END.)
function evtMonthOlderThan(monthKey, nowMs, ageLimitMs){
  return (nowMs - evtMonthRange(monthKey).to) > ageLimitMs;
}
/* END_EVTSYNC_HELPERS */

// Raw download: like dbxDownload but returns {text, rev} with NO wrapper
// validation (event files are bare arrays, not {schema,state} wrappers).
// null on 409 (file/folder absent).
async function dbxDownloadRaw(path, _retriedAuth){
  const tok = await syncToken();
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { "Authorization": "Bearer " + tok, "Dropbox-API-Arg": dbxArgHeader({ path: path }) }
  });
  if(res.status === 401 && !_retriedAuth){ await syncToken(true); return dbxDownloadRaw(path, true); }
  if(res.status === 409){
    let summary = "";
    try{ summary = String((((await res.json()) || {}).error_summary) || ""); }catch(e){}
    if(!summary || summary.indexOf("not_found") !== -1) return null;
    throw new HttpError("download failed: 409 " + summary.slice(0, 200), 409);
  }
  if(!res.ok){
    let detail = ""; try{ detail = (await res.text()).slice(0, 200); }catch(e){}
    throw new HttpError("download failed: " + res.status + (detail ? " " + detail : ""), res.status);
  }
  const metaHeader = res.headers.get("dropbox-api-result");
  let meta = {}; try{ meta = metaHeader ? JSON.parse(metaHeader) : {}; }catch(e){}
  return { text: await res.text(), rev: meta.rev || null };
}

// List files in a folder, following pagination. [] if the folder doesn't exist.
async function dbxListFolder(path, _retriedAuth){
  const tok = await syncToken();
  let entries = [];
  let url = "https://api.dropboxapi.com/2/files/list_folder";
  let body = { path: path, recursive: false, limit: 2000 };
  for(;;){
    const res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if(res.status === 401 && !_retriedAuth){ await syncToken(true); return dbxListFolder(path, true); }
    if(res.status === 409){
      let summary = "";
      try{ summary = String((((await res.json()) || {}).error_summary) || ""); }catch(e){}
      if(!summary || summary.indexOf("not_found") !== -1) return []; // no events uploaded yet
      throw new HttpError("list failed: 409 " + summary.slice(0, 200), 409);
    }
    if(!res.ok){
      let detail = ""; try{ detail = (await res.text()).slice(0, 200); }catch(e){}
      throw new HttpError("list failed: " + res.status + (detail ? " " + detail : ""), res.status);
    }
    const data = await res.json();
    entries = entries.concat((data.entries || []).filter(e => e[".tag"] === "file"));
    if(!data.has_more) return entries;
    url = "https://api.dropboxapi.com/2/files/list_folder/continue";
    body = { cursor: data.cursor };
  }
}

function evtInsertNew(records){
  if(!records || !records.length) return Promise.resolve(0);
  if(typeof idbOpen !== "function" || typeof EVENTS_STORE === "undefined") return Promise.resolve(0);
  return idbOpen().then(db => new Promise((resolve) => {
    let added = 0, tx;
    try{ tx = db.transaction(EVENTS_STORE, "readwrite"); }catch(e){ resolve(0); return; }
    const store = tx.objectStore(EVENTS_STORE);
    records.forEach(r => { try{ store.add(r); added++; }catch(e){} });
    tx.oncomplete = () => resolve(added);
    tx.onerror = () => resolve(added);
    tx.onabort = () => resolve(added);
  })).catch(() => 0);
}

// Upload own new events, rebuilding each touched month's file in full and
// overwriting it (single writer — no rev handshake needed; reuses
// dbxUploadText, which uploads mode:overwrite).
async function syncEventsPush(){
  if(typeof getEvents !== "function") return;
  const myDev = syncDeviceId();
  const since = syncCfg().evtLastUploadTs || 0;
  const fresh = evtUploadable(await getEvents({ from: since + 1 }), myDev, since);
  if(!fresh.length) return;
  const months = [...new Set(fresh.map(e => evtMonthKey(e.ts)))].sort();
  let maxTs = since;
  for(const mk of months){
    const r = evtMonthRange(mk);
    const recs = evtOwnMonthRecords(await getEvents({ from: r.from, to: r.to }), myDev);
    if(!recs.length) continue;
    await dbxUploadText(EVENTS_DIR + "/" + myDev + "-" + mk + ".json", JSON.stringify(recs));
    recs.forEach(e => { if(e.ts > maxTs) maxTs = e.ts; });
  }
  syncCfgSave({ evtLastUploadTs: maxTs });
}

// Pull other devices' files whose rev changed; union-insert by uid.
async function syncEventsPull(){
  if(typeof getEvents !== "function" || typeof idbOpen !== "function") return;
  const now = Date.now();
  const cfg = syncCfg();
  if(now - (cfg.evtLastPullAt || 0) < EVT_PULL_MIN_INTERVAL_MS) return;
  const myDev = syncDeviceId();
  const ageLimit = (typeof EVENT_AGE_LIMIT_MS !== "undefined") ? EVENT_AGE_LIMIT_MS : 18 * 30 * 86400000;
  const entries = await dbxListFolder(EVENTS_DIR);
  const revs = Object.assign({}, cfg.evtFileRevs || {});
  for(const ent of entries){
    const parsed = evtParseFileName(ent.name);
    if(!parsed) continue;                    // not an event file (ignore strangers)
    if(parsed.dev === myDev) continue;       // never re-import own uploads
    if(evtMonthOlderThan(parsed.month, now, ageLimit)){ delete revs[ent.name]; continue; }
    if(ent.rev && revs[ent.name] === ent.rev) continue; // unchanged since last pull
    const dl = await dbxDownloadRaw(EVENTS_DIR + "/" + ent.name);
    if(!dl) continue;
    let records = null;
    try{ records = JSON.parse(dl.text); }catch(e){ /* corrupt: skip content */ }
    if(Array.isArray(records)){
      const range = evtMonthRange(parsed.month);
      const existing = new Set((await getEvents({ from: range.from, to: range.to }))
        .map(e => e && e.uid).filter(Boolean));
      await evtInsertNew(evtIncomingFilter(records, existing, myDev, now, ageLimit));
    }
    // Record the rev even if the file was corrupt — its writer overwrites it
    // on their next push; re-downloading a permanently bad file every minute
    // helps no one.
    revs[ent.name] = dl.rev || ent.rev || null;
  }
  syncCfgSave({ evtFileRevs: revs, evtLastPullAt: now });
}

// Fire-and-forget wrapper, called from syncNow()'s success path. Own in-flight
// guard; any failure lands in lastError and never breaks ordinary state sync.
let _evtSyncInFlight = false;
function syncEventsSync(){
  if(_evtSyncInFlight) return;
  const cfg = syncCfg();
  if(!cfg.enabled || !cfg.refreshToken) return;
  if(typeof navigator !== "undefined" && navigator.onLine === false) return;
  _evtSyncInFlight = true;
  syncEventsPush()
    .then(() => syncEventsPull())
    .catch(e => { syncCfgSave({ lastError: "event sync failed: " + ((e && e.message) || String(e)) }); })
    .then(() => { _evtSyncInFlight = false; });
}

// ---- 3.6 scheduleSync() — 5s trailing debounce -----------------------------
let _syncDebounceTimer = null;
function scheduleSync(){
  if(SYNC_APPLYING) return; // this save() call came from syncApply itself — don't loop
  if(_syncDebounceTimer) clearTimeout(_syncDebounceTimer);
  _syncDebounceTimer = setTimeout(() => { _syncDebounceTimer = null; syncNow(); }, SYNC_DEBOUNCE_MS);
}

// ---- 4.x Settings UI helpers (used by app.js's openSettings()) ------------
function syncRelativeTime(ms){
  if(!ms) return 'never';
  const s = Math.max(0, Math.floor((Date.now()-ms)/1000));
  if(s<10) return 'just now';
  if(s<60) return s+'s ago';
  const m = Math.floor(s/60); if(m<60) return m+'m ago';
  const h = Math.floor(m/60); if(h<24) return h+'h ago';
  const d = Math.floor(h/24); return d+'d ago';
}
function syncRefreshSettingsUI(){
  try{
    // Only refresh Settings if it is ACTUALLY on screen. closeSheet() removes
    // the scrim's "show" class but leaves the last sheet's HTML in #sheet, so
    // querying for .appVersion alone was true even after Settings was closed —
    // which made every sync re-call openSettings() and pop Settings open by
    // itself. Gate on the scrim being visible.
    const scrim = document.getElementById('scrim');
    const sheet = document.getElementById('sheet');
    if(scrim && scrim.classList.contains('show') &&
       sheet && sheet.querySelector('.appVersion') &&
       typeof openSettings==="function") openSettings();
  }catch(e){ /* best-effort UI refresh only */ }
}
function confirmSyncDisconnect(){
  const proceed = () => {
    syncDisconnect();
    if(typeof toast==="function") toast('Dropbox disconnected');
    if(typeof openSettings==="function") openSettings();
  };
  if(typeof confirmDialog==="function"){
    confirmDialog('Disconnect Dropbox', 'Stop syncing this device? Local data is kept; other devices keep their own copy.').then(ok=>{ if(ok) proceed(); });
  } else {
    proceed();
  }
}
// Force push is destructive (it can permanently discard other devices' not-
// yet-synced changes), so unlike confirmSyncDisconnect above it does NOT
// have a "just proceed" fallback if the confirm dialog is unavailable for
// any reason — refusing is the safe default for a hard-to-undo action.
function confirmForcePush(){
  if(typeof confirmDialog!=="function"){
    if(typeof toast==="function") toast('Force push unavailable right now (confirmation dialog missing).');
    return;
  }
  confirmDialog(
    'Force push — overwrite Dropbox?',
    "This replaces the data in Dropbox with what's on THIS device. Anything saved on other devices that hasn't synced yet will be permanently lost. This cannot be undone."
  ).then(ok=>{
    if(!ok) return;
    if(typeof toast==="function") toast('Pushing this device\'s data to Dropbox\u2026');
    syncForcePush();
  });
}
// Same "refuse rather than silently proceed" rule as confirmForcePush — force
// pull discards whatever unsynced local changes this device has, so it needs
// the same hard confirmation gate.
function confirmForcePull(){
  if(typeof confirmDialog!=="function"){
    if(typeof toast==="function") toast('Force pull unavailable right now (confirmation dialog missing).');
    return;
  }
  confirmDialog(
    'Force pull — overwrite this device?',
    "This replaces what's on THIS device with whatever is in Dropbox. Anything on this device that hasn't synced yet will be permanently lost. This cannot be undone.\n\nNote: normal sync now protects newer edits on each device, so a Force Push from another device will NOT overwrite a newer change you made here. If you want this device to show ONLY the exact state that is in Dropbox, use this Force Pull; to make EVERY device match Dropbox exactly, run Force Pull on each device (or do a full app reset — clear the app's site data / reinstall — which wipes all local data and re-pulls from Dropbox)."
  ).then(ok=>{
    if(!ok) return;
    if(typeof toast==="function") toast('Pulling Dropbox\'s data onto this device\u2026');
    syncForcePull();
  });
}

// ---- 3.7 syncInit() ---------------------------------------------------------
let _syncInitDone = false;
function syncInit(){
  if(_syncInitDone) return;
  _syncInitDone = true;
  syncHandleRedirect();
  // One-time base purge (2026-07-11 recency-guard rollout): clear any base
  // snapshot written by a pre-fix build so a stale poisoned base cannot fire.
  // Next sync rebuilds base cleanly from fetch+guarded-merge. Runs exactly once.
  try{
    if(localStorage.getItem("questa.baseReset.v1") !== "done"){
      if(typeof idbOpen === "function"){
        idbOpen().then(function(db){
          try{
            var tx = db.transaction("syncmeta","readwrite");
            tx.objectStore("syncmeta").delete("base");
          }catch(e){}
        }).catch(function(){});
      }
      localStorage.setItem("questa.baseReset.v1", "done");
    }
  }catch(e){ /* best-effort */ }
  window.addEventListener("online", () => syncNow());
  document.addEventListener("visibilitychange", () => {
    if(document.visibilityState === "visible") syncNow();
    else syncNow(); // hidden: best-effort push, fire-and-forget (do not await)
  });
  setTimeout(() => syncNow(), 2000); // let the app finish booting first
}

// Exposed for the Settings screen (Phase 4) and for manual console testing.
if(typeof window !== "undefined"){
  window.QuestaSync = {
    connect: syncConnect,
    disconnect: syncDisconnect,
    now: syncNow,
    forcePush: syncForcePush,
    forcePull: syncForcePull,
    cfg: syncCfg,
    merge: merge, // exposed so it can be unit-tested from the browser console too
    mergeCollection: mergeCollection,
    resolveDailyConflict: resolveDailyConflict, // F3 (2026-07-11): daily-aware both-changed tiebreak, exposed for unit tests
    normalizeDailyResets: normalizeDailyResets, // F3 (2026-07-11): reset overlay, exposed for unit tests
    mergeChecklist: mergeChecklist, // F4 (2026-07-11): per-subtask merge, exposed for unit tests
    dailyEventDay: dailyEventDay,
    mergeDevices: mergeDevices,
    cleanDevices: cleanDevices,
    mergeDayArray: mergeDayArray,
    exportBackup: exportSaveDropbox,
    maybeAutoExport: syncMaybeAutoExport,
    eventsPush: syncEventsPush,
    eventsPull: syncEventsPull,
    eventsSync: syncEventsSync,
    evtHelpers: { evtMonthKey, evtMonthRange, evtParseFileName, evtUploadable, evtOwnMonthRecords, evtIncomingFilter, evtMonthOlderThan }
  };
}

// ---- boot -------------------------------------------------------------
// BUG FIX (2026-07-10): app.js's own init code calls
// `if(typeof syncInit==="function") syncInit();` — but that line runs as
// PART of app.js's synchronous top-to-bottom execution, which happens
// entirely BEFORE the browser even starts loading this file (two sequential
// classic <script> tags: app.js fully runs, THEN sync.js loads). So that
// call in app.js always sees `syncInit` as undefined and silently no-ops on
// EVERY page load — including the one that matters, the redirect back from
// Dropbox with ?code=... in the URL. syncHandleRedirect() never ran, so the
// token exchange never happened: PKCE_KEY sat untouched forever and
// questa.sync.v1 was never written. The fix is to call it from here instead
// — by the time this file's own top-level code executes, app.js has already
// finished running (same reason the app.js-side call was too early), so
// everything either side needs is guaranteed to exist.
//
/* BEGIN_BOOT_GATE */
// Phase A ordering constraint (2026-07-11 persistence-loss fix): reconcile the
// durable IndexedDB mirror of S against the possibly-stale localStorage boot
// copy BEFORE syncInit()'s first sync round ever calls syncSubset() -- see
// .omo/plans/2026-07-11-persistence-loss-fix-plan.md §2 step 4. If
// reconcileDurableState (app.js) isn't available for any reason, fall back to
// the old behavior rather than never booting sync at all.
if(typeof reconcileDurableState === "function"){
  reconcileDurableState().then(syncInit).catch(syncInit);
} else {
  syncInit();
}
/* END_BOOT_GATE */
