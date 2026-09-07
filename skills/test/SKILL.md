---
name: faktori-test
description: This skill should be used when a Faktori work item needs behavior-level acceptance evidence, bug reproduction, or risk-proportionate negative verification.
---

# Test

Verify outcomes a user, owner, or operator would notice. Keep test evidence
separate from review, deployment, and product acceptance; a green command alone
does not prove a criterion.

## Trigger and inputs

Apply this skill to an implementation revision, an accepted criterion, or a
reported bug. Require the scoped context packet, exact revision, risk level,
environment, acceptance criteria, and relevant receipts. Discover the target
repository's documented commands before running them. Use Faktori's `npm test`,
`npm run build`, and `npm run check` only for Faktori work; do not invent an
equivalent command for another stack.

Load `references/debugging.md` only when diagnosing a bug, test failure, or
unexpected result. Keep the main verification path lean when diagnosis is not
needed.

## Procedure

1. Bind every observation to the exact revision, environment, authority, and
   criterion. Mark an unavailable required environment as `not_verified` with
   its blocker rather than weakening the criterion.
2. For a bug, first capture a deterministic reproduction of the reported
   behavior, then add the smallest behavior-level regression that fails for the
   defect and passes after the fix. Preserve the original symptom; do not
   replace its oracle with a fixture, mock success, internal call count, or
   looser assertion.
3. Exercise the critical story through the highest useful boundary: a journey
   for a user flow, an integration/contract test for a service seam, or a unit
   test only for intricate isolated logic. Check UI behavior and accessible
   names, keyboard interaction, focus, semantic feedback, and responsive
   failure states when the criterion exposes a UI.
4. Add targeted negative evidence for high-risk boundaries: authority,
   tenant/data isolation, credentials, publication, concurrency/idempotency,
   cancellation, and recovery. Demonstrate that a crafted request cannot bypass
   the boundary and that retries do not duplicate a consequential effect.
5. Run the selected documented command or interaction and preserve its actual
   result. Record failures, flakes, skipped cases, and unknown telemetry as
   facts. Do not claim a provider exercise, deployment, or acceptance that was
   not observed.

## Scale and evidence

Use compact verification for a small bug or chore: one criterion-bound
regression or observed check. Use normal verification for a feature: critical
story coverage plus meaningful failure paths. Use high-risk verification for
security, money, authority, destructive actions, or recovery: normal evidence
plus focused bypass, replay, denial, and recovery cases.

Emit a result such as:

```text
revision/environment: <revision> | <environment>
criterion: <id> | pass | observed <behavior and command/interaction>
criterion: <id> | not_verified | blocked by <specific missing condition>
regression: <reported symptom> -> red at <revision> -> green at <revision>
next: review | deploy | blocked: <reason>
```

Escalate a failed criterion, flaky result, missing receipt, inaccessible test
environment, changed revision, or any required provider/production test without
explicit authorization. Preserve the repro and failure evidence so a later run
can resume from the same fact rather than retesting by assumption.
