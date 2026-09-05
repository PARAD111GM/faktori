# Provisioning records and recovery

Faktori's Phase 1 provisioning surface is deliberately a planning and local
scaffolding boundary, not a cloud provisioner. Discovery records contain only
resource facts and owner answers; provider credentials remain in vendor-owned
login flows.

`createProvisioningProposal` takes a resolved configuration and locks the
component versions, local effects, cost statement, human workload, tradeoffs,
and authority relaxations into one revision. Render the result with
`renderProvisioningProposal` before approval. `approveProvisioningProposal`
requires every concrete effect and every current risk relaxation to be
confirmed. Editing the proposal, its effects, its risks, or its resolved
configuration invalidates that approval.

`provisionApprovedProposal` requires an absolute, dedicated root. It writes an
`intended` record to `<root>/.faktori/provisioning/operations.jsonl` before
each effect and writes the observed result afterward. An interrupted local
operation is reconciled by the same stable operation identity on rerun. A
different owner-controlled factory profile, a non-Git target, and all unknown
paths are blocked rather than overwritten. A pre-existing Git repository at an
intended target is reconciled, never reinitialized.

Before each local effect, Faktori canonicalizes the supplied root and rejects a
symlink root or any existing symlink component below it. It rechecks parents
after creating them and verifies their resolved path remains below the real
root before a write or `git init`. This closes ordinary configuration-parent
and products-parent escapes. As with other path-based filesystem APIs, an
attacker with concurrent write access can still race replacement between a
check and the subsequent system call; Phase 1 does not claim descriptor-relative
or kernel-enforced protection against that TOCTOU class.

Remote effects are sent only to `createFakeRemoteTransport()` in this phase;
they return `pending` and `supported: false`. That is an explicit unsupported
state, not a simulated repository, cloud project, credential, or provider
success.

`previewNewProduct` shows factory-default inheritance and incremental cost; it
always reports `podsCreated: 0`. Pod assignment remains an explicit later
configuration decision.
