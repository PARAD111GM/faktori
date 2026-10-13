# Adopting an externally released product

`product observe` accepts an optional observation-request `profile`. Omission
retains the managed Lean/GitHub release rules, including controller acceptance,
publication, review, merge, deployment and staging receipts. `managed_lean`
explicitly selects those same rules. `external_hosted` separately characterizes
an **already externally released** public product. It never supplies or bypasses
managed release gates and rejects `loopArtifactsDirectory`.

The external profile is limited to Linux OCI/Docker images. It records external
release provenance and observed continuity; it does not assert that Faktori
merged, published or deployed the product. Observation and adoption retain
`productionReady: false`. Owner approval authorizes observation/adoption, not
new delivery, spending, cloud changes, migration execution or feature priorities.

## Observation request

Use the existing `faktori.product-baseline-observation/v1` request, with
`profile: "external_hosted"` and `environment: "public_production"`.
`expected` retains exact product/candidate/source/artifact/schema identity,
source/artifact references, target platforms, supported clients and contracts.
Additionally require:

- `targetOrigin`: canonical HTTPS origin, without credentials, path or query.
- `resourceId`: exact externally running resource identity (for example the
  existing Machine ID). Do not substitute an app name for Machine identity.
- `releaseManifestDigest`: SHA256 of the immutable single-platform manifest's
  **original bytes**. A mutable tag or pretty-printed JSON is insufficient.

`sourceRevision` accepts an exact Git commit, or a `sha256:` source revision for
an externally characterized source bundle. `candidateDigest` remains the
existing candidate snapshot digest; those two digest families are distinct.
`artifactDigest` is the image configuration byte digest, also distinct from the
registry manifest digest and from a Docker-save archive digest.

The existing owner-approved native observer has explicit executable/argv, fixed
workspace, environment allowlist, time/output bounds, and a scope digest from
`productBaselineObservationScopeDigest`. Its identity and check JSON must contain
all nine runtime identity fields, including origin/resource/manifest. Identity
is read before and after the actual check. Authenticated behavior, persistence,
compatibility, recovery and observed outcome must all pass. A check should
actually inspect the selected provider/runtime and target data; echoing request
values or owner declarations is not a qualified observer.

## External release configuration

`receipts.configuration` seals a private JSON file with this shape:

```json
{
  "format": "faktori.external-hosted-release/v1",
  "id": "owner-recorded-existing-release",
  "productId": "product-id",
  "ownerId": "owner-id",
  "approved": true,
  "releaseAuthority": "owner_recorded_external_release",
  "workspacePath": "/canonical/approved/workspace",
  "expected": "the complete observation expected object, not a text string",
  "source": {
    "candidatePath": "/canonical/private/source-bundle",
    "files": [{"path": "/canonical/private/source-bundle/server.mjs", "digest": "sha256:..."}]
  },
  "manifest": {"path": "/canonical/private/original-manifest.json", "digest": "sha256:..."},
  "verificationConfiguration": {"path": "/canonical/private/native-verification.json", "digest": "sha256:..."},
  "evaluatorFiles": [{"path": "/canonical/private/source-bundle/protected-check.mjs", "digest": "sha256:..."}],
  "observerFiles": [{"path": "/canonical/private/live-observer.mjs", "digest": "sha256:..."}]
}
```

Replace the explanatory `expected` string with the actual object. All file
bindings use exact byte SHA256 with the `sha256:` prefix, canonical absolute
paths, private regular files, one hard link, no symlinks or parent aliases.
Source files must cover the entire qualified candidate snapshot, including the
protected evaluator files. The approved native check must invoke a sealed
evaluator from that snapshot. `observerFiles` separately seals both the actual
identity and check command entry points; these files may live outside the source
snapshot. Their byte bindings are reread before and after observation, fresh
adoption and next discovery, and on exact retries. An approved argv path alone
never authorizes changed observer code.

Supported invocation is either the sealed executable itself, or the exact Node
executable running Faktori (`process.execPath`) with the actual sealed script at
`argv[0]`. No interpreter flags precede that script: `-e`, `-p`, `--import`, shell
or interpreter wrappers and a sealed filename in an unused later argument fail
qualification. Native verification cannot supply `NODE_OPTIONS` or `NODE_PATH`
overrides, including in seeded-control environments. Other executable commands
must seal the executable file itself rather than an incidental argument.

The trusted controller/operator owns those bytes;
an implementer or model must not be allowed to replace its evaluator or receipts.
The controller enforces entry-point hashes and file boundaries, not an OS
sandbox between actors who already share the same writable filesystem. This
attended native execution boundary is not hermetic: the Node interpreter,
imported modules, operating system, external tools and selected provider remain
trusted dependencies. Seal further code dependencies in the file lists when
needed; this profile does not claim isolation or automatic transitive-import
discovery.

`receipts.artifact` seals the actual image configuration JSON bytes.
`receipts.verification` seals the existing genuine
`faktori.candidate-verification-result/v1` produced by `verifyCandidateRuntime`.
The corresponding configuration must approve this owner, select the exact
source path/snapshot digest, and include seeded negative controls. Qualification
must complete the healthy and every negative-control scenario with confirmed
cleanup. Result/configuration digests and the snapshot are checked using the
existing verifier's hash algorithm. A declared `passed: true`, foreign result,
changed evaluator, incomplete cleanup or edited report fails this boundary.

The manifest must be an OCI or Docker schema-2 image manifest. Its config
descriptor must match the actual image configuration digest, byte size and
media type. Manifest indexes are not image manifests: select the immutable
platform child that actually runs. This binds provenance without performing a
registry request or publication. The separately approved target observer must
inspect the actual runtime's immutable manifest/config/source identity and
behavior. Local container qualification alone is never a public target observation.

## Durable controller evidence and the next cycle

After actual bounded observations and rereading all sealed dependencies, the
controller persists its own `faktori.external-hosted-characterization/v1` inside
private observation evidence. It identifies the controller actor, external
release ID/configuration digest, exact expected runtime, input bindings and
observer authority. `factoryPublicationClaimed` is always false. A failed
observer is durably failed and cannot be adopted.

The existing `product adopt` operation requires separate explicit owner
approval, the passed observation, current journal parent, fresh observations,
and unchanged evidence before and after those observations. `product
next-discovery` requires the current adoption and an owner-requested idea. Its
history retains the current source/artifact, clients, contracts, schema and
observed outcome without selecting priorities or accepting the next feature.

Exact retries validate sealed external inputs and return their original records
without relaunching observers or rewriting history. Conflicting retries and
stale parents fail. Known revision/byte capacity is checked before commands or
history writes. A durable intent precedes each fresh operation; interruption or
post-observation drift leaves evidence for explicit operator recovery and
prohibits automatic duplicate execution. Keep journals/evidence private and
preserve uncertain artifacts; do not delete intent to turn an uncertain action
into an automatic retry.

## Whole-feature local acceptance

```sh
PATH=/tmp/faktori-audit-toolchain:$PATH node scripts/accept-existing-product-adoption.mjs
FAKTORI_ACCEPT_CLI=/absolute/installed/kit/dist/cli.js node scripts/accept-existing-product-adoption.mjs
```

This model-authored, human-uncalibrated fixture uses actual local Node processes,
SQLite state, restart/backup/restore, native runtime verification and a seeded
household-scope defect. It exercises external observation/adoption/requested
discovery, mismatch/managed-profile denial, unused-argument evaluator/observer
bypass denial, observer-path replacement, replay/CAS, post-observer drift,
durable interrupted intent and pre-effect capacity. Its `.invalid` HTTPS
identity is explicitly a local fixture, never production/runtime evidence.
It launches no models, providers, network targets, registries or cloud effects.
Native process inspection may require the same permission as the existing
candidate verifier. A source or installed acceptance pass remains separate
from independent review and actual provider/runtime qualification.
