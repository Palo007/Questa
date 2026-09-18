# Installing and running Questa

Questa is a **static web app**. There is no build step, no package to install, no
server code and no database. Four files do the work — `index.html`, `app.js`,
`sync.js` and `sw.js` — plus the icons and `manifest.json`.

You only need one thing: a way to serve those files over **`http://` or
`https://`**.

---

## The one rule: do not open `index.html` from your file system

Double-clicking `index.html` gives you a `file://` URL, and that **will not
work properly**. Browsers refuse to register a service worker on `file://`, so
you lose offline support, the install-to-home-screen prompt and the update
mechanism. Dropbox sync cannot complete its login either, because the redirect
comes back to an origin the browser treats as opaque.

Serve the folder instead. Every option below does that.

---

## Option 1 — Run it locally (fastest way to try it)

Clone or download the repository, then start any static file server **in the
repository root** and open the address it prints.

Python (already installed on most machines):

```bash
python3 -m http.server 8080
```

Node, if you prefer:

```bash
npx serve -l 8080
```

Then open <http://localhost:8080> in your browser. That is the whole install.

Your data lives in that browser profile, under that exact origin
(`http://localhost:8080`). Change the port and the browser treats it as a
different site with an empty save file.

---

## Option 2 — Host it on GitHub Pages (what most people want)

1. Fork this repository, or push a copy to your own GitHub account.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   pick branch `main` and folder `/ (root)`, then **Save**.
4. Wait a minute. GitHub gives you a URL like
   `https://<your-username>.github.io/<repo-name>/`.

Open that URL on your phone or desktop. It is served over `https://`, so the
service worker registers and everything works offline afterwards.

**Note for Dropbox sync users:** your fork will be on a different address from
the original, and Dropbox will refuse to log in until you register that address.
See [Self-hosting and Dropbox sync](#self-hosting-and-dropbox-sync) below.

---

## Option 3 — Any other static host

Netlify, Cloudflare Pages, Vercel, an S3 bucket, nginx, Apache, a Raspberry Pi
on your LAN — anything that serves a folder over http(s) works. Upload the
repository root as-is. There is nothing to configure.

---

## Installing it as an app

Once the page is open over http(s):

- **Android / Chrome:** menu → *Add to Home screen* (or *Install app*).
- **iOS / Safari:** Share → *Add to Home Screen*.
- **Desktop Chrome / Edge:** the install icon at the right of the address bar.

After that it launches full-screen and runs with no network.

---

## Updating

`sw.js` uses a network-first strategy for the app shell, so a new version
appears **on the next launch** after you deploy it. There is nothing to press.

If you are hacking on the code and an old version seems stuck, bump the cache
name in `sw.js` (line 3, `const CACHE = "questa-vN"`) and reload twice.

---

## Self-hosting and Dropbox sync

Dropbox sync is **optional**. Everything else in Questa works without it, and
without any account at all.

If you do want it on your own copy, there is a step you cannot skip. Questa logs
in with Dropbox's PKCE flow, which sends the browser back to a `redirect_uri`
computed from the address the app is served from. **Dropbox rejects any redirect
URI that is not pre-registered on the app it belongs to.** The key shipped in
this repository is registered for the original deployment only, so on your own
address the login will fail.

To fix it, register your own Dropbox app:

1. Go to <https://www.dropbox.com/developers/apps> and **Create app**.
2. Choose **Scoped access**, then **App folder** access. Name it anything.
3. On the app's **Settings** tab, under **OAuth 2 → Redirect URIs**, add the
   exact address you serve Questa from, with no trailing slash — for example
   `https://your-name.github.io/questa` or `http://localhost:8080`. Add one
   entry per address you use.
4. On the **Permissions** tab, tick `files.content.read` and
   `files.content.write`, then **Submit**.
5. Copy the **App key** from the Settings tab. It is a public client id, not a
   secret.
6. In `sync.js`, replace the value of `DBX_APP_KEY` (near the top, around line
   17) with your app key.

Reload, then **Settings → Connect Dropbox**. It will work against your own app
folder now.

*(The key is also read from the sync config field `appKey` if one is set, which
is how a fork can override it without editing the file. There is no UI for that
field yet, so editing `DBX_APP_KEY` is the simpler route.)*

---

## Developing

The test suite needs Node and nothing else — no framework, no dependencies:

```bash
node tests/run.js
```

It runs every file in `tests/` and `archive/tests/` and exits non-zero if any of
them fail. Keep it green: it is the deploy gate.

The design documents in [`docs/`](./docs/) are the place to start if you want to
understand the sync and backup behaviour before changing it.

---

## Maintainer note

The old contents of this file — the workflow for merging an internal Google AI
Studio build into this repository — moved to
[`docs/MAINTAINER-SYNC.md`](./docs/MAINTAINER-SYNC.md). It is a private workflow
against a remote nobody else can reach, and it was never install instructions.
