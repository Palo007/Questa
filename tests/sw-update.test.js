// sw-update.test.js -- 2026-09-26 (design D4, PWA-11 + PWA-12, DEC-P06 option A).
//
// The service worker keeps auto-activating (skipWaiting + clients.claim). The page
// shows an "Update ready" banner when a NEW worker takes over a page that already
// had one, and reloads ONLY when the user taps it. The cache is named after the
// build (questa-<APP_VERSION>) so every stamp bump is also a cache bump.
//
//   T1  offline, app.js not cached -> network error, NOT index.html
//   T2  online 404 for sync.js, not cached -> the real 404, NOT index.html
//   T3  offline navigation (?tab= shortcut) still gets index.html
//   T4  shell GETs revalidate: fetch(..., {cache:"no-cache"})
//   T5  sw.js VERSION === app.js APP_VERSION and CACHE === "questa-" + VERSION
//   T6  register() rejection is logged (swRegisterFail) and reminders still start
//   T7a shouldOfferSwUpdate truth table
//   T7b controllerchange with a boot controller -> ONE banner, no auto reload;
//       tap -> reloadApp('swUpdate') once
//   T7c first install (no boot controller) -> no banner
//   T7d tap while a sheet is open -> no reload, a toast instead
//   T7e tap while a sync is in flight -> waits for it, capped at 5 s
//   T8  install still skipWaiting()s and fills the cache with cache:"reload";
//       SHOW_NOTIFICATION still shows a notification (TWA reminders)
//   T9  foreground update check is throttled to once per 30 min
//   T10 activate deletes the old questa-vNNN cache, keeps the current one, claims
//   T11 activate leaves other apps' caches on palo007.github.io alone: only
//       names starting with "questa-" (and not the current one) are deleted
//
// Run: node tests/sw-update.test.js  (also run by node tests/run.js)

const fs = require('fs'), path = require('path'), vm = require('vm');
const { extractFunction, extractLine } = require('./_extract');

const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name); }
}
function tryExtract(fnName){
  try { return extractFunction(appSrc, new RegExp('^function ' + fnName + '\\('), fnName); }
  catch(e){ console.log('  (extract ' + fnName + ': ' + e.message + ')'); return null; }
}
const tick = () => new Promise(r => setImmediate(r));

// ---------------------------------------------------------------------------
// sw.js harness: the whole file runs in a vm with fake self/caches/fetch.
// ---------------------------------------------------------------------------
const BASE = 'https://palo007.github.io/Questa/';
const keyOf = r => new URL(typeof r === 'string' ? r : r.url, BASE).href;

function makeSw(opts){
  opts = opts || {};
  const handlers = {};
  const store = new Map();             // cacheName -> Map(url -> response)
  const calls = { fetch: [], skipWaiting: 0, claim: 0, notify: [] };
  const cacheObj = name => {
    if(!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      addAll: reqs => { reqs.forEach(r => m.set(keyOf(r), { body: 'ASSET ' + keyOf(r), init: r.init })); return Promise.resolve(); },
      put: (req, res) => { m.set(keyOf(req), res); return Promise.resolve(); },
      match: req => Promise.resolve(m.get(keyOf(req))),
    };
  };
  const caches = {
    open: name => Promise.resolve(cacheObj(name)),
    keys: () => Promise.resolve([...store.keys()]),
    delete: name => Promise.resolve(store.delete(name)),
    match: req => { for(const m of store.values()){ const h = m.get(keyOf(req)); if(h) return Promise.resolve(h); } return Promise.resolve(undefined); },
  };
  class Request { constructor(url, init){ this.url = keyOf(url); this.init = init || {}; } }
  const Response = { error: () => ({ type: 'error' }) };
  const fetch = (req, init) => {
    calls.fetch.push({ url: keyOf(req), init: init });
    return opts.fetch ? opts.fetch(req, init) : Promise.reject(new TypeError('offline'));
  };
  const self = {
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: () => { calls.skipWaiting++; return Promise.resolve(); },
    clients: { claim: () => { calls.claim++; return Promise.resolve(); }, matchAll: () => Promise.resolve([]) },
    registration: { showNotification: (t, o) => { calls.notify.push({ t, o }); return Promise.resolve(); } },
  };
  const ctx = { self, caches, fetch, Request, Response, URL, console };
  vm.createContext(ctx);
  vm.runInContext(swSrc, ctx);
  return { ctx, handlers, store, calls, caches };
}
function fire(sw, req){
  let p;
  sw.handlers.fetch({ request: Object.assign({ method: 'GET' }, req), respondWith(x){ p = x; } });
  return p;
}
function waitEv(sw, type, extra){
  let p = Promise.resolve();
  sw.handlers[type](Object.assign({ waitUntil(x){ p = x; } }, extra || {}));
  return p;
}
const INDEX = { body: 'INDEX' };
function seedIndexOnly(sw){ sw.store.set('seed', new Map([[keyOf('./index.html'), INDEX]])); }

(async function main(){
  // --- T1-T4 fetch handler ---------------------------------------------------
  {
    const sw = makeSw(); seedIndexOnly(sw);
    const r = await fire(sw, { url: BASE + 'app.js', mode: 'no-cors' });
    ok(r !== INDEX && r && r.type === 'error', 'T1 offline uncached app.js -> network error, not index.html');
  }
  {
    const r404 = { ok: false, status: 404, clone(){ return this; } };
    const sw = makeSw({ fetch: () => Promise.resolve(r404) }); seedIndexOnly(sw);
    const r = await fire(sw, { url: BASE + 'sync.js', mode: 'no-cors' });
    ok(r === r404, 'T2 online 404 uncached sync.js -> the real 404, not index.html');
  }
  {
    const sw = makeSw(); seedIndexOnly(sw);
    const r = await fire(sw, { url: BASE + '?tab=habits', mode: 'navigate' });
    ok(r === INDEX, 'T3 offline navigation ?tab=habits -> index.html');
  }
  {
    const okRes = { ok: true, status: 200, clone(){ return this; } };
    const sw = makeSw({ fetch: () => Promise.resolve(okRes) });
    for(const [u, mode] of [['app.js', 'no-cors'], ['sync.js', 'no-cors'], ['', 'navigate']]){
      await fire(sw, { url: BASE + u, mode });
    }
    const allNoCache = sw.calls.fetch.length === 3 && sw.calls.fetch.every(c => c.init && c.init.cache === 'no-cache');
    ok(allNoCache, 'T4 shell fetches pass {cache:"no-cache"} (got ' + JSON.stringify(sw.calls.fetch.map(c => c.init)) + ')');
  }

  // --- T5 one version stamp ------------------------------------------------------
  let swVersion = '';
  {
    const appVer = (appSrc.match(/^const APP_VERSION\s*=\s*"([^"]+)"/m) || [])[1] || '';
    swVersion = (swSrc.match(/^const VERSION\s*=\s*"([^"]+)"/m) || [])[1] || '';
    let cache = '';
    try { cache = vm.runInContext('CACHE', makeSw().ctx); } catch(e){}
    ok(appVer !== '' && swVersion === appVer, 'T5a sw.js VERSION "' + swVersion + '" === APP_VERSION "' + appVer + '"');
    ok(swVersion !== '' && cache === 'questa-' + swVersion, 'T5b CACHE "' + cache + '" === "questa-" + VERSION');
  }

  // --- T8 install / message guards ------------------------------------------------
  {
    const sw = makeSw();
    await waitEv(sw, 'install');
    let cache = ''; try { cache = vm.runInContext('CACHE', sw.ctx); } catch(e){}
    const m = sw.store.get(cache);
    const idx = m && m.get(keyOf('./index.html'));
    ok(sw.calls.skipWaiting === 1, 'T8a install calls skipWaiting()');
    ok(!!(idx && idx.init && idx.init.cache === 'reload'), 'T8b install fills CACHE from the network (cache:"reload")');
    await waitEv(sw, 'message', { data: { type: 'SHOW_NOTIFICATION', title: 'x', body: 'y' } });
    ok(sw.calls.notify.length === 1 && sw.calls.notify[0].t === 'x', 'T8c SHOW_NOTIFICATION shows a notification');
  }

  // --- T10 activate cleanup -----------------------------------------------------
  {
    const sw = makeSw();
    let cache = ''; try { cache = vm.runInContext('CACHE', sw.ctx); } catch(e){}
    sw.store.set('questa-v246', new Map());
    sw.store.set(cache, new Map());
    await waitEv(sw, 'activate');
    const keys = [...sw.store.keys()];
    ok(!keys.includes('questa-v246'), 'T10a activate deletes the old questa-v246 cache');
    ok(keys.length === 1 && keys[0] === cache, 'T10b activate keeps only the current cache (' + JSON.stringify(keys) + ')');
    ok(sw.calls.claim === 1, 'T10c activate calls clients.claim()');
  }

  // --- T11 activate spares other apps' caches ------------------------------------
  {
    const sw = makeSw();
    let cache = ''; try { cache = vm.runInContext('CACHE', sw.ctx); } catch(e){}
    sw.store.set('questa-v246', new Map());
    sw.store.set(cache, new Map());
    sw.store.set('other-app-v1', new Map());
    await waitEv(sw, 'activate');
    const keys = [...sw.store.keys()];
    ok(!keys.includes('questa-v246'), 'T11a activate deletes the old questa-v246 cache');
    ok(keys.includes('other-app-v1'), 'T11b activate leaves another app\'s cache alone');
    ok(keys.includes(cache), 'T11c activate keeps the current cache');
  }

  // ---------------------------------------------------------------------------
  // app.js side
  // ---------------------------------------------------------------------------
  const srcShould = tryExtract('shouldOfferSwUpdate');
  const srcBanner = tryExtract('showSwUpdateBanner');
  const srcTap = tryExtract('onSwUpdateTap');
  const srcReg = tryExtract('registerServiceWorker');
  const srcCheck = tryExtract('maybeCheckSwUpdate');
  let srcLast = null;
  try { srcLast = extractLine(appSrc, /^var _swLastUpdateCheck\s*=/, '_swLastUpdateCheck'); } catch(e){}

  // T7a
  {
    const c = {}; vm.createContext(c);
    let t = false;
    if(srcShould){
      vm.runInContext(srcShould, c);
      t = c.shouldOfferSwUpdate(true, false) === true
        && c.shouldOfferSwUpdate(false, false) === false
        && c.shouldOfferSwUpdate(true, true) === false
        && c.shouldOfferSwUpdate(false, true) === false;
    }
    ok(t, 'T7a shouldOfferSwUpdate(hadController, alreadyShown) truth table');
  }

  function el(tag){
    const e = { tag, className: '', style: {}, children: [], textContent: '', onclick: null,
      appendChild(c){ this.children.push(c); return c; },
      remove(){ this.removed = true; },
      classList: { _s: new Set(), contains(k){ return this._s.has(k); }, add(k){ this._s.add(k); } } };
    return e;
  }
  function makeApp(o){
    o = o || {};
    const log = { reload: 0, reloadApp: [], toast: [], events: [], sched: 0, timers: [], upd: 0 };
    const swListeners = {};
    const toastBox = el('div'), scrim = el('div');
    if(o.sheetOpen) scrim.classList.add('show');
    const ctx = {
      log, swListeners, toastBox,
      document: {
        getElementById: id => id === 'toast' ? toastBox : id === 'scrim' ? scrim : null,
        createElement: el,
      },
      navigator: { serviceWorker: {
        controller: o.controller === undefined ? { scriptURL: 'sw.js' } : o.controller,
        addEventListener: (t, fn) => { (swListeners[t] = swListeners[t] || []).push(fn); },
        register: () => o.regReject ? Promise.reject(new Error('boom')) : Promise.resolve({}),
        getRegistration: () => { log.upd++; return Promise.resolve({ update(){ return Promise.resolve(); } }); },
      } },
      location: { reload(){ log.reload++; } },
      reloadApp: r => { log.reloadApp.push(r); },
      toast: m => { log.toast.push(m); },
      logEvent: ev => { log.events.push(ev); },
      startReminderScheduler: () => { log.sched++; },
      setTimeout: (fn, ms) => { log.timers.push({ fn, ms }); return log.timers.length; },
      _syncInFlight: o.syncInFlight || null,
    };
    vm.createContext(ctx);
    for(const s of [srcShould, srcBanner, srcTap, srcReg, srcCheck, srcLast]) if(s) vm.runInContext(s, ctx);
    return ctx;
  }
  const fireCC = ctx => (ctx.swListeners.controllerchange || []).forEach(f => f({}));
  const banners = ctx => ctx.toastBox.children.filter(c => !c.removed);
  const buttonOf = b => b && b.children.find(c => c.tag === 'button');
  const have = !!(srcShould && srcBanner && srcTap && srcReg);

  // T6
  {
    let t = false, t2 = false;
    if(srcReg){
      const ctx = makeApp({ regReject: true });
      ctx.registerServiceWorker(); await tick(); await tick();
      t = ctx.log.events.some(e => e.kind === 'lifecycle' && e.detail === 'swRegisterFail' && /boom/.test(e.error || '')) && ctx.log.sched === 1;
      const ctx2 = makeApp();
      ctx2.registerServiceWorker(); await tick(); await tick();
      t2 = ctx2.log.sched === 1 && ctx2.log.events.length === 0;
    }
    ok(t, 'T6a register() rejection logs lifecycle swRegisterFail AND starts reminders');
    ok(t2, 'T6b register() success starts reminders and logs nothing');
  }

  // T7b
  {
    let one = false, noAuto = false, stillOne = false, tapped = false, text = false;
    if(have){
      const ctx = makeApp();
      ctx.registerServiceWorker(); await tick();
      fireCC(ctx);
      one = banners(ctx).length === 1;
      noAuto = ctx.log.reload === 0 && ctx.log.reloadApp.length === 0;
      fireCC(ctx);
      stillOne = banners(ctx).length === 1;
      const b = banners(ctx)[0];
      text = !!(b && /update ready/i.test(b.textContent) && b.style.animation === 'none' && buttonOf(b));
      const btn = buttonOf(b);
      if(btn && btn.onclick) btn.onclick();
      tapped = ctx.log.reloadApp.length === 1 && ctx.log.reloadApp[0] === 'swUpdate' && ctx.log.reload === 0;
    }
    ok(one, 'T7b1 controllerchange with a boot controller shows ONE banner');
    ok(noAuto, 'T7b2 no automatic reload on controllerchange');
    ok(stillOne, 'T7b3 a second controllerchange adds no second banner');
    ok(text, 'T7b4 banner says "Update ready", does not fade (animation none), has a button');
    ok(tapped, "T7b5 tapping the banner calls reloadApp('swUpdate') once");
  }
  // T7c
  {
    let t = false;
    if(have){
      const ctx = makeApp({ controller: null });
      ctx.registerServiceWorker(); await tick();
      fireCC(ctx);
      t = banners(ctx).length === 0 && ctx.log.reloadApp.length === 0;
    }
    ok(t, 'T7c first install (no controller at boot) shows no banner');
  }
  // T7d
  {
    let t = false;
    if(have){
      const ctx = makeApp({ sheetOpen: true });
      ctx.registerServiceWorker(); await tick();
      fireCC(ctx);
      const btn = buttonOf(banners(ctx)[0]);
      if(btn && btn.onclick) btn.onclick();
      t = !!btn && ctx.log.reloadApp.length === 0 && ctx.log.toast.length === 1 && banners(ctx).length === 1;
    }
    ok(t, 'T7d tap with a sheet open: no reload, a toast, banner stays');
  }
  // T7e
  {
    let waits = false, after = false, capped = false;
    if(have){
      let resolve;
      const p = new Promise(r => { resolve = r; });
      const ctx = makeApp({ syncInFlight: p });
      ctx.registerServiceWorker(); await tick();
      fireCC(ctx);
      buttonOf(banners(ctx)[0]).onclick();
      await tick();
      waits = ctx.log.reloadApp.length === 0;
      resolve(); await tick(); await tick();
      const cap = ctx.log.timers.find(t => t.ms === 5000);
      if(cap) cap.fn();
      after = ctx.log.reloadApp.length === 1;

      const ctx2 = makeApp({ syncInFlight: new Promise(() => {}) });
      ctx2.registerServiceWorker(); await tick();
      fireCC(ctx2);
      buttonOf(banners(ctx2)[0]).onclick();
      await tick();
      const cap2 = ctx2.log.timers.find(t => t.ms === 5000);
      if(cap2) cap2.fn();
      capped = !!cap2 && ctx2.log.reloadApp.length === 1;
    }
    ok(waits, 'T7e1 tap during a sync waits for it');
    ok(after, 'T7e2 reloads exactly once after the sync settles (cap timer is then a no-op)');
    ok(capped, 'T7e3 a hung sync is capped at 5 s, then reloads once');
  }
  // T9
  {
    let t = false;
    if(srcCheck && srcLast){
      const ctx = makeApp();
      const T0 = 1e12;
      ctx.maybeCheckSwUpdate(T0);
      ctx.maybeCheckSwUpdate(T0 + 29 * 60 * 1000);
      const mid = ctx.log.upd;
      ctx.maybeCheckSwUpdate(T0 + 31 * 60 * 1000);
      t = mid === 1 && ctx.log.upd === 2;
    }
    ok(t, 'T9a foreground SW update check runs at most once per 30 min');
    ok(/^registerServiceWorker\(\);/m.test(appSrc), 'T9b wiring: registerServiceWorker() is called at boot');
    ok(/visibilitychange[\s\S]{0,200}checkReminders\(\);[\s\S]{0,120}maybeCheckSwUpdate\(Date\.now\(\)\)/.test(appSrc),
      'T9c wiring: the reminder visibilitychange listener calls maybeCheckSwUpdate(Date.now())');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if(fail){ console.error('FAILED: ' + fail + ' sw-update assertion(s)'); process.exit(1); }
  console.log('ALL SW-UPDATE TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
