# Frozen fixture: personal task board

`src/` is intentionally incomplete. The unchanged browser acceptance test is the candidate contract: a correct implementation must start with `node src/server.mjs <store-file>`, print one loopback port to stdout, and serve the UI at `/`.

The UI contract uses accessible names: `New task`, `Add task`, `Filter tasks`, `All tasks`, `Open tasks`, `Completed tasks`, and per-task `Toggle <title>`, `Edit <title>`, and `Delete <title>` controls. Enter creates/saves, Escape clears/cancels, and Space toggles a focused task. Create, edit/cancel, complete and uncomplete, delete, all/open/completed filtering, case-insensitive text filtering, reload, and process restart must retain server-side state. Browser/API actions have a deterministic 20-second suite bound. Run `npm test`; the frozen starter is expected to fail with `candidate UI root returned 404`.

Envelope: 30 minutes, Luna-medium (Terra-medium fallback), one clarification round of at most five minutes, no network or paid services.
