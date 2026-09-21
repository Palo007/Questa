# OmO Setup for Android Studio Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Install 9 global custom skills, set up the project-local `.cline/` runtime directories and seeds, and configure the rules and ignore lists.

**Architecture:** Custom global skills live under `C:\Users\user\.agents\skills/`. Project runtime state lives inside `.cline/`.

**Tech Stack:** Markdown, JSON.

---

### Task 1: Create Global Skill Directories and Files

**Files:**
- Create: `C:\Users\user\.agents\skills\omo-plan\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-critic-review\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-gap-analysis\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-compliance-audit\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-research\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-writing\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-ui-engineering\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-quick-execution\SKILL.md`
- Create: `C:\Users\user\.agents\skills\omo-hyperplan\SKILL.md`

**Step 1: Write omo-plan/SKILL.md**
Write the full Prometheus planner skill content ensuring all references look for `.cline/`.

**Step 2: Write omo-critic-review/SKILL.md**
Write the full Momus fault-finder critic review skill content.

**Step 3: Write omo-gap-analysis/SKILL.md**
Write the full Metis execution truth gap analysis skill content.

**Step 4: Write omo-compliance-audit/SKILL.md**
Write the full Oracle compliance audit skill content.

**Step 5: Write omo-research/SKILL.md**
Write the full research category skill content.

**Step 6: Write omo-writing/SKILL.md**
Write the full technical prose writing skill content.

**Step 7: Write omo-ui-engineering/SKILL.md**
Write the full frontend/UI visual verification skill content.

**Step 8: Write omo-quick-execution/SKILL.md**
Write the full fast-worker quick execution skill content.

**Step 9: Write omo-hyperplan/SKILL.md**
Write the full five-lens adversarial gauntlet hyperplan skill content.

---

### Task 2: Create Project Local Runtime Skeleton and Seeds

**Files:**
- Create: `C:\Users\user\Documents\Opti\.cline\boulder.json`
- Create: `C:\Users\user\Documents\Opti\.cline\prompts\next-review-prompt.md`
- Create empty files and placeholder structures under `C:\Users\user\Documents\Opti\.cline/` folders (`plans/`, `drafts/`, `notepads/`, `evidence/`, `run-continuation/`, `start-work/ledger.jsonl`).

**Step 1: Create boulder.json seed**
Seed file with `{"schema_version": 2, "active_work_id": null, "works": {}}`.

**Step 2: Create prompts/next-review-prompt.md**
Write review prompt template file.

**Step 3: Update project .gitignore**
Append `.cline/` to `.gitignore`.
