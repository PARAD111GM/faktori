---
name: faktori-shaping
description: This skill should be used when accepted product intent must become bounded planning and executable work with explicit dependencies. Bypass it only for a tiny clear bug already carrying a compact accepted intent and context; send a new or ambiguous product request to the interview skill first.
---

# Shape Faktori work

Turn accepted intent into the smallest executable hierarchy that preserves
ancestor constraints and makes dependencies reviewable.

## Establish authoritative context

- Resolve `<faktori-kit-root>` and read
  `<faktori-kit-root>/docs/context/README.md` and
  `<faktori-kit-root>/docs/lifecycle/contract.md`.
- Inspect the accepted product intent, ancestor constraints, existing hierarchy,
  source revisions, approved design references, capacities, and dependency
  contracts. Do not collect sibling material merely because it shares a parent.
- Route vague or materially ambiguous intent through the **interview skill**.
  Preserve inherited facts as source references, record owner decisions, and
  keep unknowns explicit rather than silently resolving them.

## Shape the smallest useful graph

For an issue-backed request, read the full issue and relevant comments first.
Search existing open and closed work for the same cause, not merely matching
error text. Reuse the owner's labels and hierarchy; do not create labels, close
duplicates, comment, or claim work without the configured tracker authority.
For a bug, record expected versus actual behavior, a minimal reproduction,
affected version/environment, and the criterion proving the repair. Use
`faktori-test` for reproduction when evidence is missing; ask only for facts that
cannot be established safely. Preserve related issue references without importing
their entire scope. Do not start a second implementation of already-owned work.

1. State the user-visible objective, acceptance criteria, non-goals, affected
   surface, authority, and evidence needed to establish behavior.
2. Choose planning nodes for intent/specification/design and executable nodes
   for buildable work. Give every node a stable ID, one primary parent, and a
   source revision.
3. Add dependency links only for real ordering or contract needs. Attach the
   narrow interface, data, authority, or verification contract the dependent
   node needs; reject cycles and unknown references.
4. Assemble a context packet containing the accepted objective and criteria,
   applicable global/ancestor constraints, approved references, lineage
   revisions, commands, authority, evidence requirements, and declared
   dependency contracts. Exclude unrelated siblings.
5. Stop shaping when another split, question, or role would not materially
   change executable scope, risk, authority, or order. Record a blocked decision
   as a gate rather than guessing or widening scope.

## Package and hand off

- Select compact packaging for a bug or chore; select normal packaging for a
  feature; select high-risk packaging for broad, irreversible, privacy,
  security, money, or cross-product changes.
- Emit the node graph, context packet, scale rationale, source revisions,
  criteria, non-goals, dependencies, owner decisions, unknowns, and escalation
  gates. Example: `work-item rounding-bug depends on minor-unit-contract;
  currency-contract excluded; merge authority remains human.`
- Hand the packet to the **plan skill**. Escalate missing parent authority,
  contradictory inherited constraints, unapproved design references, a cycle,
  undefined acceptance behavior, or an uncontractable dependency.
