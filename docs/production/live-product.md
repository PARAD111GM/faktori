# Observed baseline to the next owner-requested increment

APP-05 connects existing verification/delivery evidence to an actual bounded
runtime observation, a separate owner baseline adoption, and the next discovery
session. It reuses the command runner, ownership lock and discovery history. It
does not add a scheduler or execute publication, deployment, migrations or
rollback. Owner-selected observer commands are trusted native code declared
read-only against the target; this is not OS filesystem isolation.

The CLI exposes `product observation-scope`, `product observe`, `product adopt`,
`product next-discovery` and `product live-journal`. The first four take one
request JSON file; `live-journal` takes the canonical absolute journal path.
The scope command is nonexecuting. Public API exports are
`productBaselineObservationScopeDigest`, `observeProductBaseline`,
`adoptProductBaseline`, `beginProductIncrement` and `readProductLiveJournal`.

## Observe and adopt

An observation request uses `faktori.product-baseline-observation/v1` with:

- `id`, `productId`, `ownerId`, `environment`, `journalPath`, and
  `expectedParentDigest` (null for the initial empty journal).
- `receipts.configuration` and `receipts.verification`, each an exact private
  `{path,digest}` binding. The first is the existing approved Lean loop
  configuration; the second is an actual passed
  `faktori.candidate-verification-result/v1` with confirmed cleanup. The candidate
  snapshot digest must match `expected.candidateDigest`.
- `expected`: product/environment identity, exact `sourceRevision`,
  `candidateDigest`, `artifactDigest`, `schemaRevision`, `sourceReference`,
  `artifactReference`, produced `platforms`, and versioned `supportedClients` and
  `contracts` arrays containing `{reference,revision}` entries.
- `observer`: approved workspace `cwd`, absolute argv-only `identity` and `check`
  commands, exact allowlisted environment, and `limits` with `timeoutMs`
  (1–120000) and `outputMaxBytes` (1024–1000000). Approval requires
  `nativeAccessApproved:true`, the same `approvedBy` as `ownerId` and the existing
  execution configuration, `scope:"read_only_target"`, and the exact scope digest
  returned by the nonexecuting helper/CLI. The digest binds the commands,
  environment, limits, expected runtime and receipt references. No controller
  environment or API-key variables are inherited.

The identity command returns exactly:

```json
{
  "format": "faktori.product-live-identity/v1",
  "productId": "owned-product",
  "environment": "local_qualification",
  "candidateDigest": "sha256:<64-hex>",
  "sourceRevision": "<exact-Git-commit>",
  "artifactDigest": "sha256:<64-hex>",
  "schemaRevision": "<schema-revision>"
}
```

The check returns the same identity with
`format:"faktori.product-live-check/v1"` and a `checks` object containing
`authenticated`, `persistence`, `compatibility`, `recovery`, `outcome` (all true
for a passed observation), and bounded `outcomeText`. Identity is read before and
after the check. The approving owner is responsible for representative verifier
code, independent review, negative controls and calibration. A command saying
"passed" is evidence from that trusted evaluator, not independent proof of every
semantic claim, real-user business value or physical-device behavior. Credentials
stay in the operator's private credential source; arguments use references,
never secret values. Only strict validated output is retained in 0600 evidence
files. Arbitrary stderr, credential values and controller environment are not
copied into the journal or CLI output.

`local_qualification` never supplies or synthesizes a GitHub publication,
production deployment or production admission. Its adoption remains
`qualified_local_runtime`. For `public_production`, observation additionally
requires the actual existing `state.json`, `publication.json` and `delivery.json`
chain from `receipts.loopArtifactsDirectory`, with all delivery gates passed.
The directory, loop ID and normalized configuration digest must match the
approved Lean configuration. The exact deterministic acceptance stage/receipt,
verification payload, candidate evidence and dependency set must match the
publication binding. The verification receipt must be the exact sealed
`live-runtime-verification` file dependency. `receipts.artifact` is required and
must be the exact sealed `live-release-artifact` file dependency; its bytes and
digest must match the observed runtime artifact. Current private file limits are
eight megabytes; larger immutable build artifacts require a separately qualified
streaming artifact adapter. Workspace content digests and candidate snapshot
digests are different contracts and are not compared as though interchangeable.
The runtime source must match the recorded deployed and staging-accepted merge
revision, which may differ from the reviewed PR head. Missing or unrelated
release evidence cannot be promoted. The API does not manufacture those receipts
or authenticate owner declarations; `productionReady` remains false. This public
route is specifically the existing factory Lean/GitHub publication-delivery
profile. Initial registration of unmanaged live products or other release routes
remains open; their owners must not invent prior factory/GitHub receipts.

Adoption is separate: `faktori.product-baseline-adoption/v1` supplies `id`,
`productId`, `ownerId`, `journalPath`, `observationId`, the current
`expectedParentDigest`, and `approved:true`. Only a matching passed observation
can be adopted. Receipt/artifact bytes are checked before and after another fresh
identity/check/identity observation. This owner action grants baseline adoption
only; it grants no feature, release, spending or publication authority.

## Durable continuity and recovery

The private JSONL journal is revision-linked, append-only and serialized by the
existing ownership lock. Entries have `kind`, `id`, `payload`, `revision`,
`previousDigest` and `digest`. Read the last entry's digest for the next request.
An exact ID/request retry returns the recorded result; conflicting IDs, stale
parents, alias/hardlink files, incomplete records and cross-product histories
fail explicitly. Capacity (400 records/eight megabytes) is checked before
observer commands or discovery writes; reserve bounds can require archival
earlier than the absolute byte maximum.

Each operation persists an exclusive durable `.live-operation-*.json` intent
before observer execution. If evidence persistence or journal commit fails, an
identical retry cannot silently rerun unrecorded commands. Preserve the marker,
private evidence and any discovery history for operator investigation; a new
approved operation ID follows explicit recovery. There is no automatic deletion,
lock reclamation or rewriting of accepted records. A committed record supports
idempotent response recovery. Failed observations remain in history and cannot
be adopted.

## Start the next increment

`faktori.product-increment-start/v1` supplies `id`, `productId`, `ownerId`,
`journalPath`, the latest `adoptionId`, current `expectedParentDigest`,
`sessionId`, private `historyPath`, and the owner's explicit `rawIdea` and
`ideaSource` reference/revision. Optional `platforms` are an explicit owner
selection for the next produced increment; they do not erase the adopted
supported-client baseline, which remains in the session notes.

The bridge rechecks the adopted runtime and receipt bytes, then uses the existing
discovery API to save a `live_increment` seed with the exact source/artifact
baseline and versioned clients/contracts/schema context. The prior observed
outcome and local/public evidence boundary stay sourced in immutable notes.
They are not automatic priorities or invented owner answers. Previous discovery
histories remain untouched. Discovery, design and execution authority for the
requested feature still pass through their existing independent gates.

## Whole-slice qualification

`scripts/accept-live-product-cycle.mjs` exercises the source CLI/API or, with
`FAKTORI_ACCEPT_CLI`, the same installed package path. It runs a private persistent
authenticated web A→B cycle with actual existing candidate-runtime verification,
old-client/data continuity, additive schema migration, restart and disposable
restore evidence. It checks observation/adoption/next-discovery, replay, stale
runtime/parent and public-evidence denial, bounded capacity, concurrent receipt
mutation and incomplete-operation recovery. It does not publish, call a model,
retest mobile or create cloud resources. The evaluator is model-authored and
human-uncalibrated; this local cycle is not a production adoption receipt.
