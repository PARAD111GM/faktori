---
name: faktori-design
description: This skill should be used when accepted Faktori work has material interface, data, interaction, or integration decisions that need an approved design reference. Bypass a separate design artifact for a tiny clear bug or implementation whose plan already fixes every material decision; retain the explicit reason in the lifecycle record.
---

# Design Faktori work

Record only the decisions needed to implement an accepted scope safely and
portably; keep framework choices local to the product implementation.

## Ground the decision

- Resolve `<faktori-kit-root>` and read
  `<faktori-kit-root>/docs/lifecycle/contract.md` and
  `<faktori-kit-root>/docs/context/README.md`.
- Verify the accepted plan/context packet, ancestor constraints, exact source
  revisions, approved references, dependency contracts, authority, and risk
  level. Do not adopt unapproved references or reinterpret product scope.
- Inspect existing interfaces, schemas, user flows, repository conventions, and
  deployment/recovery boundaries before asking a question. Route only a
  materially execution-changing owner decision to the **interview skill**.

## Decide proportionally

1. Define the chosen interface, data/state ownership, interaction or operational
   flow, integration contract, validation/error behavior, and compatibility
   boundary. State what remains intentionally unchanged.
2. Compare alternatives only where they materially differ in cost, control,
   safety, user behavior, migration, operations, or recovery. Name the reason
   for the selected option and any owner decision behind it.
3. Describe the smallest verification-visible behavior, relevant negative or
   recovery cases, and rollout/rollback implications. Preserve inherited
   constraints verbatim; add refinements rather than replacing them.
4. Keep core guidance stack-neutral. Point repository-specific implementation
   work to installed Faktori documents by kit-root path, not a Markdown link
   that would break outside a source checkout.
5. Bind the approved design revision to the plan. Stop when remaining questions
   would not materially change implementation or acceptance; create an explicit
   gate for unresolved material risk.

## Package and hand off

- Select a compact decision note for small work; select a normal design
  reference for a feature; select separate interface/data/security/recovery
  decisions and dependency contracts for large or high-risk work.
- Emit approved references, selected decisions, rejected material alternatives,
  invariant constraints, contracts, risks, verification implications, authority,
  and revision. Example: `Design@d7 keeps the existing HTTP contract; malformed
  input returns a recoverable validation error; production rollout remains
  human-authorized.`
- Hand the accepted design and plan to the **build skill**. Escalate an
  incompatible contract, unapproved reference, scope-rewriting design change,
  material security/data risk, unavailable recovery, or absent authority.
