# Product requirements discovery

The `faktori.product-definition/v1` artifact turns raw intent into portable,
revisioned product knowledge. It supports a new idea and a bounded feature on an
existing live product. It does not choose a stack, run a provider, grant execution
authority or establish production acceptance. The [example definition](../../examples/production/product-definition.json)
is fictional; its owner decision is example data, not permission to execute.

Start with the saved [requirements interview](discovery-session.md). The
[definition-draft bridge](definition-draft.md) supplies its full model output
schema and imports exact response bytes against that session. The CLI exposes
`discovery definition-prompt` and `discovery import-definition`; imported
interpretations remain proposed for the separate owner-decision path.

Use `parseProductDefinition(input)` to validate and normalize untrusted JSON.
`inspectProductDefinition(input)` returns the immutable normalized definition,
its SHA-256 `definitionDigest`, `readyForDesign`, accepted requirement IDs and
ordered `unresolvedQuestions`. Both `executionReady` and `productionReady` are
always false. Source and owner evidence is explicitly `declared_not_verified`:
an operator/evaluator must inspect the referenced material before relying on it.
`productDefinitionDigest(input)` uses the same normalized content and is stable
under object-key reordering. Array order remains significant. Changing content,
including accepted decisions or baseline constraints, changes the digest.

## Artifact and provenance

The top-level fields are `format`, `productId`, `revision`, `rawIdea`, `intentRef`,
`sources`, `users`, `outcomes`, `journeys`, `requirements`, `roles`, `data`,
`integrations`, `resources`, `constraints`, `platforms`, `scope`, `assumptions`,
`openQuestions`, `ownerDecisions`, `modelProposals`, and `acceptanceScenarios`.
`definitionDecisionId` and `existingProduct` are optional while discovery is
incomplete. List fields are required but may be empty in a draft. Record IDs are
unique throughout the artifact; all source, question, decision, journey,
requirement and scope references are validated. Unsupported keys, cyclic or
exotic objects, getters, oversized inputs and malformed identities fail closed.
Limits are 200 entries per array, 8,000 characters per text field, 20 nesting
levels and one megabyte of text. Errors expose a concrete `issues` path/message.

Each source has `id`, `kind`, `reference` and `revision`. Its kind is exactly one
of `owner_requirement`, `observed_constraint`, or `proposed_assumption`. Each
sourced record has `id`, `text`, nonempty `sourceIds`, `status` (`proposed` or
`accepted`), and optional `decisionId`. Accepted records require a declared
owner/observed source or a separate accepted owner decision naming that record
at the definition's current revision. Model-only provenance cannot silently
become accepted. Assumptions and model proposals always remain proposed; an
owner may resolve one through a separately recorded requirement and decision.

Requirements additionally name `priority` (`must`, `should`, `could`), `category`
(`functional`, `domain`, `error`, `permission`, `non_functional`), `journeyIds`
and selected `platforms`. Journeys name `requirementIds`; both sides of that map
must agree. Acceptance scenarios name mapped `requirementIds`, selected
`platforms`, testable `given`/`when`/`then`, and `kind` (`positive`, `negative`,
`recovery`). A scenario platform must occur on at least one mapped requirement.

The text of roles/data/NFR should express the actual ownership, authentication,
tenant boundaries, security/privacy/retention, operating expectations and
success measures relevant to the next slice. These are product discoveries,
not defaults manufactured by the parser. Write explicit applicability records
when an integration, native capability or baseline constraint is inapplicable.

`scope.includedRequirementIds` selects the next complete outcome;
`scope.exclusions` captures deliberate omissions. Unselected requirements stay
in the durable product context without automatically blocking this slice.
Do not split acceptance into detached endpoint/UI tasks just to fill the map.

## Owner decisions and resume

An open question has `id`, `text`, `sourceIds`, `blocking` and `subjectIds`.
Owner decisions are separate from model proposals and contain `id`, `text`,
`sourceIds`, `subjectIds`, `ownerId`, `reference`, `revision`, `status`
(`accepted`, `rejected`, `deferred`) and optional `questionId`. Decisions require
an `owner_requirement` source. An accepted/rejected current-revision decision
resolves its named question; a deferred decision preserves the unresolved
question. Answer only questions relevant to the next dependent gate. Accepted
answers survive resumption because the caller reloads the same artifact;
inspection has no hidden session state or inference.

`definitionDecisionId` names an accepted owner decision whose `subjectIds`
contains `productId` and whose `revision` equals the definition revision. It
accepts product intent for design and does not approve spending, provider runs,
merge, deployment, infrastructure or release. Referenced decisions are declared
inputs; parsing cannot authenticate an owner or check an external source.

Inspection prioritizes blocking questions, retains unresolved explicit questions
and asks deterministic completeness questions for missing users, outcomes,
journeys, roles, data, integrations, selected targets, scope, proposed scoped records and uncovered
requirement/platform pairs. Contradictory owner acceptance/rejection or a
rejection of an accepted scoped record blocks readiness until an explicit
amendment resolves it. Every included requirement, at every selected
requirement platform, needs an accepted scenario. Missing error, permission and
NFR consideration produces advisory questions for proportional discovery.
`readyForDesign` requires explicit owner definition acceptance and no blocking
question; it is not a full product, design, execution or release gate.

## Platforms and existing products

`platforms.targets` selects `web`, `ios`, `android`. `mobileCodebase` defaults to
`shared_native`; `nativeUi` must be true, so a WebView wrapper cannot satisfy
native delivery. `separate_native` requires `exceptionDecisionId` naming a
current accepted owner decision for this product. Framework and web/mobile UI
sharing remain later design decisions. Native delivery discovery includes
sourced `deviceEnvelope`, `nativeCapabilities`, and `distribution` records.
Missing native device or distribution details block design readiness.

`existingProduct` carries a versioned `baseline` reference, sourced
`deployedArtifact`, `supportedClients`, `contracts`, `schemaConstraints`,
`incidents`, `telemetry`, and `concurrentWork`. These fields describe actual
observations/constraints or proposals honestly; unknown telemetry stays unknown.
Inspection requests missing client/API/schema/concurrent-work constraints before
designing a live-product increment. This avoids restarting unrelated discovery
and preserves supported-client and migration compatibility.

## Scoped context handoff

`compileProductHierarchy(input)` refuses an incomplete definition and produces
the existing `HierarchyDocument` contract through `validateHierarchy`.
The product root uses `productId`; feature planning nodes use
`journey.<journeyId>`. Accepted scoped requirements, exclusions, platform
constraints and live compatibility records remain inherited constraints;
scenario criteria include their given/when/then. The artifact reference binds
the definition digest, intent reference and optional deployed baseline.
`assembleProductContext(input, nodeId)` delegates to the existing
`assembleContextPacket` implementation. Neither bridge creates executable work,
commands, approved design references or authority. The delivery compiler adds
separately accepted design and owner-controlled execution bindings.

On an amendment, preserve source/decision history in version control, advance
the revision, review affected requirements/scenarios and record current owner
acceptance. Downstream consumers bind the exact definition digest rather than
trusting an unchanged filename or an old status. This deterministic slice
supplies contracts and resume/handoff behavior; adaptive interviewing,
researched model judgment, independently observed acceptance and live delivery
remain separately qualified capabilities.
