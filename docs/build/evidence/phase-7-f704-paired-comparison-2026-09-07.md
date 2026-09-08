# F7-04 approved paired fixture comparison — 2026-09-07

Status: comparison evidence complete; F7-04 release acceptance remains blocked
by the owner-deferred, unmet F7-03 dependency.

## Authority and isolation

The owner explicitly approved the tracked Triforge harness at
`ca0c70dbed3f2ae2bf53292b9e09c346ae6a462d` with bridge networking and the
dedicated Codex profile against only disposable mirrors of the frozen
task-board, due-dates, and Python date-boundary cases. Only the selected
`auth.json` was mounted read-only. Provider state used an ephemeral home. No
publisher, remote push, pull request, deployment, Jira operation, Twinzy path,
active Triforge path, Docker socket, or controller store was available to a
job.

Each job used Codex `gpt-5.5`, the same immutable starting fixture, 2 CPUs, 4
GiB memory, 256 PIDs, a read-only root, the non-root controller UID/GID, dropped
capabilities, `no-new-privileges`, and a 30-minute watchdog. The trusted
verification runs used no credentials or network.

## Functional result

| Frozen case | Faktori candidate | Triforge candidate |
| --- | --- | --- |
| Task board | PASS — 1/1 in 2.973 s at `5b4836d393c6d02c8b3668f72e786edc8c328ec3` | FAIL — 0/1 in 3.102 s at `5b17a3f4ae4571fa179927584e5d1350658b0ba6`; the deleted persisted task remained visible after restart |
| Due dates | PASS — base 1/1 in 3.077 s and feature 1/1 in 3.314 s at `a80e05362fac9aa63a89c73e944cacc0c96d6421` | FAIL — base 1/1 in 3.124 s, feature 0/1 in 2.092 s at `fc3a5b15d4cfc8308404a2bf3ba52a9a60b49002`; a task due today remained visible under the strict overdue filter |
| Python boundary | PASS — 3/3 in 0.01 s at `56f78304f995838cc3fdbc96441afcfba435526c` | PASS — 3/3 in 0.01 s at `2d959262fd2636e9d45d95285f55f914648cad27` |

This single approved case study therefore observed three passing Faktori cases
and one passing Triforge case. It does not establish a general benchmark or a
provider-intelligence ranking.

## Usage and elapsed execution

| Case | Faktori provider observation | Triforge provider/harness observation |
| --- | --- | --- |
| Task board | 1,939,996 input, 1,850,624 cached input, 15,342 output, and 4,927 reasoning-output tokens; exact provider elapsed unavailable; the turn also performed the broader cold-start flow | 49,318 Codex CLI-reported total tokens; 251 s from lane start to failed final packaging |
| Due dates | 601,110 input, 548,480 cached input, and 12,217 output tokens; about 302.4 s | 45,998 Codex CLI-reported total tokens; 290 s |
| Python boundary | 141,591 input, 110,976 cached input, and 1,806 output tokens; about 62.5 s | 49,134 Codex CLI-reported total tokens; 121 s |

Triforge's three measured lane-to-bundle intervals total 662 seconds (11 minutes
2 seconds). The comparable Faktori due-date and Python provider intervals total
about 365 seconds (6 minutes 5 seconds); exact task-board provider elapsed is
unknown. The token schemas are not commensurate: Faktori retained separate
input/cached/output fields, while the Triforge logs retained one CLI total, and
the Faktori task-board turn included cold-start construction beyond product
implementation. No token-efficiency percentage is inferred.

Direct incremental cost is unknown for both sides; the existing subscription
route was used and no separately billed route or paid service was enabled.

## Human effort, rework, and maintainability

- Faktori required earlier runtime, Git identity, credential-boundary, and
  verifier preparation before this paired observation. Those interventions are
  retained and are not hidden behind the final passing products.
- Triforge's first task-board job implemented and bundled the repository, then
  exited 127 because the runner image lacked the tracked harness's required
  `jq`. The controller added only `jq` to a local derivative image, reconstructed
  the deterministic zero-byte metadata file from the retained bundle inputs,
  and resumed only the two untouched cases. This is one failed handoff and one
  infrastructure intervention.
- The Triforge task-board change concentrated 442 insertions and 12 deletions in
  `src/board.mjs` but missed the frozen post-restart delete behavior.
- The Triforge due-date change modified the four intended product files and
  added `tests/e2e/f704-due-dates.spec.mjs`, contrary to the case instruction to
  change only product source. The added test was not used as acceptance evidence.
- Both Python candidates made a small single-file repair and passed the frozen
  contract.

Human waiting time was not separately instrumented and remains unknown. The
controller intervened only after an observed infrastructure stop and during
credential-free verification; it did not revise either failing Triforge
candidate or ask the provider for a second attempt.

## Bundle integrity and retained failure

All 20 frozen source/test hashes passed after the run. Reconstructed repositories
were clean at the bundle-declared commits, and regenerating each Git diff exactly
matched its retained patch hash.

| Case | Packet SHA-256 | Diff SHA-256 | Repository bundle SHA-256 |
| --- | --- | --- | --- |
| Task board | `9a2997c3a83c2720df245e7db78688ff2451487cb2c9df6910183752fb8ecc0e` | `9d2fd41c5357e4960fc2c382fdf08d68ba2839ca3e0bda10d9a916a4e43c77c6` | `37fdb1b478da96f804b33997f7015d43a545f97963c70f07604168a0cee1a7e6` |
| Due dates | `79f6dadeaa240802f8c2a1e170a67866a2142772f903b9211bc2c157c25bba60` | `c4fe7ac9546a1be3aa81aed9e2ac8212e38630f9599a54d26043027e4f7da0c6` | `893a20d98de80dd53ec3192b7b670b758aa6211d6cf25c5e3d47b9abc6988814` |
| Python boundary | `6ec628204a42e0e15e8ce01cc1ca4df4936af770079bb1a5bd85073d6e0654a5` | `93e629d972227f34828ccb790f6fb1066f3a96722b9d553159f7fbfebcdf5728` | `05ed93265ee16daebffc30e55898a0ff604f129a8b742ccdb815547e17b0f922` |

The task-board harness exit 127 and metadata repair remain explicit; the product
is scored from its independently reconstructed commit and frozen contract, not
from the harness exit code or provider-authored summary.

## Release boundary

The comparison cells are no longer unknown, but F7-04 cannot be accepted under
the committed dependency graph while F7-03 is owner-deferred and unmet. No
winner is published and Faktori V1 is not called complete. The accepted Faktori
commits are a concrete local release candidate for the measured fixtures only.
