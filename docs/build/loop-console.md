# Manager Loop Console integration

## Scope

Expose explicitly registered Manager Loop records in the existing Console on
Overview and Work, using its existing live state connection. Keep the loop
runner authoritative: this view cannot start, cancel, resume, approve, or
publish loop work. Replace the sidebar symbol with the owner-supplied SVG.

## Implementation

- Owner configuration selects artifact directories; browser requests cannot
  select filesystem paths. Each source must match the recorded loop identity.
- A read-only observer projects phase acceptance, current recorded step,
  execution outcomes, review decisions, verification results, and repair history.
- Changed summaries reach connected clients through the existing event stream.
  Missing or invalid records stay visible as unavailable. Recorded running
  status does not establish worker liveness.
- React renders the same scoped component in both views, with expandable history
  and no extra control authority. The frontend-patterns skill guided reuse of
  the existing state connection and a shared presentation component.
- No new dependencies, provider calls, scheduler, or workflow editor.

## Verification (2026-09-09)

- Typecheck and production build passed under Node 24.20.0/npm 12.0.2.
- Final regression suite including observer and presentation coverage: 390 tests
  across 48 files passed with four workers. The initial restricted run could not bind local sockets or
  inspect native process identity; rerunning with local permissions passed.
- New observer and presentation checks: 12 tests passed, including real file
  changes pushed to an already-connected event client, stale-state transitions,
  missing/malformed sources, redacted projections, scoped UI, and escaped text.
- Clean temporary package installation and CLI verification passed.
- Installed local Console displayed a preserved successful two-phase Codex
  proof on Overview and Work: two accepted phases, eight stage receipts,
  separate passing reviews/verification, and zero repair attempts. This was
  observation of existing evidence, not a new paid provider execution.
- Browser inspection confirmed the uploaded orange logo and expandable history;
  no browser errors were reported during the successful Console session.
- Independent review identified pod-only registrations disappearing under
  product filters and accepted loop IDs that the runner could never produce.
  Both were corrected and covered by configuration tests. Free-form runner
  messages were replaced by allowlisted outcome/reason codes before final tests.

## Boundaries

Register sources in the local Console configuration and restart to change the
watch list. Source updates then appear automatically. Configuration, original
proof records, and credentials remain outside the public repository. Loop runs
remain separate from coordinator-managed run counts and resource reservations.
