# Faktori

For installation or owner onboarding, start with [INSTALL.md](INSTALL.md) and
follow its bootstrap route. Do not start construction phases or edit this kit
when the owner asked you to install a factory.

For development of Faktori itself, read `docs/implementation-plan.md`, your
phase brief when assigned, and the latest applicable accepted report before work.
The construction protocol below applies to that development, not to ordinary
installation or operation of an owner's factory.

## Lean delivery and communication

- Optimize for accepted software delivered with less total time, inference and
  human effort, not ticket counts, PR counts or agent activity.
- Use one ticket per coherent, independently verifiable outcome, not per
  implementation step. Keep related code, verification, documentation and
  in-scope UI refinements together.
- Default to one feature-sized PR per outcome or human review batch. A cohesive
  feature may reference several existing tickets. Split only for genuinely
  separate outcomes, conflicting ownership, dependencies or material risk and
  reviewability boundaries; avoid micro-PRs and catch-all PRs alike.
- Keep tickets concise: **Outcome | Acceptance checks | Dependencies/constraints**.
  Link authoritative specifications and evidence instead of copying them.
- Keep agent handoffs to changed facts, evidence references, blockers and next
  action. Do not resend full histories or report unchanged status repeatedly.
- Keep human updates brief and plain-English; add detail when needed for a
  decision, safe operation or comprehension.
- Track small UI-review edits as checklist items within the existing ticket and
  active implementation session. Batch related edits into one PR update rather
  than pushing each adjustment. Separate genuinely new or deferred scope.
- Use deterministic code for routine status and summaries where practical.
  Measure administrative effort per accepted outcome, not activity volume.
- Conciseness never removes actionable acceptance criteria, safety constraints,
  ownership coordination, independent review or reproducible failure evidence.
  Feature-sized batching does not grant push, merge or deployment authority.

## Construction protocol

- The Build Manager accepts phases. A fresh Phase Implementer-Orchestrator owns each phase and commands specialized subagents.
- Activate and verify an actual goal. A slash command in a prompt is not proof of goal activation.
- Work only in the assigned isolated worktree. Never edit Twinzy or Triforge during factory construction.
- Use explicit model and reasoning choices: Luna medium for mechanical tasks, Terra medium/high for bounded implementation, Sol medium/high for orchestration and complex integration. Escalate based on evidence and record why.
- Parallelize independent work with explicit ownership; one writer per file at a time. You are not alone in the codebase; preserve others' work.
- Use available relevant skills, reading their instructions first. User-approved phase scope and orchestration take precedence over generic skill conventions.
- The phase orchestrator alone updates the shared checklist. Reviewers remain read-only. All reports require observed evidence.
- Budget targets are estimates, not completion criteria. Record measured versus unknown usage; never infer tokens from account percentages or double-count parent/child usage.
- Keep construction estimates only in the construction records. Never copy or infer an estimate into a native goal `token_budget`; a native hard cap requires an explicit owner request.
- Use apply_patch for file edits, small conventional commits, no co-author trailers, and no force pushes.
- Every merge must include release notes in `docs/releases/` and an updated README release-note link. Small patches increment the patch version by one (for example, 0.2.1 to 0.2.2); keep package.json and the root package-lock.json versions aligned. Release notes distinguish source changes from installed/runtime verification and document required update steps.
- Implement the simplest behavior that meets the specification. Write behavior-level tests; focus deeper tests on authority, concurrency, credentials and recovery.
- Do not buy services, switch to separately billed inference, alter existing provider credentials, or mutate active product infrastructure.
- Provider authentication remains in the unmodified vendor CLI. Never print, copy, commit, or export credentials/session tokens into Faktori records.
- Subagents do not merge or publish. The phase orchestrator reports a candidate commit; the manager verifies and integrates it.
- Do not call tests, live provider checks, deployments, or release acceptance passed unless actually observed. Record exact blockers and continue unaffected authorized work.

## Source of truth

The committed specification defines the product. Construction progress and per-phase reports are durable. Private local operational telemetry and credentials never belong in the public repository.

## Commands

Use the package scripts under the pinned Node 24/npm 12 toolchain. `npm run check`
strictly typechecks the TypeScript runtime, runs behavior tests, emits the
installable package, and verifies the packed CLI from a clean temporary install.
Do not invent successful checks or start a later phase before manager acceptance.
