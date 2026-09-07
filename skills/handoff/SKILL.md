---
name: faktori-handoff
description: This skill should be used when transferring a Faktori work item, evidence package, incident, or decision between owners, lifecycle stages, or providers without transferring authority or private runtime state.
---

# Faktori handoff

Transfer a narrow, replay-safe account of completed observation and the current authorized task. Preserve the authority boundary: a handoff informs the receiver but does not authorize a new action, resume, merge, release, spend, policy change, or provider session.

## Use and bypass

Use when a lifecycle stage changes, an owner/agent/provider must continue an explicitly scoped task, an incident needs an operator decision, or evidence must survive a restart or provider substitution.

Bypass for routine local notes that have no successor action, raw transcript archival, or a request to grant authority. Do not use a handoff as a substitute for approval, admission, recovery reconciliation, or a provider-native resume binding.

## Assemble exact evidence

1. State the source work-item identity, lifecycle stage, current status, and current authorized next task. Name the decision owner when the task is blocked.
2. Bind every repository artifact to an exact revision and every transferred artifact to a safe relative reference plus digest. Include the observed command/interaction, result, environment, and authority that permitted that observation.
3. Separate facts observed now from historical evidence and unknowns. A passing command, provider final, PR, CI run, or deployment receipt proves only that event.
4. Record resource state precisely: configured budget policy, held reservation, provider-reported usage, and unavailable/overlapping measurement. Treat estimates as advisory, never as a hard stop or a measured total.
5. Record the selected provider/model/reasoning and selection rationale only as observed route evidence. Do not let the receiving provider alter the route without a new configured authorization.
6. Include recovery state: resolved, contained, blocked, or uncertain. Prefer containment for uncertainty; state any configured verified rollback authority, or explicitly say none is configured.

## Choose the package scale

| Scale | Apply when | Include |
| --- | --- | --- |
| Compact | One completed low-risk stage | Scope, exact revision, one observed result, current next task |
| Normal | Multi-artifact stage, provider transition, or routine incident | Compact fields plus artifact digests, authority, resources, unknowns, and recovery state |
| High-risk | Safety/credential boundary, cancellation uncertainty, migration, external effect, or disputed authority | Normal fields plus explicit owner decision, containment/recovery plan, exact evidence needed to unblock, and prohibition on retry without admission |

## Preserve portability and confidentiality

1. Use portable, digest-bound artifacts and concise summaries for cross-provider transfer. Require the receiving provider to begin a new explicitly scoped session.
2. Transfer accepted scope, criteria, approved references, artifact revisions/digests, verification evidence, and bounded outcome summary only.
3. Exclude raw reasoning, native conversation state, provider session IDs, tokens, credentials, controller secrets, private paths, raw private prompts/transcripts, authority-bearing fields, and unvalidated nested metadata.
4. Do not turn the handoff into a product requirement. Factory GM may diagnose the factory and propose an improvement, but may not create or rewrite product requirements.
5. Do not claim an unobserved external effect, retry an unresolved intent, or roll back an incident without configured verified authority.

## Emit the handoff

```text
Handoff: H-2026-09-07-03
From / to: Test → Deploy; provider A → provider B (new scoped session required)
Current authorized task: deploy artifact only after owner approval D-81
Scope: WI-42, accepted plan revision 4f2e9aa
Artifacts: plan.md sha256:...; verifier.mjs sha256:...; repository revision 8d9c412
Observed evidence: 2026-09-07, verifier command exited 0 and persisted expected result
Authority: test execution approved by run intent RI-44; no deploy authority transferred
Route evidence: configured provider A / model <selected> / reasoning <selected>; route change not authorized
Resources: reservation 40k; provider-reported usage unknown; estimate advisory
Recovery: contained pending owner; rollback authority not configured
Unknowns: staging receipt and external effect not observed
Receiver action: request/confirm deploy approval, then admit a new configured run
```

Validate the package before forwarding: require exact revisions, safe artifact references, digests, observed evidence, current authorized task, and no prohibited private/authority material. Reject ambiguous, stale, widened, or secret-bearing handoffs rather than normalizing them silently.
