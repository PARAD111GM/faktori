# Phase 7 Console continuation and public-flow repair — 2026-09-07

This record preserves the single owner-authorized runtime-only continuation of
the repaired cold-start session. It resumed the exact recorded session rather
than using a latest-session fallback. Provider session identifiers and
credential details are intentionally omitted.

## Authorized boundary and observations

The continuation used the same immutable worker image and hardened envelope as
the preceding cold-start run: read-only root, UID/GID `501:20`, all capabilities
dropped, `no-new-privileges`, 2 CPUs, 4 GiB memory, 256 PIDs, bounded ephemeral
`/tmp`, and only the disposable workspace plus dedicated vendor credential
profile mounted. It was limited to native SQLite verification and no-provider
Console preparation/start/projection. It did not rerun product acceptance,
launch a Faktori provider or GM, mutate the product, or touch a remote system.

Inside the fresh-agent path:

- `npm rebuild better-sqlite3` completed for only the pinned native dependency;
- `better-sqlite3@13.0.3` opened an in-memory database, created a table,
  inserted and queried the expected value, asserted it, and closed cleanly;
- the task-board remained clean at
  `5b4836d393c6d02c8b3668f72e786edc8c328ec3`;
- no runtime journal, projection database, worker, provider, or remote side
  effect was created; and
- `faktori console prepare` exited 1 with the exact sanitized error
  `local Codex preparation requires a product resolved to a native Codex
  provider`.

The existing approved factory intentionally resolves to isolated Codex with
strict spending. The only public preparation command coupled Console creation
to a native Codex work item and a route without a hard spending cap. The agent
stopped instead of weakening the approved configuration or hand-writing a
lower-level Console file. The continuation result is therefore blocked, not a
Console pass.

The resumed session's latest provider-reported usage snapshot was 2,838,098
input tokens, 2,662,912 cached-input tokens, 19,125 output tokens, and 6,076
reasoning-output tokens. It shares one resumed session with the preceding
snapshot, so the two snapshots are not summed.

## Public-flow repair

Commit `5784f41` extends the existing public `faktori console prepare` command
with explicit `mode: "projection"`. The mode:

- reuses the normal approved factory-profile and exact configuration-revision
  verification;
- emits canonical factory/product/pod hierarchy and loopback runtime paths;
- retains the approved factory limits while marking strict-spending capability
  unavailable, so coordinator admission stays fail-closed;
- emits no runtime provider, eligible work item, resume plan, or GM template;
  and
- rejects provider/work-item fields instead of ignoring ambiguous authority.

The original native-work preparation path remains the default and keeps its
existing validation. A pinned Node 24 focused end-to-end test prepares an
approved isolated strict-spending factory, parses the emitted configuration,
starts the real loopback Console, observes factory/product/pod nodes, verifies
zero work-item nodes, and shuts down cleanly. The focused Console/provisioning
set passed 38/38 with strict typecheck.

This is a candidate repair, not retrospective F7-01 proof. The authorized
continuation ended on the prior revision. F7-01 remains blocked until a fresh
authorized agent uses a public revision containing `5784f41` to prepare, start,
observe, stop, and cleanly restart the projection-only Console without
build-team-created runtime configuration.
