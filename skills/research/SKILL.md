---
name: faktori-research
description: This skill should be used when Faktori needs bounded, current research to inform a decision without implementing, authorizing, or changing factory or product behavior.
---

# Faktori research

Produce a decision-ready research brief without turning investigation into implementation. Separate sourced facts, bounded inferences, and unresolved unknowns. Prefer current primary evidence; treat vendor marketing, memory, and secondary summaries as leads to verify, not proof.

## Use and bypass

Use for a bounded question about a provider capability, compatibility, cost/control trade-off, external system contract, safety boundary, deployment dependency, or factory/product decision that requires current evidence.

Bypass when the requested work already has approved, current evidence or when the task is implementation, provider activation, configuration mutation, credential handling, deployment, or product requirement creation. Return the brief and route a resulting proposal through the normal lifecycle; do not take effects during research.

## Bound the question

1. State the decision being informed, the decision owner, the exact question, target environment, deadline/freshness requirement, and what is explicitly out of scope.
2. Name the minimum evidence needed to resolve the question and the acceptance condition for stopping. Keep the investigation proportionate; do not widen it because an adjacent topic is interesting.
3. Record existing repository facts with their exact revision. Mark an unobserved current state `unknown` rather than inheriting a prior report.
4. Prefer primary sources: the configured provider's official documentation, versioned API/CLI references, release notes, published policy, source repository, or direct observed behavior where authorized. Date-stamp external evidence.

## Gather and reason

1. Collect only the evidence needed for the stated decision. Preserve source, publication/version date, access date, relevant scope, and any environment limits.
2. Write facts as directly supported claims. Label a conclusion as an inference when it combines facts, and state the reasoning boundary without exposing raw chain-of-thought.
3. Preserve conflicting evidence and unknowns. Do not convert silence, a documentation omission, an unavailable account, or provider login status into support for a capability.
4. Compare options on control, authority, isolation, portability, recovery, cost, workload, and verifiability only when those dimensions affect the decision.
5. Record model/version/reasoning information only when it is observed and material to the decision. Recommend a model-selection policy only as a proposal; do not select or activate a route during research.
6. Treat estimates as advisory. Keep provider-reported usage, reservations, pricing, and missing telemetry separate; never manufacture a hard budget cap from a planning estimate.

## Produce a bounded brief

```text
Question: Can route X enforce the configured hard budget in staging?
Scope: Faktori adapter contract at repository revision 8f3c1d2; provider documentation accessed 2026-09-07

Facts
- [F1] Adapter contract requires explicit provider token-limit capability for strict budget enforcement. (repository source, revision 8f3c1d2)
- [F2] Provider documentation <version/date> describes <bounded observed capability>. (primary source)

Inference
- [I1] Route X is unsuitable for a strict policy unless F2 confirms enforceable limits; this is not proof of current account entitlement.

Unknowns
- Current route entitlement and observed enforcement have not been authorized for live verification.

Decision support
- Option A: retain route with advisory budget; preserves current operation but cannot claim a hard cap.
- Option B: obtain an approved controlled verification; requires explicit authority and no credentials in the brief.

No effects taken. Current authorized next task: <decision owner review or approved lifecycle proposal>.
```

## Hand off safely

Hand off the exact repository revisions, dated sources, facts, inferences, unknowns, and the current authorized next task. Do not hand off credentials, session IDs, raw reasoning, private prompts, or new authority. Keep the package portable: transfer source citations, accepted artifacts, and digests so another provider can begin a new scoped session without inheriting private conversation state.
