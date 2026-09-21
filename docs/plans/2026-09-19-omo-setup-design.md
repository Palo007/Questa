# OmO-for-Cline Setup for Android Studio Agent Design Document

## Goal
Adapt and setup the OmO (oh-my-openagent) work discipline to operate seamlessly within an Android Studio agent environment using `.cline/` as the project-local runtime directory, and custom global skills for role execution.

## Architecture
- **Global Skills Layer:** 9 specialized roles placed under `C:\Users\user\.agents\skills\omo-*` folders, complying with the exact YAML frontmatter and markdown body protocol.
- **Project-Local Runtime Layer:** All ongoing state, todo logs, and continuation files live inside `C:\Users\user\Documents\Opti\.cline/`.
- **Global / Project Rules Integration:** Core protocol constraints and workflows are written directly to `AGENTS.md` / `CLAUDE.md` to ensure they are persistently in context.

## Components
1. **Global Skills Configuration:** 9 folders under `C:\Users\user\.agents\skills/`.
2. **Project Local Skeleton:** `.cline/` structure inside `C:\Users\user\Documents\Opti/`.
3. **Always-On Rules Wiring:** Updating `AGENTS.md` and `.gitignore`.
