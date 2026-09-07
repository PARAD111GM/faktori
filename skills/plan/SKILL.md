---
name: faktori-plan
description: This skill should be used when a shaped Faktori work item needs an evidence-ready implementation plan. Bypass a separate plan artifact only for a tiny clear bug with a compact accepted intent; still record its approach, verification, release evidence, and every inapplicable lifecycle stage.
---

# Plan Faktori work

Convert a scoped context packet into an executable, authority-bounded plan.

## Read the packet before proposing work

- Resolve `<faktori-kit-root>` and read
  `<faktori-kit-root>/docs/lifecycle/contract.md` and
  `<faktori-kit-root>/docs/context/README.md`.
- Verify the accepted objective, criteria, ancestor constraints, dependency
  contracts, approved design references, source revisions, commands, authority,
  budget, and required evidence. Treat the packet as authoritative; never infer
  permission from a sibling, green command, PR, or prior approval.
- Return to **shaping** for an unclear objective or dependency; return to the
  **interview skill** only when an owner decision or unknown materially changes
  scope, execution, cost, or authority.

## Produce the smallest complete plan

1. Restate the objective, acceptance criteria, non-goals, exact scope boundary,
   inherited constraints, owner decisions, and unresolved facts.
2. Describe ordered implementation steps, affected contracts/data, dependency
   inputs, testable acceptance behavior, commands or interactions, environment,
   and recovery/rollback actions appropriate to the risk.
3. Address Plan, Design, Build, Test, Deploy, and Maintain. Combine stages in a
   compact artifact when justified; for every inapplicable stage, state why and
   what evidence supports that conclusion.
4. Identify only material risks: authority, credentials, privacy/security,
   destructive or irreversible behavior, budget/capacity, provider capability,
   release, and recovery. Turn unresolved material decisions into named gates.
5. Bind the plan to current artifact revisions and authority. Re-plan when the
   intent, constraints, dependencies, or approved design changes; never carry a
   prior approval forward to changed scope.

## Package and hand off

- Select a compact intent/acceptance record for a small bug or chore; select a
  specification plus implementation plan for a normal feature; select separate
  planning/design artifacts, dependency breakdown, risk evidence, and recovery
  plan for large or high-risk work.
- Emit a revision-bound plan with commands/interactions, expected observable
  results, exact evidence locations, authority, risk gates, and scale rationale.
  Example: `Test: run <documented command> at revision abc; accept only when the
  saved value survives reload; Deploy: pending until release authority is
  granted.` Treat missing approval or infrastructure as pending, not inapplicable;
  reserve inapplicable for a genuinely unnecessary outcome with a recorded reason.
- Hand the plan to the **design skill** when interface, data, interaction, or
  other material design decisions remain; otherwise hand it to the **build
  skill**. Escalate scope drift, missing contracts, unapproved references,
  authority/budget uncertainty, or an unproven recovery path.
