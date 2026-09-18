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
// 2026-09-18: the app key a fork should actually use. syncCfgDefaults() has carried
// an `appKey` field since the start, but all three OAuth call sites hardcoded the
// constant, so the field was write-only — a fork that set it got the ORIGINAL app's
// consent screen, and Dropbox rejects any redirect_uri not registered on that app.
// Reading it here is what lets someone self-host this at their own origin.
function dbxAppKey(){
  try{ return (syncCfg().appKey || DBX_APP_KEY); }catch(e){ return DBX_APP_KEY; }
}
const SYNC_KEY = "questa.sync.v1";
const PKCE_KEY = "questa.sync.pkce";
// F7 (2026-08-18): derived from app.js's HLC_RATCHET_TOLERANCE_MS so exactly ONE
// tolerance exists across both files. Literal fallback kept because both files are
// classic scripts in one document and sync.js must still work if app.js is older --
// the same pattern EVENT_AGE_LIMIT_MS uses below.
// J3 (2026-08-19): try-guarded IIFE, not a bare ternary. `typeof` does NOT protect
// against the temporal dead zone: app.js's top-level `const` binding is created when
// app.js is INSTANTIATED, so if app.js throws before reaching that declaration the
// binding exists but is uninitialised and this lookup throws a ReferenceError at
// script-parse time -- killing all of sync.js. Under the old plain literal, sync
// survived a broken app.js (AGENTS.md §1). The bare identifier is deliberate: it
// resolves through the shared global LEXICAL environment where app.js's const lives,
// which `typeof globalThis.HLC_RATCHET_TOLERANCE_MS` would not. The fallback literal is
// repeated in the catch on purpose, keeping the `: <N>;` shape that
// tests/hlc-ratchet-tolerance.test.js 5e pins; both copies are asserted equal to
// app.js's value by tests/max-future-skew-derive.test.js T3i.
const MAX_FUTURE_SKEW_MS = (function(){ try{ return (typeof HLC_RATCHET_TOLERANCE_MS !== "undefined") ? HLC_RATCHET_TOLERANCE_MS : 120000; }catch(e){ return 120000; } })(); // 120s future-skew tolerance (shared with _ua/_ca)
const STATE_PATH = "/state.json";
const SYNC_DEBOUNCE_MS = 5000;
const SYNC_CONFLICT_RETRY_LIMIT = 3;
const SYNC_TRANSIENT_RETRY_DELAYS_MS = [1000, 5000, 25000]; // 429/5xx backoff
const SYNC_CONFLICT_BACKOFF_MS = 30000; // 30s backoff after conflict retry exhaustion

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
    lastBackupError: null,   // auto-backup failures only; never clobbers lastError (2026-09-18 round 2)
    deviceId: null,
    evtLastUploadTs: 0,   // watermark: max ts of own events already uploaded
    evtFileRevs: {},      // filename -> Dropbox rev of last successfully PARSED+INSERTED pull
    evtLastPullAt: 0,     // throttle: last time we ran a pull
    evtFullScanAt: 0,     // periodic full re-scan watermark (ignores evtFileRevs/evtBadRevs)
    evtBadRevs: {},        // filename -> {rev, at} for corrupt/failed payloads (slower retry, never pins)
    evtFullPushAt: 0,        // periodic full re-push watermark (ignores evtLastUploadTs)
    evtFileCounts: {},       // filename -> {count, hash} of last successfully uploaded month
    evtPushBlocked: {}       // filename -> {at, local, known} for blocked pushes
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
async function syncConnect(keepPendingForcePush){
  try{
    // A normal connect must never inherit a leftover force-push intent from an
    // abandoned "Connect & Force Push" attempt. Only confirmConnectForForcePush()
    // passes keepPendingForcePush=true (right after it sets the flag) to preserve it.
    if(!keepPendingForcePush){
      localStorage.removeItem("questa.sync.pendingForcePush");
    }
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
      client_id: dbxAppKey(),
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
  try{ params = new URLSearchParams(location.search); }catch(e){ localStorage.removeItem("questa.sync.pendingForcePush"); return; }
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
  if(!code || !verifier){
    // 2026-09-18: this is the path Dropbox takes when the user presses Cancel on the
    // consent screen (?error=access_denied). The verifier used to survive here
    // forever, and the ?error= querystring stayed in the address bar across reloads
    // because the cleanup below only ran on success. Clear both.
    // 2026-09-18 (round 2): this branch is also taken on EVERY ordinary boot, because
    // syncInit() calls syncHandleRedirect() unconditionally and a normal load has no
    // ?code=. Clearing the verifier there destroyed an in-flight connect started in
    // another tab: tab A navigates to the consent screen, tab B reloads (refresh, SW
    // update, tab restore), tab B wipes PKCE_KEY, and tab A returns with a code it
    // can no longer exchange -- silently, since this path writes no lastError. Only
    // clear when this load really is an OAuth return.
    // The stale force-push intent is still dropped on EVERY load — that is the
    // documented behaviour (T4/T8 in tests/force-push-on-connect.test.js, and
    // syncInit clears it on a normal load too). Only the PKCE secret is protected.
    try{ localStorage.removeItem("questa.sync.pendingForcePush"); }catch(e){}
    const _isOAuthReturn = !!(code || params.get("error"));
    if(_isOAuthReturn){
      try{ localStorage.removeItem(PKCE_KEY); }catch(e){}
      // ...and strip the querystring for a ?code= too, not just ?error=. A failed
      // exchange used to leave the authorization code in the address bar, in history,
      // in any bookmark or PWA shortcut made from there, and in the Referer of every
      // later outbound request, across every future reload.
      try{ history.replaceState(null, "", location.pathname); }catch(e){}
    }
    return;
  }

  const redirectUri = (pkce && pkce.r) || (location.origin + location.pathname);
  try{
    const body = new URLSearchParams({
      code: code,
      grant_type: "authorization_code",
      code_verifier: verifier,
      client_id: dbxAppKey(),
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
    // Consume the "connect with intent to force push" flag BEFORE syncNow() can
    // run. This is the crux of Option A: a normal connect merges the remote down
    // first, which would defeat a user who connected specifically to overwrite the
    // remote with THIS device's data. Read it, clear it, then branch on it.
    const pendingForcePush = localStorage.getItem("questa.sync.pendingForcePush") === "true";
    localStorage.removeItem("questa.sync.pendingForcePush");
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
    if(pendingForcePush){
      if(typeof toast === "function") toast("Performing initial force push\u2026");
      syncForcePush();
    } else {
      // 2026-07-15: if a reset-while-disconnected stashed a device id for an
      // event-log purge, delete that device's now-stale /events files before
      // any pull can resurrect them into the Activity Feed.
      const pend = (typeof localStorage !== "undefined") ? localStorage.getItem("questa.events.pendingPurgeDev") : null;
      if(pend){
        try{ localStorage.removeItem("questa.events.pendingPurgeDev"); }catch(e){}
        if(typeof syncEventsDeleteDevice === "function") syncEventsDeleteDevice(pend).catch(function(){});
      }
      syncNow();
    }
  }catch(e){
    try{ localStorage.removeItem(PKCE_KEY); }catch(e2){}
    localStorage.removeItem("questa.sync.pendingForcePush"); // never leave a sticky force-push intent behind on failure
    // 2026-09-18 (round 2): the success path strips the querystring; this one did
    // not, so a failed exchange left ?code=<authorization code> in the address bar
    // permanently. Strip it here too -- the code is spent either way.
    try{ history.replaceState(null, "", location.pathname); }catch(e2){}
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
    client_id: dbxAppKey()
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
  if(res.status === 409){
    // F6 parity (upload, 2026-07-12): inspect the 409 body to distinguish
    // a genuine rev conflict from other 409 errors (e.g. restricted_content).
    // Only rev mismatches feed the retry loop; anything else surfaces as an
    // HttpError — no retry burn.
    //
    // 2026-09-18: this used to test for the literal "update/conflict", which is
    // NOT a tag the Dropbox API emits. Its WriteError union is
    // {malformed_path, conflict, no_write_permission, insufficient_space,
    //  disallowed_name, team_folder, operation_suppressed,
    //  too_many_write_operations} — a real stale-rev upload returns
    // "path/conflict/file/...". So every genuine conflict became an HttpError,
    // `e instanceof ConflictError` was false in _pushWithConflictRetry, nothing
    // retried, and the device was left with the merge APPLIED to S but never
    // uploaded and syncBasePut never called: a stale base plus an advanced
    // local, which is the amplifier for every accumulating-rule bug in this file.
    // Match a `conflict` path SEGMENT instead, which covers the real string and
    // still accepts the old one, while never matching restricted_content or
    // insufficient_space.
    let summary = "";
    try{ summary = String((((await res.json()) || {}).error_summary) || ""); }catch(e){}
    if(!summary || /(^|\/)conflict(\/|$)/.test(summary)){
      throw new ConflictError("upload conflict: rev");
    }
    throw new HttpError("upload failed: 409 " + summary.slice(0, 200), 409);
  }
  if(!res.ok){
    let detail = "";
    try{ detail = (await res.text()).slice(0, 200); }catch(e){}
    throw new HttpError("upload failed: " + res.status + (detail ? " " + detail : ""), res.status);
  }
  return await res.json();
}

// Delete a file/folder at path. 409 path/not_found is treated as success
// (already gone); any other error surfaces. Pre-flight 401 refreshes the
// token once. Used by the event-log purge on "Reset everything".
async function dbxDelete(path, _retriedAuth){
  const tok = await syncToken();
  const res = await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + tok,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path: path })
  });
  if(res.status === 401 && !_retriedAuth){
    await syncToken(true);
    return dbxDelete(path, true);
  }
  if(res.status === 409){
    let summary = "";
    try{ summary = String((((await res.json()) || {}).error_summary) || ""); }catch(e){}
    if(!summary || summary.indexOf("not_found") !== -1) return; // already deleted
    throw new HttpError("delete failed: 409 " + summary.slice(0, 200), 409);
  }
  if(!res.ok){
    let detail = ""; try{ detail = (await res.text()).slice(0, 200); }catch(e){}
    throw new HttpError("delete failed: " + res.status + (detail ? " " + detail : ""), res.status);
  }
  return true;
}

function syncDisconnect(){
  const cfg = syncCfg();
  syncCfgSave(Object.assign(syncCfgDefaults(), {
    deviceId: cfg.deviceId || null,
    lastSyncAt: cfg.lastSyncAt || null,
    // 2026-09-18 (round 2): these two describe REMOTE content, not credentials, and
    // deviceId is deliberately preserved -- so after a reconnect this device pushes
    // to the very same <deviceId>-<YYYYMM>.json filenames. Resetting them to {}
    // disarmed the event-push shrink guard (`const known = fileCounts[fname]; if
    // (known != null ...)`), so a locally shrunken month would overwrite a fuller
    // remote file with no diagnostic. Nothing on the pull side ever repopulates them.
    evtFileCounts: cfg.evtFileCounts || {},
    evtPushBlocked: cfg.evtPushBlocked || {}
  }));
  // 2026-09-18: also drop the one-shot OAuth leftovers. The PKCE verifier is a
  // secret for a single in-flight authorize/exchange pair; disconnecting used to
  // leave it (and a stale pendingForcePush flag) in localStorage indefinitely.
  try{ localStorage.removeItem(PKCE_KEY); }catch(e){}
  try{ localStorage.removeItem("questa.sync.pendingForcePush"); }catch(e){}
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
  const pause = { paused: !!(S.prefs && S.prefs.paused), pausedDays: (S.prefs && Array.isArray(S.prefs.pausedDays)) ? S.prefs.pausedDays : [], at: (S.prefs && S.prefs.pausedAt) || 0 };
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
    pause: pause,
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
    // 2026-09-18: an ABSENT key means "the writer expressed no opinion", not "empty".
    // These six used to fall back to [] while their neighbours (char, lastCron,
    // deletions, pause) correctly preserve local. merge() always emits all 12 keys so
    // the normal round was safe, but _syncForcePullAttempt applies the RAW remote: a
    // /state.json written by a build predating monthlyBackups/an — or hand-edited in
    // the user's own Dropbox folder — wiped every saved analytics view, metric,
    // reward, tag and history row on this device. Preserve local instead.
    S.rewards = Array.isArray(subset.rewards) ? subset.rewards : (S.rewards || []);
    S.tags = Array.isArray(subset.tags) ? subset.tags : (S.tags || []);
    S.devices = cleanDevices(Array.isArray(subset.devices) ? subset.devices : (S.devices || []));
    if(subset.lastCron) S.lastCron = subset.lastCron;
    S.history = Array.isArray(subset.history) ? subset.history : (S.history || []);
    S.charHistory = Array.isArray(subset.charHistory) ? subset.charHistory : (S.charHistory || []);
    S.monthlyBackups = Array.isArray(subset.monthlyBackups) ? subset.monthlyBackups : (S.monthlyBackups || []);
    S.deletions = Array.isArray(subset.deletions) ? subset.deletions : (S.deletions || []);
    S.prefs = S.prefs || {};
    S.prefs.an = S.prefs.an || {};
    if(subset.an){
      S.prefs.an.views = Array.isArray(subset.an.views) ? subset.an.views : (S.prefs.an.views || []);
      S.prefs.an.metrics = Array.isArray(subset.an.metrics) ? subset.an.metrics : (S.prefs.an.metrics || []);
    }
    if(subset.pause){
      S.prefs.paused = !!subset.pause.paused;
      // 2026-09-18 (round 2): the absent-key rule above listed `pause` among the keys
      // that "correctly preserve local". It did not. A /state.json written by a build
      // predating pausedDays -- or hand-edited in the user's own Dropbox folder --
      // reached _syncForcePullAttempt's syncApply(raw remote) and wiped pausedDays to
      // []. runCron's _cov cover then vanished, so every daily left unticked during
      // the pause took miss damage and lost its streak, and mergePause's union of
      // three now-empty lists made it unrecoverable. `at` was a clamp-to-0 of a
      // timestamp on top of that -- the polarity this repo treats as a hard rule.
      S.prefs.pausedDays = Array.isArray(subset.pause.pausedDays) ? subset.pause.pausedDays.slice() : (S.prefs.pausedDays || []);
      if(subset.pause.at) S.prefs.pausedAt = subset.pause.at;
    }
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
        try{
          if(!req.result){ resolve(null); return; }
          const parsed = JSON.parse(req.result);
          // New format (#5): {b: <json-string>, r: <rev-string>}
          if(parsed && typeof parsed === "object" && "b" in parsed){
            resolve({ base: JSON.parse(parsed.b), lastRev: parsed.r || null });
          } else {
            // Old format (backward compat): the parsed value IS the base
            resolve({ base: parsed, lastRev: null });
          }
        }
        catch(e){ resolve(null); }
      };
      req.onerror = () => resolve(null);
    }catch(e){ resolve(null); }
  })).catch(() => null);
}
function syncBasePut(subset, rev){
  // Accepts an object OR a pre-serialized JSON string (fix 2026-07-11).
  // Serializing HERE, before the idbOpen await, also closes the small window
  // where object callers could be mutated during that await.
  // FIX 2026-07-12 (#5): store rev alongside base for poisoned-base self-check.
  const payload = (typeof subset === "string") ? subset : JSON.stringify(subset);
  const envelope = JSON.stringify({b: payload, r: rev || null});
  if(typeof idbOpen !== "function") return Promise.resolve(false);
  return idbOpen().then(db => new Promise((resolve) => {
    try{
      const tx = db.transaction("syncmeta", "readwrite");
      tx.objectStore("syncmeta").put(envelope, "base");
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
// char.updatedAt IS now reliably stamped on every stat change (app.js save()
// chokepoint via _charSig, 2026-07-12). The F6 merge tiebreak (sync.js) uses
// it: strictly-newer remote wins; ties use a deterministic deviceId tiebreak.
// Residual clock-skew is char-lossy-accepted per plan §0.
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
// dayStampOf: LOCAL calendar day from ms timestamp — same semantics as app.js dayStamp().
// Cross-device: two TZs computing dayStampOf on the same ms may get different YYYYMMDD.
// Cross-TZ merge correctness verified in tests/daystamp.test.js.
function dayStampOf(ms){
  if(!ms) return 0;
  const d = new Date(ms);
  return d.getFullYear()*10000 + (d.getMonth()+1)*100 + d.getDate();
}
// 2026-09-18: the completion day, in the frame it was RECORDED in.
// dayStampOf(doneAt) re-derives the day in the MERGING device's timezone, while
// missedOn is a frozen int minted in the RECORDING device's. Comparing the two
// made resolveDailyConflict ambient-timezone dependent, so two devices in
// different zones read the same pair of records and returned opposite winners —
// the completion survived on one and was replaced by the miss (streak zeroed,
// damage charged) on the other, with no round able to converge them.
// app.js completeTask/creditYesterday now freeze t.doneDay the same way runCron
// freezes t.missedOn. Records written by older builds have no doneDay, so fall
// back to the old derivation for them.
function doneDayOf(x){
  if(!x) return 0;
  const d = Number(x.doneDay) || 0;
  return d || dayStampOf(x.doneAt || 0);
}
function dailyEventDay(x){
  if(!x) return 0;
  return Math.max(doneDayOf(x), x.missedOn || 0);
}
// Both-changed-both-present tiebreak for type==='daily' entries only (called
// from mergeCollection below). Pure function of (l, r) -- no S/base access --
// so conflict-retry re-merges stay convergent (analysis Sec5/Sec8 invariant).
// localDeviceId / remoteDeviceId are OPTIONAL trailing parameters (added 2026-08-18 for
// F1's tie-convergence). Omitting them keeps the exact pre-existing behaviour, so the
// existing 2-argument callers in tests/ and archive/tests/ need no edit.
function resolveDailyConflict(l, r, localDeviceId, remoteDeviceId){
  const led = dailyEventDay(l), red = dailyEventDay(r);
  if(led !== red) return led > red ? l : r; // rule 1: newer event day wins
  // rule 2: same event day -- a completion beats a miss recorded for that same
  // day (the miss was, by definition, computed from stale data on that side).
  const lDoneToday = !!(l && led && doneDayOf(l) === led);
  const rDoneToday = !!(r && red && doneDayOf(r) === red);
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
  // F1 (2026-08-18): clamp future-skewed stamps so a fast clock cannot win this
  // tiebreak. Both sides carry a real competing value here, so 0 only loses.
  const luc = _clampFuture(lu), ruc = _clampFuture(ru);
  // Clamping makes ties far more likely (two skewed sides both become 0), and the
  // old unconditional "remote wins the tie" is non-convergent: "remote" is the OTHER
  // device from each side, so A would adopt B's copy while B adopts A's. Break the tie
  // on the lexically greater deviceId, which is the same answer on both devices.
  // Same pattern as the char merge below. Dailies are the app's primary task type.
  if(luc === ruc && remoteDeviceId != null){
    const _ld = (localDeviceId != null) ? localDeviceId
      : ((typeof syncDeviceId === "function") ? syncDeviceId() : null);
    if(_ld != null && _ld !== remoteDeviceId) return (remoteDeviceId > _ld) ? r : l;
  }
  return luc > ruc ? l : r;
}
// Idempotent post-decision overlay applied to EVERY merged daily regardless of
// which mergeCollection branch produced it (one-sided branches can also carry
// a stale done=true from a device that hasn't cronned past it yet). Pure: does
// not mutate its input.
// Cross-TZ: if mergedLastCron > dayStampOf(t.doneAt) the daily is reset. This is
// correct even when a completion happened behind — the other device's cron already
// transitioned. The completing device's char stats (XP/gold) are preserved via HLC merge.
function normalizeDailyResets(tasks, mergedLastCron){
  if(!Array.isArray(tasks)) return tasks;
  return tasks.map(t=>{
    if(!t || t.type!=='daily' || !t.done) return t;
    // 2026-09-18: doneDayOf, not dayStampOf(doneAt) — same cross-timezone frame
    // problem as resolveDailyConflict. mergedLastCron is a frozen local day stamp,
    // so the value it is compared against must be frozen too, or a device one zone
    // away un-ticks a completion that is still current.
    if(doneDayOf(t) < (mergedLastCron || 0)){
      const nt = Object.assign({}, t, {done:false});
      if(Array.isArray(t.checklist)) nt.checklist = t.checklist.map(c=>Object.assign({}, c, {done:false}));
      return nt;
    }
    return t;
  });
}
// K5 (2026-09-11): recognise the CROSS-TZ ECHO of the overlay directly above.
// normalizeDailyResets builds Object.assign({}, t, {done:false}) -- it KEEPS doneAt and
// it never bumps updatedAt. A device in a later timezone therefore uploads a record that
// differs from base by the done flag ALONE, which makes mergeCollection's one-sided
// branch apply it on a device whose own day has NOT rolled over yet, erasing a
// completion the user really made today plus every subtask tick with it. K1 fixed the
// sibling case (a remote lastCron in this device's future) in mergedLastCron; the echo
// arrives on the record itself and never reaches that rule.
// A deliberate retraction is a DIFFERENT SHAPE on disk: uncompleteDaily/uncompleteTodo
// (app.js:1818-1821, 1829-1831) BOTH `delete t.doneAt` AND set `t.updatedAt = now()`,
// so neither test below holds and a real un-tick still wins. That is the whole
// discriminator -- do not relax either half.
// INVERTED POLARITY: returning false KEEPS the remote reset and DESTROYS local data, so
// every operand reads RAW and the day test is `>=`, not `>`. This is deliberately NOT a
// clamp site; see the _uaRaw block comment below and D5. `today` is a pure read of the
// physical clock, exactly as mergedLastCron's own is (see J1 finding 4).
function _isCronEchoReset(l, r){
  if(!l || !r) return false;
  if(l.type !== 'daily' && r.type !== 'daily') return false;
  if(l.done !== true || r.done !== false) return false;
  if(_uaRaw(l) !== _uaRaw(r)) return false;        // a real edit always bumps updatedAt
  const da = Number(r.doneAt) || 0;
  if(!da) return false;                            // doneAt retracted -> a real un-tick
  // 2026-09-18 (round 2): use the FROZEN completion day, not a re-derivation of
  // doneAt in the merging device's timezone. doneDayOf() was introduced for exactly
  // this and applied to resolveDailyConflict and normalizeDailyResets; this third
  // sibling was left on the old derivation, so the two could disagree about whether
  // the same record is current. A completion recorded 26h ago on a device 13h ahead
  // has doneDay == TODAY but dayStampOf(doneAt) == TODAY-1: normalizeDailyResets kept
  // it while this guard declined, and the echo erased it.
  return doneDayOf(r) >= dayStampOf(Date.now()); // completion still current HERE
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
      // F1 (2026-08-18): SEPARATE clamped operands, used ONLY by the two comparisons
      // below. Do NOT clamp lt/rt themselves: they also feed Math.max(lt, rt) further
      // down, and two skewed sides would give Math.max(0,0) === 0, which executes
      // "delete merged.touchedAt". The record would then persist with no edit-recency
      // metadata, and in a LATER one-sided round the survivor-vs-deletion test reads
      // survivor.touchedAt || 0, fails, and DROPS THE SUBTASK. Keep Math.max raw.
      const ltc = _clampFuture(lt), rtc = _clampFuture(rt);
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
      else if(ltc !== rtc) text = ltc > rtc ? l.text : r.text;
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
      else if(ltc !== rtc) done = ltc > rtc ? !!l.done : !!r.done;
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
    // Site 1 of 4 -- DIAGNOSTIC ONLY, never clamp here. The else-branch below is
    // "deletion wins", so clamping a real-but-skewed edit to 0 would DELETE the subtask.
    _skewDiagNote('skewChecklistSurvivor', survivorTouchedAt, id);
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
// timestamp more than 2 min ahead of the trust ceiling is untrusted -> treated
// as 0 so a future-skewed clock cannot win a guard or mint an undeletable record.
// K2 (2026-09-11): that ceiling is now the PHYSICAL clock, not app.js's HLC. It used
// to be `_hlcNow()`, bound to now(), which is monotonic-FORWARD ONLY and persisted to
// S.__hlcLast -- so (a) ONE clock excursion raised this device's ceiling permanently,
// surviving both a clock correction and a reboot, and (b) now() is not a pure read (it
// does lastIssued = Math.max(p, lastIssued+1) and writes S.__hlcLast), so the ceiling
// crept ~1ms per comparison and the guard grew MORE permissive the bigger the state.
// Physical is also strictly TIGHTER: ratchetHlc admits a peer up to physical+120s and
// now() then bumps past it, so the old ceiling was worth up to 240s PLUS unbounded
// per-merge drift, where MAX_FUTURE_SKEW_MS is the 120s the rest of the fleet actually
// honours. Same reasoning and same per-round capture that J1 finding 4 applied to the
// diagnostics path below; this NARROWS that fix's SCOPE line, which excluded these
// three helpers on the grounds that "a 0 there destroys data" -- true of the
// inverted-polarity sites, but those call _uaRaw/_caRaw or read raw values and never
// reach here. The one site that did have inverted polarity is GUARD 1's sibling
// GUARD 3, reclassified below. Paired with app.js now()'s heal: the heal may only drop
// lastIssued because every value it drops reads as 0 HERE too, on every device
// including the poisoned one, so no already-issued stamp can beat the new lower one.
// See .omo/plans/K2-hlc-future-lock.md.
var _clampCeil = 0;
// The `||` fallback is LOAD-BEARING, not defensive. _clampCeil is stamped per round in
// _skewDiagReset() and cleared in _skewDiagFlush(), but mergeCollection/mergeChecklist
// are also reachable OUTSIDE a round -- the unit tests call them directly -- where a
// 0 ceiling would clamp every timestamp in the suite to 0.
function _futureCeil(){ return _clampCeil || (Date.now() + MAX_FUTURE_SKEW_MS); }
// STATUS as of K2: _ua and _ca have ZERO callers in this file. GUARD 3 at line ~891 was
// the last one, and K2 moved it to the raw twins. They are kept, not deleted, for two
// reasons: tests/hlc.test.js H4a-H4d poke _ua directly and are the ONLY coverage of the
// clamp rule itself, and they are the canonical object-shaped clamp for any future
// arbitration site (use them where 0 means "loses a tiebreak"; use _uaRaw/_caRaw where
// 0 would destroy data, and classify the polarity BEFORE you pick). Deleting them is a
// separate decision that costs that coverage -- do not do it as a drive-by cleanup.
function _ua(x){ var v = (x && (Number(x.updatedAt) || Number(x.createdAt) || 0)) || 0; return v > _futureCeil() ? 0 : v; }
function _ca(x){ var v = (x && Number(x.createdAt)) || 0; return v > _futureCeil() ? 0 : v; }
// K1 (2026-09-11): the UNCLAMPED twin of _ua, for the inverted-polarity sites where a
// clamped 0 DESTROYS data instead of losing a tiebreak. Same field precedence and the
// same numeric coercion as _ua -- the only difference is that it never returns 0 for a
// future-skewed value. Three sites use it: the tombstone overlay's ENTITY operand,
// mergeCollection's GUARD 1, and (K2) GUARD 3. See the block comments at each site.
function _uaRaw(x){ return (x && (Number(x.updatedAt) || Number(x.createdAt) || 0)) || 0; }
// K2 (2026-09-11): _ca's unclamped twin, for GUARD 3's local-absent branch. Exists so
// both arms of that one test read raw; see the polarity comment at GUARD 3.
function _caRaw(x){ return (x && Number(x.createdAt)) || 0; }
// F1 (2026-08-18): clamp a RAW scalar timestamp for ARBITRATION only.
// Use this ONLY where 0 means "loses the tiebreak". There are four sites where 0
// means "destroy data" instead -- mergeChecklist's survivor-vs-deletion test, the
// cleanDevices/mergeDevices isJunk+score pair, the tombstone overlay, and the
// one-sided char guard. Those must NOT share this helper, and must keep reading raw
// values. See the plan's Scope OUT section before adding a caller.
function _clampFuture(v){ v = Number(v) || 0; return v > _futureCeil() ? 0 : v; }
// Per-ROUND skew diagnostics for the four INVERTED-POLARITY sites (2026-08-18).
// Those sites are deliberately left unclamped -- 0 there destroys data rather than
// losing a tiebreak -- so this adds observability and NOTHING else. No merge result
// changes. Aggregated per round on purpose: three of the four sit inside per-record
// loops, and _qDiagPush (app.js:9) is a 50-entry ring with blind FIFO eviction, so
// per-record pushes would evict the uncaught-error records the buffer exists for plus
// evtWatermarkRepaired, which is _qDiagPush-only. One entry per site per round.
// _skewDiag is null outside a merge() round, so a direct mergeCollection/mergeChecklist
// call (as the unit tests make) accumulates nothing and cannot grow unbounded.
var _skewDiag = null;
// J1 finding 4 (2026-08-19): the tolerance boundary is captured ONCE PER ROUND here,
// as a pure read of Date.now(). _skewDiagNote() used to call _hlcNow(), which is
// bound to app.js's now() and is NOT a pure read -- it does
// lastIssued = Math.max(p, lastIssued+1) and persists S.__hlcLast -- so every noted
// record advanced the HLC and wrote it. Stamped in _skewDiagReset(), never at module
// load: a long-lived tab would otherwise compare against a stale boundary forever.
// NOT a literal no-op: Date.now() + MAX_FUTURE_SKEW_MS is not the same number as the
// ratcheting _hlcNow() one, so which records get noted shifts slightly. That is
// diagnostic-only and accepted -- no merge result depends on it.
// SCOPE (superseded by K2, 2026-09-11): this used to read "_hlcNow()'s other three call
// sites (_ua, _ca, _clampFuture) are the inverted-polarity clamp operands and MUST NOT
// be touched -- a 0 there destroys data." The conclusion was right for the
// inverted-polarity sites and wrong about which helpers they use: they call
// _uaRaw/_caRaw or read raw values, so they never reach _ua/_ca/_clampFuture. Those
// three now share this same physical ceiling (see _futureCeil above), _hlcNow is gone,
// and no path from a merge can advance the HLC any more.
var _skewDiagThreshold = 0;
// J1 finding 3 (2026-08-19): cross-round throttle, mirroring _evtPullLastThrottleDiag.
// There was none. merge() runs once per round and again on a conflict retry,
// SYNC_DEBOUNCE_MS is 5000, and _qDiagPush is a 50-entry ring with blind FIFO
// eviction -- so a peer more than 120 s fast (far likelier since todo 17 tightened the
// ratchet tolerance from 1 h to 2 min) flushed 4-8 entries per round and evicted every
// uncaught-error and evtWatermarkRepaired record in roughly 7-13 rounds, well under
// two minutes of use. Keyed PER KIND deliberately: a single global key would let a
// skewDeviceMerge burst silently suppress a skewCharGuard note.
var SKEW_DIAG_MIN_INTERVAL_MS = 60000; // matches EVT_PULL_MIN_INTERVAL_MS
var _skewDiagLastPush = {};
// K2: _clampCeil rides along with _skewDiagThreshold -- deliberately the SAME number,
// so the clamp and the diagnostic that reports on it can never disagree about what
// "future" means within one round. Constant for the whole round, so it cannot creep
// with state size the way the old _hlcNow() ceiling did.
function _skewDiagReset(){ _skewDiag = {}; _skewDiagThreshold = Date.now() + MAX_FUTURE_SKEW_MS; _clampCeil = _skewDiagThreshold; }
function _skewDiagNote(kind, ts, id){
  if(!_skewDiag) return;
  var t = Number(ts) || 0;
  // Same tolerance _ua uses, WITHOUT clamping the value and WITHOUT touching the HLC.
  if(t <= _skewDiagThreshold) return;
  var e = _skewDiag[kind] || (_skewDiag[kind] = { n: 0, maxTs: 0, worstId: null });
  e.n++;
  if(t > e.maxTs){ e.maxTs = t; e.worstId = (id == null) ? null : String(id); }
}
function _skewDiagFlush(){
  if(!_skewDiag) return;
  var d = _skewDiag; _skewDiag = null;
  _clampCeil = 0; // K2: end of round -- any later out-of-round clamp re-reads the clock
  var nowMs = Date.now(); // pure read; see finding 4 above
  Object.keys(d).forEach(function(k){
    var e = d[k];
    if(e.n > 0 && typeof _qDiagPush === "function"){
      if(nowMs - (_skewDiagLastPush[k] || 0) < SKEW_DIAG_MIN_INTERVAL_MS) return; // finding 3
      _skewDiagLastPush[k] = nowMs;
      _qDiagPush(k, { n: e.n, maxTs: e.maxTs, worstId: e.worstId });
    }
  });
}
// remoteDeviceId is an OPTIONAL trailing parameter (added 2026-08-18). It defaults to
// undefined, and every consumer treats a missing id as "no remote id available" and
// degrades to the pre-existing behaviour, so the older 3-, 4-, 5- and 6-argument call
// sites in tests/ and archive/tests/ keep working unchanged. It must never reach the
// user as a printed value.
function mergeCollection(baseArr, localArr, remoteArr, remoteSavedAt, localSavedAt, tombstoneMap, remoteDeviceId){
  // Resolved ONCE per call, never per record: syncDeviceId() reads localStorage and
  // lazily PERSISTS a new id when none exists, so calling it inside the per-task loop
  // below would mean one localStorage read per task.
  const _localDev = (typeof syncDeviceId === "function") ? syncDeviceId() : null;
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
      // K2 (2026-09-11) -- INVERTED POLARITY, and it was never classified as one.
      // These operands used to run through _ua/_ca. Both arms compare ONE clamped
      // value against an UNCLAMPED scalar (localSavedAt), and the operand is `b` --
      // the agreed ANCESTOR, not a competitor trying to win a tiebreak. So a clamped
      // 0 does not "lose": it makes staleLocal FALSE, this guard FAILS OPEN, and the
      // stale local revert is kept AND uploaded -- exactly the amplifier loss the
      // guard exists to stop. The question here is factual ("could local have known
      // about base's current state?"), so a future-skewed base must be compared as it
      // is. Both arms read RAW. This was already live on any peer whose HLC had not
      // ratcheted to the skewed value; K2's physical ceiling would have made it fire
      // on the skewed device too. Same reasoning as GUARD 1 above. Test: K2-D.
      if(b && localSavedAt != null){
        const staleLocal = localHad ? (_uaRaw(b) >= Number(localSavedAt)) : (_caRaw(b) >= Number(localSavedAt));
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
        // K1 (2026-09-11) -- INVERTED POLARITY, site 5 of 6. This branch fires ONLY
        // when local did NOT change vs base, so `r` holds the one and only real edit
        // and `l` is just a copy of the agreed ancestor. Clamping r.updatedAt to 0
        // here makes the guard true, keeps the stale local copy AND pushes it back
        // over the remote edit -- the edit is discarded, not merely out-tiebroken.
        // This is the exact reasoning the char one-sided guard already carries at
        // "Site 4 of 4" below; that site was left raw and this one was not. Both
        // operands must stay RAW. Skew protection here needs a different rule.
        _skewDiagNote('skewGuard1', r && r.updatedAt, id);
        // GUARD 2 (K5, 2026-09-11) -- the cross-TZ daily echo; see _isCronEchoReset.
        // GUARD 1 below only rescues local when _uaRaw(l) > _uaRaw(r), and the echo
        // carries the SAME updatedAt on both sides, so it slipped straight through.
        // Keep `l` WHOLESALE, with no F4 checklist splice: normalizeDailyResets clears
        // the ENTIRE checklist whenever it resets, so the remote side is all-false by
        // construction and holds no real subtask edit to preserve. Splicing it in here
        // would re-clear the very ticks this guard exists to save.
        if(localHad && _isCronEchoReset(l, r)){ resultMap.set(id, l); return; }
        if(localHad && _uaRaw(l) > _uaRaw(r)){
          let w = l;
          if(Array.isArray(l && l.checklist) || Array.isArray(r && r.checklist)){
            // still merge subtasks so a remote toggle is not lost (F4 parity)
            // 2026-09-18 (round 2): pass NO base. This branch requires !localChanged,
            // so `l` is deep-equal to `b` by construction -- handing `b` in makes
            // mergeChecklist read every remote/local subtask difference as "remote
            // changed, local didn't" and adopt the remote value one-sidedly, without
            // ever consulting touchedAt. GUARD 1 has just declared this base
            // unreliable; using it as the per-subtask authority let a demonstrably
            // OLDER remote revert a tick, which is what the guard exists to prevent.
            // With base absent, both-present items fall to the touchedAt comparison
            // (newer edit wins) and no id can be inferred as a deletion.
            w = Object.assign({}, l, { checklist: mergeChecklist(null, (l&&l.checklist)||[], (r&&r.checklist)||[], true) });
          }
          resultMap.set(id, w);
        } else {
          resultMap.set(id, r);
        }
      } else {
        // Remote no longer has it (deletion) while local is unchanged vs base.
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
      winner = resolveDailyConflict(l, r, _localDev, remoteDeviceId);
    } else {
      const lu = (l && l.updatedAt) || 0;
      const ru = (r && r.updatedAt) || 0;
      // F1 (2026-08-18): clamp so a fast clock cannot win. Both sides are gated as
      // changed-since-base above, so each carries a real competing value and 0 only loses.
      const luc = _clampFuture(lu), ruc = _clampFuture(ru);
      // Deterministic tie-break on the lexically greater deviceId, so both devices
      // compute the SAME winner. The old unconditional "remote wins the tie" is
      // non-convergent: A would adopt B's copy while B adopts A's, forever.
      if(luc === ruc && remoteDeviceId != null){
        const _ld = _localDev;
        if(_ld != null && _ld !== remoteDeviceId){ winner = (remoteDeviceId > _ld) ? r : l; }
        else { winner = luc > ruc ? l : r; }
      } else {
        winner = luc > ruc ? l : r;
      }
    }
    // 2026-09-18 (round 2): capture the winner's identity ONCE, before the two
    // Object.assign rebuilds below. Both the checklist splice and _accumCounters
    // return a fresh object, so a later `winner === l` test is false for every task
    // that carries a checklist or habit counters -- i.e. every todo, every daily and
    // every habit. The conflictResolved event therefore always reported "remote won"
    // and swapped winnerDev/loserDev. tests/conflict-attribution.test.js T5 missed it
    // because its fixture is a checklist-less todo, so identity happened to survive.
    const _winIsLocal = (winner === l);
    // F4 (2026-07-11): the whole-object winner above still discards the
    // OTHER side's checklist wholesale. Splice in a per-subtask merge
    // whenever either side carries a checklist array (todos and dailies;
    // habits carry an always-empty one; rewards/tags/an.views/an.metrics have
    // no checklist field at all, so Array.isArray guards them out here --
    // this is intentionally NOT gated on task `type`).
    //
    // K5 (2026-09-18, round 2): GUARD 2's cron-echo rule has to hold HERE too.
    // _isCronEchoReset is only consulted in the one-sided branch above, but the
    // moment the user ALSO edits the task locally (toggleSub and every other edit
    // bumps updatedAt) control lands in this both-changed branch instead. The splice
    // then reads every subtask the echo flipped as "remote changed, local didn't"
    // and takes the remote's false -- re-clearing the very ticks GUARD 2 exists to
    // save. normalizeDailyResets clears the ENTIRE checklist when it resets, so the
    // echo side holds no real subtask edit to preserve: keep the completed side's
    // list wholesale, exactly as GUARD 2 does.
    let _echoKeep = null;
    if(_isCronEchoReset(l, r)) _echoKeep = l;
    else if(_isCronEchoReset(r, l)) _echoKeep = r;
    if(Array.isArray(l && l.checklist) || Array.isArray(r && r.checklist)){
      winner = Object.assign({}, winner, {
        checklist: _echoKeep
          ? ((_echoKeep.checklist || []).map(c => Object.assign({}, c)))
          : mergeChecklist(b && b.checklist, (l && l.checklist) || [], (r && r.checklist) || [], _winIsLocal)
      });
    }
    // K3 (2026-09-11): same shape as the F4 splice above -- the whole-object winner also
    // discarded the OTHER side's habit taps. cUp/cDown are additive quantities, not
    // properties of the winning snapshot. MUST run AFTER the checklist splice, which
    // tests `winner === l` by identity. See _accumCounters for the reset handling.
    // 2026-09-18: the device ids feed the absorbed-watermark guard that stops a
    // 409 conflict retry re-adding the peer's taps (see _accumCounters).
    winner = _accumCounters(b, l, r, winner, _localDev, remoteDeviceId);
    // T4: throttle conflictResolved to one per (kind, entityId) per round
    const _conflictKey = 'task:' + id;
    if(typeof logEvent === "function" && !_conflictLogThrottle.has(_conflictKey)){
      _conflictLogThrottle.add(_conflictKey);
      // F5 (2026-08-18): winner/loser are RELATIVE words, so the same event reads as a
      // different device on each side -- wrongly on one of them. Emit ABSOLUTE device ids
      // too. LONG-FORM only: do NOT add these to app.js's _EXPORT_FIELD_MAP, or a
      // new-build backup becomes unimportable by an old build (hash refusal).
      // tools/join_exports.py already documents and maps these three names.
      // Legacy winner/loser stay so older readers keep rendering.
      const _cLd = _localDev;
      const _cRd = (remoteDeviceId != null) ? remoteDeviceId : null;
      logEvent({kind:'conflictResolved', taskType:(winner&&winner.type)||'task', taskId:id, taskTitle:(winner&&winner.title)||'', winner:_winIsLocal?'local':'remote', loser:_winIsLocal?'remote':'local', winnerDev:_winIsLocal?_cLd:_cRd, loserDev:_winIsLocal?_cRd:_cLd, reason:'updatedAt recency'});
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
      // Site 3 of 4 -- DIAGNOSTIC ONLY, never clamp `ts`. Clamping it to 0 makes the
      // test 0 >= <positive> false, the delete never fires, and the deleted task
      // survives every future merge.
      // K1 (2026-09-11) -- the ENTITY operand is inverted-polarity too (site 6 of 6),
      // and it used to read _ua(v). A task re-created or edited AFTER the delete, on a
      // device more than MAX_FUTURE_SKEW_MS fast, clamps to 0 on every SLOWER device;
      // `ts >= 0` is then always true, so the slower device deletes a live task and
      // uploads the deletion, while the fast device keeps it -- a permanent ping-pong
      // that loses the task on one side. Raw on BOTH operands: whoever acted last wins,
      // which is exactly what the "resurrects" rule above promises.
      _skewDiagNote('skewTombstoneOverlay', ts, id);
      if(ts != null && Number(ts) >= _uaRaw(v)) resultMap.delete(id);
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
    // Site 2 of 4 -- DIAGNOSTIC ONLY, never clamp. A blank name with updatedAt > 0 is a
    // DELIBERATE clear meant to win on recency; clamping it to 0 makes it
    // indistinguishable from a never-touched placeholder (score -1), so it loses to the
    // stale old name and a name the user deleted reappears.
    // J1 finding 7 (2026-08-19): this note MUST sit BEFORE the !prev early return.
    // It used to sit after it, so it only ever observed duplicate-id entries and a
    // skewed device with a unique id was never reported here at all. cleanDevices() is
    // now the SINGLE observer of device skew -- mergeDevices' two per-side notes were
    // removed, because they fired once for `l` and once for `r` on the same id and
    // double-counted one device as two. Since mergeDevices ends in cleanDevices(out)
    // and `out` carries exactly one entry per id, n is now a true DEVICE COUNT.
    _skewDiagNote('skewDeviceMerge', d && d.updatedAt, d && d.id);
    const prev = byId.get(d.id);
    if(!prev){ byId.set(d.id, d); return; }
    const nameOf = x => x && typeof x.name === "string" ? x.name.trim() : "";
    const isJunk = x => !nameOf(x) && ((x.updatedAt) || 0) === 0;
    const score = x => isJunk(x) ? -1 : ((x.updatedAt) || 0) + (nameOf(x) ? 0.5 : 0);
    if(score(d) > score(prev)) byId.set(d.id, d);
  });
  return [...byId.values()];
}

function mergeDevices(baseArr, localArr, remoteArr, localDeviceId, remoteDeviceId){
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
    // Site 2 of 4 (second location) -- DIAGNOSTIC ONLY, never clamp. Same polarity
    // trap as cleanDevices above; the arbitration below is deliberately untouched.
    // J1 finding 7 (2026-08-19): the two per-side _skewDiagNote calls that used to sit
    // here were REMOVED. They noted `l` and `r` separately for the same device id, so
    // one skewed device present on both sides counted as two, and then
    // cleanDevices(out) re-noted every survivor on top. cleanDevices() is now the
    // single observer -- see the comment there. Residual, stated rather than implied: a
    // skewed entry that LOSES arbitration is no longer noted, because `out` holds only
    // winners. That is the price of making n a true device count, and the merged state
    // in that case is clean anyway.
    let winner;
    if(sl > sr) winner = l;
    else if(sr > sl) winner = r;
    else {
      // Exact tie (equal score). Use a deterministic deviceId tiebreak so the
      // merge converges symmetrically instead of ping-ponging: the higher
      // deviceId (the merging device vs the remote device that wrote this
      // entry) wins. Falls back to local if the remote device id is unknown.
      const _ld = (localDeviceId != null) ? localDeviceId : syncDeviceId();
      const _rd = (remoteDeviceId != null) ? remoteDeviceId
        : (((remoteArr||[]).map(function(d){return d && d.id;})
             .filter(function(id){return id && id !== _ld;}))[0]) || null;
      if(_rd != null && _ld !== _rd) winner = (_rd > _ld) ? r : l;
      else winner = l;
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

// ---- K3 (2026-09-11) earnings accumulate helpers ---------------------------
// P10c / docs row 4.28: char was one indivisible LWW record, so when two devices both
// earned offline ONE snapshot won and the other device's xp/gold/mp was thrown away.
// The tasks all merged correctly (mergeCollection unions by id), so the user saw five
// completed tasks and the earnings of two. Design, costed alternatives and the reasons
// the event-log replay was REJECTED: .omo/plans/K3-earnings-design.md
//
// The level curve lives in app.js (xpToLevel). sync.js loads after app.js and reads its
// globals, so prefer the live function; the literal fallback exists only for the vm
// sandbox the tests build. tests/earnings-accumulate.test.js K3-H asserts the two agree,
// so a curve change in app.js cannot drift away from this copy unnoticed.
function _xpNeed(lvl){
  if(typeof xpToLevel === "function") return xpToLevel(lvl);
  return Math.round(0.25 * lvl * lvl + 10 * lvl + 139.75);
}
const _XP_LVL_CAP = 9999; // loop bound only; the curve is quadratic so this is unreachable
function _num(v){ return Number(v) || 0; }
// char.xp is NOT lifetime xp: gainXp (app.js) subtracts xpToLevel(lvl) on every
// level-up, so .xp is the residual INSIDE the current level. Summing two residuals adds
// numbers on two different scales, so the accumulating quantity is the TOTAL and
// (lvl, xp) is re-derived from it afterwards.
function _charTotalXp(c){
  const lvl = Math.max(1, Math.floor(_num(c && c.lvl) || 1));
  let tot = Math.max(0, _num(c && c.xp));
  for(let k = 1; k < lvl && k <= _XP_LVL_CAP; k++) tot += _xpNeed(k);
  return tot;
}
// Exact inverse of _charTotalXp, using gainXp's own `>=` boundary.
function _charFromTotalXp(total){
  let rem = Math.max(0, _num(total)), lvl = 1, need = _xpNeed(1);
  while(rem >= need && lvl <= _XP_LVL_CAP){ rem -= need; lvl++; need = _xpNeed(lvl); }
  return { lvl: lvl, xp: rem };
}
// gainXp's invariant is xp < xpToLevel(lvl). A Habitica-imported character can carry a
// TOTAL in .xp instead, and re-levelling one of those would rewrite a character nobody
// edited. A single non-canonical side disqualifies the whole reconcile -> today's LWW.
function _charCanonical(c){
  if(!c || typeof c !== "object") return false;
  return Math.max(0, _num(c.xp)) < _xpNeed(Math.max(1, Math.floor(_num(c.lvl) || 1)));
}
function _charTotals(c){
  return { xp: _charTotalXp(c), gold: Math.max(0, _num(c && c.gold)), mp: Math.max(0, _num(c && c.mp)) };
}
// char.abs[deviceId] = {ua, xp, gold, mp}: the totals of THAT device's snapshot which
// are already folded into this char. It exists because _pushWithConflictRetry re-merges
// with the ALREADY-MERGED state as `local` while `base` is still the pre-round base --
// syncBasePut only runs after a successful upload (sync.js:1475) -- so a plain
// base-delta reconcile double-counts the remote contribution on every conflict retry.
// LONG-FORM only: do NOT add `abs` to app.js's _EXPORT_FIELD_MAP, or a new-build backup
// becomes unimportable by an older build (hash refusal). join_exports.py maps it.
function _absEntry(c, dev){
  const a = c && c.abs;
  if(!a || typeof a !== "object" || dev == null) return null;
  const e = a[dev];
  if(!e || typeof e !== "object") return null;
  return { ua: _num(e.ua), xp: Math.max(0, _num(e.xp)), gold: Math.max(0, _num(e.gold)), mp: Math.max(0, _num(e.mp)) };
}
// Strict total order on an abs entry, so carrying third-party entries over is
// order-independent: merge(b,L,R) and merge(b,R,L) build the same map.
function _absBetter(e, cur){
  if(!cur) return true;
  const a = [e.ua, e.xp, e.gold, e.mp], c = [cur.ua, cur.xp, cur.gold, cur.mp];
  for(let i = 0; i < 4; i++){ if(a[i] !== c[i]) return a[i] > c[i]; }
  return false;
}
// NEW INVERTED-POLARITY SITE (K3, 2026-09-11). Deliberately NOT numbered: the file
// already carries two incompatible numbering schemes ("site 4 of 4" for the clamp-helper
// sites, "site 6 of 6" after K1), so a third count would just add noise.
// Read the _uaRaw block comment above
// before touching this. Every operand below is an absorbed WATERMARK -- a factual
// record of "have I already folded this contribution in?", not a competitor in a
// tiebreak. Clamping any of them (_ua/_clampFuture on a stamp, or a fallback to the
// base on a value) leaves the baseline at the shared base; on the conflict-retry path
// base does NOT yet contain the absorbed remote contribution, so the same delta is
// counted a SECOND time and the user's earnings DOUBLE. Everything here stays RAW.
//
// F1 (2026-09-19). The previous rule -- return the peer's `abs` entry for a side when
// it is newer than the base's -- was right for two devices and wrong for three.
// `abs[k]` is keyed by the device whose DOCUMENT was folded in, and it stores that
// document's WHOLE totals (see the two writes at the end of _charAccumulate), so it
// already carries every peer that document had merged. Reading one entry as "what
// device k contributed" under-states the shared part, and the excess is added again
// on every retry: base 160 total xp, A+50 / B+30 / C+40 with A's upload failing, then
// B+20, retried to 340 where the truth is 300 (gold 38 where the truth is 34).
//
// What both sides must be measured from is the LARGEST aggregate BOTH sides have
// already folded in. For every device k recorded on both sides, min(L_k, R_k) is a
// k-authored document both descend from; the best of those -- floored at the shared
// base, which is common by definition -- is that quantity. A side reads its OWN key
// from its own current totals, because a document always contains every earlier value
// of itself; that is what lets a device recognise its own contribution inside a peer's
// document even when it has never merged. xp/gold/mp are independent accumulators and
// are reduced independently.
//
// This is a strict generalisation, not a reinterpretation: with two devices at most
// one of the two old per-side baselines is ever raised above the base, and
// `c + (l - c) + (r - c)` with c = that baseline is arithmetically identical to the
// old `base + (l - lBase) + (r - rBase)`. Nothing STORED changes shape or meaning, so
// entries written by an older build read correctly here and vice versa.
function _accCommon(bT, l, r, localDeviceId, remoteDeviceId){
  const out = { xp: bT.xp, gold: bT.gold, mp: bT.mp };
  if(localDeviceId == null || remoteDeviceId == null || localDeviceId === remoteDeviceId) return out;
  const lT = _charTotals(l), rT = _charTotals(r);
  // A side's own key: its live totals, raised by any recorded entry for itself.
  function sideEntry(doc, selfDev, ownTotals, k){
    const e = _absEntry(doc, k);
    if(k !== selfDev) return e;
    if(!e) return ownTotals;
    return { xp: Math.max(e.xp, ownTotals.xp), gold: Math.max(e.gold, ownTotals.gold), mp: Math.max(e.mp, ownTotals.mp) };
  }
  const seen = {};
  [l, r].forEach(function(d){
    const a = d && d.abs;
    if(a && typeof a === "object") Object.keys(a).forEach(function(k){ seen[k] = 1; });
  });
  seen[localDeviceId] = 1; seen[remoteDeviceId] = 1;
  Object.keys(seen).forEach(function(k){
    const le = sideEntry(l, localDeviceId, lT, k), re = sideEntry(r, remoteDeviceId, rT, k);
    if(!le || !re) return;   // only a device BOTH sides record can be a common ancestor
    out.xp   = Math.max(out.xp,   Math.min(le.xp, re.xp));
    out.gold = Math.max(out.gold, Math.min(le.gold, re.gold));
    out.mp   = Math.max(out.mp,   Math.min(le.mp, re.mp));
  });
  return out;
}
// Returns the accumulating fields to overlay on the arbitration winner, or null for
// "not applicable" -- in which case the caller keeps exact pre-K3 LWW behaviour.
function _charAccumulate(b, l, r, localDeviceId, remoteDeviceId){
  // Precondition 1 -- a real common ancestor. With an empty base EVERY field reads as
  // "changed", so both whole totals would be added onto 0 and the character DOUBLES.
  // IDB loss with localStorage intact (docs/SYNC-MULTI-DEVICE-CASES.md 1.3) and the #5
  // poisoned-base self-check both produce exactly that. No base -> no reconcile.
  if(!b || typeof b !== "object" || !Object.keys(b).length) return null;
  // Precondition 2 -- canonical level form on all three sides (see _charCanonical).
  if(!_charCanonical(b) || !_charCanonical(l) || !_charCanonical(r)) return null;
  // Precondition 3 -- two distinct device ids. The absorbed record is keyed by device,
  // so without both ids a retry cannot tell its own contribution from the peer's.
  if(localDeviceId == null || remoteDeviceId == null || localDeviceId === remoteDeviceId) return null;

  const bT = _charTotals(b), lT = _charTotals(l), rT = _charTotals(r);
  // Both deltas are measured from the largest aggregate BOTH sides have already
  // folded in -- the agreed base when no absorbed record beats it. See _accCommon.
  const cB = _accCommon(bT, l, r, localDeviceId, remoteDeviceId);
  const dXp   = (lT.xp - cB.xp)     + (rT.xp - cB.xp);
  const dGold = (lT.gold - cB.gold) + (rT.gold - cB.gold);
  const dMp   = (lT.mp - cB.mp)     + (rT.mp - cB.mp);
  if(dXp === 0 && dGold === 0 && dMp === 0) return null; // no numeric conflict -> leave LWW alone
  // The shared part is carried ONCE, and it is the common aggregate, not the base:
  // cB + (lT - cB) + (rT - cB). Using bT here is what re-added the peer's earnings
  // on a retry once cB had moved past the stale base.
  let totXp = Math.max(0, cB.xp + dXp);
  let gold  = Math.max(0, cB.gold + dGold);
  let mp    = Math.max(0, cB.mp + dMp);
  // Safety floor, EARNINGS-ONLY. mp has no consumer anywhere in app.js and xp only
  // falls on death(), so when NEITHER side lost ground the merged total cannot
  // legitimately sit below either side -- a floor there means an arithmetic slip in an
  // exotic 3-device ordering loses nothing. gold is a SPENDABLE balance (rewards,
  // potions, death's *0.75) and must be free to fall, so it never gets a floor; and a
  // side that DID lose ground must keep that loss, so the floor is skipped entirely.
  const lostGround = (lT.xp < cB.xp) || (rT.xp < cB.xp) || (lT.mp < cB.mp) || (rT.mp < cB.mp);
  if(!lostGround){ totXp = Math.max(totXp, lT.xp, rT.xp); mp = Math.max(mp, lT.mp, rT.mp); }
  const relv = _charFromTotalXp(totXp);
  // Record what this result absorbed. Each participant is authoritative about itself,
  // so its own snapshot totals are written verbatim; entries for any THIRD device are
  // carried over by _absBetter so both devices compute an identical map.
  const abs = {};
  [b, l, r].forEach(src => {
    const a = src && src.abs;
    if(!a || typeof a !== "object") return;
    Object.keys(a).forEach(k => {
      const e = _absEntry(src, k);
      if(e && _absBetter(e, abs[k])) abs[k] = e;
    });
  });
  abs[localDeviceId]  = { ua: _uaRaw(l), xp: lT.xp, gold: lT.gold, mp: lT.mp };
  abs[remoteDeviceId] = { ua: _uaRaw(r), xp: rT.xp, gold: rT.gold, mp: rT.mp };
  return { lvl: relv.lvl, xp: relv.xp, gold: +gold.toFixed(2), mp: mp, abs: abs };
}
function _charOver(winner, acc){ return acc ? Object.assign({}, winner, acc) : winner; }
// K3 (2026-09-11) habit period counters (prompt K3b). cUp/cDown live inside the task
// object and had no special handling, so mergeCollection's whole-object winner
// discarded one device's taps. They are NOT monotone: runCron zeroes them on the
// resetFreq boundary (app.js:2243) and deliberately does not bump updatedAt, so a plain
// base-delta goes NEGATIVE across a reset (base 10, both reset, A taps 6 / B taps 3 ->
// 10-4-7 = -1). effBase collapses to 0 when BOTH sides sit below base, which is the
// only shape a reset-on-both-devices can produce.
// 2026-09-18: did THIS side's cron zero the tallies since the base snapshot?
// app.js runCron stamps t.cResetOn with the local day stamp whenever it resets a
// habit's cUp/cDown. Comparing a side's stamp against the base's is robust to
// clock skew between devices, because each side is only ever compared with the
// shared ancestor.
function _counterDidReset(side, base){
  return (Number(side && side.cResetOn) || 0) > (Number(base && base.cResetOn) || 0);
}
// ---- 2026-09-18: conflict-retry protection for the counters -----------------
// _syncNowAttempt applies the merge to S BEFORE the upload, so on a 409 the retry
// in _pushWithConflictRetry re-reads syncSubset() -- i.e. a local that has ALREADY
// absorbed the peer's taps -- while re-using the same pristine base. Every
// accumulating rule therefore counts the peer's contribution again: cUp 5+3 came
// back as 8, then 11, then 14 across the retry limit, and a plain upload failure
// left the same stale-base/advanced-local shape for the NEXT ordinary round.
//
// char solved this with an absorbed watermark (see _absEntry/_accCommon above).
// This is the same mechanism for cUp/cDown: t.cAbs[deviceId] records the counter
// values of THAT device's document which are already folded into this task.
//
// INVERTED POLARITY, same as _accCommon: every operand is an absorbed WATERMARK, a
// factual record of "have I already folded this in?", not a competitor in a
// tiebreak. Clamping one (_ua/_clampFuture on a stamp, or falling back to the base
// on a value) makes the delta count a SECOND time. All of it stays RAW (_uaRaw).
function _cAbsEntry(t, dev){
  const a = t && t.cAbs;
  if(!a || typeof a !== "object" || dev == null) return null;
  const e = a[dev];
  if(!e || typeof e !== "object") return null;
  return { ua: _num(e.ua), cUp: Math.max(0, _num(e.cUp)), cDown: Math.max(0, _num(e.cDown)) };
}
// Strict total order, so carrying third-party entries over is order-independent:
// merge(b,L,R) and merge(b,R,L) build the same map.
function _cAbsBetter(e, cur){
  if(!cur) return true;
  const a = [e.ua, e.cUp, e.cDown], c = [cur.ua, cur.cUp, cur.cDown];
  for(let i = 0; i < 3; i++){ if(a[i] !== c[i]) return a[i] > c[i]; }
  return false;
}
// F1 (2026-09-19), the counter twin of _accCommon -- read that block comment first.
// `cAbs[k]` stores device k's whole DOCUMENT value, which carries every peer k had
// already merged, so reading one entry as "what device k contributed" is only true
// with two devices. Measured on the real merge: base cUp 0, B+3, C+4, A+5 with A's
// upload failing, then B+2 -- A retried to 18 where the truth is 14, and stayed at 18
// on every further retry. The common baseline is the largest aggregate BOTH sides have
// already folded in: max over devices recorded on both sides of min(L_k, R_k), floored
// at the shared base. A side reads its own key from its own live value.
function _cntCommon(bv, l, r, localDeviceId, remoteDeviceId, key){
  let c = Math.max(0, _num(bv));
  if(localDeviceId == null || remoteDeviceId == null || localDeviceId === remoteDeviceId) return c;
  function sideVal(doc, selfDev, k){
    const e = _cAbsEntry(doc, k);
    if(k !== selfDev) return e ? e[key] : null;
    return Math.max(e ? e[key] : 0, Math.max(0, _num(doc && doc[key])));
  }
  const seen = {};
  [l, r].forEach(function(d){
    const a = d && d.cAbs;
    if(a && typeof a === "object") Object.keys(a).forEach(function(k){ seen[k] = 1; });
  });
  seen[localDeviceId] = 1; seen[remoteDeviceId] = 1;
  Object.keys(seen).forEach(function(k){
    const lv = sideVal(l, localDeviceId, k), rv = sideVal(r, remoteDeviceId, k);
    if(lv == null || rv == null) return;  // only a device BOTH sides record is common
    const m = Math.min(lv, rv);
    if(m > c) c = m;
  });
  return c;
}
// `lReset`/`rReset` are booleans, or NULL meaning "no reset markers available —
// use the legacy heuristic". See _accumCounters for when that applies.
// `lBaseIn`/`rBaseIn` are the baselines from _cntCommon; null means "no absorbed
// record applies, measure from the shared base". They are the SAME value on both
// sides since F1 -- the two parameters are kept so the 5-argument calls in
// tests/counter-reset-marker.test.js keep meaning exactly what they meant.
function _accumCounter(bv, lv, rv, lReset, rReset, lBaseIn, rBaseIn){
  const b = Math.max(0, _num(bv)), l = Math.max(0, _num(lv)), r = Math.max(0, _num(rv));
  // 2026-09-18 (round 2): the per-side absorbed baselines are computed BEFORE the
  // legacy branch now. They used to be derived below it, so the whole conflict-retry
  // watermark guard was inert for every record whose base carries no cResetOn --
  // which is every habit created since the last cron, and every weekly/monthly-reset
  // habit for up to a month. Measured on the real merge: base cUp 0, local 5,
  // remote 3 gave 8, then 11, then 14, then 17 across the retry limit. With the
  // marker present the same inputs stayed at 8.
  const lb = (lBaseIn == null) ? b : Math.max(0, _num(lBaseIn));
  const rb = (rBaseIn == null) ? b : Math.max(0, _num(rBaseIn));
  // F1 (2026-09-19): the shared part is carried ONCE, and it is the common absorbed
  // baseline -- not `b`. With no absorbed record lb === rb === b and this is the old
  // value byte for byte. On a retry, carrying `b` while subtracting a HIGHER baseline
  // from each side added the difference back: b + (l-lb) + (r-rb) counts the shared
  // part once at `b` and once more at every lb/rb that moved past it.
  const carry = Math.max(lb, rb);
  if(lReset == null || rReset == null){
    // Pre-2026-09-18 behaviour for records whose base carries no reset marker (data
    // written before this build, or before the first cron after upgrading): infer a
    // reset from "value below its own baseline" on BOTH sides. With no absorbed
    // record lb === rb === b, so this is byte-for-byte the old arithmetic; the
    // baselines only bite on a retry, where they are exactly what stops the
    // peer's contribution being counted twice.
    if(l < lb && r < rb) return Math.max(l + r, l, r);   // both restarted from 0
    return Math.max(carry + Math.max(0, l - lb) + Math.max(0, r - rb), l, r);
  }
  // A side that reset started its new period from 0, so its whole current value is
  // new taps; a side that did not reset has `base` already inside its value. The
  // shared base only carries forward when NEITHER side reset — once either has
  // crossed its boundary, the old period's total is no longer part of the count.
  //
  // The deltas are deliberately SIGNED. The old code clamped them with
  // Math.max(0, ...) and floored the result at Math.max(l, r), which meant a user
  // lowering a tally on the edit sheet could never propagate: base 10, local 8,
  // remote 10 came back as 10, and with both sides lowered it INFLATED (base 10,
  // local 8, remote 7 -> 15) because two ordinary decrements were misread as a
  // double cron reset. Only the final value is floored, at zero.
  const effL = lReset ? 0 : lb;
  const effR = rReset ? 0 : rb;
  return Math.max(0, ((lReset || rReset) ? 0 : carry) + (l - effL) + (r - effR));
}
function _accumCounters(b, l, r, winner, localDeviceId, remoteDeviceId){
  const has = k => (l && typeof l[k] === "number") || (r && typeof r[k] === "number");
  const hU = has("cUp"), hD = has("cDown");
  // Gated on FIELD PRESENCE, not on task `type` -- same precedent as F4's checklist
  // splice, so dailies/todos/rewards/tags/an.views are untouched.
  if(!hU && !hD) return winner;
  // Markers are only trustworthy once the BASE carries one. Without that anchor a
  // side's stamp would compare against 0 and every side would look like it had just
  // reset, so the very first merge after upgrading would sum both sides in full.
  const useMarkers = (Number(b && b.cResetOn) || 0) > 0;
  const lReset = useMarkers ? _counterDidReset(l, b) : null;
  const rReset = useMarkers ? _counterDidReset(r, b) : null;

  // The absorbed record needs two distinct device ids: it is keyed by device, so
  // without both a retry cannot tell its own contribution from the peer's. Same
  // precondition 3 as _charAccumulate. Without them this degrades to measuring both
  // sides from the shared base, i.e. exactly the pre-2026-09-18 behaviour.
  const idsOk = (localDeviceId != null && remoteDeviceId != null && localDeviceId !== remoteDeviceId);
  // F1 (2026-09-19): ONE baseline per field, not one per side -- the largest aggregate
  // both sides have already folded in. _cntCommon falls back to the shared base, so
  // without ids, without cAbs, or on a first merge this is the pre-F1 arithmetic.
  const cUpBase = idsOk ? _cntCommon(b && b.cUp,   l, r, localDeviceId, remoteDeviceId, 'cUp')   : null;
  const cDnBase = idsOk ? _cntCommon(b && b.cDown, l, r, localDeviceId, remoteDeviceId, 'cDown') : null;

  const patch = {};
  if(hU) patch.cUp = _accumCounter(b && b.cUp, l && l.cUp, r && r.cUp, lReset, rReset,
                                   cUpBase, cUpBase);
  if(hD) patch.cDown = _accumCounter(b && b.cDown, l && l.cDown, r && r.cDown, lReset, rReset,
                                     cDnBase, cDnBase);
  // Carry the newest reset stamp forward, or a merge whose winner happened to be the
  // side that had NOT reset would hand the next round a stale anchor.
  //
  // 2026-09-18 (round 2): drop a stamp that lies in THIS device's future before
  // taking the max -- the same rule mergedLastCron already applies to lastCron, and
  // for the same reason. cResetOn is a local day stamp merged with a plain max, so
  // one device with a wrong date pinned the shared marker at a day nobody can ever
  // exceed. _counterDidReset (side.cResetOn > base.cResetOn) was then false for every
  // subsequent genuine cron reset while useMarkers stayed true, so effL/effR kept
  // subtracting the stale pre-reset base and the result clamped to 0. Measured:
  // remote stamped 20270101, next real period local 3 + remote 2 came back as cUp 0.
  const _todayStamp = dayStampOf(Date.now());
  const _lRes = Number(l && l.cResetOn) || 0, _rRes = Number(r && r.cResetOn) || 0;
  const newest = Math.max(_lRes > _todayStamp ? 0 : _lRes, _rRes > _todayStamp ? 0 : _rRes);
  if(newest > 0) patch.cResetOn = newest;
  else if(Number(b && b.cResetOn) || 0) patch.cResetOn = Number(b.cResetOn) || 0;

  // Record what this result absorbed. Each participant is authoritative about
  // itself, so its own values are written verbatim; entries for any THIRD device are
  // carried over by _cAbsBetter so both devices compute an identical map.
  if(idsOk){
    const cAbs = {};
    [b, l, r].forEach(src => {
      const a = src && src.cAbs;
      if(!a || typeof a !== "object") return;
      Object.keys(a).forEach(k => {
        const e = _cAbsEntry(src, k);
        if(e && _cAbsBetter(e, cAbs[k])) cAbs[k] = e;
      });
    });
    cAbs[localDeviceId]  = { ua: _uaRaw(l), cUp: Math.max(0, _num(l && l.cUp)), cDown: Math.max(0, _num(l && l.cDown)) };
    cAbs[remoteDeviceId] = { ua: _uaRaw(r), cUp: Math.max(0, _num(r && r.cUp)), cDown: Math.max(0, _num(r && r.cDown)) };
    patch.cAbs = cAbs;
  }
  return Object.assign({}, winner, patch);
}

// Union-by-day merge for history-style arrays ({date:<ms>, ...numeric fields,
// ...array fields whose entries have an id}). Used for S.charHistory (and the
// always-empty top-level S.history, harmlessly).
function mergeDayArray(localArr, remoteArr){
  // K3 (2026-09-11): the bucket is the LOCAL day, matching dayStampOf everywhere else
  // in the app. It used to be Math.floor(ms/86400000) -- a UTC day -- so two devices on
  // either side of LOCAL midnight folded two distinct days into one bucket and lost
  // one. dayStampOf(0) is 0, the same key the old expression gave a missing date.
  const dayOf = ms => dayStampOf(ms || 0);
  const buckets = new Map(); // dayKey -> merged entry

  function fold(entry){
    // 2026-09-18 (round 2): a malformed row used to throw straight out of merge(),
    // into _syncNowAttempt's .catch, and every later round failed the same way with
    // no recovery from inside the app. syncApply already reasons about a
    // /state.json "hand-edited in the user's own Dropbox folder", and the tombstone
    // union one block down guards its entries; this did not.
    if(!entry || typeof entry !== "object") return;
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
  // ...and a non-array charHistory (a hand-edited or older /state.json) used to
  // throw "(remoteArr || []).forEach is not a function" out of the same path.
  (Array.isArray(localArr) ? localArr : []).forEach(fold);
  (Array.isArray(remoteArr) ? remoteArr : []).forEach(fold);
  return [...buckets.values()].sort((a, b) => (a.date || 0) - (b.date || 0));
}

// J1 finding 8 (2026-08-19): the flush now runs in a `finally`. If merge() threw
// between _skewDiagReset() and _skewDiagFlush(), _skewDiag stayed non-null -- and
// cleanDevices() is also reachable from syncSubset() and syncApply() OUTSIDE any merge
// round, so those calls then wrote into the orphaned object and were misattributed to a
// later round's flush. `finally`, never `catch`: the throw must still propagate
// untouched, because the caller's error handling must not change.
// The body lives in _mergeInner() rather than being wrapped in place purely to keep the
// diff reviewable -- indenting ~145 lines of arbitration code into a try block would
// bury the real change. merge() keeps its name, signature and registry entry.
function merge(base, local, remote, remoteSavedAt, localSavedAt, localDeviceId, remoteDeviceId){
  _skewDiagReset(); // one merge() call == one round; see _skewDiagNote
  try{
    return _mergeInner(base, local, remote, remoteSavedAt, localSavedAt, localDeviceId, remoteDeviceId);
  } finally {
    _skewDiagFlush(); // exactly one diagnostic entry per site per round, throw or not
  }
}
function _mergeInner(base, local, remote, remoteSavedAt, localSavedAt, localDeviceId, remoteDeviceId){
  base = base || {};
  local = local || {};
  remote = remote || {};
  const baseAn = base.an || {}, localAn = local.an || {}, remoteAn = remote.an || {};

  // K1 (2026-09-11): a plain max here was the single widest data-loss path in the
  // engine. lastCron feeds normalizeDailyResets, which force-unchecks every daily
  // whose dayStampOf(doneAt) is BELOW it AND clears that daily's whole checklist.
  // max() never decreases, so one device with a wrong date (say 2027) pinned the
  // shared lastCron in the future permanently: from then on EVERY daily and EVERY
  // subtask tick on EVERY device unchecked itself on EVERY sync round, and the
  // poisoned value came straight back on the next pull. The same shape, one day
  // wide instead of years, is the cross-timezone case: a peer that has already
  // crossed local midnight wiped this device's still-current completion.
  //
  // Rule: a remote cron day that lies in THIS device's future carries no authority
  // over this device's own day boundary. Fall back to the local value; do not clamp
  // to "today", because that could silently raise a local lastCron that is legitimately
  // behind and make startDay() skip a real cron run (runCron early-returns on
  // S.lastCron === today). A device with its own bad clock still poisons only itself,
  // which is the most any peer can fix from the outside.
  const mergedLastCron = (function(){
    const l = local.lastCron || 0, r = remote.lastCron || 0;
    const today = dayStampOf(Date.now()); // pure read; NOT _hlcNow() -- see _skewDiagNote J1 finding 4
    const rEff = (r > today) ? l : r;     // implausible/ahead remote day -> no authority
    return l >= rEff ? l : rEff;          // dayStamp() is a lexically-sortable integer (YYYYMMDD-ish) -> plain max
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
  // Tombstone GC: drop tombstones older than 180 days to bound deletions growth.
  // Accepted residual: a device offline >180d may resurrect a deleted entity.
  const TOMBSTONE_MAX_AGE_MS = 180 * 86400000;
  const _gcNow = Date.now();
  for(const [_id, _at] of mergedDeletions){
    if(_gcNow - Number(_at) > TOMBSTONE_MAX_AGE_MS) mergedDeletions.delete(_id);
  }
  const _tomb = mergedDeletions;

  const merged = {
    tasks: normalizeDailyResets(mergeCollection(base.tasks, local.tasks, remote.tasks, remoteSavedAt, localSavedAt, _tomb, remoteDeviceId), mergedLastCron), // F3 (2026-07-11): reset overlay keyed to merged lastCron
    rewards: mergeCollection(base.rewards, local.rewards, remote.rewards, remoteSavedAt, localSavedAt, _tomb, remoteDeviceId),
    tags: mergeCollection(base.tags, local.tags, remote.tags, remoteSavedAt, localSavedAt, _tomb, remoteDeviceId),
    devices: mergeDevices(base.devices, local.devices, remote.devices, localDeviceId, remoteDeviceId),
    an: {
      views: mergeCollection(baseAn.views, localAn.views, remoteAn.views, remoteSavedAt, localSavedAt, _tomb, remoteDeviceId),
      metrics: mergeCollection(baseAn.metrics, localAn.metrics, remoteAn.metrics, remoteSavedAt, localSavedAt, _tomb, remoteDeviceId)
    },
    pause: (function(){
      const baseP = base.pause || {}, localP = local.pause || {}, remoteP = remote.pause || {};
      const lAt = Number(localP.at) || 0, rAt = Number(remoteP.at) || 0;
      // F1 (2026-08-18): clamped copies for the WINNER choice only. Safe here because
      // the returned `at` below keeps Math.max(lAt, rAt) on the RAW values, so the field
      // is never deleted, and no consumer treats at === 0 as "never paused" -- they all
      // branch on the paused boolean or on pausedDays. Do not clamp the raw pair.
      const lAtc = _clampFuture(lAt), rAtc = _clampFuture(rAt);
      const src = (lAtc >= rAtc) ? localP : remoteP; // LWW by `at` (base ignored), tie -> local; same philosophy as mergedLastCron's plain-max
      const _union = [].concat(baseP.pausedDays || [], localP.pausedDays || [], remoteP.pausedDays || [])
        .filter(v => typeof v === "number" && isFinite(v));
      const pausedDays = Array.from(new Set(_union)).sort((a, b) => a - b).slice(-7);
      return { paused: !!src.paused, pausedDays: pausedDays, at: Math.max(lAt, rAt) };
    })(),
    history: mergeDayArray(local.history, remote.history), // DEAD WORK: S.history is never populated by app.js (per-task history lives at t.history). Kept for schema compat; syncApply writes it back to S.history.
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
      // F5 (2026-07-12) fresh-sync fix: a brand-new / just-"reset everything"
      // browser has an EMPTY sync base, so BOTH its default char and the real
      // remote char differ from base -> the both-changed branch below returned
      // local and clobbered the synced character back to level 1. (Tasks were
      // unaffected: they union by id via mergeCollection.) An UNTOUCHED default
      // character carries no real progress and must always yield to a real one.
      // K5 (2026-09-11) -- D14. This used to read: "death() keeps gold (>0) and elevated
      // maxHp (>50), so a died character is NOT 'untouched'." BOTH halves are false at
      // 2e346ac. maxHp has exactly two write sites, app.js:107 and app.js:1731, and both
      // write the literal 50 -- nothing raises it, so the maxHp conjunct below can never
      // be false. death() (app.js:1737-1742) never touches maxHp, and gold*0.75 of 0 is 0.
      // So a character that dies at lvl <= 2 holding no gold DOES read as untouched(),
      // and because untouched() is tested BEFORE the three-way merge its death is
      // discarded and the pre-death snapshot comes back. That is silent wrong behaviour
      // but NOT data loss -- the outcome restores progress rather than destroying it --
      // so it is tracked as MINOR, not fixed here. See
      // .omo/evidence/K5-sync-backlog/cycle-1-findings.md §1 (D14).
      // The maxHp conjunct is KEPT deliberately: it costs one term and becomes live again
      // the day maxHp is level-scaled (gainXp already owns the write site).
      const untouched = c => (Number(c.lvl)||0) <= 1 && (Number(c.xp)||0) <= 0
                          && (Number(c.gold)||0) <= 0 && (Number(c.maxHp)||50) <= 50;
      const lU = untouched(l), rU = untouched(r);
      if(lU && !rU) return r;   // local is fresh/reset; remote is a real character
      if(rU && !lU) return l;   // symmetric: protect real local from a stale default
      const localChanged = !deepEqual(l, b);
      const remoteChanged = !deepEqual(r, b);
      if(!localChanged && !remoteChanged) return b;
      if(localChanged && !remoteChanged) return l;
      if(!localChanged && remoteChanged){
        // Site 4 of 4 -- DIAGNOSTIC ONLY, never clamp. This branch fires ONLY when local
        // made no edit at all, so there is no competing value: r.updatedAt belongs to
        // remote's only real edit. Clamping it to 0 fails the guard, returns the untouched
        // local char, and silently discards remote's real XP/gold/level/maxHp. The current
        // unclamped behaviour here is CORRECT. Skew protection here needs a different rule.
        _skewDiagNote('skewCharGuard', r && r.updatedAt, (r && r.id) || 'char');
        // GUARD (recency): accept remote char only if it is not OLDER than local.
        return ((Number(r.updatedAt)||0) >= (Number(l.updatedAt)||0)) ? r : l;
      }
      // K3 (2026-09-11) -- P10c / docs row 4.28. The arbitration below is UNCHANGED and
      // still decides which snapshot CARRIES the non-accumulating fields (name, face,
      // cls, hp, maxHp, updatedAt); all four of its guards still hold. _charAccumulate
      // then folds the ACCUMULATING quantities (total xp -> lvl+xp, gold, mp) in on top
      // of that winner via _charOver, so the loser's earnings are no longer discarded.
      // It returns null -- i.e. exact pre-K3 behaviour -- whenever its preconditions do
      // not hold (no base, non-canonical levels, missing device ids, no numeric delta).
      const _acc = _charAccumulate(b, l, r, localDeviceId, remoteDeviceId);
      // F6 (2026-07-12): both sides are REAL characters edited since base — a
      // genuine conflict. char.updatedAt is reliably stamped per stat change
      // (app.js save() chokepoint via _charSig), so resolve by newest edit:
      // remote wins ONLY if strictly newer. On an exact updatedAt tie, use a
      // deterministic deviceId tiebreak (below) so two devices editing offline
      // with equal timestamps converge in ONE round instead of ping-ponging.
      // A future-skewed remote cannot win a tie (anti-skew bias preserved).
      // F1 (2026-08-18): clamped. This is the BOTH-changed branch, so each side carries a
      // real competing value and 0 only loses; an equal result falls through to the
      // deterministic deviceId tiebreak below. NOTE: the ONE-SIDED branch above
      // (!localChanged && remoteChanged) must stay UNCLAMPED -- there remote holds the
      // only real edit, so clamping it to 0 would discard remote's real XP/gold/level.
      // K4 (2026-09-11): clamp each side ONCE and reuse both results. _futureCeil() is
      // Date.now()-derived, so two separate _clampFuture calls on the same value can
      // disagree across a millisecond tick; the tiebreak gate below must compare exactly
      // the same pair this branch compared. No new clamp is introduced -- both operands
      // were already clamped here (F1, 2026-08-18); see the _uaRaw block comment above.
      const _lUa = _clampFuture(l.updatedAt), _rUa = _clampFuture(r.updatedAt);
      if(_rUa > _lUa){
        // T4: throttle conflictResolved to one per (kind, entityId) per round
        const _conflictKey1 = 'char:' + ((l&&l.id)||(r&&r.id));
        if(typeof logEvent === "function" && !_conflictLogThrottle.has(_conflictKey1)){
          _conflictLogThrottle.add(_conflictKey1);
          // F5: absolute device ids alongside the relative words. Computed inline rather
          // than hoisted, because syncDeviceId() persists a new id when none exists and
          // must stay inside the branch that actually emits.
          const _e1Ld = (localDeviceId != null) ? localDeviceId : ((typeof syncDeviceId === "function") ? syncDeviceId() : null);
          const _e1Rd = (remoteDeviceId != null) ? remoteDeviceId : null;
          logEvent({kind:'conflictResolved', taskType:'char', winner:'remote', loser:'local', winnerDev:_e1Rd, loserDev:_e1Ld, reason:'updatedAt recency', charId:(l&&l.id)||(r&&r.id), charTitle:(l&&l.name)||(r&&r.name), day: mergedLastCron||0});
        }
        return _charOver(r, _acc); // K3: winner carries the scalars, _acc the earnings
      }
      // Deterministic tiebreak: the higher deviceId string wins, on BOTH sides,
      // so merge(b,L,R) and merge(b,R,L) pick the same winner (total order).
      const _ld = (localDeviceId != null) ? localDeviceId : syncDeviceId();
      const _rd = (remoteDeviceId != null) ? remoteDeviceId
        : (((remote.devices||[]).map(function(d){return d && d.id;})
             .filter(function(id){return id && id !== _ld;}))[0]) || null;
      // K4 (2026-09-11) -- docs row 4.33. The deviceId tiebreak must fire ONLY on an
      // EXACT clamped updatedAt tie, which is what the other three tiebreak sites in this
      // file already do (resolveDailyConflict, mergeCollection's non-daily arm,
      // mergeDevices). Without the `_lUa === _rUa` gate this site also fired when LOCAL was
      // strictly newer, so each device adopted the OTHER device's name/face/cls/hp/maxHp/id
      // and the pair swapped them on every sync round, forever. hp is the non-cosmetic one:
      // a device that took damage had its HP restored by a peer that did not.
      // With the gate, local-strictly-newer falls through to the local return below, which
      // is the correct mirror of the strictly-newer-remote branch above.
      if(_lUa === _rUa && _rd != null && _ld !== _rd){
        // T4: throttle conflictResolved to one per (kind, entityId) per round
        const _conflictKey2 = 'char:' + ((l&&l.id)||(r&&r.id));
        if(typeof logEvent === "function" && !_conflictLogThrottle.has(_conflictKey2)){
          _conflictLogThrottle.add(_conflictKey2);
          logEvent({kind:'conflictResolved', taskType:'char', winner:(_rd>_ld)?'remote':'local', loser:(_rd>_ld)?'local':'remote', winnerDev:(_rd>_ld)?_rd:_ld, loserDev:(_rd>_ld)?_ld:_rd, reason:'deviceId tiebreak', charId:(l&&l.id)||(r&&r.id), charTitle:(l&&l.name)||(r&&r.name), day: mergedLastCron||0});
        }
        return _charOver((_rd > _ld) ? r : l, _acc); // K3: see the note above the F6 block
      }
      // T4: throttle conflictResolved to one per (kind, entityId) per round
      const _conflictKey3 = 'char:' + ((l&&l.id)||(r&&r.id));
      if(typeof logEvent === "function" && !_conflictLogThrottle.has(_conflictKey3)){
        _conflictLogThrottle.add(_conflictKey3);
        // F5: loserDev may be null here, and the renderer's || chain keeps the legacy
        // wording when it is.
        // K4 (2026-09-11): TWO distinct paths now reach this return, so name the real one.
        //   a) local is strictly newer  -> local wins on recency, same rule as the remote
        //      branch above. This is the path the K4 gate newly routes here.
        //   b) exact clamped tie with no usable remote device id -> the F2 local bias
        //      (C7's shape). _rd is null on this path only.
        logEvent({kind:'conflictResolved', taskType:'char', winner:'local', loser:'remote', winnerDev:_ld, loserDev:_rd, reason:(_lUa > _rUa) ? 'updatedAt recency' : 'unresolved tie, local kept', charId:(l&&l.id)||(r&&r.id), charTitle:(l&&l.name)||(r&&r.name), day: mergedLastCron||0});
      }
      // K3: _acc is null here whenever the tie is unresolved because remoteDeviceId was
      // missing (precondition 3), so this stays exactly the pre-K3 F2 bias.
      return _charOver(l, _acc); // unresolved tie (no remote device id available) -> local (F2 bias)
    })()
  };
  return merged; // the flush is merge()'s finally -- see J1 finding 8 above
}

function wrap(subset){
  return { schema: 1, savedAt: Date.now(), deviceId: syncDeviceId(), state: subset };
}

// ---- 3.5 syncNow() — the only orchestrator ---------------------------------
let _syncInFlight = null;
let _syncRerunQueued = false;
// T4: per-round throttle for conflictResolved logs (one per kind:entityId per sync round)
let _conflictLogThrottle = new Set();

function syncNow(){
  if(!navigator.onLine) return Promise.resolve();
  const cfg = syncCfg();
  if(!cfg.enabled || !cfg.refreshToken) return Promise.resolve();

  if(_syncInFlight){
    _syncRerunQueued = true;
    return _syncInFlight;
  }
  // #10 Layer (c): Web Locks elect a single sync-runner per origin
  // (prevents duplicate syncNow across tabs sharing the same origin).
  function _doSync(){
    // T4: clear conflict log throttle at the start of each sync round
    _conflictLogThrottle.clear();
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
  if(typeof navigator!=='undefined' && navigator.locks && typeof navigator.locks.request==='function'){
    return navigator.locks.request('questa-sync', {mode:'exclusive'}, function(){
      // Inside lock: skip if another tab's sync is already in flight on this tab.
      if(_syncInFlight) return _syncInFlight;
      return _doSync();
    });
  }
  return _doSync();
}

// HLC receive ratchet: compute the max ordering timestamp across a state
// object so ratchetHlc (app.js) can pull the local clock forward.
function _maxOrderingTs(st){
  if(!st) return 0;
  var mx = 0;
  (st.tasks||[]).forEach(function(t){
    var u = Number(t.updatedAt)||0; if(u>mx) mx=u;
    (t.checklist||[]).forEach(function(c){ var ta = Number(c.touchedAt)||0; if(ta>mx) mx=ta; });
  });
  var ch = Number(st.char && st.char.updatedAt)||0; if(ch>mx) mx=ch;
  (st.devices||[]).forEach(function(d){ var du = Number(d.updatedAt)||0; if(du>mx) mx=du; });
  (st.deletions||[]).forEach(function(dl){ var da = Number(dl.at)||0; if(da>mx) mx=da; });
  (st.tags||[]).forEach(function(tg){ var tu = Number(tg.updatedAt)||0; if(tu>mx) mx=tu; });
  (st.rewards||[]).forEach(function(rw){ var ru = Number(rw.updatedAt)||0; if(ru>mx) mx=ru; });
  // 2026-09-18: the only caller passes a wrap(syncSubset()) payload, whose analytics
  // live at the TOP level as `an` — syncSubset emits `an`, merge emits `an`. Reading
  // st.prefs.an made both lines below dead, so a peer whose only recent edits were
  // saved views/metrics never ratcheted this device's HLC and the next local view
  // edit was stamped below the remote one and lost the merge tiebreak.
  var pv = st.an || (st.prefs && st.prefs.an);
  (pv && pv.views||[]).forEach(function(v){ var vu = Number(v.updatedAt)||0; if(vu>mx) mx=vu; });
  (pv && pv.metrics||[]).forEach(function(m){ var mu = Number(m.updatedAt)||0; if(mu>mx) mx=mu; });
  return mx;
}
async function _syncNowAttempt(transientRetryCount){
  try{
    const remote = await dbxDownload(STATE_PATH);
    if(remote && remote.state && typeof ratchetHlc==='function'){ ratchetHlc(_maxOrderingTs(remote.state)); }
    const _baseResult = await syncBaseGet();
    let base = _baseResult ? _baseResult.base : null;
    const _storedRev = _baseResult ? _baseResult.lastRev : null;
    // Phase B (2026-07-11 persistence-loss fix): captured from the live S
    // object (app.js global) BEFORE syncSubset() builds the whitelisted
    // upload payload -- syncSubset() never copies __savedAt, by design, so it
    // must be read here or not at all.
    const localSavedAt = (typeof S !== "undefined" && S && S.__savedAt) || null;
    const local = syncSubset();
    // FIX 2026-07-12 (#5, Fraser-lite): if remote.rev matches the rev stored
    // with the base but the actual state differs, the base is poisoned/stale.
    // Discard it — degrades to 2-way keep-by-default (tombstones make safe).
    if(remote && _storedRev && remote.rev === _storedRev
       && stableStringify(remote.state) !== stableStringify(base)){
      base = null;
    }
    const merged = remote ? merge(base, local, remote.state, remote.savedAt, localSavedAt, syncDeviceId(), remote.deviceId || null) : local;

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
      const _noopRev = remote ? remote.rev : cfgRevOrNull();
      const baseOk = await syncBasePut(mergedJson, _noopRev);
      syncCfgSave({ lastSyncAt: Date.now(), lastRev: _noopRev,
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
    const baseOk = await syncBasePut(mergedJson, up.rev || null);
    syncCfgSave({ lastRev: up.rev || null, lastSyncAt: Date.now(),
                  lastError: baseOk ? null : "base snapshot write failed — sync degraded" });
  }catch(e){
    if(e instanceof ConflictError && attempt < SYNC_CONFLICT_RETRY_LIMIT){
      const fresh = await dbxDownload(STATE_PATH);
      // 2026-09-18 (round 2): ratchet BEFORE applying, exactly as _syncNowAttempt and
      // _syncForcePullAttempt do. This is the third site that imports a peer's rows
      // and their updatedAt stamps, and it was the only one not ratcheting: the next
      // local edit was then stamped BELOW the value just imported and lost the
      // following both-changed merge tiebreak -- the edit is discarded, silently.
      if(fresh && fresh.state && typeof ratchetHlc === 'function'){ try{ ratchetHlc(_maxOrderingTs(fresh.state)); }catch(e){} }
      const _baseRes2 = await syncBaseGet();
      let _base2 = _baseRes2 ? _baseRes2.base : null;
      const _storedRev2 = _baseRes2 ? _baseRes2.lastRev : null;
      // #5 self-check on retry path too
      if(fresh && _storedRev2 && fresh.rev === _storedRev2
         && stableStringify(fresh.state) !== stableStringify(_base2)){
        _base2 = null;
      }
      const localSavedAt = (typeof S !== "undefined" && S && S.__savedAt) || null;
      const local = syncSubset();
      const reMerged = fresh ? merge(_base2, local, fresh.state, fresh.savedAt, localSavedAt, syncDeviceId(), fresh.deviceId || null) : local;
      syncApply(reMerged);
      return _pushWithConflictRetry(JSON.stringify(reMerged), fresh ? fresh.rev : null, attempt + 1);
    }
    if(e instanceof ConflictError){
      syncCfgSave({ lastError: "sync conflict — retry later" });
      // Schedule a delayed retry so applied-but-unpushed state is bounded
      // in time instead of silent until next user action / visibility event.
      setTimeout(function(){ syncNow(); }, SYNC_CONFLICT_BACKOFF_MS);
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
      // 2026-09-18 (round 2): honour a sync queued while the force op was running,
      // the same tail _doSync has. syncNow() sets _syncRerunQueued and returns THIS
      // promise, so without this the queued round was dropped entirely (a tick made
      // during a force push waited for some later unrelated trigger) and the flag
      // stayed true, making the next ordinary sync fire a second redundant round.
      if(_syncRerunQueued){ _syncRerunQueued = false; syncNow(); }
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
    // 2026-09-18: syncBasePut returns false (never throws) when the IDB write fails.
    // Discarding it and writing lastError:null reported success while the PREVIOUS
    // base survived — and a stale base resurrects, on the very next merge, exactly
    // the records the user just force-pushed away. Surface it like the two
    // _pushWithConflictRetry call sites already do.
    const baseOk = await syncBasePut(local, up.rev || null);
    syncCfgSave({ lastRev: up.rev || null, lastSyncAt: Date.now(),
                  lastError: baseOk ? null : "base snapshot write failed — sync degraded" });
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
      // Same queued-sync tail as syncForcePush above (2026-09-18 round 2).
      if(_syncRerunQueued){ _syncRerunQueued = false; syncNow(); }
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
    // 2026-09-18: ratchet the HLC before applying, exactly as _syncNowAttempt does on
    // its pull. Force pull is the path most likely to import a peer's higher stamps
    // wholesale; without the ratchet the next local edit was stamped BELOW the value
    // it just imported and lost the following both-changed merge tiebreak.
    if(typeof ratchetHlc === 'function'){ try{ ratchetHlc(_maxOrderingTs(remote.state)); }catch(e){} }
    syncApply(remote.state);           // local becomes remote's content, unconditionally
    // 2026-09-18: same discarded-boolean bug as force push above — a failed base write
    // left the OLD base in place, which then resurrects the data the force pull
    // deliberately discarded on the next ordinary merge.
    const baseOk = await syncBasePut(remote.state, remote.rev);
    syncCfgSave({ lastRev: remote.rev || null, lastSyncAt: Date.now(),
                  lastError: baseOk ? null : "base snapshot write failed — sync degraded" });
    // W6.15: a force pull only reconciled state, silently leaving the event
    // store behind -- same bug class as the clearAllEvents() gap just fixed on
    // the restore/import paths. Pull events too, bypassing both the rev cache
    // and the 60s throttle ({force:true}, added in W6.13) so this reconciles in
    // one shot. State reconciliation has already succeeded above, so a failure
    // here must not fail/roll back the force pull -- catch and diagnose only.
    if(typeof syncEventsPull === "function"){
      try{ await syncEventsPull({force:true}); }
      catch(e){
        if(typeof _qDiagPush === "function") _qDiagPush('forcePullEventsFailed', { error: (e && e.message) || String(e) });
      }
    }
  }catch(e){
    syncCfgSave({ lastError: "force pull failed: " + ((e && e.message) || String(e)) });
  }
}

// ---- 3.8 Automatic Dropbox export backup -----------------------------------
// A SEPARATE feature from the state.json sync above: uploads a full backup
// (the same format Settings -> Export produces) to /questa-backups/ using a
// four-tier cycling system (4-hourly, daily, weekly, monthly). Each tier keeps
// its own slot cycle, filename prefix, and cadence, scoped per device.
//
// Backups ride the existing syncNow() opportunistic hook -- no new timers.
// On every successful sync, every due tier fires exactly once (own in-flight
// lock), writes its next slot to Dropbox, and rolls the oldest file off.
//
// Tier bookkeeping (lastTs, idx) lives in localStorage off the merge path.
// Tier selections live in S.prefs.autoBackupEnabled (sync-excluded prefs).
//
// Manual "Save to Dropbox" (exportSaveDropbox below) still writes to the
// legacy /export-backup.json path. lastExportTs is updated on any tier fire
// or manual export, so Settings' "Last export" reflects the most recent activity.
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


// ---- 3.8a Cycling backup tier infrastructure ---------------------------------
// Tier bookkeeping lives in localStorage (off the sync/merge path).
const _BK_LOCAL_KEY = 'questa.autobackup.local';
// bkVersion 0 means "slot bookkeeping unknown" and is what makes _bkFire's lazy
// self-heal reachable (2026-09-18 round 2); _bkFire stamps 1 once it has listed
// Dropbox and recovered the real slot index.
const _BK_DEFAULT = {fourHour:{bkVersion:0,lastTs:0,idx:0}, daily:{bkVersion:0,lastTs:0,idx:0}, weekly:{bkVersion:0,lastTs:0,idx:0}, monthly:{bkVersion:0,lastTs:0,idx:0}};

function bkLocalLoad(){
  try{
    const raw = localStorage.getItem(_BK_LOCAL_KEY);
    if(!raw) return JSON.parse(JSON.stringify(_BK_DEFAULT));
    const obj = JSON.parse(raw);
    if(!obj || typeof obj !== 'object') return JSON.parse(JSON.stringify(_BK_DEFAULT));
    const out = JSON.parse(JSON.stringify(_BK_DEFAULT));
    for(const k of ['fourHour','daily','weekly','monthly']){
      if(obj[k] && typeof obj[k] === 'object'){
        // 2026-09-18 (round 2): default to 0, not 1. Normalising an absent field to 1
        // -- and seeding _BK_DEFAULT with 1 -- made `typeof !== 'number' || < 1` at
        // the self-heal below impossible to satisfy, so the branch was dead. A device
        // whose site data was evicted restarted the rotation at slot 0 and the dedup
        // step then deleted the NEWEST backups first, keeping the oldest.
        out[k].bkVersion = typeof obj[k].bkVersion === 'number' ? obj[k].bkVersion : 0;
        out[k].lastTs = typeof obj[k].lastTs === 'number' ? obj[k].lastTs : 0;
        out[k].idx = typeof obj[k].idx === 'number' ? obj[k].idx : 0;
      }
    }
    return out;
  }catch(e){ return JSON.parse(JSON.stringify(_BK_DEFAULT)); }
}
function bkLocalSave(data){
  try{ localStorage.setItem(_BK_LOCAL_KEY, JSON.stringify(data)); }catch(e){ /* quota -- non-fatal */ }
}

// ---- 3.8b Tier definitions ---------------------------------------------------
const BK_TIERS = {
  fourHour: {prefix:'4hour', count:10, cadenceMs:4*3600e3},
  daily:    {prefix:'daily', count:7},
  weekly:   {prefix:'weekly', count:4},
  monthly:  {prefix:'monthly', count:4}
};

// ---- 3.8c Filename / path helpers --------------------------------------------
function _bkDeviceShort(){ return syncDeviceId().slice(-6); }
function _bkStamp(ts){
  const d = new Date(ts);
  const p = n => String(n).padStart(2,'0');
  return '' + d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function _bkPath(tierKey, slot, ts){
  const tier = BK_TIERS[tierKey];
  return '/questa-backups/' + tier.prefix + '-' + _bkDeviceShort() + '-' + String(slot).padStart(2,'0') + '-' + _bkStamp(ts) + '.json';
}

// ---- 3.8d Dropbox listing + boundary calculation ----------------------------
async function _bkListTier(deviceShort, tierPrefix){
  try{
    const entries = await dbxListFolder('/questa-backups/');
    const re = new RegExp('^' + tierPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-' + deviceShort.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d+-');
    return entries.filter(e => e && e.name && re.test(e.name));
  }catch(e){ return []; }
}
function _bkNextBoundary(tierKey, lastTs){
  // 2026-07-29 FIX (plan: .kilo/plans/1785344033093-dropbox-cycling-backups-review.md P1).
  // The boundary MUST be derived from lastTs. The old body opened with
  // `const now = new Date();` and built every calendar boundary from it, so the
  // returned boundary was future-by-construction relative to the very instant the
  // caller compares it against (syncMaybeAutoExport, below) -- meaning
  // daily/weekly/monthly could NEVER fire, under any lastTs. Only fourHour worked.
  // lastTs === 0 (never fired) => 0, i.e. due immediately, seeding slot 0. The
  // alternative `lastTs || Date.now()` was considered and REJECTED: lastTs is
  // persisted in _bkFire the moment a tier fires, so lastTs===0 costs exactly one
  // seed upload, whereas that guard would withhold all backups from a freshly
  // enabled monthly tier for up to 31 days. Unit-tested in
  // tests/auto-backup-boundary.test.js (B1-B8).
  if(!BK_TIERS[tierKey]) return Infinity;
  if(!lastTs) return 0;
  const base = new Date(lastTs);
  if(tierKey === 'fourHour'){
    return lastTs + BK_TIERS.fourHour.cadenceMs;
  }
  if(tierKey === 'daily'){
    const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 0, 0, 0, 0);
    return next.getTime();
  }
  if(tierKey === 'weekly'){
    const next = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1, 0, 0, 0, 0);
    while(next.getDay() !== 1){ next.setDate(next.getDate() + 1); }
    return next.getTime();
  }
  if(tierKey === 'monthly'){
    return new Date(base.getFullYear(), base.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
  }
  return Infinity;
}

// ---- 3.8e Per-tier in-flight guard ------------------------------------------
const _bkInFlight = new Set();

// ---- 3.8f _bkFire(tierKey, blob) -- upload + slot rotation -------------------
async function _bkFire(tierKey, blob){
  if(_bkInFlight.has(tierKey)) return;
  _bkInFlight.add(tierKey);
  try{
    const tier = BK_TIERS[tierKey];
    const deviceShort = _bkDeviceShort();
    const now = Date.now();
    const bk = bkLocalLoad();
    const tierState = bk[tierKey];

    // Lazy self-heal: if bkVersion missing or < 1, list Dropbox to discover existing slots
    if(typeof tierState.bkVersion !== 'number' || tierState.bkVersion < 1){
      try{
        const existing = await _bkListTier(deviceShort, tier.prefix);
        let maxSlot = -1;
        for(const ent of existing){
          const parts = ent.name.split('-');
          if(parts.length >= 3){
            const s = parseInt(parts[2], 10);
            if(!isNaN(s) && s > maxSlot) maxSlot = s;
          }
        }
        tierState.idx = (maxSlot + 1) % tier.count;
        tierState.lastTs = now;
        tierState.bkVersion = 1;
        bkLocalSave(bk);
      }catch(e){
        tierState.bkVersion = 1;
      }
    }

    const slot = tierState.idx;
    const path = _bkPath(tierKey, slot, now);
    const text = await blob.text();
    await dbxUploadText(path, text);

    // Slot rotation
    const existing = await _bkListTier(deviceShort, tier.prefix);
    const slotMap = {};
    for(const ent of existing){
      const parts = ent.name.split('-');
      if(parts.length < 4) continue;
      const s = parseInt(parts[2], 10);
      if(isNaN(s)) continue;
      const stampStr = parts.slice(3).join('-').replace(/\.json$/, '');
      if(!slotMap[s]) slotMap[s] = [];
      slotMap[s].push({name: ent.name, stamp: stampStr, path: '/questa-backups/' + ent.name});
    }

    // Deduplicate: keep newest per slot
    // 2026-09-18 (round 2): "newest" was decided purely by string order on the
    // filename stamp, with nothing anchoring the survivor to the file this call just
    // wrote. After a clock correction backwards -- a rewind this repo already guards
    // for elsewhere (tests/cron-day-rewind.test.js) -- the hour-old file sorted
    // higher and the FRESH backup was deleted, while lastTs/idx still advanced and
    // the log said the upload succeeded. Pin the just-written path to the front.
    for(const s in slotMap){
      if(slotMap[s].length > 1){
        slotMap[s].sort((a, b) => b.stamp.localeCompare(a.stamp));
        const _justWritten = slotMap[s].findIndex(f => f.path === path);
        if(_justWritten > 0) slotMap[s].unshift(slotMap[s].splice(_justWritten, 1)[0]);
        for(let i = 1; i < slotMap[s].length; i++){
          try{ await dbxDelete(slotMap[s][i].path); }catch(e){ /* best-effort */ }
        }
        slotMap[s] = [slotMap[s][0]];
      }
    }

    // If distinct slots occupied > count, delete oldest-per-slot
    const occupiedSlots = Object.keys(slotMap).map(Number).sort((a,b) => a - b);
    if(occupiedSlots.length > tier.count){
      const slotOldest = occupiedSlots.map(s => ({
        slot: s,
        newestStamp: slotMap[s][0].stamp
      })).sort((a, b) => a.newestStamp.localeCompare(b.newestStamp));

      let toDelete = occupiedSlots.length - tier.count;
      for(const entry of slotOldest){
        if(toDelete <= 0) break;
        if(entry.slot === slot) continue;
        for(const file of slotMap[entry.slot]){
          try{ await dbxDelete(file.path); }catch(e){ /* best-effort */ }
        }
        delete slotMap[entry.slot];
        toDelete--;
      }
    }

    // Advance index and persist
    tierState.idx = (slot + 1) % tier.count;
    tierState.lastTs = now;
    bkLocalSave(bk);

    if(typeof S !== 'undefined'){
      S.prefs = S.prefs || {};
      S.prefs.lastExportTs = Date.now();
      if(typeof save === 'function') save();
    }

    if(syncCfg().lastBackupError) syncCfgSave({lastBackupError: null});   // this tier is healthy again

    if(typeof logEvent === 'function'){
      logEvent({kind:'export', taskTitle:'Auto Backup (' + tier.prefix + ')', notes:'Uploaded ' + path + ' to Dropbox'});
    }
  }catch(e){
    // 2026-09-18 (round 2): own key. syncMaybeAutoExport is fired unawaited AFTER
    // _syncNowAttempt has already written lastError:null, so a backup failure used to
    // land on top of a fully successful sync and Settings reported a Dropbox error
    // against a lastSyncAt of seconds ago. The guard at the call site only blocked
    // the other direction. lastError belongs to the state-sync path alone.
    syncCfgSave({lastBackupError: tierKey + ' backup failed: ' + ((e && e.message) || String(e))});
  }finally{
    _bkInFlight.delete(tierKey);
  }
}

// Opportunistic scheduler -- rides on syncNow()'s success path. Best-effort:
// any failure here must never break ordinary sync, hence the try/catch wrapping.
async function syncMaybeAutoExport(){
  try{
    if(typeof S === 'undefined' || !S.prefs) return;
    const enabled = S.prefs.autoBackupEnabled;
    if(!enabled || typeof enabled !== 'object') return;
    if(typeof buildBackupFile !== 'function') return;

    const tiers = ['fourHour','daily','weekly','monthly'];
    const due = [];
    const now = Date.now();
    const bk = bkLocalLoad();

    for(const tierKey of tiers){
      if(!enabled[tierKey]) continue;
      const lastTs = bk[tierKey].lastTs;
      if(now >= _bkNextBoundary(tierKey, lastTs)){
        due.push(tierKey);
      }
    }
    if(due.length === 0) return;

    const eventsArr = (typeof getEvents === 'function') ? await getEvents({}).catch(() => []) : [];
    const {blob} = await buildBackupFile(eventsArr);
    if(!blob) return;

    for(const tierKey of due){
      await _bkFire(tierKey, blob);
    }
  }catch(e){ /* best-effort only, never throw into syncNow() chain */ }
}

// ---- 3.9 Event-log sync (plan: .omo/plans/2026-07-10-eventlog-sync.md) ----
const EVENTS_DIR = "/events";
const EVT_PULL_MIN_INTERVAL_MS = 60000; // list_folder at most once/min
// (2026-07-29 W6.13) Self-healing pull knobs -- see plan note above
// syncEventsPull() for the full rationale.
const EVT_FULL_SCAN_INTERVAL_MS = 24 * 3600000; // periodic rev-cache-ignoring re-scan
const EVT_BAD_REV_RETRY_MS = 15 * 60000;        // corrupt/failed payload retry backoff
const EVT_BAD_REVS_MAX = 200;                   // cap on cfg.evtBadRevs so it can't grow unbounded

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
// (2026-07-29 W6.13) Deliberately does NOT match Dropbox's own conflict-copy
// naming, e.g. "mrl770yaq56gl-202607 (1).json" (confirmed present in prod
// Dropbox). A conflict copy is Dropbox's artifact of a write race on a file
// this same device-month OVERWRITES WHOLESALE on every push (see
// evtOwnMonthRecords/syncEventsPush) -- it is not an appended log, so a
// " (1)" copy is a stale full-month snapshot the writer already superseded.
// Ingesting it risks resurrecting events the writing device deliberately
// dropped from its own rebuilt file (e.g. after a local delete/edit). Such
// names already fall through to the 'unparsedName' diag path below rather
// than being silently dropped, which meets the visibility bar without
// resurrecting superseded history. Left unparsed on purpose; do not "fix"
// this without re-reading that reasoning.
function evtParseFileName(name){
  const m = /^(.+)-(\d{6})\.json$/.exec(name || "");
  return m ? { dev: m[1], month: m[2] } : null;
}
// Own not-yet-uploaded events: stamped, mine, real (not synthetic), not an
// unpublished import, newer than the watermark.
// (2026-07-29 W6.14) `imported` records (reparentEventsForImport(), app.js)
// are excluded the same way `synthetic` records always have been: re-
// uploading an imported record would publish ANOTHER device's history under
// THIS device's uid, permanently duplicating it with no uid-based dedup able
// to collapse the copies (the concrete harm this task exists to remove --
// see reparentEventsForImport()'s header comment in app.js). The exclusion
// is lifted ONLY when the record carries an explicit `republish: true`
// opt-in (see republishImportedEvents(), app.js). The `!e.synthetic` check
// below is UNCONDITIONAL and independent of `republish` -- a synthetic
// (reconstructed/backfilled) record can never become uploadable no matter
// what other flags it carries. Do not fold synthetic into the same
// republish-gated clause; it must stay a separate, unconditional term.
function evtUploadable(events, myDev, sinceTs){
  // 'lifecycle' is a local-only diagnostic kind (Phase C, 2026-07-11) and
  // must never be pushed to Dropbox -- it would spam every other device's
  // Activity Feed too (see app.js getEvents() for the read-side filter and
  // the matching fix note).
  return (events || []).filter(e => e && e.uid && e.dev === myDev && !e.synthetic
    && (!e.imported || e.republish)
    && e.kind !== "lifecycle" && typeof e.ts === "number" && e.ts > sinceTs);
}
// Full-month rebuild set for upload: same ownership rule (including the
// imported/republish gate above -- see evtUploadable() comment), no
// watermark, local IDB `id` stripped (meaningless on other devices).
function evtOwnMonthRecords(events, myDev){
  return (events || [])
    .filter(e => e && e.uid && e.dev === myDev && !e.synthetic && (!e.imported || e.republish) && e.kind !== "lifecycle" && typeof e.ts === "number")
    .map(e => { const r = Object.assign({}, e); delete r.id; return r; });
}
// Filter a downloaded file's records down to what should be inserted locally:
// stamped, not synthetic, not ours, inside the prune window, uid not already
// present (in IDB — caller passes the set — or earlier in this same batch).
// LOCKSTEP: this must produce the exact same string as app.js eventMergeSig().
// It is duplicated rather than called because the test sandbox loads sync.js on
// its own, with no app.js globals. tests/uid-collision.test.js extracts both and
// asserts they agree, so drift fails the suite instead of silently splitting the
// two dedup paths.
function evtIncomingSig(r){
  // LOCKSTEP with app.js eventMergeSig() — tests/uid-collision.test.js C9a pins
  // the two to be byte-identical. 2026-09-18 (round 2): widened together to carry
  // detail/subId/done, because the app emits two DISTINCT lifecycle records with
  // the same ts from one visibilitychange (flushState + the Tier-1 handler) and
  // the old five-field signature collapsed them into one.
  return [r.ts, r.kind, r.taskId || '', r.dir || 0, r.reps || 0,
          r.detail || '', r.subId || '', (r.done === undefined ? '' : (r.done ? 1 : 0))].join('|');
}
// LOCKSTEP: must match app.js eventUidDisambiguate(). Same reason as above.
function evtUidDisambiguate(uid, sig){
  let h = 0x811c9dc5;
  const s = String(sig);
  for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return String(uid) + '~' + (h>>>0).toString(16);
}
function evtIncomingFilter(records, existingUidSet, myDev, nowMs, ageLimitMs){
  const out = []; const seen = new Map();
  // `existingUidSet` is a Set of uids (legacy callers) or a Map uid -> signature.
  // Only the Map form can tell a duplicate from a uid collision; without it the
  // old lossy uid-only behaviour is kept rather than guessed at.
  const uidSigs = (existingUidSet && typeof existingUidSet.get === 'function') ? existingUidSet : null;
  const existingSigs = uidSigs ? new Set(uidSigs.values()) : null;
  const seenSigs = new Set();
  (records || []).forEach(r => {
    if(!r || typeof r !== "object") return;
    if(!r.uid || typeof r.ts !== "number") return;
    if(r.synthetic) return;
    if(r.kind === "lifecycle") return; // defense-in-depth: reject even if an old build uploaded one
    if(r.dev === myDev) return;
    if(nowMs - r.ts > ageLimitMs) return;
    // Content-hash uids ('rep-...', minted by app.js eventUidOf() when an import
    // is re-parented) are the ONLY uids that can change for one logical event:
    // the digest was widened from 32 to 64 bits on 2026-09-18, and a re-import
    // on the new build re-mints them. Dedupe those by signature so the same tap
    // does not land twice under two uid schemes. Real taps carry a random
    // syncEventUid() and are deliberately left to uid-only dedup -- a signature
    // net there could drop two genuinely distinct remote taps that happen to
    // share (ts, kind, taskId, dir, reps).
    const isRep = String(r.uid).slice(0, 4) === 'rep-';
    const sig = uidSigs ? evtIncomingSig(r) : null;
    if(isRep && existingSigs && (existingSigs.has(sig) || seenSigs.has(sig))) return;
    let uid = r.uid;
    if(existingUidSet.has(uid) || seen.has(uid)){
      const knownSig = existingUidSet.has(uid)
        ? (uidSigs ? uidSigs.get(uid) : null)
        : seen.get(uid);
      // Equal signature => genuinely the same event, already stored. Unequal =>
      // a uid COLLISION: before 2026-09-18 this line dropped the losing event
      // permanently, with nothing downstream to recover it.
      if(!uidSigs || knownSig === sig) return;
      uid = evtUidDisambiguate(uid, sig);
      if(existingUidSet.has(uid) || seen.has(uid)) return;
    }
    seen.set(uid, sig);
    if(sig !== null) seenSigs.add(sig);
    const rec = Object.assign({}, r); delete rec.id;
    if(uid !== r.uid) rec.uid = uid;
    out.push(rec);
  });
  return out;
}
// Is this whole month older than the prune window? (Compared against month END.)
function evtMonthOlderThan(monthKey, nowMs, ageLimitMs){
  return (nowMs - evtMonthRange(monthKey).to) > ageLimitMs;
}
// T1: uidHash - stable digest of sorted uid list for shrink-guard comparison
async function uidHash(recs){
  const uids = (recs || []).map(e => e.uid).filter(Boolean).sort();
  if(typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest){
    try{
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uids.join(",")));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
    }catch(e){ /* fall through */ }
  }
  // Fallback: simple hash when crypto unavailable
  let h = 0;
  for(let i = 0; i < uids.join(",").length; i++){
    h = ((h << 5) - h) + uids.join(",").charCodeAt(i);
    h |= 0;
  }
  return "fallback-" + Math.abs(h).toString(16).padStart(8, "0");
}
// T1: uidsAreSuperset - check if local uids contain all known uids
function uidsAreSuperset(localRecs, knownHash, knownUids){
  const localUids = new Set((localRecs || []).map(e => e.uid).filter(Boolean));
  // If we have the known uids stored, use them directly.
  // F8 (2026-08-18): uids persist as an ARRAY, not a Set — a Set becomes {} through
  // JSON.stringify, so .size was undefined after every reload and this fast path was
  // silently skipped forever. Arrays are still iterable by the for-of below.
  if(knownUids && knownUids.length){
    for(const u of knownUids){
      if(!localUids.has(u)) return false;
    }
    return true;
  }
  // Otherwise compare hashes (less precise but works for exact match)
  const localHash = uidHash(localRecs);
  return localHash === knownHash;
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

// 2026-09-18: resolves {added, ok}. It used to resolve the same `added` count from
// oncomplete, onerror AND onabort, and `added` counted store.add() CALLS, not
// committed writes. So a transaction aborted by a quota error was reported to the
// caller as a full success — syncEventsPull logged evtPullOk{inserted:N} and cached
// that file's rev, which pins the file out of every subsequent pull until its writer
// changes it or the 24h full scan comes round. A whole month of another device's
// history could sit invisible for a day behind a diagnostic saying it landed.
// `ok:false` now routes the file into the existing badRevs retry path instead.
function evtInsertNew(records){
  if(!records || !records.length) return Promise.resolve({ added: 0, ok: true });
  if(typeof idbOpen !== "function" || typeof EVENTS_STORE === "undefined") return Promise.resolve({ added: 0, ok: false });
  return idbOpen().then(db => new Promise((resolve) => {
    let added = 0, tx;
    try{ tx = db.transaction(EVENTS_STORE, "readwrite"); }catch(e){ resolve({ added: 0, ok: false }); return; }
    const store = tx.objectStore(EVENTS_STORE);
    records.forEach(r => { try{ store.add(r); added++; }catch(e){} });
    tx.oncomplete = () => resolve({ added: added, ok: true });
    tx.onerror = () => resolve({ added: 0, ok: false });
    tx.onabort = () => resolve({ added: 0, ok: false });
  })).catch(() => ({ added: 0, ok: false }));
}

// Upload own new events, rebuilding each touched month's file in full and
// overwriting it (single writer — no rev handshake needed; reuses
// dbxUploadText, which uploads mode:overwrite).
async function syncEventsPush(opts){
  if(typeof getEvents !== "function") return;
  const myDev = syncDeviceId();
  const cfg = syncCfg();
  const since = cfg.evtLastUploadTs || 0;
  const forceFullPush = !!(opts && opts.forceFullPush);
  const forcePush = !!(opts && opts.force); // T1: force-push override for shrink guard
  // 24h full re-push: ignore watermark if due
  let effectiveSince = since;
  if(forceFullPush){
    effectiveSince = 0;
  } else if(cfg.evtFullPushAt && (Date.now() - cfg.evtFullPushAt) > 86400000){
    effectiveSince = 0;
  }
  // diagnostics sync cross-device for remote debugging; the Activity Feed
  // still filters them at render via getEvents' default (app.js).
  const fresh = evtUploadable(await getEvents({ from: effectiveSince + 1, includeDiag: true }), myDev, effectiveSince);
  if(!fresh.length){
    // 2026-09-18 (round 2): still start the full-push clock. evtFullPushAt defaults
    // to 0, which is falsy, so the `cfg.evtFullPushAt && …` gate above can never
    // become true until something writes it — and the only writer is the syncCfgSave
    // at the end of this function, which this early return skips. So the periodic
    // re-push, the one mechanism that recovers own events sitting BELOW the
    // watermark (a restored backup re-inserts them with their original ts), never
    // started on exactly the idle device it was written for. The pull side already
    // bootstraps evtFullScanAt unconditionally; mirror that.
    if(!cfg.evtFullPushAt) syncCfgSave({ evtFullPushAt: Date.now() });
    return;
  }
  const months = [...new Set(fresh.map(e => evtMonthKey(e.ts)))].sort();
  let maxTs = since; // only advance the real watermark, not the full-push scan
  let anyBlocked = false;
  const fileCounts = Object.assign({}, cfg.evtFileCounts || {});
  const pushBlocked = Object.assign({}, cfg.evtPushBlocked || {});
  const ageLimit = (typeof EVENT_AGE_LIMIT_MS !== "undefined") ? EVENT_AGE_LIMIT_MS : 18 * 30 * 86400000;
  for(const mk of months){
    const r = evtMonthRange(mk);
    // diagnostics sync cross-device for remote debugging (see note above).
    const recs = evtOwnMonthRecords(await getEvents({ from: r.from, to: r.to, includeDiag: true }), myDev);
    if(!recs.length) continue;
    const fname = myDev + "-" + mk + ".json";
    const known = fileCounts[fname];
    // T1: Shrink guard - check if local set is smaller than known remote
    if(known != null && !forcePush){
      const localCount = recs.length;
      const knownCount = known.count;
      const localHash = await uidHash(recs);
      const isSuperset = uidsAreSuperset(recs, known.hash, known.uids);
      // Check if shrink is legitimate (age pruning)
      let isLegitimateShrink = false;
      if(localCount < knownCount){
        // F3 (2026-08-18): ask "could the records that disappeared have legitimately
        // aged out?", not "is the NEWEST remaining record stale?". The old test
        // (now - localMaxTs > ageLimit) blocked a month straddling the cutoff FOREVER.
        // Two conditions, both computable here with zero extra Dropbox calls:
        //   (a) nothing prunable remains locally — exactly what a completed prune leaves;
        //   (b) the cutoff has swept into this month, so it genuinely held prunable records.
        // Deliberately a heuristic: it cannot distinguish "aged out" from "real loss
        // coinciding with an aging month". A precise rule would need a per-month download
        // every round; judged not worth it against a permanent silent stall.
        // recs is non-empty here (the !recs.length continue above), so Math.min is finite.
        const now = Date.now();
        const cutoff = now - ageLimit;
        const localMinTs = Math.min(...recs.map(e => e.ts));
        if(localMinTs >= cutoff && r.from < cutoff){
          isLegitimateShrink = true;
        }
      }
      if(localCount < knownCount && !isSuperset && !isLegitimateShrink){
        // BLOCK the push
        anyBlocked = true;
        if(typeof _qDiagPush === "function"){
          _qDiagPush('evtPushShrinkBlocked', { 
            file: fname, 
            local: localCount, 
            known: knownCount, 
            localHash: localHash, 
            knownHash: known.hash 
          });
        }
        pushBlocked[fname] = { at: Date.now(), local: localCount, known: knownCount };
        continue; // skip this month, don't upload
      }
    }
    // Upload the month
    await dbxUploadText(EVENTS_DIR + "/" + fname, JSON.stringify(recs));
    // Update the file counts with new count and hash
    const newHash = await uidHash(recs);
    // F8 (2026-08-18): a plain ARRAY, never a Set — this is persisted through
    // JSON.stringify by syncCfgSave(), and JSON.stringify(new Set([...])) yields {}.
    const newUids = recs.map(e => e.uid).filter(Boolean);
    fileCounts[fname] = { count: recs.length, hash: newHash, uids: newUids };
    // Clear any previous block for this file
    delete pushBlocked[fname];
    recs.forEach(e => { if(e.ts > maxTs) maxTs = e.ts; });
  }
  // Clamp the watermark to prevent future-skew pinning (P1/P2)
  const now = Date.now();
  const clampedMaxTs = Math.min(maxTs, now + MAX_FUTURE_SKEW_MS);
  // Never write a watermark greater than now
  const finalMaxTs = Math.min(clampedMaxTs, now);
  // T1: Do not advance watermark past a blocked month
  const newEvtLastUploadTs = anyBlocked ? since : finalMaxTs;
  syncCfgSave({ 
    evtLastUploadTs: newEvtLastUploadTs, 
    // 2026-09-18: BOOTSTRAP the 24h clock. It defaults to 0, which is falsy, so the
    // `cfg.evtFullPushAt && …` gate above could never become true and the periodic
    // full re-push was dead code — only the manual "Force Push Events" button ever
    // set it. Own-device events that land BELOW the watermark (a restored backup
    // re-inserts them with their original ts) therefore never left the device.
    // Start the cycle on the first successful push, like evtFullScanAt does on pull.
    evtFullPushAt: (forceFullPush || !cfg.evtFullPushAt || (Date.now() - cfg.evtFullPushAt) > 86400000) ? Date.now() : cfg.evtFullPushAt,
    evtFileCounts: fileCounts,
    evtPushBlocked: pushBlocked
  });
  // T1: Surface blocked push to user
  if(anyBlocked && typeof toast === "function"){
    const blockedFiles = Object.keys(pushBlocked);
    toast('Sync blocked: ' + blockedFiles.length + ' month file(s) would shrink. Use "Force Push Events" in Settings to override.');
  }
}

// Pull other devices' files whose rev changed; union-insert by uid.
// (2026-07-29 W6.12) Instrumentation only -- every continue/return below now
// pushes a diag entry via _qDiagPush so a silent skip is visible in
// questaFullDiagnostic(). Control flow is unchanged; see archive backup diff.
// Module-scoped so the throttle-diag rate limit survives across calls.
let _evtPullLastThrottleDiag = 0;
async function syncEventsPull(opts){
  // (2026-07-29 W6.13) opts.force bypasses BOTH the rev cache and the 60s
  // throttle for a full reconciliation pull. Every existing call site
  // (syncEventsSync()'s .then(() => syncEventsPull()), the only caller
  // today) passes no argument, so `opts` is undefined and `force` is false --
  // identical to prior behavior.
  const force = !!(opts && opts.force);
  if(typeof getEvents !== "function" || typeof idbOpen !== "function"){
    if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: null, reason: 'missingDeps' });
    return;
  }
  const now = Date.now();
  const cfg = syncCfg();
  if(!force && now - (cfg.evtLastPullAt || 0) < EVT_PULL_MIN_INTERVAL_MS){
    // The throttle can fire far more often than an actual pull would run (any
    // scheduleSync/syncNow tick inside the 60s window), so logging every hit
    // would flood the 50-entry ring before the user opens the diag overlay.
    // Rate-limit this one reason to roughly once per pull-cycle window.
    if(typeof _qDiagPush === "function" && (now - _evtPullLastThrottleDiag >= EVT_PULL_MIN_INTERVAL_MS)){
      _evtPullLastThrottleDiag = now;
      _qDiagPush('evtPullSkip', { name: null, reason: 'throttled' });
    }
    return;
  }
  const myDev = syncDeviceId();
  const ageLimit = (typeof EVENT_AGE_LIMIT_MS !== "undefined") ? EVENT_AGE_LIMIT_MS : 18 * 30 * 86400000;
  // Periodic full re-scan: ignore the rev cache entirely once a day so a file
  // that got wedged (stale/corrupt rev pinning, a missed webhook-less list,
  // etc.) self-heals within 24h instead of staying invisible forever. Insert
  // is already a uid union (evtIncomingFilter + evtInsertNew), so redundantly
  // re-pulling an already-ingested file is idempotent and cheap.
  // A never-before-set watermark (fresh device, or upgrading from a build
  // that predates this feature) bootstraps the clock on THIS pull without
  // forcing an immediate full scan -- the first real full scan then lands
  // ~24h later, matching "self-heals within a day" rather than instantly
  // re-scanning every existing install the moment this ships.
  const lastFullScanAt = cfg.evtFullScanAt || 0;
  const isFullScan = lastFullScanAt > 0 && (now - lastFullScanAt) > EVT_FULL_SCAN_INTERVAL_MS;
  const ignoreRevCache = force || isFullScan;
  const entries = await dbxListFolder(EVENTS_DIR);
  if(isFullScan && typeof _qDiagPush === "function") _qDiagPush('evtFullScan', { entries: entries.length });
  const revs = Object.assign({}, cfg.evtFileRevs || {});
  const badRevs = Object.assign({}, cfg.evtBadRevs || {});
  for(const ent of entries){
    const parsed = evtParseFileName(ent.name);
    if(!parsed){                             // not an event file (ignore strangers)
      if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: ent.name, reason: 'unparsedName' });
      continue;
    }
    if(parsed.dev === myDev){                // never re-import own uploads
      if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: ent.name, reason: 'ownDevice' });
      continue;
    }
    if(evtMonthOlderThan(parsed.month, now, ageLimit)){
      delete revs[ent.name];
      delete badRevs[ent.name];
      if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: ent.name, reason: 'tooOld' });
      continue;
    }
    const bad = badRevs[ent.name];
    if(!ignoreRevCache && bad && (now - (bad.at || 0)) < EVT_BAD_REV_RETRY_MS){
      // A corrupt/failed payload backs off at a slower cadence than a normal
      // unchanged-rev skip, instead of being pinned alongside healthy files.
      if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: ent.name, reason: 'badRevBackoff' });
      continue;
    }
    if(!ignoreRevCache && ent.rev && revs[ent.name] === ent.rev){
      if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: ent.name, reason: 'revUnchanged' });
      continue; // unchanged since last pull
    }
    const dl = await dbxDownloadRaw(EVENTS_DIR + "/" + ent.name);
    if(!dl){
      if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: ent.name, reason: 'downloadFailed' });
      badRevs[ent.name] = { rev: ent.rev || null, at: now };
      continue;
    }
    let records = null;
    let _evtParseFailed = false;
    try{ records = JSON.parse(dl.text); }catch(e){ _evtParseFailed = true; /* corrupt: skip content */ }
    if(Array.isArray(records)){
      const range = evtMonthRange(parsed.month);
      // diagnostics sync cross-device for remote debugging (see note above);
      // the pre-existing kind:'lifecycle' exclusion in evtIncomingFilter stays.
      // uid -> content signature, not a bare uid Set: evtIncomingFilter() needs
      // the stored record's signature to separate a real duplicate from a
      // content-hash uid collision, which used to drop the incoming event for
      // good. Month-scoped, so the Map stays small.
      const existing = new Map();
      (await getEvents({ from: range.from, to: range.to, includeDiag: true }))
        .forEach(e => { if(e && e.uid) existing.set(e.uid, evtIncomingSig(e)); });
      const _evtRes = await evtInsertNew(evtIncomingFilter(records, existing, myDev, now, ageLimit));
      const _evtInserted = (_evtRes && _evtRes.added) || 0;
      // Successful parse + COMMITTED insert only: record the rev in the normal
      // cache (and clear any earlier bad-payload sentinel) so a future unchanged
      // rev correctly short-circuits again.
      // 2026-09-18: an aborted IDB transaction (quota, eviction mid-write) used to
      // land here too, pinning a file whose records were never actually stored.
      if(_evtRes && _evtRes.ok){
        if(typeof _qDiagPush === "function") _qDiagPush('evtPullOk', { name: ent.name, inserted: _evtInserted });
        revs[ent.name] = dl.rev || ent.rev || null;
        delete badRevs[ent.name];
      } else {
        if(typeof _qDiagPush === "function") _qDiagPush('evtPullInsertFailed', { name: ent.name });
        badRevs[ent.name] = { rev: dl.rev || ent.rev || null, at: now };
      }
    } else {
      if(typeof _qDiagPush === "function") _qDiagPush('evtPullSkip', { name: ent.name, reason: _evtParseFailed ? 'parseError' : 'notArray' });
      // Corrupt/unexpected payload: do NOT record it in `revs` -- that would
      // pin the file out of the pull forever (its writer may never change
      // the rev again). Track it separately with a timestamp instead, so it
      // is retried at a slower cadence (see badRevBackoff above) rather than
      // being silently skipped alongside healthy files.
      badRevs[ent.name] = { rev: dl.rev || ent.rev || null, at: now };
    }
  }
  // Bound badRevs: it must never grow without limit (a Dropbox account could
  // accumulate many stale/foreign files over time). Keep only the most
  // recently-touched EVT_BAD_REVS_MAX entries.
  const badKeys = Object.keys(badRevs);
  if(badKeys.length > EVT_BAD_REVS_MAX){
    badKeys.sort((a, b) => (badRevs[a].at || 0) - (badRevs[b].at || 0));
    for(let i = 0; i < badKeys.length - EVT_BAD_REVS_MAX; i++) delete badRevs[badKeys[i]];
  }
  syncCfgSave({
    evtFileRevs: revs,
    evtBadRevs: badRevs,
    evtLastPullAt: now,
    evtFullScanAt: isFullScan ? now : (lastFullScanAt || now)
  });
}

// Delete a single device's own /events files from Dropbox. Used by
// resetEverything() so a reset truly erases THIS device's event history from the
// cloud (other devices keep their own copies -- "this device only" scope). The
// Activity Feed's own-device filter means a same-deviceId reconnect already
// skips these, but deleting them also covers the identity-changed case and
// stops stale files from ever being re-pulled. No-op if not connected.
async function syncEventsDeleteDevice(devId){
  if(!devId || typeof dbxListFolder !== "function" || typeof dbxDelete !== "function") return;
  const entries = await dbxListFolder(EVENTS_DIR);
  for(const ent of entries){
    const parsed = evtParseFileName(ent.name);
    if(parsed && parsed.dev === devId){
      try{ await dbxDelete(EVENTS_DIR + "/" + ent.name); }catch(e){ /* best-effort */ }
    }
  }
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
async function confirmForcePush(){
  if(typeof confirmDialog!=="function"){
    if(typeof toast==="function") toast('Force push unavailable right now (confirmation dialog missing).');
    return;
  }
  // Surface the local event count so the user has a signal for whether THIS
  // device is the well-synced one before nuking Dropbox's copy of the state.
  // NOTE: force push only overwrites remote STATE (syncSubset() -> dbxUpload
  // (STATE_PATH, ...) in syncForcePush()/_syncForcePushAttempt() above) -- it
  // never touches the event log, so a low count here is a hint about THIS
  // device's history, not a claim that events are at risk on the remote.
  // countEvents() (app.js) resolves 0 on any failure and is optional per this
  // file's typeof-guard convention (see syncDeviceId() above, ~line 60), so a
  // missing/throwing/rejecting global just means we skip the sentence.
  let n = null;
  if(typeof countEvents==="function"){
    try{ const c = await countEvents(); if(typeof c === "number" && !isNaN(c)) n = c; }
    catch(e){ n = null; }
  }
  let text = "This replaces the data in Dropbox with what's on THIS device. Anything saved on other devices that hasn't synced yet will be permanently lost. This cannot be undone.";
  if(n !== null){
    text += " This device has " + n + " local event" + (n === 1 ? "" : "s") + ".";
    // Advisory only, not a hard gate: below this, THIS device's own event
    // history looks thin, which can mean it hasn't been the synced device in
    // a while -- worth a second look before overwriting Dropbox's state.
    if(n < 50){
      text += " If that looks low, it may not be the most up-to-date device.";
    }
  }
  confirmDialog('Force push — overwrite Dropbox?', text).then(ok=>{
    if(!ok) return;
    if(typeof toast==="function") toast('Pushing this device\'s data to Dropbox\u2026');
    syncForcePush();
  });
}
// F4 (2026-08-18): the shrink-block toast tells the user to press "Force Push Events"
// in Settings. That button did not exist, so the instruction was unfollowable.
// This is FAR safer than a state force push: event files are an additive union with no
// tombstones, so re-pushing them cannot delete anything on the other device. The copy
// below stays calm for that reason -- do not reuse confirmForcePush's warning text.
async function confirmEventsForcePush(){
  if(typeof confirmDialog!=="function"){
    if(typeof toast==="function") toast('Force push unavailable right now (confirmation dialog missing).');
    return;
  }
  let text = "This re-uploads this device's event history to Dropbox, overriding a blocked push. Event files only ever get added together, so nothing on your other device can be deleted by this.";
  try{
    const _blocked = Object.keys((syncCfg().evtPushBlocked) || {}).length;
    if(_blocked > 0){
      text += " " + _blocked + " month file" + (_blocked === 1 ? " is" : "s are") + " blocked right now.";
    }
  }catch(e){ /* advisory only, never block the dialog */ }
  confirmDialog('Force Push Events?', text).then(ok=>{
    if(!ok) return;
    if(typeof toast==="function") toast('Re-uploading events to Dropbox\u2026');
    syncEventsForcePush();
  });
}
// Connect + force push in a single action, for the "fresh device, make Dropbox hold
// THIS device's data (don't merge the remote in)" case. The OAuth round-trip returns
// via syncHandleRedirect(), which normally auto-runs syncNow() (a merge) — so we
// can't connect-then-force-push from here, the merge would already have happened.
// Instead we stash an intent flag BEFORE redirecting; syncHandleRedirect() reads it
// and force-pushes instead of merging. Same hard-confirm gate as confirmForcePush()
// since it is equally destructive to whatever is already in Dropbox.
function confirmConnectForForcePush(){
  if(typeof confirmDialog!=="function"){
    if(typeof toast==="function") toast('Connect & Force Push unavailable right now (confirmation dialog missing).');
    return;
  }
  confirmDialog(
    'Connect and overwrite Dropbox?',
    "This connects to Dropbox and IMMEDIATELY overwrites the remote backup with THIS device's data, skipping the normal merge. Anything already saved in Dropbox will be permanently lost. This cannot be undone."
  ).then(ok=>{
    if(!ok) return;
    try{
      localStorage.setItem("questa.sync.pendingForcePush", "true");
    }catch(e){
      if(typeof toast==="function") toast('Could not start connect (storage unavailable).');
      return;
    }
    if(typeof toast==="function") toast('Connecting to Dropbox\u2026');
    syncConnect(true);
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
  // Drop any stale force-push intent left behind by an abandoned "Connect & Force
  // Push" (user bailed out mid-OAuth). BUT NOT on the redirect coming back: when a
  // ?code= is present, syncHandleRedirect() below must still see the flag to force
  // push instead of merging. On the redirect load, syncHandleRedirect() itself
  // consumes/clears the flag on every path.
  try{
    if(String((typeof location!=="undefined" && location.search) || "").indexOf("code=") === -1){
      localStorage.removeItem("questa.sync.pendingForcePush");
    }
  }catch(e){ /* best-effort */ }
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
  // T0: Boot self-heal for poisoned upload watermark (P1/P2)
  // Check if evtLastUploadTs is in the future (any future value, not just >120s)
  // If so, reset it to the max local event ts and warn the user.
  (function(){
    try{
      const cfg = syncCfg();
      const watermark = cfg.evtLastUploadTs || 0;
      const now = Date.now();
      if(watermark > now){
        // Watermark is in the future - this device has stopped uploading
        // Find the max ts in the local event store
        if(typeof idbOpen === "function" && typeof getEvents === "function"){
          idbOpen().then(function(db){
            try{
              const tx = db.transaction("events","readonly");
              const store = tx.objectStore("events");
              const idx = store.index("ts");
              const req = idx.openCursor(null, "prev"); // descending, first = max
              // 2026-09-18 (round 2): an ASYNC request error or a transaction abort
              // is not caught by the surrounding try/catch, which only sees
              // synchronous throws. Without these handlers a read failure meant the
              // repair simply never happened: the future watermark stayed in place,
              // evtUploadable's `e.ts > sinceTs` rejected every real event, the
              // device uploaded nothing until wall-clock time overtook the poison,
              // and the diagnostic showed no repair had even been attempted. Fall
              // back to exactly what the two IDB-failure arms below already do.
              let _repairDone = false;
              const _repairFallback = function(err){
                if(_repairDone) return; _repairDone = true;
                syncCfgSave({ evtLastUploadTs: 0 });
                if(typeof _qDiagPush === "function"){
                  _qDiagPush('evtWatermarkRepaired', { was: watermark, now: now, resetTo: 0, maxLocalTs: 0, eventCount: 0, error: String(err) });
                }
              };
              req.onerror = function(){ _repairFallback(req.error || 'cursor failed'); };
              try{ tx.onabort = function(){ _repairFallback(tx.error || 'transaction aborted'); }; }catch(e){}
              req.onsuccess = function(){
                _repairDone = true;
                const cursor = req.result;
                const maxLocalTs = cursor ? cursor.value.ts : 0;
                const eventCount = cursor ? 1 : 0; // we only need max, but count for diag
                // Count all events for diag
                const countReq = store.count();
                countReq.onerror = function(){ _repairDone = false; _repairFallback(countReq.error || 'count failed'); };
                countReq.onsuccess = function(){
                  const totalCount = countReq.result;
                  // 2026-09-18: reset to 0, not to the max local ts. maxLocalTs is the
                  // NEWEST event in the store, so `from: maxLocalTs + 1` excluded every
                  // event by construction — the repair re-uploaded nothing while the
                  // toast promised "Events will upload on next sync". Worse, when the
                  // poison came from clock skew the skewed event IS maxLocalTs, so
                  // nothing uploaded until wall-clock time overtook it. A full re-scan
                  // is cheap: the month rebuild is idempotent, and the IDB-failure
                  // fallbacks a few lines below already use 0.
                  const resetTo = 0;
                  syncCfgSave({ evtLastUploadTs: resetTo });
                  if(typeof _qDiagPush === "function"){
                    _qDiagPush('evtWatermarkRepaired', { 
                      was: watermark, 
                      now: now, 
                      resetTo: resetTo, 
                      maxLocalTs: maxLocalTs, 
                      eventCount: totalCount 
                    });
                  }
                  // Surface to user: toast + persistent Settings note
                  if(typeof toast === "function"){
                    toast('Sync repaired: upload watermark was in the future (' + new Date(watermark).toISOString() + '). Reset to ' + new Date(resetTo).toISOString() + '. Events will upload on next sync.');
                  }
                  // Persistent Settings note - store in localStorage for Settings to read
                  try{
                    const notes = JSON.parse(localStorage.getItem('questa.sync.watermarkNotes') || '[]');
                    notes.unshift({ at: now, was: watermark, resetTo: resetTo, maxLocalTs: maxLocalTs, eventCount: totalCount });
                    if(notes.length > 10) notes.length = 10;
                    localStorage.setItem('questa.sync.watermarkNotes', JSON.stringify(notes));
                  }catch(e){}
                };
              };
            }catch(e){
              // Fallback: reset to 0 if IDB fails
              syncCfgSave({ evtLastUploadTs: 0 });
              if(typeof _qDiagPush === "function"){
                _qDiagPush('evtWatermarkRepaired', { was: watermark, now: now, resetTo: 0, maxLocalTs: 0, eventCount: 0, error: String(e) });
              }
            }
          }).catch(function(e){
            // Fallback: reset to 0 if IDB fails
            syncCfgSave({ evtLastUploadTs: 0 });
            if(typeof _qDiagPush === "function"){
              _qDiagPush('evtWatermarkRepaired', { was: watermark, now: now, resetTo: 0, maxLocalTs: 0, eventCount: 0, error: String(e) });
            }
          });
        } else {
          // No IDB access - reset to 0
          syncCfgSave({ evtLastUploadTs: 0 });
          if(typeof _qDiagPush === "function"){
            _qDiagPush('evtWatermarkRepaired', { was: watermark, now: now, resetTo: 0, maxLocalTs: 0, eventCount: 0, error: 'noIDB' });
          }
        }
      }
    }catch(e){ /* best-effort */ }
  })();
  window.addEventListener("online", () => syncNow());
  // 2026-09-18 (round 2): both arms of the old `if` called syncNow() identically,
  // so the branch was provably dead and its comment described behaviour the code
  // did not have. Collapsed to the one call that was actually happening.
  document.addEventListener("visibilitychange", () => { syncNow(); });
  setTimeout(() => {
    // F2 / D3 todo 14: tell app.js the first sync round settled, so its boot
    // day-rollover decision runs on POST-sync state instead of pre-sync state
    // (app.js onQuestaFirstSyncRound -> _runDayRollover -> startDay).
    // syncNow() ALWAYS fulfils and never rejects, so the rollover proceeds after a
    // FAILED round too -- that is required, not incidental. Idempotence is app.js's
    // _dayRolloverDone flag, not ours: firing twice is safe.
    // Defensive on both sides. `fire` is typeof-guarded per AGENTS.md §1 so a
    // missing or broken app.js cannot break syncInit(); the return value is only
    // treated as a promise if it is actually thenable, because a naive .then() on an
    // `undefined` return would throw inside this timer and the day would NEVER roll
    // over -- the worst failure mode in the boot-gate plan.
    var fire = function(){
      try{ if(typeof onQuestaFirstSyncRound === "function") onQuestaFirstSyncRound(); }catch(e){}
    };
    var p;
    try{ p = syncNow(); }catch(e){ fire(); return; }
    if(p && typeof p.then === "function") p.then(fire, fire); // both handlers
    else fire();
  }, 2000); // let the app finish booting first
}

// Exposed for the Settings screen (Phase 4) and for manual console testing.
if(typeof window !== "undefined"){
  window.QuestaSync = {
    connect: syncConnect,
    connectForForcePush: confirmConnectForForcePush,
    disconnect: syncDisconnect,
    now: syncNow,
    forcePush: syncForcePush,
    confirmForcePush: confirmForcePush, // test-only-motivated export (W3.6): exercise the event-count copy directly
    forcePull: syncForcePull,
    cfg: syncCfg,
    merge: merge, // exposed so it can be unit-tested from the browser console too
    // 2026-09-18: test-only-motivated export, same rationale as confirmForcePush.
    // syncApply's missing-key policy is a data-loss surface on the force-pull path
    // (it applies the RAW remote), so it needs a direct unit test — see
    // tests/sync-apply-absent-keys.test.js.
    apply: syncApply,
    mergeCollection: mergeCollection,
    resolveDailyConflict: resolveDailyConflict, // F3 (2026-07-11): daily-aware both-changed tiebreak, exposed for unit tests
    normalizeDailyResets: normalizeDailyResets, // F3 (2026-07-11): reset overlay, exposed for unit tests
    mergeChecklist: mergeChecklist, // F4 (2026-07-11): per-subtask merge, exposed for unit tests
    dailyEventDay: dailyEventDay,
    mergeDevices: mergeDevices,
    cleanDevices: cleanDevices,
    mergeDayArray: mergeDayArray,
    // K3 (2026-09-11): earnings accumulate internals, exposed for unit tests only.
    // tests/earnings-accumulate.test.js asserts the level curve here matches app.js's.
    k3Helpers: { charTotalXp: _charTotalXp, charFromTotalXp: _charFromTotalXp, charCanonical: _charCanonical,
                 charAccumulate: _charAccumulate, accumCounter: _accumCounter, xpNeed: _xpNeed },
    exportBackup: exportSaveDropbox,
    maybeAutoExport: syncMaybeAutoExport,
    eventsPush: syncEventsPush,
    eventsPull: syncEventsPull,
    eventsDeleteDevice: syncEventsDeleteDevice,
    eventsSync: syncEventsSync,
    eventsForcePush: syncEventsForcePush, // T1: force-push override for shrink guard
    evtHelpers: { evtMonthKey, evtMonthRange, evtParseFileName, evtUploadable, evtOwnMonthRecords, evtIncomingFilter, evtIncomingSig, evtUidDisambiguate, evtMonthOlderThan, uidHash, uidsAreSuperset },
    _testOnly: { _conflictLogThrottleReset: function(){ _conflictLogThrottle.clear(); } }
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
// T1: Force-push override for event shrink guard
// Allows user to explicitly override the shrink guard and push a smaller month file
async function syncEventsForcePush(){
  return syncEventsPush({ force: true, forceFullPush: true });
}

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
