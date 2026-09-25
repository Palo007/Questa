# CR-PWA-001 (from CR-TWA-004): once reminder with no date

- `input_state_once_no_date.json`: `S.tasks` with a once reminder without `date`, a once reminder with a date, and a weekly habit reminder.
- `expected_reminders.json`: the `/inbox-meta/reminders.json` body the FIXED `syncInboxWriteReminders` (Opti sync.js) uploads for that input. The undated once item is not emitted. The other keys keep their reminder index (`<taskId>#<idx>`).
- `updatedAt` is `Date.now()` at upload time. Compare everything except it. The file has no hash field. The writer keeps `_inboxHash(JSON.stringify(items))` locally in `syncCfg().inboxRemindersHash`: fixed = `781f046d:348`, HEAD (3 items) = `54ef38cf:505`.
- Produced by running the real sync.js/app.js functions in a node vm at Opti c69461e, plus the one-line guard. Never edit this file after ACCEPTED (PROTOCOL P4).
