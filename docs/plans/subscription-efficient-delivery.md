# Faktori next phase: subscription-efficient delivery

Status: implementation approved by owner on 2026-09-22: build in goal mode and push in as few PRs as possible. Merge, active product cutover and production deployment remain outside this approval.

## Objective

Deliver more deployment-bound, human-accepted features from existing subscriptions, with less elapsed time, rework and human coordination. Optimize the complete path to acceptance, not the cost of a single model call, agent utilization, ticket count or lines of code.

Keep one provider plus GitHub/local tracking viable. Capabilities and roles are independent of vendors; existing Jira/Slack integrations remain supported, not mandatory. Use the existing Faktori graph, coordinator, journals, adapters and Console.

## 1. Reviewed baseline and first gate

Reviewed on 2026-09-22:

- GitHub main: `919e0db3511c5a5f7507d80df956f5c5e4b7c799`, v0.2.2 console guidance, Jira columns and role prompts. No open PRs were returned by the repository API at inspection time.
- Recovery worktree: `84f396f1bb17f276d4265da232e2f818f4e1dc28`, branch `feat/delivery-recovery`, package v0.2.3. This is the principal source baseline for this plan, not installed-runtime proof.
- That worktree also has modified `AGENTS.md`, untracked `CLAUDE.md` and `node_modules`. Preserve these; guidance changes require reconciliation, not replacement. The main checkout is older still; do not use its checkout state as GitHub truth.
- Existing source includes scoped context, role prompts, owner-ordered lean routes, usage deduplication/outcome cohorts, guarded graph dispatch, automatic relay replenishment, delivery synchronization, candidate verification and nightly GM input deduplication.
- Missing or not established: subscription-aware admission, first-class role pools, reliable connected task launch/completion/wake-up, persistent human previews, and the installed end-to-end acceptance journey. Automatic relay enqueue is not task execution.
- Source review only: no fresh full check, live worker exercise, installed acceptance or numerical efficiency baseline was performed in this planning pass.

Before new runtime work, reconcile the recovery candidate against current GitHub main, release/package contents and the explicitly chosen dogfood installation. Preserve active workers and journals. Identify what can be accepted unchanged versus repaired; do not replay completed phases or rebuild existing features. Prior source work may need its own coherent landing before new feature PRs; do not bury it in them.

Run a bounded attended existing-candidate validation to establish the actual remaining integration gate. Unattended admission stays disabled until task transport and the connected witness pass. Missing permissions and credentials are operational gates, not reasons to invoke a stronger model.

## 2. Three cohesive implementation increments

### A. Economical routing with evidence-rich senior consultation

Outcome: a work item uses the least expensive qualified route under the owner's policy and available subscription capacity; a blocked builder obtains narrow assistance and resumes ownership.

Extend `src/config/index.ts`, `src/loop/index.ts`, `src/runtime/contracts.ts`, `src/runtime/delegation.ts`, usage accounting and existing provider capability probes. Keep the routing evaluator deterministic.

Required behavior:

1. Bind every attempt to a stable feature/work-item identity, role, provider account pool, model, policy revision and context revision. Every dispatch path includes the configured role prompt, not just Console-originated work.
2. Represent measured usage, advisory estimates/reservations and subscription capacity as different records. Capacity observations name the account pool, provider-native unit, limit/reset window, freshness and source. Models or tools sharing one allowance consume one pool; do not count them as independent subscriptions.
3. Admit work atomically through the existing coordinator. Use provider-native capacity only where it is observable and meaningful. Where task consumption cannot be translated into that unit, reserve conservative slots/owner-approved allowances and report estimation uncertainty; never subtract token estimates from account percentages or promise prevention of weekly exhaustion.
4. Hold configurable completion capacity for review, repair and release verification before admitting new implementation. Apply it across products sharing the account, with priority and aging so low-ranked work is not starved. Do not burn allowance merely to maximize utilization. Account for usage outside Faktori as unattributable account pressure when observable.
5. Use configured task classes and route preferences initially, not a model that chooses another model on every dispatch. Routine/mechanical work starts economical; complex specification and planning may use a senior route. Reuse approved specs and existing candidates; do not add planning/build stages when they are unnecessary. Actual supported model IDs and subscription eligibility must be probed, not hardcoded from conversation examples.
6. For genuine engineering difficulty, send a bounded consultation: objective, exact revision, relevant contract/files, reproduction, attempts and results, narrow question, requested output and limit. The senior returns a diagnosis/solution proposal; the original builder implements and verifies it. Consultation does not satisfy independent review. A new consultation requires new evidence or explicit policy authority, not the same failed prompt again.
7. Separate engineering difficulty from permission, quota, missing dependency and unavailable transport failures. Those become actionable incidents. Retry only with a changed hypothesis/input or a bounded infrastructure-retry policy. Escalate earlier when failure evidence makes another cheap attempt wasteful.
8. Unknown/stale capacity permits only bounded economical work under the previously selected fallback policy. Automatic premium admission needs fresh usable evidence or an explicit allowance. Strict-budget profiles stop if their guarantee cannot be enforced. No silent separately billed fallback, credential migration or permission widening.

Token controls: source-pinned reusable context; only relevant dependency contracts; delta handoffs; bounded failure logs; no repeated history dumps; cache stable prefixes where the provider supports it without claiming guaranteed savings. Load optional skills only when the task needs them. Maintain mandatory safety and acceptance context.

Acceptance: a simple task avoids unnecessary premium/planning calls; concurrent tasks sharing an account do not duplicate capacity reservations; stale/unknown quota remains explicit; quota failure cannot switch to paid inference; a narrow consultation returns to the original builder; cumulative/cache/parent-child usage is not counted twice. Reuse existing usage metrics rather than invent another tracker.

### B. Graph-backed role queues and reliable handoffs

Outcome: a ticket advances through eligible stages without a human prompting every handoff, and without an agent consuming tokens while it waits.

Extend `src/integrations/delivery-graph.ts`, `delivery-sync.ts`, `progression.ts`, `src/console/graph-dispatch.ts`, the Manager-connected store and existing tracker adapters. Finish missing execution/receipt wiring before adding concurrency.

| Logical queue | Consumer | Exit evidence |
| --- | --- | --- |
| Needs specification | Planner, only when needed | Approved bounded specification |
| Ready to build | Economical builder pool | Candidate and configured behavior evidence |
| Ready for review | Independent reviewer | Verdict bound to current candidate |
| Human review | User and original builder | Batch feedback and acceptance/repair decision |
| Ready to release | Authorized release mechanism | Separate merge and deployment evidence |
| Staging acceptance / Done | Configured acceptance authority | Accepted deployed revision |

These are logical stages, not mandatory new tracker columns. Map stable tracker status IDs to stage policies; preserve the user's board order and empty columns. A board column may aggregate several statuses. Queue membership is a derived execution projection, not a second ticket database. Track queued/active/waiting/blocked independently of the business status when the tracker cannot represent them.

Each stage policy specifies role, entry guards, bounded output/evidence, failure route, concurrency/WIP limits and required authority. One role can use several workers; one subscription can serve several roles in separate tasks. Never assign one permanently running agent to each column.

One controller consumes durable provider events/receipts. Authenticate and deduplicate external events; re-read current authority/state before consequential actions. Where push is unsupported, use a lightweight deterministic poller with backoff, not an LLM heartbeat. Stage changes request evaluation; they are neither proof nor permission. Polling adapters remain supported.

Claim only dependency-ready, ranked work within account, role, repository and shared-file limits. Start with one builder and retain the existing maximum of three ticket builders for this rollout, subject to stricter owner limits. Preserve separate coding/review slots, but throttle new coding when downstream WIP exceeds configured limits. Resume repairs with the original builder where safe. A repaired candidate creates a new attempt/revision; do not create cycles in the acyclic dependency graph or erase the prior failed evidence.

Persist dispatch intent before launch, then task/session identity and observed result. Verify actual native goals for Codex Foreman/builders where required; a prompt containing `/goal` does not count. Probe other transports honestly. Reconcile surviving/uncertain workers before reassignment: an expired timer is not proof of death. Verify completion transport and idle wake-up before advertising unattended execution. Restrict unsupported modes to attended operation.

Foreman inference is for ambiguous dependencies, failed approaches and policy exceptions. Routine replenishment, status synchronization, notification receipts and timeout detection are code. Blockers identify owner, next action and authoritative control. Failed/ambiguous notifications remain incidents, not an unanswered human decision; reconcile before retry.

Acceptance: duplicate/out-of-order events and restart produce no duplicate workers or side effects; stale callbacks cannot advance current work; empty queues cause zero model calls; replacement work starts when capacity clears; review/merge backlog applies backpressure; changed evidence invalidates affected gates; missing goals/transport capability visibly block unattended admission. Existing schedulers never compete for the same scope.

### C. Live browser review and the measured improvement loop

Outcome: the user opens the actual candidate, works through a batch of small edits with its builder, and obtains one verified feature-sized PR update.

Extend `src/verification/`, Console work detail/artifacts, `src/gm/metrics.ts` and `src/gm/nightly.ts`. Add a narrow preview-session service only where existing process management cannot provide the required persistent lifecycle.

Register a project-owned preview with worktree, candidate identity, approved environment, process identity and URL. Disposable verification endpoints are not persistent previews. Localhost first; approved simulator hooks use the same capability contract where already configured. No new hosted-preview service or broad native-mobile tooling this phase.

Use separate browser contexts for agent testing and human review so automation cannot take over the user's tab or leak its session. Associate screenshots, console/network failures and reproduction steps with the candidate. Redact secrets and bound retention/context payloads. Local checks cannot stand in for production parity: record environment differences and test the deployed result separately.

Keep the original implementer available to resume on feedback, without a continuous inference loop. Track concise requested/applied/confirmed edits inside the existing feature. Hot reload supports iteration; after a batch, snapshot the candidate, rerun relevant behavior checks and obtain independent review of the final revision under the existing policy. Any later edit invalidates affected evidence. Do not create a ticket or push for every UI adjustment.

Canonical intent/spec/contracts remain in the project. Agents receive access to pinned revisions with explicit writing ownership. The current non-Linux artifact reader intentionally cannot project arbitrary live files; use the supported revision-bound snapshot path for this rollout and expose freshness rather than weakening path safety or pretending live access. Verify shared document access from the actual assigned worker.

Console additions are contextual: queue age/owner/next action, chosen route and reason, account-capacity freshness, preview link/revision and feature cost. Extend current Work/Factory/detail views; no new dashboard forest.

The existing nightly GM consumes deterministic aggregates and only changed findings. Use Define → Measure → Analyze → Improve → Control as a compact record: observed defect, baseline, bounded proposed change, comparison and retain/revert decision. Test one policy variable at a time. No extra agent per methodology step, unearned Six Sigma capability claims, automatic policy rewrites or relaxation of authority.

Acceptance: a real feature persists across reload; human feedback can produce several related changes in one batch; old preview/evidence cannot approve new content; disconnect/restart/cleanup is recoverable without terminating unrelated processes; no-change GM input triggers no inference; route experiments remain proposed until authorized.

## 3. Measurement and the efficiency release gate

Reuse existing outcome cohorts. Freeze feature identity and acceptance scope before measuring; splitting or renaming tickets cannot increase delivered-feature counts.

Primary metric: full attributable lifecycle tokens per deployment-bound accepted feature, including planning, consultation, failed attempts, repairs, verification agents and review. A merged PR is a separate, earlier milestone, not a shipped feature. Record local human acceptance separately from staging acceptance.

Report by comparable work class and model/provider: input, cached-input subset, output and any separately available reasoning counters with provider semantics. Never add subsets twice or treat tokens across models as interchangeable subscription cost. Keep allowance/reset observations, latency and financial charges separate.

Publish alongside the ratio:

- Sample size, source/policy revisions, observation window and coverage gaps.
- End-to-end lead time, queue wait and human interventions/minutes where observed.
- Repair/reopen/regression outcomes and whether acceptance scope was unchanged.
- Unfinished/abandoned work expenditure, shared GM/coordination costs and unattributed usage. Do not hide these outside the result or allocate them arbitrarily to make a route look cheap.
- A separate whole-cohort total where accounting coverage permits it; overlapping PR, feature and failed-attempt views are never summed.

No completed feature means the ratio is unavailable. Partial telemetry gives a labeled lower bound, not savings. Subscription allowance cannot be reconstructed from raw token totals or vice versa. Prefer the cheapest qualified route by observed total path-to-acceptance; use static conservative preferences until sufficient comparable observations exist.

Proof set, kept deliberately small:

1. Validate an existing candidate without rebuilding it.
2. Complete one bounded feature with agent browser checks, a human UI-feedback batch and final deployed acceptance.
3. Exercise a narrow senior unblock on a genuine eligible obstacle; if none arises, use a separately labeled bounded drill, not a fabricated product success.
4. Use deterministic fault drills for duplicate delivery, callback loss, ambiguous Slack acceptance, restart recovery, quota exhaustion, stale review and revoked authority. Do not pay for fresh agents to test pure bookkeeping.

For the configured integrated profile, prove tracker → visible goal-driven task → candidate → independent review → verified handoff → authorized merge → matching deployment → tracker/Console reconciliation → staging acceptance. The minimal profile must also work without Jira, Slack or n8n. Only configured, required capabilities gate a profile; unknown required capabilities block with one consolidated repair list.

Compare equivalent frozen cases with matched scope and quality. Reuse valid baseline evidence where possible; otherwise run one bounded baseline. A tiny pilot is a case study, not a statistical efficiency claim. No percentage savings target is invented in advance. If overhead outweighs the benefit, retain the simpler mode and revise or defer the costly addition.

## 4. Delivery sequence, ownership and release

1. Reconcile the current recovery baseline and accept only its evidenced source scope; exercise attended transport/evidence and capture usage coverage and the first incomplete gate. An incomplete wake-up/bridge does not block independent routing work, but must be repaired in B before unattended release. Do not call the installed factory restored at this point.
2. Approve the small versioned contract changes for route/capacity decisions, stage policies and preview evidence before parallel writers begin. Extend existing journals/projections; no new stores or scheduler.
3. Implement A, B and C as three coherent outcomes; the owner's subsequent approval requests as few PRs as practical. Use one integrated feature PR if independent review remains tractable. After contracts stabilize, non-overlapping routing and preview work can proceed in parallel; coordinator wiring and shared config/package/UI files remain serialized. Run one independent risk-appropriate review per coherent candidate, with re-review when the governing exact-head/sensitive-change policy requires it.
4. Shadow route/queue decisions first: compute selections without launching or mutating trackers. Then one attended builder in a Faktori-only test project, then bounded concurrency. Promote to unattended only after the connected witness and restart/negative cases pass. Do not use Twinzy's active sprint as the first experiment.
5. Run documented `npm run check` under the pinned toolchain for each release candidate, plus the actual browser and transport proofs above. Tests must target user behavior and authority/concurrency/recovery risks; avoid per-helper coverage theater. Reuse passed evidence only when its revision, environment and inputs still match.
6. Include release notes with every merge, README links, package/version alignment, installation/update instructions and packaged agent entry maps. Small patches increment the patch version; decide any feature-version bump against current releases at execution time. Ensure `CLAUDE.md`/generated wrappers carry the concise-ticket, feature-sized-PR and batching guidance in the installed kit, not just the local checkout.
7. Capability-first onboarding asks what handles work tracking, source/review, execution, communication and preview; verifies those capabilities; and records unavailable options honestly. Refresh only changed/expired checks. Never require Jira/Slack for the minimal profile.
8. Contain failure by disabling affected new admissions, preserving records and reconciling uncertain actions. Roll back only through a configured compatible recovery path; no automatic journal downgrade, worker restart, destructive cleanup or changes to current merge authority.

The three increments address Plan, Design, Build, Test, Deploy and Maintain as one compact evidence chain; these are not six new tickets, files or agents. Keep ticket text to Outcome | Acceptance | Dependencies/constraints. One authoritative plan and linked evidence replace repeated status essays. The factory-improvement skill requires scope approval before Build; this document does not itself launch the work.

## 5. Explicit deferrals

No Mastra/Cloudflare platform migration, Archon, Graft/graph database, new workflow engine, wholesale skill/hook suite, marketplace, hosted SaaS, generic visual workflow editor, new issue-tracker vendors, auto-promotion to production, broad Console redesign or always-running stage agents. Cloudflare informs event delivery, evidence and previews; other evaluated repositories inform bounded patterns only. Reconsider an optional tool when a measured bottleneck justifies its total cost.

## Source anchors

- `src/loop/index.ts:600`: current static first-available lean route selection.
- `src/runtime/usage-accounting.mjs:185`: existing distinct merged-PR and accepted-feature cohorts.
- `src/gm/metrics.ts:14`: outcome costs, coverage and overhead reporting.
- `src/integrations/delivery-graph.ts:40`: eligibility before rank/capacity.
- `src/console/graph-dispatch.ts:158`: witnessed-delivery gate on automatic admission.
- `src/gm/nightly.ts:100`: durable nightly invocation and unchanged-input skip.
- `src/console/work-management.ts:501`: artifact observation/snapshot boundary.
- `docs/runtime-verification.md`: disposable verification vs persistent previews; exact-revision evidence.
- `docs/releases/v0.2.3.md`: source implementation and explicitly incomplete installed acceptance.

All source anchors refer to the reviewed recovery worktree, not an assertion about GitHub main or a running installation.

