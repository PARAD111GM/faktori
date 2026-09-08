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
paths are blocked rather than overwritten. Only the exact product-local Git
repository created by an already-journaled interrupted operation can be
reconciled; a child of some parent repository is not adopted implicitly.

For an existing local product or bundled fixture, the proposal request may map
the configured product ID to an absolute source directory:

```json
{
  "localProductSources": {
    "task-board": "/absolute/path/to/approved/task-board"
  }
}
```

Proposal creation rejects symlinks and special files, excludes source `.git`
metadata, and binds the sorted file digests and modes into the approval-bound
effect. Apply re-verifies no-follow source bytes, creates destination files
exclusively, verifies the copied snapshot again, and only then initializes an
exact product-local Git repository and records a local initial commit. The new
repository receives the neutral local commit identity
`Faktori Agent <faktori@localhost>` so an isolated worker can commit without
ambient or owner Git configuration; owners may replace that repository-local
identity explicitly. Interrupted provisioning fills only missing identity
fields during reconciliation and preserves any explicit repository-local owner
identity already present. A changed source or concurrent destination edit
blocks activation instead of importing or overwriting unapproved bytes.
Omitting `localProductSources` intentionally creates a committed empty scaffold.

Before each local effect, Faktori canonicalizes the supplied root and rejects a
symlink root or any existing symlink component below it. It rechecks parents
after creating them and verifies their resolved path remains below the real
root before a write or `git init`. Source file descriptors use no-follow reads,
destination files use exclusive creation, and the final copied manifest is
rechecked immediately before Git activation. These are application-level
guards; the factory still requires an owner-controlled provisioning root.

Remote effects are sent only to `createFakeRemoteTransport()` in this phase;
they return `pending` and `supported: false`. That is an explicit unsupported
state, not a simulated repository, cloud project, credential, or provider
success.

`previewNewProduct` shows factory-default inheritance and incremental cost; it
always reports `podsCreated: 0`. Pod assignment remains an explicit later
configuration decision.

## Add a product to an existing factory

`faktori product new` is the mutation half of the same discover, propose,
approve, and apply workflow. Resolve a next configuration containing exactly
one additional product and no other change, then create its proposal with an
explicit previous configuration. The complete runnable
[`product-addition-proposal-request.json`](../../examples/provisioning/product-addition-proposal-request.json)
starts from the public solo configuration, adds only an `api` product, and
retains the existing pod unchanged. Run `faktori provision proposal`, review its rendered
incremental costs, workload, effects, and authority risks, then run `faktori
provision approve`. Put that approval beside the emitted `proposal`,
`resolvedConfig`, and `previousResolvedConfig`, and apply it with:

```sh
faktori product new approved-product-bundle.json /absolute/existing-factory
```

The proposal is rejected unless factory defaults, providers, environments,
every existing product, repository, and pod remain unchanged and exactly one
named product is added. Its registration is an exclusive append-only revision
claim, so two additions from the same approved configuration cannot both win.
The winning operation creates only the named exact-root repository; it never
creates a pod. Replaying the same bundle reconciles the receipt and repository.
A stale proposal, different registration, changed owner profile/component
locks, or competing addition blocks without overwrite. Console preparation
accepts the supplied full configuration only when its digest follows the
approved registration chain, making the new product usable rather than merely
writing a fragment.
