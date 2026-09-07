---
name: faktori-review
description: This skill should be used when an accepted Faktori plan, design, or code revision needs a fresh-context, read-only, criterion-by-criterion independent review.
---

# Review

Review an accepted plan, design, or implementation from fresh context. Produce
revision-bound evidence for the configured merge decision authority (human by
default; an owner-approved override is honored). Never edit, exercise merge
authority, change release state, or turn a review into an implementation
session.

## Trigger and inputs

Apply this skill after the artifact under review and its criteria have a stable
revision. Require the work-item identity, artifact kind (`plan`, `design`, or
`code`), exact revision, scoped context packet, acceptance criteria, dependency
contracts, risk labels, and prior verification evidence. Start without relying
on the author's private session, reasoning, or unrecorded claims. Mark the
review `not_verified` when fresh context, the exact revision, or an essential
source is unavailable.

## Read-only procedure

1. Confirm the exact revision before reading. Reject inherited conclusions from
   an earlier head, rebase, or different artifact. For code, inspect the diff
   and relevant surrounding contracts; for plan/design, inspect the complete
   accepted artifact and its stated dependencies.
2. Read the scoped context, each criterion, applicable authority constraints,
   and the supplied test or verification receipts. Keep unrelated sibling work
   out of scope.
3. Evaluate every criterion independently. Record one of `pass`, `fail`,
   `not_verified`, or `waived`; name the evidence location or exact missing
   condition. A waiver requires recorded owner authority and remains distinct
   from a pass.
4. Review plan artifacts for scope, dependencies, lifecycle handoffs, risks,
   and authority. Review design artifacts for requirement traceability,
   interfaces, failure/recovery behavior, and stack-neutral constraints. Review
   code for criterion satisfaction, truthful gating, behavior-level evidence,
   high-risk boundary coverage, and unintended scope or authority expansion.
5. Classify findings. Mark as blocking a failed required criterion, an unsafe
   authority/security/recovery boundary, missing exact-revision evidence, or a
   condition that makes release truthfulness impossible. Mark as advisory an
   improvement that does not prevent the accepted behavior or safety boundary.
6. Return the report to the implementer or configured decision authority. State
   only review readiness: `passed`, `changes_required`, `not_verified`, or
   `waived` with authority. Do not merge, approve deployment, modify files, or
   execute a provider action.

## Scale and handoff

Use compact review for a small bug or chore: exact revision and every criterion
in a concise table. Use normal review for a feature: full criterion table,
dependency/verification check, and blocking versus advisory findings. Use
high-risk review for authority, credentials, money, destructive work,
concurrency, publication, or recovery: normal review plus deliberate bypass,
replay, failure-containment, and recovery-evidence inspection.

Load the local [review record template](references/review-record.md) only when
the compact report needs a durable, structured record.

Emit a report such as:

```text
artifact/revision: code | <exact revision>
criterion C-01: pass | <observed evidence>
criterion C-02: not_verified | <missing exact environment receipt>
finding B-01: blocking | <reason and affected criterion>
finding A-01: advisory | <non-blocking improvement>
verdict: not_verified | reviewer has no merge authority
decision authority: <configured authority; human by default>
```

Escalate an ambiguous criterion, unavailable fresh context, changed revision,
missing waiver authority, unavailable required evidence, or any request to
implement a finding. Preserve the report and exact revision so a follow-up can
apply the configured review policy to a changed artifact. Do not mandate a
second review merely because an artifact changed, but do not present review
evidence from an earlier revision as evidence for the final head.
