# Installing Questa fullscreen on Android

Goal: tap the home-screen icon and Questa opens **maximized — no address bar, no
browser buttons, no Android status bar.** The manifest is set to `fullscreen`, so the
only thing you need to do is install it as an app over a real (HTTPS) link.

> Why a link and not the file: Android only offers "Install app" — the thing that
> strips all browser UI — when the page is served over **HTTPS or localhost**.
> Opening `index.html` as a file gives you a browser tab with chrome, not an app.
> The host is used **once** for install; afterwards Questa runs fully offline and all
> data stays on your phone.

---

## Step by step (≈3 minutes)

### 1. Put the files online (on your computer)

The four files must stay together: `index.html`, `manifest.json`, `sw.js`, `icon.svg`.

1. Go to **https://app.netlify.com/drop** in any browser. (No account needed.)
2. Select all four files (or the folder) and **drag them onto the page**.
3. Netlify gives you a link like `https://questa-abc123.netlify.app`. Leave the tab open.

(Alternatives that work the same way: **tiiny.host**, or **GitHub Pages**.)

### 2. Install on the phone (Chrome on Android)

1. Open that `https://…` link in **Chrome** on your phone.
2. Tap the **⋮ menu** (top-right).
3. Tap **"Add to Home screen"**, then choose **"Install"** when it appears.
   - If you see "Add to Home screen" but not "Install", tap it anyway — on a valid
     PWA it still creates the app launcher. Make sure you're in Chrome, not a
     reader/incognito mode.
4. A Questa icon appears on your home screen.

### 3. Launch it

Tap the home-screen icon. Questa opens **edge-to-edge and maximized** — no browser
elements, no status bar. The first launch caches everything; after that it works
with no internet.

---

## If it doesn't go fullscreen

- **Address bar still shows** → you opened the link as a bookmark/tab, not via
  "Install". Delete the icon, reinstall using the ⋮ → Install step.
- **Status bar (clock/battery) still visible** → some Android skins ignore
  `fullscreen` and fall back to `standalone` (no browser bar, but status bar stays).
  That's a device limitation, not a bug; the app is still chrome-free.
- **Only Samsung Internet available** → it supports install too: **≡ menu → Add page
  to → Home screen**. Chrome gives the most reliable fullscreen result.
- **Changed the files and want the update** → re-drag to Netlify (or your host),
  open the link once in Chrome to let the service worker update, then relaunch.

---

## Moving progress between devices

1. In Questa: **gear icon (top-right) → Export** → save `questa-backup-YYYYMMDD.json`.
2. On the other phone, install Questa, open **gear → Import**, pick the file, confirm.

Export regularly — uninstalling the app or clearing its data erases the on-device
save, and the export file is your only backup.

---

100% local. No account, no server holds your data. Styled after Habitica with original
assets; not affiliated with Habitica.
