# Faktori V1 — Product and Implementation Plan

## 1. Product commitment

**Faktori lets an owner point a coding agent at `PARADIIIGM/Faktori`, describe what they want to build, and erect a working software factory fitted to their resources and preferences.**

V1 delivers a complete, self-hosted path through Plan, Design, Build, Test, Deploy, and Maintain. It includes a local Console, supports Codex, Claude Code, and Cursor, and keeps the owner’s requirements, workflow, and accumulated knowledge portable.

The public repository ships tested runtime code alongside the documentation, skills, templates, and examples needed to configure and extend it. The setup agent installs and configures that runtime, generating project-specific material around a maintained core.

The first audience is an individual developer or small team. Multiple products and pods are supported on one factory host, with shared resource limits. Distributed workers and enterprise collaboration remain later additions.

**V1 boundaries**

- Greenfield factory creation, including registration of existing product repositories.
- No import of existing factory orchestration, migration engine, or automated cutover.
- Three supported providers; an individual factory may use only one.
- GitHub by default; optional Jira integration included for Twinzy.
- Local Console and locally operated agents.
- Configurable defaults, authority, budgets, and recovery behavior.
- No hosted service, billing, marketplace, 3D visualization, or business analytics.

Triforge supplies operational evidence and a comparative benchmark. Similarity to Triforge is neither an acceptance criterion nor a recommendation rule.

The design follows the committed artifact chain in [Anthropic’s SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook), the bounded scheduling and repository configuration demonstrated by [Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/), and the preference for simple, composable mechanisms in [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents).

## 2. Product behavior and architecture

### Onboarding and self-construction

The entry instruction is:

> “Use Faktori to build me a software factory for [product or organization].”

The bootstrap skill guides the external coding agent through this sequence:

1. Inspect available repositories, agent CLIs, tools, hardware, and deployment resources.
2. Interview the owner, asking only for information discovery cannot establish.
3. Recommend a configuration and explain its cost, human workload, and material tradeoffs.
4. Obtain approval for that concrete configuration and its provisioning actions.
5. Provision, authenticate through provider-owned flows, validate, and resume automatically after interruptions.
6. Open the Console and demonstrate a small working delivery loop.

The interview collects product scope, existing resources, stack, organization, ownership, hierarchy terminology, provider preferences, financial budget, available human attention, approval authority, environments, and incident preferences.

It presents one recommended configuration first. Alternatives appear where they materially change cost, control, or effort. Enterprise questions appear only when relevant.

The smallest configuration uses one owner, one product, one pod, one available provider, GitHub, local execution, and existing resources. Additional pods require an actual ownership, concurrency, repository, environment, or product-surface reason.

`faktori product new` repeats product discovery within the existing factory. It inherits factory settings and presents the incremental resource and cost implications. A new product does not automatically receive a new pod.

### Runtime and repository organization

Use:

- Node.js 24 LTS and TypeScript.
- npm with a committed lockfile.
- Fastify for the local service.
- React and Vite for the Console.
- SQLite through `better-sqlite3` for queries and UI projections.
- Vitest for behavior and contract tests; Playwright for browser journeys.
- One application package with internal modules, one coordinator, and agent subprocesses or containers.

The implementation locks dependency versions during the first phase. [Node release schedule](https://nodejs.org/en/about/previous-releases)

The standalone source checkout lives outside any product program directory, for example at `<workspace>/Faktori`. Product-specific instructions must not become Faktori’s global rules.

| Repository area | Responsibility |
|---|---|
| Entry documentation and specification | Explain Faktori, bootstrap an agent, define product intent and accepted architecture |
| Skills and templates | Interview, scope work, guide lifecycle stages, configure providers, maintain factories |
| Runtime modules | Configuration, scheduling, workspaces, providers, integrations, authority, receipts |
| Console | Render factory state and submit authorized commands |
| Conformance tests and examples | Prove adapters, lifecycle behavior, installation, and representative configurations |

Generated factory configuration lives in a separate owner-controlled repository. Product artifacts normally live beside the product code. A product spanning repositories names one artifact home and links the others to it.

The public repository contains no private Twinzy configuration, organization credentials, local machine paths, or live integration identifiers.

### Sources of truth and restart recovery

Use four clearly defined stores:

| Information | Authority |
|---|---|
| Intent, specifications, plans, policies, approved configuration | Version-controlled documents and configuration |
| Issues, PRs, CI results, deployments | Their configured provider |
| Runs, pending actions, resource reservations, messages, receipts | Durable local records owned by the coordinator |
| Dashboard views and query indexes | Rebuildable SQLite projection |

The coordinator maintains a small append-only operational journal and per-run artifacts outside Git. This is limited to execution recovery.

Before launching work or performing an external mutation, persist the intended operation and its identity. Afterward, persist the observed result. A crash between those records produces an unresolved operation that must be reconciled before retrying.

One coordinator owns a factory at a time. Startup checks both its ownership lock and surviving workers. An expired heartbeat alone never proves a worker stopped.

Cancellation invalidates the run’s permission to publish before terminating its worker. Late results may be retained for inspection but cannot trigger side effects.

### Work hierarchy, context, and lifecycle skills

The default hierarchy is:

```text
Product
└── Feature
    └── Work Item
        └── PR(s), verification, deployment evidence
```

Nodes have stable identities, one primary parent, configurable labels, and explicit dependency links. Planning scopes and executable work items remain distinguishable even when users rename them.

Support additional nesting without creating a general workflow language. Reject cycles. Map native tracker hierarchy where available; expose provider limitations and preserve unsupported relationships through explicit links. [GitHub sub-issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)

Every work item receives a scoped context packet containing:

- Its accepted objective and criteria.
- Applicable global constraints.
- Relevant parent requirements and their references.
- Necessary dependency contracts.
- Approved design references.
- Current artifact revisions, commands, authority, and evidence requirements.

Sibling context is included only through an explicit relationship. A child may refine its scope but cannot silently rewrite an ancestor’s accepted constraints.

The first-party skill set covers bootstrap, product creation, work shaping, each lifecycle stage, factory operation, and factory improvement. Each skill defines its inputs, outputs, scale selection, completion evidence, and escalation conditions. External skills such as Superpowers and gstack can supplement these skills; installation-specific tools are not required to understand the public repository.

| Work size | Required packaging |
|---|---|
| Small bug or chore | Compact intent and acceptance record, implementation approach, diff, verification, release evidence |
| Normal feature | Intent, specification, implementation plan, diff/tests, review, release evidence |
| Large or high-risk change | Separate planning/design artifacts, dependency breakdown, additional risk-specific evidence and recovery plan |

All six lifecycle outcomes must be addressed. They do not each require a separate file. An inapplicable step carries an explicit reason.

Testing happens throughout implementation. A process exit, checked box, completed PR, or successful deployment does not independently establish that acceptance criteria passed.

`AGENTS.md`, Claude instructions, and Cursor rules remain short entry maps into the same source documents. Generate provider wrappers from shared content and check for drift.

### Provider execution and specialized teams

V1 uses unmodified vendor CLIs and explicit session identities.

| Provider | V1 transport | Interaction behavior |
|---|---|---|
| Codex | `exec --json` and explicit session resume | Stream events; queue additional instructions for the next turn; cancel the worker when needed |
| Claude Code | Print mode with streaming JSON and explicit resume | Stream events; resume within the recorded workspace; handle denied permissions as visible blocked work |
| Cursor | ACP over stdio | Stream events, answer permission/question/plan requests, load sessions, cancel |

Authenticated execution must be proved during implementation. [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude programmatic execution](https://code.claude.com/docs/en/headless), [Cursor ACP](https://cursor.com/docs/cli/acp)

Codex app-server and richer Claude control bridges remain optional future transport improvements. V1 does not depend on universal live steering or identical permission semantics.

The internal adapter contract includes:

- Probe installed version and capabilities.
- Start a bounded run.
- Resume an explicit provider session.
- Stream normalized events.
- Respond to native requests when supported.
- Cancel and report the resulting state.

Capabilities explicitly report support for approval replies, questions, resume, cancellation, usage, and sandboxing. Unsupported capabilities remain visible. There is no silent fallback to broader permissions.

Results distinguish completed work, unchanged-but-verified work, blocked work, authentication required, quota exhaustion, failure, cancellation, and interruption with uncertain outcome.

Provider sessions are disposable. Every turn receives current scope and artifact references. Cross-provider handoffs transfer documents, evidence, and concise summaries; they do not depend on migrating private reasoning or native conversation state.

The runtime supports team orchestration through a narrow worker channel for child-task requests, messages, status, and results. The coordinator admits child runs against the shared budget and capacity. Specialists receive bounded ownership, and parallel writers receive separate workspaces unless their edits are explicitly serialized.

Providers may use native subagents where available. The UI reports only the subagent detail the provider actually exposes. Strict resource profiles use coordinator-managed children when native fan-out cannot be bounded.

Authentication stays in the provider’s own login flow and credential store. Faktori does not collect Claude subscription tokens or offer its own Claude login. Anthropic distinguishes running the unmodified CLI with the user’s subscription from intermediating credentials or building an SDK product using subscription credentials. [Claude authentication terms](https://code.claude.com/docs/en/legal-and-compliance)

### Execution, publication, authority, and cost

Offer two execution profiles:

- **Isolated:** Docker workers, recommended by default. Only the job workspace, approved inputs, and the selected provider’s credential profile are available. No host home, Docker socket, factory journal, or GitHub/Jira/deployment credentials.
- **Native:** Explicitly selected for host-dependent tools or owner preference. It trusts the worker with the host access its operating-system identity provides. Onboarding records that difference.

The default adds an execution container without introducing a cluster or remote worker service.

Publication runs through the coordinator using controller-owned Git configuration, remotes, environment, and storage. It validates the requested repository, branch, base, resulting commit, current authorization, and run identity. It never executes worker-supplied Git hooks or project scripts with publishing credentials.

Product builds and tests run without publishing credentials. Deployment uses an approved workflow or configured deployment command in a separate execution context with only the necessary environment credentials.

The policy defaults are:

- Human approval of product intent and material specification changes.
- Autonomous implementation inside approved scope.
- An independent review session before merge.
- Human merge and production-release authority.
- Preview or local deployment where approved.
- Quarantine and notification for factory failures; unrelated work can continue.
- Rollback only through a configured, verified recovery action.

Owners can override these settings. Changes that relax protections explain the specific consequence and require renewed confirmation. The runtime records the owner’s decision and applies it at the relevant boundary. Waiving a check remains distinguishable from passing it.

GitHub supplies repository identity and collaboration permissions. V1’s Console serves the local owner; other collaborators use GitHub/Jira according to their existing permissions. Multiuser Console access is deferred.

Budget enforcement begins before the first agent launch:

- Bound concurrent runs, retries, runtime, and supported token limits.
- Reserve estimated expenditure before work begins.
- Distinguish actual usage, estimated cost, subscription allowance, and unavailable telemetry.
- Refuse a strict spending guarantee when the selected provider cannot support it.
- Never switch to a separately billed route without configured authority.
- Poll integrations locally; do not spend GitHub Actions minutes on routine scheduling.

The interview establishes interruption preferences and human availability. Waiting decisions appear in one inbox, and repeated issues update an existing concern. Human wait time is recorded separately from agent execution time.

### Console and Factory GM

The Console uses a single product/pod filter and four primary views:

| View | Essential behavior |
|---|---|
| Overview | Active work, agent state, capacity, waiting decisions, failed runs |
| Work | Kanban and a collapsible hierarchy/dependency graph |
| Run detail | Timeline, messages, task progress, artifacts, verification, PR and deployment links |
| Factory | Health, resource settings, recovery controls, GM findings and improvement backlog |

Owners can start eligible work, send instructions, answer supported questions, pause admission, cancel runs, resume eligible work, and open the authoritative record. Changes appear as pending until their result is confirmed.

The service binds to loopback, authenticates local commands, validates browser origins, and renders logs and Markdown safely. SSE supplies live updates. The UI never reads the filesystem directly.

The **Factory GM is always AI**, with durable instructions and records rather than a permanently running inference session. Deterministic health checks trigger it when interpretation is useful.

It may perform configured routine maintenance, diagnose factory failures, identify repeated handoff problems, and propose improvements. It does not own product requirements, build product features, widen its authority, or redesign the factory during an incident.

Factory improvements use the same intent-to-delivery process after approval. The GM can commission that work only within delegated authority.

## 3. Implementation process: Manager Loop

The construction process uses the agreed hierarchy:

```text
Build Manager — this Codex task
└── Fresh Phase Implementer-Orchestrator — one Codex task per phase
    └── Specialized subagents working in parallel
```

These are construction roles, distinct from Faktori’s runtime GM and product agents.

### Phase execution

For every phase:

1. The Build Manager creates a self-contained brief from the latest accepted repository state.
2. It estimates the phase’s token budget and selects the implementer’s model and reasoning level.
3. It creates a fresh Codex task in an isolated worktree and assigns the phase.
4. The Implementer-Orchestrator activates an actual goal, organizes specialist workstreams, and selects subagents within the manager’s model-routing guidance.
5. Both tasks communicate directly while execution and token consumption are monitored.
6. The implementer submits its full report and evidence.
7. The manager independently verifies the phase. Remediation returns to the same implementer.
8. After acceptance and integration, the manager evaluates quality and token efficiency, updates subsequent instructions and estimates, and creates the next task.

The manager also operates under an actual goal for completing V1. A `/goal` string in a prompt is insufficient: both tasks must verify that their goal exists. Provider rate limits or unavailable authority remain explicit blockers.

### Model selection

The Build Manager owns model selection for the implementer and the specialist team. It selects the **least expensive model capable of delivering the required result efficiently**, considering likely retries, elapsed time, context requirements, and verification effort.

The usual choices are GPT-5.6-Sol, GPT-5.6-Terra, and GPT-5.6-Luna at medium or high reasoning. These are routing defaults, subject to actual model availability and the user’s account configuration:

| Assignment | Starting selection |
|---|---|
| Mechanical changes with explicit requirements, bounded searches, straightforward documentation | GPT-5.6-Luna, medium |
| Bounded implementation or testing with moderate dependencies | GPT-5.6-Terra, medium; high for more complex reasoning |
| Phase orchestration, integration, ambiguous implementation, consequential review | GPT-5.6-Sol, medium or high |
| Work that demonstrably exceeds those models’ capabilities | Escalate to a more capable available model, recording the reason |

The manager sets the implementer’s model and reasoning explicitly. Its phase brief includes a routing table for expected specialist work. The implementer may select or escalate subagent models within that delegated policy and must record material changes.

Model choice must minimize the expected cost of **accepted work**. A cheaper model that repeatedly fails, requires excessive correction, or consumes many more turns is a poor choice. Likewise, a stronger model should not be used automatically for simple work.

Do not change the Build Manager’s own model unless the user requests or authorizes it.

### Phase token budgets

Before each phase, the manager records:

- Estimated tokens for management and coordination.
- Estimated tokens for the implementer’s orchestration and integration.
- Allocations for specialist workstreams.
- An allowance for verification and rework.
- A contingency allowance.
- The assumptions and confidence behind the estimate.

The first phase uses a bottom-up estimate. Later estimates use observed consumption from comparable tasks and adjust for complexity, integration risk, and model choice.

The phase total includes all participating agents. Parent usage that already includes children must not be added to those children a second time.

Budget estimates are planning targets unless the owner specifies a hard ceiling. Approaching a target triggers reassessment, not premature completion or weaker acceptance criteria. The manager may revise an estimate within existing authority, recording why it changed. An owner-imposed hard ceiling remains binding.

### Token-monitoring script

Create a small Node script, `scripts/build-usage.mjs`, during Phase 0 and use it throughout construction.

The script will:

- Read normalized usage snapshots exported from available goal/session telemetry by the manager, implementer, and subagents.
- Record phase, ticket, agent/session identity, parent identity, model, reasoning level, timestamp, measurement source, and available token counters.
- Deduplicate cumulative snapshots and distinguish parent-inclusive totals from per-agent totals.
- Track input, output, and cached-token categories when available; avoid counting cached or reasoning subsets twice.
- Report measured consumption, estimated consumption, and missing telemetry separately.
- Update a machine-readable phase summary consumed by the HTML dashboard.
- Display budget, consumption, remaining allowance, and a token-consumption chart.
- Refresh from local records every ten seconds while running, without making model calls.
- Emit threshold notices at 70%, 90%, and 100% of the current estimate.

If telemetry does not expose a category or an agent’s usage, the script reports that gap. Account-level usage percentages are not converted into invented token counts.

Dollar estimates are optional and require a recorded pricing basis. Subscription quota consumption and API charges remain separate. The script does not interpret a subscription run as a new API invoice.

The monitor remains a simple local construction tool. It can later inform Faktori’s resource reporting without becoming a second scheduler or monitoring service.

### Efficiency improvement between phases

After accepting each phase, the manager evaluates:

- Estimated versus measured consumption and telemetry coverage.
- Tokens spent on implementation, orchestration, verification, and rework.
- Repeated context loading or unnecessarily large briefs.
- Failed attempts and model escalations.
- Duplicate investigation or review.
- Parallelism that helped throughput versus coordination overhead.
- Whether a cheaper or stronger model would likely have produced the accepted result more efficiently.

The phase report records the findings and concrete changes for the next phase: revised model assignments, smaller context packets, different task decomposition, improved skill routing, reduced duplicate work, or adjusted budgets.

Raw tokens per checkbox are not an efficiency measure because tickets differ in size. Compare similar work and always assess quality, elapsed time, and human intervention alongside token use.

### Implementer instructions and skills

The phase launch prompt includes:

> Complete Faktori V1 Phase N completely, extremely well. You are the orchestrator of a team of specialized subagents. Read the phase brief and governing specification, activate and verify your goal, map dependencies, assign ownership, and parallelize safely separable work within available resources. Follow the manager’s model and reasoning policy, selecting the least expensive capable model for each assignment. Select applicable skills, including Superpowers and gstack where useful. Verify and integrate every result. Maintain the canonical checklist, progress dashboard, and usage records. Report completion only with the required acceptance evidence.

Skill routing follows the user’s orchestration model. Skills cannot introduce conflicting required roles, duplicate review systems, broader authority, or additional scope.

### Construction records and stagnation

Maintain:

- One canonical checklist with stable ticket IDs, dependencies, ownership, status, implementation notes, and evidence links.
- A static HTML dashboard showing the full checklist, completion counter, progress chart, current phase, blockers, specialists, model assignments, and phase token budget.
- Historical completion events so the chart remains accurate when tickets are split or reopened.
- Usage records and phase estimates alongside the construction records.

Only the orchestrator updates shared task state; subagents submit results. The construction dashboard is separate from the shipped Factory Console.

After 30 minutes without meaningful evidence of progress, excluding known external waits, the implementer diagnoses the obstacle, decomposes the work or changes approach, and escalates if necessary. It may continue independent work. It cannot skip required work to improve the chart.

Every phase report includes the full phase checklist, per-ticket implementation notes, commit references, verification results, specialist contributions, material skills used, blockers, judgments, deviations, remaining concerns, model selections, budget variance, telemetry gaps, and lessons for the next phase.

The manager checks the actual repository and behavior before accepting the report. Final acceptance verifies the assembled product.

## 4. Phased implementation checklist

Phases run sequentially. Within each phase, the Implementer-Orchestrator parallelizes independent tickets after establishing their shared contracts.

### Phase 0 — Establish the specification, build controls, and feasibility

- [ ] **F0-01 — Establish the standalone project.** Initialize the Faktori source repository, Apache 2.0 licensing, product intent, architecture decisions, development commands, and scoped agent instructions. Acceptance: a fresh agent can identify the product, constraints, build process, and first task without this conversation.
- [ ] **F0-02 — Implement construction tracking and token monitoring.** Create the canonical ticket model, update command, HTML checklist, progress chart, usage-monitoring script, model-routing record, phase-budget record, and report template. Acceptance: ticket changes preserve correct history; repeated usage snapshots do not inflate totals; missing usage is visible; threshold notices and dashboard summaries match the source records.
- [ ] **F0-03 — Prove required provider mechanics.** Run small authenticated launch, edit, resume, permission-denial, and cancellation exercises for all three CLIs in the selected execution profiles. Capture sanitized events, tested versions, and available usage telemetry. Acceptance: every required provider has observed evidence and an explicit capability report.
- [ ] **F0-04 — Freeze comparison fixtures.** Define app, feature, and bug intents; acceptance tests; starting snapshots; budget limits; and measurement rules before building the factory. Acceptance: both Faktori and Triforge can receive equivalent inputs without changing the rubric afterward.

**Exit:** Providers are feasible, boundaries are documented, and progress and token consumption are visible. Authentication success is never inferred from installed binaries.

### Phase 1 — Build the greenfield bootstrap and lifecycle artifacts

- [ ] **F1-01 — Build the configuration model.** Represent factories, products, pods, provider assignments, budgets, authority, environments, and sparse overrides. Acceptance: solo and multiple-product examples resolve correctly; invalid configuration reports actionable errors.
- [ ] **F1-02 — Implement interview and resumable provisioning.** Produce a readable proposal, approved profile, locked component versions, and recorded provisioning steps. Acceptance: interruption and rerun do not duplicate repositories or overwrite user changes.
- [ ] **F1-03 — Implement hierarchy and context assembly.** Generate stable parent-child records and scoped context packets with source references. Acceptance: a small bug receives relevant constraints without unrelated sibling material.
- [ ] **F1-04 — Author lifecycle skills and provider wrappers.** Cover all six stages, compact and expanded artifact forms, work decomposition, design references, and evidence requirements. Acceptance: Node and Python examples use the same lifecycle without stack-specific assumptions in the core.

**Exit:** An external coding agent can generate a coherent, validated factory and product configuration from the public instructions.

### Phase 2 — Prove one recoverable execution loop

- [ ] **F2-01 — Implement coordinator and durable run records.** Add admission, ownership, journal, queued messages, resource reservations, terminal outcomes, and SQLite projection. Acceptance: restart and index rebuild preserve the correct state of pending and completed work.
- [ ] **F2-02 — Implement workspaces and execution profiles.** Add isolated Docker workers and explicit native execution, resource limits, controlled environment inputs, and process-tree cancellation. Acceptance: isolated jobs cannot reach control storage, publisher credentials, or the Docker socket.
- [ ] **F2-03 — Implement the Codex adapter and local delivery loop.** Turn an accepted work item into a bounded run, code change, tests, and structured result. Acceptance: completion, unchanged work, denial, failure, quota exhaustion, and cancellation remain distinguishable.
- [ ] **F2-04 — Implement controller-owned action admission.** Bind actions to their run, scope, expected revisions, authorization, and current target. Acceptance: duplicate requests, cancelled runs, and forged or stale results cannot perform a second or unauthorized action.

**Exit:** One provider completes a local work item, and interruption cannot silently cause duplicate work or publication.

### Phase 3 — Add three-provider team orchestration

- [ ] **F3-01 — Implement the Claude adapter.** Add streaming, explicit resume, bounded permissions, truthful usage, and blocked-request behavior using the tested CLI version. Acceptance: it passes the common contract using the selected authentication route.
- [ ] **F3-02 — Implement the Cursor adapter.** Add ACP lifecycle handling, permission responses, questions, plan requests, and cancellation. Acceptance: blocking protocol requests never leave an unexplained hanging run.
- [ ] **F3-03 — Implement team delegation and handoffs.** Add specialist admission, explicit ownership, per-workstream workspaces, durable messages, artifact transfer, and parent integration. Acceptance: independent tasks run concurrently without duplicate ownership or lost results.
- [ ] **F3-04 — Prove role portability and provider substitution.** Exercise planning, implementation, and independent review across all three providers; switch a subsequent stage to another provider using saved artifacts. Acceptance: the workflow survives substitution without relying on the previous provider’s private session.

**Exit:** All three providers participate in a coordinated workflow, while a one-provider factory remains functional.

### Phase 4 — Complete GitHub, Jira, review, and deployment handoffs

- [ ] **F4-01 — Implement GitHub integration.** Add repository registration, issue linkage, draft PR publication, check observation, permission inspection, and merge observation through `gh`. Acceptance: repeated reconciliation does not duplicate issues or PRs.
- [ ] **F4-02 — Implement optional Jira integration.** Map projects, issue relationships, assignments, and configured transitions through REST. Acceptance: transition failures are visible and cannot re-enqueue already admitted work.
- [ ] **F4-03 — Implement evidence-based progression.** Bind reviews and checks to the commit under consideration; handle revisions and refreshed evidence. Acceptance: an old review or green checks from an earlier commit cannot clear the current gate.
- [ ] **F4-04 — Implement deployment and maintenance entry.** Provide local deployment and configured existing-CI deployment, environment-specific receipts, smoke checks, and recovery hooks. Acceptance: successful deployment followed by a failed smoke test creates an explicit failure and follow-up.

**Exit:** A work item can progress from accepted intent to verified deployment with a complete, traceable handoff chain.

### Phase 5 — Deliver the Console and Factory GM

- [ ] **F5-01 — Build the Console shell and read views.** Implement Overview, Work board/graph, Run detail, and Factory views against the shared API. Acceptance: source records reconcile visibly and disconnected data is marked stale.
- [ ] **F5-02 — Add owner actions and conversation controls.** Support starting work, messaging, supported approvals, cancellation, resumption, and authoritative links. Acceptance: refresh or repeated clicks cannot duplicate consequential actions.
- [ ] **F5-03 — Implement Factory GM operation.** Add event-driven diagnosis, authorized maintenance, persistent findings, and an improvement backlog. Acceptance: repeated failure produces one updated concern and the GM cannot acquire product or policy authority through its own output.
- [ ] **F5-04 — Add resource and attention visibility.** Display known usage, estimates, unavailable measurements, queue age, waiting decisions, and costed recommendations. Acceptance: a merge bottleneck is visible without spamming the owner or changing merge authority.

**Exit:** The owner can understand and operate the factory from the Console, with GitHub retained for source review and merge decisions.

### Phase 6 — Make installation and operation dependable

- [ ] **F6-01 — Exercise recovery boundaries.** Test coordinator crashes, surviving workers, duplicate inputs, network loss, quota exhaustion, revoked authority, and late results. Acceptance: every interrupted operation becomes resolved, safely resumable, or visibly blocked.
- [ ] **F6-02 — Complete local service protection.** Verify authenticated commands, browser-origin checks, safe rendering, path validation, and worker/control isolation. Acceptance: crafted requests cannot escape the configured action scope.
- [ ] **F6-03 — Implement backup and compatible updates.** Export configuration, artifacts, and required operational records; restore them; preview runtime updates; apply supported version migrations while preserving user-owned material. Acceptance: restoration works and updates never overwrite local configuration or silently roll back incompatible state.
- [ ] **F6-04 — Package the public kit.** Produce a reproducible package, quickstart, troubleshooting guidance, compatibility matrix, and local customization example. Acceptance: required components are reconstructible from the repository and released artifacts.

**Exit:** Faktori is installable, recoverable, and maintainable without undocumented external setup.

### Phase 7 — Prove V1 and measure it against Triforge

- [ ] **F7-01 — Conduct cold-start onboarding.** Give a fresh agent only the public-ready repository and a product request. Acceptance: it erects a usable factory with no undocumented repair by the build team.
- [ ] **F7-02 — Verify supported host and stack paths.** Run the bounded Node and Python cases across macOS and Linux; document and exercise WSL2 where available. Each host runs an independent instance. Acceptance: published compatibility claims match observed results.
- [ ] **F7-03 — Run the isolated Twinzy proof.** Register an isolated Twinzy checkout and complete one small, ready, unclaimed work item with explicit criteria. Select the oldest eligible item excluding protected-risk labels and unresolved dependencies. Use only approved test resources and targets. Acceptance: all three providers contribute, the result satisfies the ticket, and active Triforge operations remain independent.
- [ ] **F7-04 — Run the paired comparison and finalize release evidence.** Execute the frozen fixtures under equal conditions and report quality, tokens, cost, time, and human effort. Include construction-wide budget variance and efficiency lessons. Acceptance: results are reproducible and candid, release blockers are resolved, and the owner has a concrete release candidate.

**Exit:** Faktori V1 passes whole-system acceptance and has measured comparative results.

## 5. Verification, release criteria, and subsequent roadmap

### Test strategy

Use behavior-level tests for the coordinator, adapters, integrations, and UI. Add deeper negative tests for authority, concurrent admission, secrets, publication, cancellation, and recovery.

Routine CI runs deterministic tests without paid inference. Recorded provider events and fake transports exercise failure paths. Live provider exercises are separately invoked for compatibility and release acceptance.

Required scenarios include:

- Interrupted setup resumes without duplicated resources.
- Features and small bugs receive appropriately sized artifacts.
- Parent constraints remain intact; unrelated sibling context stays out.
- All three providers launch, resume, produce results, and cancel correctly.
- A provider fails during a handoff and another continues from saved artifacts.
- Independent specialists work concurrently and integrate cleanly.
- Restart after PR creation does not create another PR.
- A cancelled or superseded worker cannot publish.
- Revoked authorization blocks a queued action.
- Missing cost information appears as unknown and respects strict-budget policy.
- SQLite reconstruction preserves the operational picture.
- Review, CI, deployment, and product verification retain their separate meanings.
- The owner can understand a blocker, respond, and observe confirmed recovery.
- GM recommendations never silently change product requirements or owner policy.
- Backup restoration and updates preserve owner configuration and extensions.
- Construction usage accounting handles repeated snapshots, resumed sessions, parent/child totals, unavailable counters, and budget revisions without double counting.

### Comparative evaluation

Freeze three small cases in Phase 0:

1. **App:** A personal task board with create, edit, complete, filter, keyboard access, and persistence across reload and server restart.
2. **Feature:** Add due dates and an overdue view to a fixed version of that application.
3. **Bug:** Repair a reproducible date-boundary failure in a small Python service, with regression evidence.

Each pair receives the same intent, starting state, acceptance criteria, provider/model availability, financial envelope, and human-attention allowance. Record infrastructure preparation and human waiting separately from execution time.

Evaluate functional correctness first, then cost, token consumption, elapsed time, intervention time, rework, failed handoffs, maintainability, and visibility. Do not combine these into an opaque score.

One run per case is an initial case study. It cannot establish a “nine times out of ten” claim. If Faktori shows no improvement, preserve the result and turn the identified weaknesses into its improvement backlog.

### V1 completion

V1 is complete when:

- A fresh coding agent can erect the factory from its published instructions.
- One-provider operation works, and all three providers pass live conformance.
- The isolated Twinzy work item reaches verified deployment.
- The Console accurately exposes work, decisions, failures, and resource limits.
- The GM performs its bounded factory role.
- Recovery tests pass without duplicate side effects.
- The repository and package reproduce the documented configuration.
- The comparison report states what improved, what did not, and the evidence limits.
- Every construction phase has a model-routing record, token estimate, consumption report with measurement coverage, and lessons applied to subsequent phases.

Implementation uses existing subscriptions and local resources by default. New recurring services or separately billed inference require configured owner authority. No unsupported account entitlement or spending limit is assumed.

The default license is Apache 2.0. macOS and Linux are supported host targets. WSL2 is the Windows path, with its verification status stated explicitly until exercised on a real WSL host.

### Roadmap after V1

1. **Migration assistance:** Analyze incumbent factories, map capabilities, and propose preservation or improvement paths.
2. **Extension tooling:** Stabilize interfaces demonstrated by real modules, add scaffolding and conformance checks, and define a compatibility window.
3. **Additional workers and collaboration:** Remote execution, richer provider interaction, team Console access, and organization-scale resource management.
4. **Community distribution:** Extension discovery, marketplace services, and optional managed capabilities.
5. **Hosted offerings and richer visualization:** Build on the proven interfaces, including optional factory-floor visualization.

V1 preserves the necessary seams through scoped identities, versioned configuration, provider contracts, typed commands, a separate UI API, and user-owned customization directories. Future compatibility is supported through tested contracts and migrations.
