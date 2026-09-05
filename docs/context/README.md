# Hierarchy and scoped context

`validateHierarchy()` accepts a versioned hierarchy of planning and executable
nodes. The `kind` field is structural: labels can be renamed freely and cannot
turn planning into executable work or the reverse. Each node has at most one
`parentId`; dependencies are explicit directional links where `fromId` depends
on `toId`.

`assembleContextPacket(document, nodeId)` validates first, then returns only
what that node needs: its accepted objective and criteria; global and ancestor
constraints; its local refinements; approved design references; and the
applicable ancestor-to-local lineage of artifact revisions, commands, authority
and evidence requirements. It also includes contracts on its declared
dependencies. Every packet item has `sourceNodeId` and
`sourceRevision`.

Sibling work is never copied into a packet merely because it shares a parent.
If a sibling is necessary, add a dependency and supply the narrow contract that
the receiving node needs. Its objective, criteria and unrelated artifacts stay
out of the packet.

## Constraint inheritance

Ancestor constraints remain immutable in a child packet. A child may add an
explicit refinement using a new constraint ID and `refinesConstraintId`; it may
not reuse the ancestor ID or replace its text. Parent and dependency cycles,
unknown references, unapproved design references and missing source revisions
all fail validation with exact paths.

See [small-bug.json](../../examples/context/small-bug.json) for a compact bug
hierarchy. Its `rounding-bug` packet contains the `billing-boundary` constraint
and the `minor-unit-contract`, but not the full `currency-contract` context.
