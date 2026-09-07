---
name: faktori-factory-improvement
description: This skill should be used when a measured, approved change is needed to the Faktori factory itself, including coordinator, maintenance, safety, or operational-contract improvements.
---

# Factory improvement

Improve the factory through the normal lifecycle after approval. Keep factory-operation and Factory GM work bounded to maintenance, diagnosis, and proposals: neither creates product requirements, rewrites product work, nor self-authorizes a factory change.

## Use and bypass

Use when observed evidence identifies a factory defect, recurring operational failure, safety/control gap, maintenance concern, or measurable opportunity in the coordinator, configuration, lifecycle contract, runtime, Console, adapters, or recovery process.

Bypass for operating an unchanged factory, one-off product work, or speculative cleanup. Do not use a GM finding, anecdote, provider suggestion, or estimate as approval. Open a proposal and preserve the current behavior until the designated authority approves scope.

## Shape a proposal from a measured baseline

1. State the factory problem, affected contract, owner-visible consequence, and the boundary that must remain unchanged.
2. Capture a baseline at an exact revision: command/interaction, observed result, time window, resource telemetry, failure/queue counts where relevant, and explicit unknowns. Distinguish measured values from estimates, reservations, and unavailable telemetry.
3. Identify dependencies, compatibility risks, authority, acceptance behavior, recovery state, and the smallest scale that carries the risk.
4. Make the proposal revision-bound. Include alternatives only when they materially change cost, control, workload, isolation, or recovery.
5. Request approval before Build. Record the approver, approved scope, and exact reference; leave an unapproved improvement in proposed state.

## Apply the normal lifecycle

| Scale | Apply when | Minimum package |
| --- | --- | --- |
| Compact | Documentation correction or isolated, low-risk repair | Intent/acceptance, baseline, diff, verification, and recovery note |
| Normal | Behavior, adapter, Console, or maintenance change | Plan, design decision, implementation plan, behavior-level verification, review record, deployment evidence, and measured comparison |
| High-risk | Coordinator authority, isolation, credentials, concurrency, journal format, migration, or recovery change | Separate plan/design, explicit authority, compatibility and failure-path tests, staged recovery plan, and post-change observation |

1. Plan the approved objective, criteria, authority, dependencies, unknowns, and scale.
2. Design interfaces, data/recovery behavior, provider portability, and compatibility before changing shared contracts.
3. Select a configured model and reasoning level for each approved lifecycle task. Prefer the least expensive capable route considering expected retries, context and verification cost; record the selection and an evidence-based escalation reason without claiming an unconfigured provider limit.
4. Build only the approved factory scope. Keep one writer per file, preserve concurrent work, and do not smuggle product requirements into factory changes.
5. Test behavior at the highest useful boundary, including authority, concurrency, credential, and recovery failures where risk warrants it.
6. Deploy only through the approved environment and record the exact artifact revision and observed receipt.
7. Maintain the resulting state, drift, follow-up work, and recovery decision.

## Preserve authority and recovery

1. Keep provider authentication in provider-owned flows. Do not export credentials, session tokens, controller secrets, raw provider transcripts, or private workspace paths.
2. Treat estimates as advisory. Enforce configured spend/resource controls, keep reservations distinct from reported usage, and report unavailable or overlapping measurement as unknown.
3. Prefer incident containment during an improvement failure: stop affected admission, preserve records, and isolate the impact. Roll back only through an already configured, verified authority and recovery path; otherwise escalate with evidence.
4. Reject changes that widen authority, silently relax isolation, reinterpret a denial as approval, or mutate history to make an outcome look resolved.

## Produce the approval and comparison record

```text
Improvement: IMP-17 — prevent duplicate recovery delivery
Approved scope: owner approval at proposal revision 4f2e9aa
Baseline: 2 duplicate findings / 20 restart drills at revision 1a0b7c3
Change: idempotent source-event identity at revision 8d9c412
Verification: restart drill observed 0 duplicate findings / 20; one invalid identity rejected
Measurement: elapsed 14m; reported provider usage unavailable; planning estimate advisory
Recovery: admission containment configured; rollback authority <reference or not configured>
Next state: deployed | maintain observation | blocked pending owner decision
```

Handoff the approved scope, exact revisions, observed comparison, remaining unknowns, recovery authority, and current authorized task. Transfer portable artifacts and evidence only; make a receiving provider start a new explicitly scoped session.
