# Questa Synchronization & Integration Guide

This guide documents **Option B: The Git Remote Pull Method (Semi-Automated)** to seamlessly sync your updates from Google AI Studio into your existing GitHub repository using VS Code, including instructions for resolving initial merge conflicts.

---

## 1. Quick Setup in VS Code

You can run these commands directly inside the **VS Code Terminal** (``Ctrl + ` `` or ``Cmd + ` ``).

### Step 1: Add the AI Studio Shared Build as a Remote
Add a new git remote pointing to the git repository of your AI Studio applet:
```bash
git remote add questa-temp-sync https://github.com/aistudio-build/2d556de8-722e-4215-9905-a9ba6fd886f0.git
```

### Step 2: Fetch the Latest Changes
```bash
git fetch questa-temp-sync
```

### Step 3: Trigger the Merge (Allowing Unrelated Histories)
Since the local and remote repositories don't share a common commit history initially, you must allow unrelated histories on the first merge:
```bash
git merge questa-temp-sync/main --allow-unrelated-histories -m "Sync updates from AI Studio"
```

---

## 2. Resolving the Initial Merge Conflicts

During the first sync, Git will detect conflicts because the same files (`app.js`, `index.html`, `.gitignore`, `sw.js`, and icons) exist in both trees but don't share history. Here is how to clean them up cleanly:

### A. Binary Files (Icons)
Git cannot automatically merge binary files (`icon-192.png` and `icon-512.png`). You should resolve these conflicts by choosing the latest assets from the AI Studio workspace:

To accept the AI Studio version (incoming changes):
```bash
git checkout --theirs icon-192.png icon-512.png
git add icon-192.png icon-512.png
```

### B. Text Files (`.gitignore`, `app.js`, `index.html`, `sw.js`)
Open each conflicting file in VS Code. VS Code's **Source Control Tab** will list these under "Merge Changes". Clicking on any of these files will open the interactive merge conflict editor.

1. **`.gitignore`**:
   - You want to keep the custom whitelisting rules that ignore unnecessary workspace cruft but track the core files.
   - Choose **Accept Incoming Change** (from AI Studio) or keep the version with the whitelist rule.
   - Stage the file once resolved: `git add .gitignore`

2. **`app.js`, `index.html`, `sw.js`**:
   - The AI Studio builds contain all the new features (e.g. customized scrollable layouts, optimized buttons, and XP/Gold/MP/HP indicators).
   - In almost all cases, you should **Accept Incoming Change** (the version from `questa-temp-sync/main`) so that you get the latest polished application state.
   - If you have any custom configurations in your local main branch, you can copy-paste them in or choose "Accept Both Changes" and adjust manually.
   - Stage the files:
     ```bash
     git add app.js index.html sw.js
     ```

### C. Commit the Resolved Merge
Once all conflicts are resolved and staged (which you can verify via `git status` showing all green/staged files), complete the merge commit:
```bash
git commit -m "Merge and resolve conflicts with AI Studio"
```

---

## 3. Seamless Future Syncs (Zero Conflicts)

For all future updates, syncing will be extremely simple and conflict-free because Git now understands the shared history:

1. Fetch changes:
   ```bash
   git fetch questa-temp-sync
   ```
2. Merge changes:
   ```bash
   git merge questa-temp-sync/main -m "Sync updates from AI Studio"
   ```
3. Push to your main GitHub repository:
   ```bash
   git push origin main
   ```

---

## 4. One-Line PowerShell Command (For Automated & Smooth Syncs)

If you are using PowerShell on Windows (or inside the VS Code Terminal), you can run this robust **single-line command** to fetch, automatically merge (resolving any line conflicts in favor of the incoming AI Studio build), and push directly to your public repository:

```powershell
git checkout main; git fetch questa-temp-sync; git merge -X theirs --allow-unrelated-histories questa-temp-sync/main -m "Sync updates from AI Studio"; git push origin main
```

### Why this is completely safe & error-free:
- **`git checkout main`**: Ensures you are on your primary branch before running the sync.
- **`git fetch questa-temp-sync`**: Safely retrieves the latest commits from the AI Studio workspace.
- **`-X theirs`**: This is the magic flag! In the event of any line-by-line conflict, Git will **automatically choose the incoming AI Studio changes** as the winner, bypassing manual merge reviews.
- **`--allow-unrelated-histories`**: Ensures that even on the very first sync, the command will not error out with an "unrelated histories" warning.
- **`;`**: Powershell's command chainer, ensuring each command runs sequentially.
