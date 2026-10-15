# Operate the attended product lifecycle

Use the selected installed kit for a new web/native product or the next complete
feature of an existing product. The supported fallback is attended, bounded
execution through the selected existing provider. Automatic native supervision
is not qualified. See [current gates](current-gates.md) for release status and
the remaining owner, platform, calibration and observation gates.

Resolve the exact kit revision, approved factory profile, product workspace,
selected provider executable/model, evaluator owner and release authority first.
For a new factory, complete [installation](../../INSTALL.md) and bootstrap;
for another product, use the product-creation skill without reinstalling.
Keep the public kit, private factory records and product repository separate.

## 1. Save the owner's idea and resume discovery

Use `faktori` from the selected installed package. From an already built source
checkout, `node /absolute/kit/dist/cli.js` accepts the same arguments. Installed
packages omit development scripts: source build/acceptance commands belong in
the source checkout, not the installed package.

Create an owner-private directory and approved product workspace; use canonical
absolute paths with existing, unaliased parents. Keep private directories mode
0700 and JSON records mode 0600. In the commands below, replace
`/absolute/private/product` with that private workspace. Do not overwrite an
existing record with shell redirection; use fresh revisioned output names.

Prepare `idea-request.json` using the shipped
[seed](../../examples/production/discovery-session.json). Its fields are
`sessionId`, `productId`, `ownerId`, `rawIdea`, versioned `ideaSource`, and
`platforms` (`web`, `ios`, `android` as actually requested). Replace the example
with the owner's actual idea, identity and selected targets. For an existing
product without an adopted journal, include the exact `existingProduct` baseline
and known deployed artifact per the [interview contract](discovery-session.md);
unknown deployment evidence stays unknown. Do not invent prior factory receipts.

```sh
faktori discovery session /absolute/private/product/idea-request.json > /absolute/private/product/session-1.json
faktori discovery save /absolute/private/product/session-1.json /absolute/private/product/discovery.jsonl
faktori discovery resume /absolute/private/product/discovery.jsonl
```

Prepare `discovery-provider.json` with the exact private `historyPath`, a fresh
`proposalId`, approved `workspacePath`, private `artifactsDirectory`, explicit
provider executable/model/reasoning and bounded limits from
[discovery model handoff](discovery-model-handoff.md). Set
`nativeAccessApproved` only when the existing authority covers that scope.
Provider authentication remains in the unchanged vendor CLI.

```sh
faktori discovery propose /absolute/private/product/discovery-provider.json
faktori discovery resume /absolute/private/product/discovery.jsonl
faktori discovery answer /absolute/private/product/discovery.jsonl /absolute/private/product/answer-1.json
```

`answer-1.json` contains `id`, `questionId`, `ownerId`, actual answer `text`,
`disposition` (`answered`, `unknown`, `deferred`) and versioned `source` per the
interview contract. Ask the next material owner question, record its answer,
then use a fresh proposal ID for changed history. Model proposals and answers
are separate provenance. Resolve users, outcomes, complete journeys, scope,
permissions/errors/recovery, data, integrations, constraints and release owners.
Native discovery retains native UI, shared-codebase default, device/OS envelope,
offline behavior, capabilities and signing/distribution ownership.

## 2. Obtain definition and design acceptance separately

Prepare `definition-provider.json` using the same route contract with a fresh
proposal ID and the current saved history. Then:

```sh
faktori discovery draft /absolute/private/product/definition-provider.json > /absolute/private/product/definition-result-1.json
```

Inspect the result status before continuing. A successful proposal contains
`draft.definition`; save that object as `definition-proposed-1.json`, preserving
the complete result and original provider artifacts. It is not the entire result
envelope. Resolve questions and record actual owner decisions in a new
`definition-accepted-1.json` according to [product discovery](product-discovery.md).
There is no CLI command that manufactures owner acceptance. Keep the full goal,
explicit exclusions and one coherent included scope with linked positive,
negative and recovery scenarios.

```sh
faktori discovery inspect /absolute/private/product/definition-accepted-1.json
```

Continue only when inspection reports `readyForDesign: true`. Use its exact
`definitionDigest` and file path in `design-provider.json`, following
[design draft](design-draft.md), with approved route, limits and a fresh proposal
ID. Drafting launches the configured provider; inspection/canonicalization do not.

```sh
faktori product design-propose /absolute/private/product/design-provider.json > /absolute/private/product/design-result-1.json
```

On a successful proposal, save `draft.design` as `design-proposed-1.json`.
Resolve material design questions, then canonicalize the resulting design:

```sh
faktori product design-canonical /absolute/private/product/design-proposed-1.json > /absolute/private/product/design-canonical-1.json
faktori product design-inspect /absolute/private/product/definition-accepted-1.json /absolute/private/product/design-canonical-1.json
```

Obtain actual owner design acceptance and save `design-approval-1.json` using
`ProductDesignApproval` in [product design](product-design.md), bound to the exact
definition and design digests. Reinspect with that third file argument. Preserve
canonical bytes without adding a newline. Definition/design approval does not
authorize provider execution, spending, signing, publication or deployment.

## 3. Compile and run the configured complete slice

Prepare `design-handoff-1.json` using
`faktori.product-design-handoff-request/v1` in [product design](product-design.md).
It contains the exact `designDigest`, canonical `designArtifact`, actual design
`approval`, and `deliveryRequest` from [product delivery](product-delivery.md).
Keep definition, canonical design and handoff files inside the approved worker
workspace. The CLI binds their actual file bytes; preserve those bytes thereafter.

The delivery request supplies the selected provider and implementer/reviewer
routes, exact base revision, candidate inputs/dependencies, toolchain, existing
execution/repair authority, bounded limits, one complete-feature acceptance
command, and release contracts for every requested platform. Live increments
also retain baseline/client/schema/migration/concurrent-work compatibility.
The shipped pending request example is a shape reference, not execution authority.

```sh
faktori product design-compile /absolute/private/product/definition-accepted-1.json /absolute/private/product/design-canonical-1.json /absolute/private/product/design-handoff-1.json > /absolute/private/product/compilation-1.json
faktori product design-loop-config /absolute/private/product/definition-accepted-1.json /absolute/private/product/design-canonical-1.json /absolute/private/product/design-handoff-1.json > /absolute/private/product/loop-envelope-1.json
```

Inspect `status` and `requiredBindings`. The second command returns an envelope,
not a bare loop configuration. Only when `status` is `ready_for_loop`, save its
`configuration` object as `loop-input-1.json`; do not pass the envelope to the
loop. With the recorded execution authority and available selected route:

```sh
faktori loop run /absolute/private/product/loop-input-1.json
```

The configured loop builds the complete accepted slice and retains independent
review and full-feature acceptance. Preserve failures and bounded repair
receipts. Acceptance must cover real behavior, denied/error paths and recovery;
health/build success alone does not establish product acceptance. Keep protected
evaluator ownership independent of generated implementation. Source checks,
human-calibrated acceptance and physical-device evidence are separate gates.

## 4. Deliver, observe, adopt and start the next requested feature

Use existing [publication](../loop-publication.md),
[delivery](../loop-delivery.md) and
[live-product contracts](live-product.md) for the selected managed Lean/GitHub
release profile. Read the selected command's request contract before executing
`loop publication prepare`, `loop publication publish` or
`loop delivery record`. They do not create merge/deployment authority.
For native artifacts follow [native local delivery](native-delivery.md) and
[native release](native-release.md): actual signing/export and exact-artifact
upload require their separate approvals. Simulator/emulator results do not
establish physical-device/store delivery.

Prepare private observation/adoption/increment requests from
[live product](live-product.md), retaining exact receipt/file digests, runtime
identity, owner-approved observer commands and current journal parent. For an
already externally released Linux OCI product, use the separately supported
[external-hosted profile](existing-product-adoption.md), which records external
provenance without claiming Faktori publication. Native local observation uses
its own documented artifact profile. Do not substitute profiles or receipts.

```sh
faktori product observation-scope /absolute/private/product/observation-request-1.json
faktori product observe /absolute/private/product/observation-request-1.json
faktori product live-journal /absolute/private/product/live.jsonl
faktori product adopt /absolute/private/product/adoption-request-1.json
faktori product next-discovery /absolute/private/product/increment-request-1.json
```

Use the scope digest to obtain/record actual observer approval before `observe`.
Only adopt a passed, unchanged observation with separate actual owner adoption
approval and the current journal parent. `next-discovery` requires a current
adoption and the owner's next requested idea; it preserves the live baseline
and writes the requested discovery history. Resume that history at step 1;
do not create another product or invent feature priorities. An existing-product
request can begin here when its approved observation/adoption inputs exist.

## Stop, resume and hand off

Retain private history, provider captures, loop state, exact candidate/evaluator
identities, approvals, release receipts, live journal and interventions. Resume
discovery with `discovery resume`; use existing loop recovery instructions and
the original configuration/artifact directory rather than a new execution ID.
Exact recorded proposal retries verify retained evidence; changed history needs
a new proposal ID. An incomplete journal, uncertain execution or effect requires
inspection and reconciliation before another launch. Preserve unresolved intent;
do not delete history/locks to force a retry. Record manual bridges with the
[intervention ledger](interventions.md).

Handoff names the exact kit, factory/product paths, accepted definition/design,
current phase, evidence references, actual process stop/restart procedure, first
incomplete gate, responsible owner and next eligible command/request. Report
installed kit, generated implementation, independently accepted behavior,
authorized release and observed operation separately. Real native supervision,
human calibration, sustained cohort outcomes and account/device/store gates stay
open until their own evidence exists; they do not prevent an honest attended
operator handoff now.
