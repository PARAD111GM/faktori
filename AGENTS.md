# Faktori

Build the self-hosted, vendor-neutral software factory specified in `docs/implementation-plan.md`.
Read that specification, your phase brief, and the latest accepted phase report before work.

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
