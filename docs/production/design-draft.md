# Accepted definition to an attended design proposal

APP-02 obtains a full design proposal through the existing native Codex route,
then imports its exact response bytes against an already accepted product
definition. Owner acceptance, implementation, visual/runtime verification and
release remain separate. The design includes experiences and interaction states,
architecture and shared contracts, target decisions, tradeoffs, material open
questions and coherent vertical slices.

The pure API is `renderProductDesignDraftPrompt`,
`productDesignDraftOutputSchema`, `productDesignDraftSources`, and
`importProductDesignDraft(definition, { expectedDefinitionDigest,
sourceReference, responseBytes })`. The response has exactly `definitionDigest`
and `design`. The immutable `ProductDesignDraftEnvelope` includes the entire
accepted definition, its digest, parsed design/design digest, exact response
SHA256/byte length, source bindings and unresolved questions. It always reports
`status: proposed`, `authority: none`,
`evidenceStatus: model_interpretation_not_verified`, `readyForDelivery: false`
and `productionReady: false`.

The importer preserves the full owner goal, selected targets and accepted live
baseline through the immutable definition. The existing design inspector checks
requirement/journey/scenario/decision coverage and all supported-client,
API/schema/concurrent-work identities. The importer also rejects cyclic slice
dependencies. It supplies no owner approval. The expected missing-approval gap
and material open questions remain pending; structural/cross-reference gaps
reject the proposal. Unknown questions are allowed as honest uncertainty and
still block the existing delivery inspector until separately resolved.

Used definition source `id`, `reference` and `revision` must match the actual
definition. Additional assumptions use
`definition:<productId>/assumption:<sourceId>` and
`revision: sha256:<definitionDigest>`. These citations are source links, not
verified semantic entailment or owner approval of model-derived design text.
Proposed contract revisions, implementation owners, verification plans and
release plans grant no execution authority or observed evidence. Unknown
approval/status/evidence fields are rejected by the existing strict parser.
The structured-output schema uses exact with-contract/without-contract decision
variants. Each object rejects additional properties and requires every declared
property, preserving optional contracts without null conversion or raw-response
rewriting. Actual native protocol qualification remains a separate gate.

## Installed commands and native configuration

`product design-prompt <accepted-definition.json>` is nonexecuting.
`product import-design <accepted-definition.json> <private-response.json>
<expected-definition-digest>` imports an existing response. The attended
`product design-propose <private-config.json>` launches only the explicitly
approved native proposal route. A provider failure or rejected response must
remain a failed CLI operation; it cannot expose a qualified design draft.

```json
{
  "definitionPath": "/absolute/private/accepted-definition.json",
  "expectedDefinitionDigest": "<64-hex accepted definition digest>",
  "proposalId": "design-proposal-1",
  "workspacePath": "/absolute/approved/product-workspace",
  "artifactsDirectory": "/absolute/private/design-artifacts",
  "provider": {
    "kind": "codex",
    "executable": "/absolute/path/to/qualified/codex",
    "model": "OWNER_SELECTED_QUALIFIED_MODEL",
    "reasoning": "high",
    "contextIsolation": "bounded",
    "nativeAccessApproved": true
  },
  "limits": {
    "maxRuntimeMinutes": 10,
    "maxRetries": 0,
    "maxOutputBytes": 2000000,
    "maxResponseBytes": 250000
  }
}
```

This example supplies no authority. The owner selects the exact installed
executable/model, native workspace/data scope and limits. The configuration
parser reuses existing discovery route validation. Provider credential stores
stay unchanged; API-key variables and arbitrary controller environment are not
inherited. Native read-only/bounded context is not OS filesystem isolation.
No separately billed route, model substitution or account activation occurs.

`parseDesignProviderConfiguration` and `runProductDesignDraft` are the provider
API. The provider pins both the accepted definition digest and its exact private
file bytes. Files are canonical, unaliased and bounded; artifacts use private
0700 directories and exclusive 0600 writes. Each request retains accepted source,
configuration, prompt/schema, per-attempt context approval digest and a
`product_designer` run intent before the effect. Existing Codex adapter, native
runner, process identity/lifecycle and artifact primitives perform execution.
The request/receipt shell follows the definition provider locally rather than
refactoring other active modules or introducing a scheduler.

## Repair, replay and recovery

Default `maxRetries: 0` performs no correction. The configured attempt ceiling
is `maxRetries + 1` and applies jointly to eligible transport retries and semantic
corrections. Maximum provider wall time is that count times the per-attempt
runtime; it is not a token or financial cap. The combined prompt/schema context
must fit 128000 UTF-8 bytes. Correction includes the complete prior exact
response as explicitly untrusted data, its source digest and the deterministic
validation error. Oversize context fails closed without truncating the response.

Only a completed native turn with safely captured bounded bytes and a known
`ProductDesignDraftValidationError` can enter semantic correction. Auth/quota,
denial, malformed native lifecycle, uncertain interruption, stale accepted
definition and artifact/persistence failures cannot trigger it. The definition
bytes/acceptance are checked before every attempt, after validation and before
returning a proposed result. Persistence errors remain outside the importer
catch. Raw model output is never normalized or repaired by the importer.

The exclusive proposal directory establishes one writer. Exact replay checks
configuration/context, every retained artifact and the current definition,
reconstructs the draft from its exact response, and launches zero model calls.
Reused conflicting IDs, changed bytes or stale acceptance fail. Incomplete
journals require explicit operator recovery with preserved artifacts and a new
approved proposal ID; no automatic deletion, lock reclamation or double launch.

After owner review, write the canonical design using `design-canonical`, supply
the separate exact `ProductDesignApproval`, and use existing `design-inspect`
and `design-loop-config`. Acceptance still requires the current definition/design
digests and complete execution/release bindings. The proposal never changes an
accepted definition, discovery history, approval or live product.

## Whole-feature qualification

`scripts/accept-design-draft.mjs` uses a local protocol executable to exercise
combined greenfield/live invalid response → bounded correction → proposed design
→ separate synthetic owner acceptance → existing compiler/dependency preflight.
It checks zero-call replay, source/config/response drift, forged authority/source
claims, cross-reference/target/live compatibility and cyclic dependencies,
stale input during execution and auth/quota/uncertain/no-retry outcomes. Set
`FAKTORI_ACCEPT_CLI` to the clean installed CLI to run the same journey against
the package. This is model-authored, human-uncalibrated qualification. A real
native design turn, generated implementation, multimodal critique, actual UI,
native binaries/devices and production release need their separate receipts.
