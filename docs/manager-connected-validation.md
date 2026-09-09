# Manager-connected mode validation

Validated locally on 2026-09-09 with Node 24.20.0 and npm 12.0.2.

## Observed behavior

- Queued a harmless instruction through the real Console Work form.
- Claimed the persisted request through the shipped CLI relay and checked its
  exact target before dispatch.
- Sent it to an existing, owner-authorized Codex phase task using desktop task
  messaging, then recorded successful submission.
- Received an explicit source-identified, request-correlated callback containing
  `MANAGER-CONNECTED-OK` and recorded that observed report through the CLI.
- The Console displayed the report through its state updates. After restarting
  the separate proof Console on the final build, the same single report remained
  visible as “Result reported,” not product acceptance.
- Product workers and the existing CLI execution mode were not modified by this
  proof. Private connection files, real task IDs, and operational records remain
  outside the public repository.

## Verification

- TypeScript typecheck and production Console/runtime build passed.
- Full suite: 55 files, 444 tests passed using
  `npm test -- --maxWorkers=2 --testTimeout=15000`.
- Initial default-concurrency runs hit five-second timeouts in existing CLI/loop
  tests on the busy host. The final run bounded concurrency and extended only the
  test time allowance; behavior assertions and production limits were unchanged.
- Clean packed CLI installation verification passed on the final build.
- Independent read-only security review passed after fixes for private storage
  permissions, absolute-path/file-URI redaction, Manager identity changes across
  restart, and submission-before-completion requirements.
- Store and HTTP tests cover authority separation, duplicate and conflicting
  identities, exclusive ownership, interruption, uncertain writes, torn journals,
  revoked assignments, wrong callback sources, and missing acceptance evidence.

## Limits

This is an active-Manager-mediated transport proof, not unattended execution,
native permission forwarding, direct desktop API support, automatic navigation,
or a new product-delivery acceptance claim. Full project organization and a
decision inbox are proposed separately in
[Console Work Management](plans/console-work-management.md).

Construction used Sol for store implementation, planning and independent review,
and Terra for the bounded UI slice. Exact per-agent token telemetry was not
collected for this feature; no token counts or financial totals are inferred.
