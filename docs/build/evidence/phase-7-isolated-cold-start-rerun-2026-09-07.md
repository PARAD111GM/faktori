# Phase 7 isolated cold-start repaired rerun — 2026-09-07

This is a sanitized record of the single owner-authorized rerun after the local
Git identity repair. It proves the provisioning and product slice described
below. It does not prove a usable running factory Console, and F7-01 remains
blocked pending fresh-agent runtime follow-through.

## Boundary and immutable inputs

- Candidate revision: `73554103f701f605344925da4fa58790d4ad4461`.
- Public archive SHA-256:
  `ce930ea5489b59468732b22ff55196596f054b659ae983bd7a4ec8c8be3329a3`.
- Worker image ID:
  `sha256:4655fe29859991e999f5ffd9aec80a1f880a6549986807f98f1af8bd900fe8ed`.
- Runtime: UID/GID `501:20`, read-only root, all capabilities dropped,
  `no-new-privileges`, 2 CPUs, 4 GiB memory, 256 PIDs, 1 GiB ephemeral
  `/tmp`, and a 45-minute outer timeout.
- The only mounts were the disposable workspace and dedicated vendor-owned
  credential profile. No host home, Docker socket, controller storage, Twinzy,
  or Triforge path was mounted. The worker made no push, deployment, merge,
  tracker change, reset, paid-route change, or active-product mutation.

Controller comparison of every tracked archive path against the post-run
public kit returned no changed or missing path. The archive digest above was
reverified after the run.

## Provisioning and product observations

The public CLI created the following exact records:

- discovery `discovery-5c38836693c36bf9`, revision
  `3b2e9b8b5f84c043db11abba58bcf76ce28b6bae57e0977d8ee944a52279c7c5`;
- proposal `proposal-e5abd550d83c2a05`, revision
  `e84d5133d9dad93c2f45c9cdbaa4692220d435c7c7a08353ea905e3d59066da1`;
- approval revision
  `0d00e830b4c1d3a8825e06d88f6c590870a7786be1d384cb2e56dc2b928236d5`;
  and
- approved configuration revision
  `6b1a3c5839fd048618f20aebdf29afb47389e9723c18f7ae26cc45ed56468e8a`.

The six provisioning journal records are exactly `intended`, `completed`, and
`reconciled` observations for the same factory-profile and task-board
repository operation IDs. Replay created no duplicate effect. Independent
resolution returned the same approved revision and the configured isolated
Codex route.

The task-board repository began at
`1e8aff818f02a8487c43190971d4f0ce3c460822`, used the neutral repository-local
`Faktori Agent <faktori@localhost>` identity, and finished clean at
`5b4836d393c6d02c8b3668f72e786edc8c328ec3`. Genuine Playwright 1.63.0 was
installed product-locally with npm bin links disabled. Complete-tree controller
scans found zero symlinks and zero hard-linked regular files after acceptance.

The unchanged frozen browser contract passed 1/1 after the final commit in the
worker in 2.867 seconds. A separate credential-free, network-disabled
controller execution in the same 4 GiB/256 PID envelope passed 1/1 in 3.129
seconds. The product stayed clean and link-free after that independent run.

The provider reported 1,939,996 input tokens, 1,850,624 cached-input tokens,
15,342 output tokens, and 4,927 reasoning-output tokens. These are exact
provider fields for this turn, not an estimate, hard cap, or overlap-adjusted
whole-phase total.

## Exact remaining cold-start gap

The public-kit `npm ci` exited zero but reported that npm 12 blocked the
`better-sqlite3` install script under `allowScripts`. The fresh worker then
built and used provisioning commands, but did not perform the README's explicit
narrow rebuild/open-write-query observation and did not prepare or start the
loopback Console. A later credential-free, network-disabled controller
diagnostic loaded the exact installed package and passed an in-memory SQLite
open/create/insert/query check from a read-only public-kit mount, establishing
runtime readiness but not retroactively supplying fresh-agent evidence.

The generated factory contains the durable provisioning journal, approved
factory profile, and product repository. It contains no prepared local-Console
configuration or Console startup/projection record. The Build Manager therefore
rejected F7-01 completion at candidate `7355410`: the ticket requires a usable
factory with no undocumented build-team repair, not only a completed product.

The worker's discovery deliberately retained these unanswered interview fields:
organization and owner identity, hierarchy terminology, financial budget beyond
the configured execution limit, human attention availability, and incident,
notification, and recovery preferences. They are named unknowns rather than
invented owner answers. Provider usage was also absent from the worker-authored
result but is reported separately above from controller-observed turn telemetry.

F7-01 can advance only after a fresh authorized agent uses the public documented
flow to complete the narrow native-dependency observation, prepare the Console,
start it on loopback, and demonstrate canonical factory/product/pod projection
without a build-team-created runtime configuration or provider launch. This
record does not infer authority for that additional provider turn.
