# Delivery recovery inventory

Baseline: Faktori `f7ced4959e6bdf43658ae56b6df9fc7750ea3d4a`, Triforge
`ca0c70dbed3f2ae2bf53292b9e09c346ae6a462d`. Owner approved the recovery plan
on 2026-09-11. This record is an implementation baseline, not release acceptance.

| Responsibility | Reuse | Repair / missing | Observed capability |
| --- | --- | --- | --- |
| Jira | Existing REST action executor, Console observer; Triforge rank/dependency policy | Active-sprint reads, correlated lifecycle synchronization, discovered transitions | No Jira connector available in this construction task; installed authorization unverified |
| GitHub | `gh` transport, registered PR observer, exact-head progression, deployment verification | Connect evidence to authorized Jira transitions regardless of PR author | Read-only remote Triforge revision check succeeded; product mutation and deployment not tested |
| Codex Foreman | Private Manager relay, durable claims, uncertain restart recovery | Shared admission gate and native-goal/bootstrap evidence | Construction goal activated; app bridge idle wake-up and product builder goals not verified here |
| Slack | Triforge allowlisted router, PR-thread and receipt recovery design | Durable intent, serialized subject delivery, ambiguous-result reconciliation | Read of recorded Twinzy PR channel returned `channel_not_found`; no n8n management connector available |
| Console | Work catalog, sanitized artifacts, Jira/PR observers, task links | Artifacts navigation and readiness visibility | Source inspected; current installed backend not restarted |

Triforge n8n records are not necessarily executable exports or proof of live
configuration. Retrieve deployed workflow definitions through the authorized
operator before changing routing. Never copy credentials from another task.
Slack HTTP 500 after a successful post is a documented historical failure mode,
not a diagnosis of the overnight incident. No live notification was sent here.

## Boundaries and recovery

Use one Foreman and at most three ticket builders. Jira owns tickets; GitHub owns
PR/merge/deployment evidence; Codex owns execution; Slack owns notification
receipts; Console projects these facts. Asad retains merge authority. No timed
authority transfer, new billing, product provider activation, or worker restart.
Opt-in configuration must not change existing admitted work. A source/transport
failure stops affected new admission, preserves records and permits unrelated
work. Unknown submission is reconciled, never blindly repeated.

## Release gate

Local tests cannot establish the connected journey. Release acceptance remains
pending until an authorized Jira ticket is claimed, a visible goal-driven builder
delivers a PR, substantive review passes, Slack delivery is verified, the merge
owner merges, deployment and staging acceptance pass, and Jira/Console reconcile.

## Construction verification — 2026-09-11

Graph/readiness fixes at `08a5a367ff3155ccc43622c164b078272436f587` passed
typecheck, build and the focused graph/admission suites (12 tests). Independent
read-only review verified both final fixes: current tracker blockers override
older satisfied graph evidence, and readiness expiry uses applicable checks.

The serial full-suite run completed with 574 passing tests across 77 files.
That run began at `67ecf6e` and overlapped the final two regression fixes; the
focused suites above were rerun after those changes. Earlier concurrent runs
had timeouts, not assertion failures; their unchanged affected suites passed
when run alone. No timeout threshold was weakened.

Packed CLI verification passed under Node 24.20.0 / npm 12.0.2 in a clean
temporary install. The final source was rebuilt after the last fix. These
receipts establish local construction behavior, not installed integration,
native task wake-up, notification delivery or staging acceptance. No product
worker was restarted and no release was published during this verification.

The subsequent owner-triggered graph enqueue change at `c4b3c87` passed build,
typecheck and 49 Console/relay/prepare tests. A further focused admission test
also passed after closing and reopening the relay: refreshed passing readiness
still cannot authorize a request queued with older evidence. This is an
owner-triggered queue operation, not proof of automatic replacement dispatch or
platform task execution.
