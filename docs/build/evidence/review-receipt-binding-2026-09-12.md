# Controller-owned review receipt binding

Approved scope: repair brittle hash/ID echo requirements in the isolated Faktori
development worktree, based on `6a4c364`. No product edits, publication,
integration changes, or reinterpretation of failed operational receipts.

The isolated current-main exercise stopped after an independent reviewer passed
the candidate but transposed characters in the returned digest. Verification
passed, but phase acceptance correctly remained absent. This is evidence of a
bookkeeping defect, not evidence that the product or delivery journey passed.

## Change and safety boundary

- Preserve raw provider judgment; the controller writes an optional versioned
  binding containing the candidate digest and, for acceptance, review stage ID.
- New prompts request judgment only. Old responses remain readable when their
  explicit identities agree; contradictory fields fail closed.
- Existing before/after workspace checks and independent read-only review remain.
  Acceptance additionally compares the candidate with the preceding review.
- Publication consumes the same compatibility rule. No receipt migration and no
  automatic replay of failed or completed runs.

## Verification

The judgment-only regression failed on the unmodified runner, then passed after
the repair. Focused verification covers runner-to-publication compatibility,
denial, required repair, contradictory IDs/digests, workspace changes during and
after review, and preservation of terminal records on restart. Typecheck passed
under Node 24.20.0 / npm 12.0.2. The focused runner, lean-loop and publication
suite passed 31 tests; build passed. Independent read-only review (Terra/high)
found no substantive issues and also checked delivery and Console consumers.
Test adapters are deterministic fixtures, not live provider proof.

Final full-suite verification: 611 tests across 83 files passed (84.66 seconds,
four workers). Clean offline package/installed-CLI verification passed for
`faktori-0.2.3.tgz`. Sandbox-only cache/process restrictions required running
these local checks with elevated filesystem/process access; no live inference
or external delivery effects were invoked.

Installed-kit verification and a fresh real-provider exercise remain separate
from this source fix. The original failed exercise records are untouched.
No token savings are claimed; removing identity-copy instructions reduces
bookkeeping obligations, but savings need an equivalent measured run.
