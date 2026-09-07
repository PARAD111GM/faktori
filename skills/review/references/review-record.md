# Review record fields

Load this local reference only when a durable review record needs a fuller
shape than the compact report in `SKILL.md`.

```text
work_item: <stable-id>
artifact_kind: plan | design | code
exact_revision: <immutable revision>
review_context: fresh | unavailable
criteria:
  - id: <criterion-id>
    verdict: pass | fail | not_verified | waived
    evidence: <revision-bound observation or missing condition>
    waiver_authority: <recorded authority when waived>
findings:
  - id: <finding-id>
    severity: blocking | advisory
    criterion: <criterion-id or scope>
    detail: <actionable observation>
overall: passed | changes_required | not_verified | waived
reviewer_merge_authority: none
decision_authority: <configured authority; human by default>
```

Keep this record free of credentials, private provider reasoning, and invented
test results. Store a provider or CI URL only when it is part of the approved
artifact record.
