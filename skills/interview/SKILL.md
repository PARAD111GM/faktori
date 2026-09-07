---
name: faktori-interview
description: This skill should be used when product intent, inherited constraints, resources, authority, or a material execution choice is unknown. Bypass the full interview for a tiny clear bug with accepted context; inspect discoverable facts first and ask only the single highest-value owner question when one remains.
---

# Interview for Faktori intent

Produce portable, decision-ready intent without turning an owner conversation
into a transcript or treating a skipped question as approval.

## Start with discovery

- Resolve `<faktori-kit-root>` and read
  `<faktori-kit-root>/docs/onboarding/interview.md`,
  `<faktori-kit-root>/docs/configuration/README.md`,
  `<faktori-kit-root>/docs/context/README.md`, and
  `<faktori-kit-root>/docs/lifecycle/contract.md`.
- Inspect, read-only, existing intent, hierarchy/context packets, repository
  status/remotes/stack, configuration, provider capabilities, environments,
  resources, ownership, and incident/release records. Record every discovered
  fact with source and revision. Do not ask an owner to repeat a discoverable
  fact; never request credentials or private provider sessions.
- Identify the one unresolved fact or owner decision most likely to change
  scope, authority, provider/environment choice, cost/workload, acceptance, or
  recovery. Ask one concise question only, then incorporate the answer before
  asking another.

## Select the smallest interview case

| Case | Procedure | Output |
| --- | --- | --- |
| Vague product intent | Inspect first; ask the next highest-value question about outcome, owner, or boundary; repeat only while an answer materially changes execution. | Canonical product intent with criteria, non-goals, owner, decisions, unknowns, and sources. |
| Feature with inherited constraints | Read the context packet and preserve its ancestor constraints; ask only about the proposed refinement or a missing owner decision. | Compact amendment naming its parent intent/revision, refinement, criteria, unchanged constraints, and sources. |
| Tiny, clear bug | Bypass the full interview when accepted context already identifies the behavior, boundary, and authority. Record the bypass reason and compact intent; ask a question only if a material ambiguity appears. | Compact amendment suitable for shaping/plan. |
| Factory resources | Inspect host, repositories, provider capability reports, environments, existing owners, human attention, and budget records; ask only for an owner preference or authority no source establishes. | Resource facts plus explicit owner decisions/unknowns for bootstrap or product creation. |

## Preserve authority and finish correctly

1. Translate each answer or observed fact into a canonical intent field,
   inherited constraint, configuration/proposal input, acceptance criterion,
   risk, or named unknown. Mark the source and revision.
2. State owner decisions explicitly, including a deliberate skip. Record a skip
   as `interview skipped by <owner or requester>; no approval inferred`; require
   the relevant later approval for material configuration, provisioning, merge,
   or release effects.
3. Stop when further questions would not materially change execution. Do not use
   numeric confidence scores or a pseudo-confidence gate.
4. Exclude the private question-and-answer transcript from canonical artifacts,
   context packets, provider prompts, and shared records. Retain only necessary
   decisions, facts, unknowns, and source references.

## Handoff and evidence

- Start from [the intent template](assets/intent.md) when no accepted artifact
  already exists. Adapt it into a compact amendment rather than duplicating an
  existing intent; retain the original artifact home and naming convention.
- Emit either a canonical intent or a compact amendment, never both by default.
  Include objective, criteria, non-goals, owner, inherited constraints, source
  revisions, decisions, unknowns, authority state, and the selected next step.
  Example: `Amendment intent@42: retain tenant boundary C-1; add export criteria;
  owner has not selected preview environment; no deployment approval recorded.`
- Hand product intent to the **shaping skill**; hand factory-resource findings to
  the **bootstrap skill**; hand a new product’s increment to the
  **product-creation skill**. Escalate contradictions, an uninspectable material
  fact, a request to infer authority, sensitive data that cannot be retained
  safely, or a decision that changes accepted ancestor scope.
