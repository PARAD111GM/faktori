# Trusted harness preflight — 2026-09-06

Bounded local continuation; no provider inference, reset redemption, paid-route
switch, tracker mutation or product deployment was performed.

- Account telemetry reported 100% of the regular Codex plan window used.
- Genuine installed Playwright version: 1.63.0. Its default Chromium executable
  was missing. The official CLI installed Chromium and headless shell v1243
  into the provider's normal local browser cache successfully.
- Initial default-shell Node 22 attempt failed at harness preparation and is
  not evidence for the supported Node 24 path.
- Reran `node fixtures/verify-fixtures.mjs` with cached Node 24.20.0 and local
  browser/server execution permission. All frozen checksums passed (the runner
  checks them before executing any contract).
- Task-board starter reproduced its expected RED assertion.
- Due-dates base contract timed out at the existing 25,000 ms harness bound.
  The runner exited 1. Subsequent due-date feature and Python checks were not
  reached. Neither the timeout nor frozen fixtures were modified.

The missing browser prerequisite is repaired on this host, but trusted baseline
preparation is NOT complete. Next action: investigate the due-dates base timeout
with the genuine harness; retain this failed attempt and its original bounds.
After the baseline works, prepare the same dependencies for both isolated
comparison systems and perform a compliant fresh onboarding run. The product's
previous delete-after-restart failure remains unresolved. No Phase 7 ticket is
complete as a result of this preflight.

## Subsequent resolution

The initial observation above remains part of the attempt history. A diagnostic
rerun with unchanged fixture bytes and bounds passed the due-dates base case,
including delete after restart, and the unchanged aggregate verifier then
reproduced every frozen expected RED/base GREEN outcome. Commit `7797200` adds a
Node 24/Chromium envelope around the unchanged verifier; both the implementer
and Build Manager independently observed it pass. See
`phase-7-trusted-harness-2026-09-06.md`.

Trusted local baseline preparation is now complete at that bounded scope. The
scope-invalid cold-start result remains invalid, and no F7 ticket becomes
complete without the fresh isolated onboarding, host matrix and paired
comparison required by the plan.
