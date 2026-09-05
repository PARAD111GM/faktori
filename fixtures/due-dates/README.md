# Frozen fixture: due dates and overdue view

`starter.json` is immutable. `src/working-board.mjs` is a working, server-persistent copy of the full task-board baseline; `npm run test:base` must pass. `npm run test:acceptance` is intentionally red until the due-date feature is implemented.

Keep the baseline accessible contract, then add `Set due date <title>`, a `Due date <title>` editable date input that saves on Enter, visible `Due: YYYY-MM-DD` text, and an `Overdue tasks` filter. With fixed today `2026-09-04`, yesterday is overdue; today and missing dates are excluded; completed overdue tasks remain visible. Dates must survive reload and server restart. The browser/API suite is bounded at 20 seconds.

Envelope: 30 minutes, Luna-medium (Terra-medium fallback), one clarification round of at most five minutes, no network or paid services.
