# Phase 7 isolated cold-start observation — 2026-09-07

This is a sanitized controller-side record of the single directly authorized
F7-01 worker run. It is partial evidence, not ticket acceptance. Credential
contents, provider session identifiers, environment values, and private host
paths are intentionally omitted.

## Immutable inputs and execution boundary

- Public-kit Git revision: `2ad5932`.
- Public archive SHA-256:
  `a3396b5836592825dd5f51e280d1cb65929b4358d05f3e767e855dc20a706732`.
- Combined Node 24/npm 12/Chromium/Codex image ID:
  `sha256:4655fe29859991e999f5ffd9aec80a1f880a6549986807f98f1af8bd900fe8ed`.
- Runtime: UID/GID `501:20`, read-only root, all capabilities dropped,
  `no-new-privileges`, 2 CPUs, 4 GiB memory, 256 PIDs, 1 GiB ephemeral
  `/tmp`, and a 45-minute outer timeout.
- Networking was ordinary bridge access for the vendor API and exact npm
  dependencies. The only mounts were the disposable writable workspace and
  the dedicated vendor-owned credential profile. No host home, Docker socket,
  controller storage, Twinzy, or Triforge path was mounted.
- The worker used Codex 0.146.0 with approvals disabled inside this reviewed
  OS-isolated envelope. It did not push, publish, deploy, merge, or mutate a
  remote product or tracker.

After the run, a byte comparison against the immutable archive reported no
changed or missing tracked public-kit path. The archive digest above was
reverified independently.

## Observed public workflow

The worker used Node 24.20.0 and npm 12.0.2, installed the public kit with
scripts disabled, narrowly rebuilt and exercised `better-sqlite3`, and built
the kit successfully. It then used the public CLI to create and approve:

- discovery `discovery-83a38bb13b9d2eeb`, revision
  `1913f07d4c4ba187d8b5e26b12438d843fdbb919535793b7fa3c02d306c96969`;
- proposal `proposal-0823f1270358deec`, revision
  `4f8ea5b3016369e10680ca620de4ab97af0bf23f6c049749eec2f458019f1668`;
- configuration revision
  `c318c9f393d1db10ce0bacdfc9a92cc8b3cda353b7ea5c729a454a916eb993d6`;
  and
- approval revision
  `9a1174e659995e46fe7040a1f5c0d987e062a0e31ae6f7159508a70d9cdc129a`.

The apply created the approved factory profile and exact six-file task-board
repository at initial commit
`d9b63111ff9c3c86c1fb73a37968ce9e002131d1`. Replaying the same bundle returned
both effects as reconciled. The six journal records are exactly two
`intended`, two `completed`, and two `reconciled` observations for those same
operation IDs; no duplicate product or profile was created. Independent
controller resolution returned the same approved configuration revision and
the `codex-isolated` product route.

## Product behavior and exact stop

The worker installed genuine product-local Playwright 1.63.0 and implemented
only `package.json`, `package-lock.json`, and `src/board.mjs`. Its final unchanged
frozen browser run passed 1/1 in 3.962 seconds. A credential-free,
network-disabled controller rerun in the exact 4 GiB/256 PID envelope passed
the same unchanged contract 1/1 in 3.849 seconds. A preceding controller run
with only 2 GiB/128 PIDs crashed Chromium before an assertion and is resource
calibration, not contradictory product evidence.

The first unmet required step was the final product commit. Git exited 128 with
`Author identity unknown` because provisioning used a command-scoped identity
for the bootstrap commit but left no repository-local identity for isolated
follow-on work. The product remained staged at its initial commit. The outer
wrapper exited zero only because the Codex turn stopped and wrote its result;
that exit is not product or F7-01 acceptance.

The controller also observed no hard-linked regular file outside `.git` and
`node_modules`, but genuine npm created the normal internal
`node_modules/.bin/playwright` and `playwright-core` symlinks. Therefore the
literal no-symlinks-anywhere criterion was not satisfied. A future identical
exercise must either install with bin links disabled and verify the complete
tree, or explicitly narrow the criterion; this run does neither retroactively.

Provider usage reported by the completed turn was 1,386,829 input tokens,
1,307,392 cached-input tokens, 12,782 output tokens, and 1,786 reasoning-output
tokens. These are provider-reported fields, not an inferred cap or an
overlap-adjusted whole-phase total.

## Repair and remaining authority boundary

Commit `9f0cdba` makes approved product-repository creation and reconciliation
set the neutral repository-local identity
`Faktori Agent <faktori@localhost>`. It never changes global Git configuration
or impersonates an owner, and owners can explicitly replace the local identity.
The pinned Node 24.20.0/npm 12.0.2 provisioning suite passes 21/21 with direct
assertions for both local values.

No second provider run was authorized or attempted. F7-01 remains blocked until
the repaired exact public revision is exercised in a newly approved isolated
run and all criteria, including final commit, clean worktree, complete link
check, and retained configuration, pass together.
