# Product design and architecture handoff

The APP-02 bridge turns an accepted product definition and a separately accepted
design into the existing Product Delivery / Lean loop input. It does not create
a second execution system. A design remains proposal data until the owner supplies
an exact acceptance declaration. Source checks do not establish visual quality,
API availability, device compatibility, deployment or release acceptance.

## Artifact and approval

`ProductDesign` uses `faktori.product-design/v1`. It binds the product identity and
normalized accepted `definitionDigest`, its own revision, and versioned sources
for owner taste, research, prototype references and changes. It has no `approved`,
execution or observed-evidence fields. Unsupported authority fields are rejected.

- Experiences bind included journey/requirement IDs and a selected web, iOS or
  Android target. Each records information architecture, navigation, loading,
  empty, success, error, denied and recovery behavior, scenario mappings,
  accessibility, and referenced visual sources or explicit non-applicability.
  A source reference is a declared reference; it is not proof that a prototype
  was opened, critiqued or accepted visually.
- Architecture separates shared domain, API, auth/authorization, data,
  integrations, error behavior, environment, migration and monitoring from
  target UI, navigation, device, runtime and release decisions. Decisions carry
  requirements, rationale and explicit applicability. Shared API decisions have
  versioned contracts; each target decision links those exact shared identities.
  Native implementation must retain the accepted definition's native UI,
  codebase, capability, device and distribution constraints.
- Consequential tradeoffs retain sources, alternatives and consequences. Open
  questions block delivery. A compact clear design can use an empty tradeoffs
  array when there is no consequential alternative to resolve.
- Slices deliver user behavior across domain, backend and target UI, record
  data/runtime applicability through decisions, and link journeys, requirements,
  scenarios, targets, decisions, ownership, whole-feature verification and pending
  release evidence. Dependencies carry narrow versioned contracts. Graph nodes
  are planning nodes; only the existing owner-configured delivery loop becomes
  executable. This bridge passes the entire current accepted definition scope
  into one existing loop and does not silently execute a subset or schedule
  detached layers. Narrow the accepted definition for a smaller execution scope.

`ProductDesignApproval` is supplied separately, with `ownerId`, a versioned
`reference`, `status`, and exact `definitionDigest` and `designDigest`. Only an
`accepted` declaration matching both digests clears the design gate. This pure
API validates declarations; it does not authenticate owners or convert a model
proposal into approval. Execution approval, provider access, resources, financial
authority, signing, publication and release remain separate existing bindings.

## Public API

```ts
parseProductDesign(proposal)
productDesignDigest(proposal)
serializeProductDesign(proposal)
parseProductDesignApproval(ownerDeclaration)
inspectProductDesign(definition, proposal, ownerDeclaration?)
inspectProductDesignChange(previousProposal, nextProposal)
compileProductDesignHandoff(definition, proposal, {
  format: 'faktori.product-design-handoff-request/v1',
  designDigest,
  designArtifact, // absolute in-workspace path, sha256:<designDigest>
  approval: ownerDeclaration,
  deliveryRequest, // existing ProductDeliveryRequest
})
```

Persist exactly the UTF-8 bytes returned by `serializeProductDesign`, without a
trailing newline. Its file-byte digest equals `sha256:` plus `productDesignDigest`.
Pretty-printing or appending whitespace changes the artifact and must be repaired
before execution. This canonical binding prevents a declaration from pointing
at an unrelated file while naming an accepted normalized design digest.

Persist the complete handoff request including the owner design declaration and
bind that immutable source file as the existing `deliveryRequest.requestArtifact`.
As with the existing delivery API, the caller/CLI supplies the current source-file
binding after reading the request, rather than storing a recursive self-digest
inside that file. Bind the definition source separately using the existing
`deliveryRequest.definitionArtifact` contract.

The compiler returns `needs_design`, `needs_bindings` or `ready_for_loop`, with
explicit gaps and no executable configuration while a gate is missing. A ready
result's `delivery.leanConfiguration` uses existing provider/routing/limits,
owner execution approval, release plan and whole-feature acceptance. The existing
delivery serializer can serialize its `delivery` value. Compilation reads no
files, starts no provider and runs no commands.

The bridge adds the reserved `product-design` file dependency. It also appends
the complete design, exact digest, source binding and owner declaration to the
actual existing implementation brief in ordered bounded JSON parts. The existing
brief prefix and all inherited definition constraints are preserved verbatim.
Source data is labeled as source data and grants no additional tool authority.
Approved design references enter the existing context contract with the acceptance
declaration and declared-evidence boundary. Every target shares explicit API
contract identities and revisions through the same packet.

Existing loop preflight checks file dependency bytes, refuses missing/mismatched
or symlink files, and rechecks input evidence before acceptance reuse. The pure
compiler reports `artifactEvidence: declared_not_read`; only a separate real
preflight receipt shows observed files. The existing loop's realpath check now
includes the reserved `product-design` identity, covering parent-directory
symlink escapes. Do not infer a passed preflight from an unrun configuration.

## Installed commands

Use `product design-inspect <definition> <design> [owner-approval]` for declared
readiness and `product design-change <previous> <next>` for affected consumers.
`product design-canonical <design>` emits exact canonical bytes without a newline.
Save those bytes before obtaining approval of the resulting design digest.

`product design-compile <definition> <canonical-design> <handoff-request>` pins
the actual definition, design and outer request bytes. A conflicting declared
source binding is rejected. `product design-loop-config` returns the existing
configuration only when all design and operator gates pass; compilation itself
does not run it. Keep owner design approval in the separate request field.

## Live feature changes and recovery

Existing products additionally require exact baseline revision, all accepted
supported-client/contract/schema/concurrent-work identities, a shared migration
decision and per-target declared regression scenarios. The existing compiler
still requires its complete compatibility plan with migration, regression and
concurrent-work boundaries. Source qualification does not observe the deployed
artifact or test old clients or database recovery.

`inspectProductDesignChange` compares versioned records and source revisions.
Changed experience/decision/tradeoff consumers and their downstream dependency
consumers are marked for replanning; unrelated slices are retained. Definition
digest, compatibility boundary or unresolved global-question changes invalidate
all slices. Any changed design digest needs new exact owner acceptance even when
the only edit is a revision label. Preserve previous artifacts and receipts;
repair by producing a new revision, never rewriting accepted evidence.

## Minimal qualification

One complete local feature journey covers an accepted new definition and an
accepted live feature across web/iOS/Android, with scoped dependency context,
unchanged inherited constraints, actual worker-brief reconstruction, missing
approval/artifact/operator bindings, UX/API/layer gaps, graph cycles, stale
approval, live schema omissions and affected-consumer recovery. The whole-feature acceptance script additionally calls the real existing preflight with a
deliberately unavailable provider, observes valid design bytes, then changes the
bytes and observes `dependency.product-design: file_digest_mismatch`, without
launching a model. The evaluator is model-authored and human-uncalibrated. Product
UI, visual critique, real devices, deployed APIs, migrations and release remain
separate observed qualification gates.

Run the complete bridge slice with Node 24:

```sh
node scripts/accept-product-design.mjs
FAKTORI_DESIGN_MODULE=/absolute/installed/faktori/dist/production/design.js node scripts/accept-product-design.mjs
```

The script uses discovery, delivery, context and loop modules from the same source
or installed kit as the selected design module. It retains private acceptance
records under `.build/product-design-acceptance/`; provider launch is deliberately
blocked. It does not mutate a generated product or any remote system.

