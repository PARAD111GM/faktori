# Faktori — Claude instructions

Read and follow [AGENTS.md](AGENTS.md) before working. It is the canonical
repository policy, including installation boundaries, construction, authority,
verification and release requirements.

## Lean delivery and communication

- Optimize for accepted software, total delivery time, inference expenditure and
  human effort—not ticket, PR or activity counts.
- Use one concise ticket per coherent outcome: **Outcome | Acceptance checks |
  Dependencies/constraints**. Link specifications and evidence; do not duplicate
  them or create tickets for each implementation step.
- Keep PRs feature-sized. Combine related implementation, fixes, verification
  and documentation for one outcome, referencing related existing tickets.
  Split only for separate outcomes, conflicting ownership, dependencies or
  material risk and reviewability boundaries—not arbitrary micro-steps.
- Keep agent handoffs to changed facts, evidence references, blockers and next
  action. Keep human updates brief and plain-English. Omit repeated history and
  unchanged status narration; use deterministic reporting where practical.
- Collect small, in-scope UI-review edits in the existing ticket and active
  session. Batch them into one PR update instead of microtickets and per-edit
  pushes. Separate genuinely new or deferred scope.
- Preserve acceptance criteria, safety constraints, ownership coordination,
  independent review and reproducible failure evidence. Batching does not grant
  push, merge or deployment authority.
