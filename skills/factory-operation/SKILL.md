---
name: faktori-factory-operation
description: This skill should be used when operating a configured self-hosted Faktori factory, admitting or observing authorized work, handling a runtime incident, or preparing an owner-facing operational handoff.
---

# Factory operation

Operate the factory as a governed coordinator, not as a product manager or an autonomous product worker. Keep the append-only operational journal authoritative and treat its SQLite view as rebuildable. Preserve the configured owner, current authorized work item, provider boundary, and recovery state.

## Use and bypass

Use for an already configured factory when admitting a work item, observing queue or provider health, resolving an operational incident, reconciling durable records, or preparing an operational handoff.

Bypass for product discovery, design, implementation, test, deployment, or factory changes. Route those requests to their applicable lifecycle skill. Route a factory defect or policy change to `faktori-factory-improvement`; do not quietly rewrite factory behavior during operations.

## Establish the operating envelope

1. Read the current factory configuration and record its revision, the current authorized work-item identity, selected environment, execution profile, provider route, authority snapshot, and budget policy.
2. Confirm that the requested effect is present in the approved work item. Treat a sibling run, previous successful command, provider output, or green dashboard state as evidence only, never authority.
3. Refuse to supply a provider, model, workspace, session, authority, or budget from browser/user input when the configuration has not already selected it. Keep provider authentication in the unmodified vendor CLI and credential store.
4. Select the configured model and reasoning level explicitly. Use the least expensive capable configured route considering retries, context and verification effort; escalate for observed complexity or a documented failure, and record the reason. Do not invent availability or claim a provider's native hard limit.
5. Classify the package before acting:

| Scale | Apply when | Require |
| --- | --- | --- |
| Compact | One known, low-risk local operation | Intent, authority check, receipt, and handoff note |
| Normal | Routine provider delivery, parallel coordination, or a recoverable incident | Current context packet, reservation, durable intent/result, evidence, and follow-up owner |
| High-risk | Cancellation uncertainty, isolation/credential boundary, corruption, external publication, or recovery decision | Explicit authority, separate recovery/containment plan, observed post-action state, and owner decision for ambiguity |

## Admit and observe work

1. Serialize admission. Record intent before a launch, resume, cancellation, retry, or action effect; bind it to the exact repository/base/revision, scope, context, authority epoch, and provider session where applicable.
2. Reserve only the resources the configured policy permits. Treat planning estimates as advisory, not as a hard ceiling or a reason to stop otherwise authorized work. Enforce actual configured limits; record reported usage separately from reservations and mark absent or overlapping telemetry `unknown`.
3. Resume only an explicit, durable source session in its recorded scope and workspace. Never select a provider's latest session or silently retry an unresolved intent.
4. Recheck authority at the local effect boundary. Treat provider output as evidence, not permission to merge, publish, spend, alter policy, or widen scope.
5. Record normalized provider outcome, observed local effect, and terminal classification separately. Do not equate a process exit, receipt, CI result, PR, or deployment with product acceptance.

## Spend inference on decisions, not observation

Use the configured deterministic observers for registration, status, usage,
deduplication and health checks. Do not wake an agent to poll, acknowledge an
unchanged state, copy a receipt or recount work. Distinguish recorded progress
from observed worker activity; absent liveness is unknown, not idle.

For opted-in lean execution, use an approved brief directly or validate an
existing candidate without inventing implementation work. Keep executable
verification and independent review. Deterministic acceptance proves the
declared evidence gate, not that software has shipped or met product intent.

Consolidate nonurgent GM interpretation into the configured nightly review.
Send only changed findings, qualified metrics, prior recommendations and owner
decisions. No material change means no inference. Use the cheapest adequate
owner-configured model; do not fan out specialists or retry failed diagnosis
repeatedly. Keep urgent containment deterministic and within existing authority.

Send agent-to-agent handoffs as objective, constraints, changed facts, evidence
references and next action. Use prose for the human's problem, consequence,
owner and decision. Never resend a full conversation when references suffice.

Until GM supervision passes an observed operational test, name the human or
Build Manager accountable for efficiency. Configuration alone is not coverage.

## Contain incidents and recover safely

1. Prefer containment: pause affected admission, revoke the affected capability, preserve the journal, quarantine unproven worker identity, and notify the recorded owner with the precise blocked decision.
2. Classify missing receipts, unknown/mismatched worker probes, interrupted cancellation, unavailable usage, and unverified external effects as unresolved or uncertain. Keep unrelated, proven work moving only where the configuration permits it.
3. Rebuild the SQLite projection from the journal when query state is suspect; do not alter journal history to repair a view.
4. Perform rollback only when a configured, verified rollback authority and recovery path cover the exact target. Otherwise retain the evidence, contain the effect, and request an explicit owner decision. Never infer that an uncertain side effect was reversed.

## Produce the operation record

Return a redacted, durable-facing record. Keep private prompts, raw reasoning, workspace paths, provider session IDs, credentials, tokens, and controller secrets out of the output.

```text
Operation: run-2026-09-07-014
Scope: product/acme-api · work item WI-42 · revision 8f3c1d2
Authority: owner-approved run intent rev 19; effect rechecked at admission
Route: configured codex / model <selected> / reasoning <selected>
Resources: reservation 40k; reported usage unknown; estimate advisory
Observed evidence: journal intent + provider final + verifier receipt
State: succeeded | blocked | cancelled | interrupted_uncertain
Follow-up: <owner, decision, or exact next authorized task>
```

Hand off only the exact revision, observed evidence, state, unknowns, and current authorized next task. Preserve provider portability by exporting accepted artifacts and digests rather than private provider state.
