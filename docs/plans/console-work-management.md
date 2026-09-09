# Implementation Plan: Console Work Management

Status: proposed plan only; presenting this draft does not start work. If Nathan
explicitly accepts it, that acceptance authorizes the bounded implementation and
local self-dogfood described here. Remote publication, merge, deployment, new
paid/provider routes, and any action outside that accepted scope still require
their normal separate authority.

## Overview

Turn the Console from a run-centric diagnostic dashboard into a truthful
companion for managing human-readable software work. The smallest useful slice
is Faktori managing this plan itself: one real Faktori project, this plan, its
ordered phases and tickets, Manager-mediated requests attached to that work,
and one owner decision whose resolution is observed end to end.

The work extends the experimental Manager-connected path now being built. That
path is agent-mediated: an active Manager uses Codex desktop task tools and the
private local relay. It is not a standalone Codex desktop API, automatic task
discovery, a native approval bridge, an unattended scheduler, or a proven deep
link. The Console must preserve those limits in its data model and copy.

## Requirements

1. Give every page one job. Overview is compact, starts with at-a-glance
   rollups, and has no full activity or loop history. Work owns full activity,
   Manager Loop details, and Jira work.
2. Organize the product around human titles, goals, reported accomplishments,
   and numbered phases. Loop and run IDs remain traceable details, not primary
   labels.
3. Add a Decision Inbox. Every item names the problem, observed or unknown
   cause, recommended resolution, owner, and one truthful next action. Use a
   supported owner response when one exists; otherwise create a bounded task
   for a named agent. Never label a message to an agent as a native approval.
4. Make Sessions first-class: Manager, one phase implementer per phase, and
   ticket specialists. Show configured provider/capability facts and honest
   unknowns. Normal Codex tasks remain visible in Codex and are correlated to
   the companion Console by recorded task title, private thread identity, and
   work scope; no deep link is promised.
5. Add Projects as the home for intent, artifacts, multiple plans, each plan's
   ordered phases, and each phase's tickets. Show project progress, blockers,
   and a concise deterministic daily summary. General Overview rolls up all
   projects. Work has All/Project filtering; there is no mandatory global
   picker.
6. Replace decorative counts with qualified measures. Counts must define their
   population and basis. Unavailable or stale evidence is never rendered as
   zero, and configured sessions or old heartbeats are never inferred active.
7. Separate factory infrastructure health, the Factory GM improvement backlog,
   and product-delivery blockers. A blocked product is not necessarily an
   unhealthy factory.

## Current Baseline and Gaps

- `console/src/main.tsx` defines one global product/pod filter and five primary
  views. Overview currently includes full activity and Manager Loop details;
  Work repeats both and centers a nine-column coordinator-run board.
- `console/src/manager-loops.tsx` and
  `src/console/manager-loop-observer.ts` expose phases, review, delivery gates,
  and safe failure states, but the loop ID and phase ID are the visible names.
  A recorded `running` state is correctly not treated as process liveness.
- `console/src/work-visibility.tsx`, `src/console/activity.ts`, and
  `src/console/jira-observer.ts` provide bounded run/loop/Jira activity and a
  read-only Jira board. Jira mutations and durable Jira activity history do not
  exist.
- `src/console/service.ts` projects coordinator runs, loop summaries, Jira,
  blockers, resource observations, and Factory GM records. It has no coherent
  project/plan/phase/ticket read model and no qualified metric contract.
- The in-progress `src/manager-connected/index.ts` stores a configured Manager,
  explicit Codex task assignments, and durable request states (`queued`,
  `claimed`, `submitted`, `completed`, `uncertain`, `cancelled`). A completion
  is deliberately only `delivery: reported` with
  `productAcceptance: not_evaluated`. Preserve that distinction.
- The in-progress `console/src/manager-connected.tsx` shows sessions and a
  generic request composer inside Work. It does not attach a request to a
  validated project graph or represent owner decisions.
- The in-progress `src/console/manager-relay.ts` is a private loopback relay for
  an active Manager. `docs/manager-connected.md` explicitly says there is no
  automatic wake, task discovery, native permission bridge, or supported
  deep-link navigation.
- The current experiment has observed one real round trip—browser enqueue, CLI
  claim, app message to an existing phase task, explicit task callback, CLI
  completion, and browser report. That is transport evidence only. It does not
  prove unattended execution, generic task visibility, acceptance, or any of
  the work-management redesign in this plan.
- `console/src/main.tsx` derives counts in React from partial arrays. For
  example, it can count recorded running loops but cannot prove an agent is
  currently active. Completion, review, and PR denominators are not defined.
- `src/gm/health-observer.ts` and `src/gm/coordinator-store.ts` concern factory
  health/improvements, while product blockers also appear on Overview/Factory.
  The UI does not make the ownership boundary clear enough.

## Product Model and Authority

Keep `productId` as the durable key already used by factory configuration,
coordinator runs, Jira sources, Manager Loops, and Manager-connected sessions.
The UI calls these records **Projects**. Do not introduce a second project ID.

```text
Project (existing productId)
├── intent and artifact references
└── Plan 1..n
    └── Phase 1..n (ordered within its plan)
        └── Ticket 1..n (stable CWM-style identity)
            ├── dependencies
            ├── assigned Session(s)
            ├── Manager-connected Request(s)
            ├── Decision(s)
            └── delivery evidence
```

### Sources of truth

| Fact | Authority | Console behavior |
| --- | --- | --- |
| Project name/configuration | Resolved `FactoryConfiguration.products` | Reuse `productId`; do not duplicate or rename it in private state. |
| Intent, plan, phase, ticket, goal, order, artifact homes/refs | Versioned `workCatalog` beside `managerConnected` in the owner-controlled Console configuration, or later in shared first-party factory config | Validate exact identities and references at startup; read only allowlisted bounded content and expose no absolute root. |
| Manager and task assignments | `managerConnected.manager` and `.sessions` | Snapshot the assignment on enqueue; configuration is not liveness. |
| Request lifecycle and Manager-observed report | Manager-connected append-only journal | Reported completion is an accomplishment report, never ticket acceptance. |
| Owner decision | New durable owner-action event authenticated by the existing Console command token | Record the choice as pending Manager observation; the active Manager reads and acknowledges it through the private relay. |
| Run/loop execution | Coordinator journal and allowlisted Manager Loop artifacts | Correlate by IDs; do not collapse their state into acceptance. |
| Jira issue state | Read-only Jira observer | Show connected/stale/unavailable with source timestamp. |
| PR/review/merge state | New bounded read-only GitHub observation or existing exact delivery receipt | Show unavailable when not configured; retain last good data as stale after refresh failure. |
| Ticket acceptance | Explicit, evidence-bound acceptance record from the configured project workflow | Do not infer it from an agent report, passing test, review, PR, or merge alone. |
| UI summary/metrics | Deterministic projection of the facts above | Rebuildable, scoped, and timestamped; never authoritative. |

### Minimal catalog contract

Add an optional top-level `workCatalog` beside `managerConnected` in
`LocalConsoleConfiguration`; do **not** nest general work under the experimental
Manager bridge. Projects/plans/phases/tickets must also work for CLI Manager
Loops, Jira-only projects, coordinator runs, and future providers. Once the
shape proves stable it can move unchanged into shared first-party factory
configuration. The exact parser should accept only:

- projects: existing `productId`, intent summary, one server-side artifact home,
  and safe artifact references;
- plans: stable `planId`, project, positive display number, title, goal, and
  artifacts;
- phases: stable `phaseId`, plan, positive unique order, title, goal, and
  acceptance summary;
- tickets: stable `ticketId`, phase, positive unique order, title, goal,
  dependency ticket IDs, and optional external issue key;
- sessions: retain the current identity, role, product/plan/phase/ticket scope,
  adding provider and capability observations only when the Manager can state
  their source and freshness.

Reject duplicate numbers, orphan references, dependency cycles, cross-project
parents, and a ticket-scoped session whose parent IDs do not agree. Sessions
reference the independently parsed catalog; the catalog never depends on a
Manager-connected session existing. The browser cannot create catalog nodes or
select filesystem paths. Catalog changes require editing the owner-controlled
file and restarting the Console in this release.

An artifact home is an owner-allowlisted absolute repository/directory root held
only by the server. Artifact records use repository-relative paths beneath that
root and declare a role such as intent, plan, specification, or evidence. A
bounded read-only observer rejects symlinks, traversal, special files, oversize
content, changed-file races, and non-text content; it publishes title, role,
availability, digest/freshness, and sanitized text content without the absolute
root. Projects renders that intent/artifact content as inert text with preserved
line breaks, not executable HTML. Safe credential-free `https:` references may
also be rendered as external links. This provides an actual artifact home, not
just a list of links.

### Request and decision attachment

An enqueue action must include the target session plus its validated
`productId`, `planId`, `phaseId`, and optional `ticketId`. The store snapshots
that complete scope alongside the assignment so a later config change cannot
silently move a request.

A decision projection has these required fields:

- stable ID and work scope;
- problem in plain English;
- cause with `basis: observed | reported | unknown`;
- recommended resolution and consequence;
- decision owner (`owner` or a named session alias);
- state (`open`, `response_recorded`, `pending_manager_ack`,
  `manager_acknowledged`, `resolved`,
  `uncertain`, or `withdrawn`);
- one action descriptor whose capability is `supported`, `unavailable`, or
  `stale` and whose label says exactly what it does.

Supported action kinds are deliberately narrow:

1. `record_owner_response`: records the owner's response as
   `pending_manager_ack`. The active Manager sees it on its next explicit relay
   read and acknowledges the same decision ID through a relay action. This does
   not wake the Manager or send a task message to the Manager's own thread. It is
   not a native Codex approval and does not approve a merge/deploy/provider
   request.
2. `answer_provider_request`: delegates to the existing coordinator answer
   command only when that run/provider exposes a pending answerable request.
3. `enqueue_agent_task`: creates a bounded Manager-connected request for a
   named configured non-Manager session. The active Manager later claims and
   dispatches it through the existing protocol.
4. `open_external_record`: opens an already observed safe Jira/GitHub URL.

When no owner-response transport exists, the recommended CTA is a named agent
task. When neither route exists, show why the action is unavailable; do not
render an enabled button.

### Qualified measures

Every measure uses `{status, numerator?, denominator?, label, basis,
observedAt}` where status is `available`, `stale`, or `unavailable`.

| Measure | Definition |
| --- | --- |
| Phase implementers | `working / assigned` only when explicit per-session work-state events exist. Until then show `Unavailable · N configured phase implementer tasks`; never use Manager heartbeat. |
| Ticket specialists | `claimed or submitted / assigned specialist requests` in the selected scope. Label this request activity, not live agents. |
| Active PRs | Open, non-draft or draft PRs observed for catalog tickets at the last successful GitHub sync. No source means unavailable, not 0. |
| Review progress | PRs with an observed passing independent-review gate / PRs that have reached the review-required population. State that denominator in the label. |
| Merge progress | Observed merged PRs / all observed ticket PRs. A merged PR is not ticket acceptance. |
| Ticket completion | Explicitly accepted tickets / all in-scope catalog tickets. If the acceptance source or complete catalog is unavailable, the measure is unavailable. |
| Plan/phase progress | Explicitly accepted descendant tickets / all descendant tickets, plus blocked and reported-not-accepted counts. Empty plans say `No tickets`, not `0% complete`. |

The deterministic daily summary uses the owner's configured timezone and a
fixed local-day boundary. It lists at most: accepted tickets; Manager-reported
accomplishments labeled reported; newly opened/resolved decisions; phase
transitions; PR/review/merge changes; and new/resolved blockers. If no durable
event exists, say `No recorded changes today`. An AI-written daily summary is
not part of this plan.

## Information Architecture

| Page | One job | Content |
| --- | --- | --- |
| Overview | Answer “what needs attention across my projects?” | At-a-glance first, compact project rollups, open decisions, truthful capacity/health flags, links to the owning page. No activity feed or loop history. |
| Projects | Explain why each project exists and how its plans are progressing | Project intent/artifacts, multiple plans, numbered phases/tickets, progress, blockers, deterministic daily summary. |
| Decisions | Let the owner resolve or delegate a specific problem | Problem, cause/basis, recommendation, impact, owner, one supported CTA, and result state. |
| Work | Inspect the full work stream | Full activity, Jira board, Manager Loop phase/review details, coordinator runs, All/Project local filter, search. |
| Sessions | Show who is assigned to what and what the connection can actually do | Manager, phase implementers, ticket specialists, Codex task titles, scope, provider facts, capabilities, freshness/unknowns. |
| Run detail | Inspect one coordinator run | Keep contextual navigation from Work; remove it from primary navigation. |
| Factory | Diagnose and improve the factory itself | Infrastructure health, resources, recovery, GM findings/improvements; separate linked section for product-delivery blockers. |
| Settings | Review/edit supported factory configuration | Existing guarded workflow; work catalog remains file-controlled in this release. |

Remove the top-bar global product/pod picker. Overview is always a cross-project
rollup; Projects provides project selection; Work owns an All/Project filter.
Run detail retains the scope of the selected run. Factory remains factory-wide.

## Construction Routing and Measurement

- Default the Phase Implementer-Orchestrator to GPT-5.6-Sol at medium/high
  reasoning for cross-layer integration and phase judgment.
- Route bounded implementation and focused test work to GPT-5.6-Terra at
  medium/high reasoning; use GPT-5.6-Luna at medium for mechanical, low-risk
  edits or deterministic evidence collection. Escalate only from observed need
  and record why.
- Record a soft phase estimate when the phase launches. It is planning data, not
  a native goal `token_budget`, completion criterion, or permission to use a
  separately billed route. Never create a hard token cap without an explicit
  owner request.
- Reuse `scripts/build-usage.mjs` and the existing construction dashboard
  renderer for measured/unknown usage; do not build a second usage monitor for
  this plan. Report telemetry coverage and parent/child overlap honestly.
- Each phase report records estimate versus measured/unknown usage, time,
  rework/review causes, and one lesson used to simplify the next phase. These
  observations tune routing; they do not weaken acceptance criteria.

## Architecture Changes

- `src/manager-connected/index.ts`: extend immutable request scope, journal
  events, decision records, and public/private projections; consume catalog
  identities without owning the catalog.
- `src/console/startup.ts`: parse top-level `workCatalog`; cross-validate it,
  sessions, factory
  products/pods, Jira/GitHub sources, and startup format compatibility.
- `src/console/service.ts`: expose one bounded `workManagement` read model;
  serialize owner decisions and Manager-connected queue operations; keep relay
  authority separate.
- `src/console/activity.ts`: add safe Manager request, decision, and delivery
  milestones; retain per-project/source bounds and deterministic ordering.
- `src/console/github-observer.ts` (new): bounded read-only PR status source
  built on the existing controller-owned `gh` environment in
  `src/integrations/github.ts`; no mutation commands.
- `src/console/work-management.ts` (new): pure graph validation/projection,
  rollups, qualified metrics, and deterministic daily summary.
- `src/console/artifact-observer.ts` (new): bounded read-only access to
  owner-allowlisted project intent/artifact homes with safe public projections.
- `console/src/projects.tsx` (new): project/plan/phase/ticket presentation.
- `console/src/decisions.tsx` (new): inbox and explicit action/result states.
- `console/src/sessions.tsx` (new): task hierarchy and capability visibility.
- `console/src/manager-connected.tsx`: reduce to shared request/action
  components or remove after Projects/Decisions/Sessions own those jobs.
- `console/src/main.tsx`: state types, routes/navigation, page composition, and
  removal of the global filter/run-detail nav item.
- `console/src/work-visibility.tsx`: Work-local project filtering and full
  activity/Jira/loop composition.
- `console/src/styles.css`: only layout required by the new page boundaries;
  preserve the accepted industrial bento system and 4px grid rhythm.
- `src/gm/health-observer.ts` and `src/gm/coordinator-store.ts`: do not broaden
  GM authority; expose enough classification to separate infrastructure
  findings/improvements from product-delivery blockers.
- `tests/manager-connected/*`, `tests/console/*`, and a new installed browser
  journey: behavior-level contract, recovery, security, projection, and real
  Faktori self-proof.
- `docs/manager-connected.md`, `docs/console.md`, and
  `docs/console-jira.md`: document the shipped behavior and explicit limits
  after implementation, not before.

## Implementation Order and Tickets

Use one fresh **Phase Implementer-Orchestrator** per phase. That task owns phase
integration and evidence. It may assign a listed specialist ticket to one task
with exclusive file ownership; no two writers touch the same file concurrently.
An independent reviewer remains read-only and runs after the integrated phase
candidate. The active Manager advances phases only after the owner-visible phase
gate is met.

### Phase 1 — Real Faktori project slice

Goal: make the actual Faktori project, this plan, numbered phases/tickets, and a
scoped request visible in Projects before doing broad navigation polish.

1. **CWM-001 · Define and validate the work catalog** — M
   - Files: `src/console/startup.ts`, `src/console/work-management.ts`,
     `tests/console/work-catalog.test.mjs`.
   - Action: add the top-level minimal project/plan/phase/ticket contract,
     exact-key validation, ordering, dependency-cycle detection, and parent
     consistency. Keep it independent from Manager-connected mode.
   - Why: every later surface needs one trustworthy human work graph.
   - Dependencies: current Manager-connected store candidate accepted as base.
   - Risk: Medium; durable contract and cross-reference integrity.
   - Proof: table-driven boundary tests reject duplicate order, orphan scope,
     cycles, cross-project references, unsafe artifact homes/refs, and unknown
     versions; a Jira-only or loop-only project loads without a Manager session.

2. **CWM-002 · Bind requests to immutable work scope** — M
   - Files: `src/manager-connected/index.ts`, `src/console/service.ts`,
     `tests/console/manager-connected.test.mjs`.
   - Action: require validated plan/phase/ticket scope on enqueue; snapshot it in
     the journal; preserve idempotency and `reported != accepted` semantics.
   - Why: a task must stay attached to the work the owner saw when sending it.
   - Dependencies: CWM-001.
   - Risk: High; replay, reassignment, and false-completion behavior.
   - Proof: enqueue/claim/submit/report/restart tests show identical replay is a
     no-op, changed scope conflicts, reassignment fails closed, and reports do
     not increment accepted-ticket completion.

3. **CWM-003 · Ship the Projects vertical UI** — M
   - Files: `src/console/artifact-observer.ts`, `console/src/projects.tsx`, `console/src/main.tsx`,
     `console/src/styles.css`, `tests/console/projects.test.mjs`.
   - Action: add Projects navigation; safely read and render bounded intent and
     artifact content from the registered home; render multiple plans, numbered
     phases/tickets, dependencies, scoped requests, reported accomplishments,
     blockers, and deterministic daily summary.
   - Why: this is the first user-visible replacement for opaque loop/run IDs.
   - Dependencies: CWM-001–002.
   - Risk: Medium; hierarchy clarity and accessible responsive layout.
   - Proof: rendered behavior tests plus 1440px and 390px browser inspection;
     IDs remain secondary, order is stable, the real plan text is readable, and
     symlink/traversal/oversize/non-text artifacts are unavailable rather than
     exposed.

4. **CWM-004 · Load and use Faktori as the first real dataset** — S
   - Files: owner-controlled local Console config/state outside Git; this plan is
     the catalog artifact. No source fixture is the acceptance dataset.
   - Action: register product `faktori`, plan `console-work-management`, the
     accepted phases/tickets in this document, the real Manager task, and the
     Phase 1 implementer task. Queue one harmless Phase 1 follow-up through the
     installed Console and complete the Manager protocol.
   - Why: prove the model on the product building it.
   - Dependencies: CWM-001–003 and explicit owner approval to run the real task.
   - Risk: Medium; private task IDs and native host authority.
   - Proof: installed Console shows the real plan hierarchy and the request
     lifecycle; the normal Codex task is separately visible by the same title;
     the result is labeled Manager-reported, not accepted. The planning task
     that authored this document is not counted as bridge proof.

Phase 1 gate: the installed Console can answer “what is the Faktori Console
plan, which phase/ticket is active, and what did the assigned task report?”
without inspecting raw loop IDs or local files.

### Phase 2 — Attached Decision Inbox

Goal: resolve one real owner decision through the Manager-mediated path before
adding broad dashboard metrics.

5. **CWM-005 · Add durable decision and action-result contracts** — M
   - Files: `src/manager-connected/index.ts`,
     `src/console/work-management.ts`,
     `tests/manager-connected/decisions.test.mjs`.
   - Action: add scoped decision events, cause basis, recommendation/impact,
     owner, action capability, response, notification outcome, and uncertainty.
   - Why: a red badge is useless unless it says what happened and what to do.
   - Dependencies: CWM-002.
   - Risk: High; authority and wording can imply permissions that do not exist.
   - Proof: invalid owner/action combinations fail; unknown causes stay unknown;
     native/provider approval cannot be represented by a Manager message.

6. **CWM-006 · Execute supported decision actions** — M
   - Files: `src/console/service.ts`, `src/console/manager-relay.ts`,
     `tests/console/decisions.test.mjs`.
   - Action: serialize authenticated owner responses as pending Manager
     acknowledgements; extend the private relay with read/ack operations for the
     same decision ID; never target the Manager as a Manager-connected session
     request. Reuse the existing coordinator provider-answer command only for
     supported pending native requests, and expose safe external-link actions.
   - Why: owner choices need an observed result, not optimistic button state.
   - Dependencies: CWM-005.
   - Risk: High; duplicate decisions, partial delivery, and approval confusion.
   - Proof: exact-origin/token, replay, conflict, restart-between-record/ack,
     wrong-Manager acknowledgement, Manager-as-request-target rejection, and
     unsupported-provider negative tests. Relay reads do not wake an idle Manager.

7. **CWM-007 · Build the Decisions page** — M
   - Files: `console/src/decisions.tsx`, `console/src/main.tsx`,
     `console/src/styles.css`, `tests/console/decisions.test.mjs`.
   - Action: render open first, resolved history collapsed, the five required
     facts, one capability-aware CTA, pending/uncertain/retry-with-same-ID states,
     and project scope.
   - Why: decisions become a short work queue rather than scattered alerts.
   - Dependencies: CWM-005–006.
   - Risk: Medium; action clarity and accessible form behavior.
   - Proof: screenshot/readability checks and assertions that no enabled
     `Approve`/`Allow` control appears unless backed by the matching native
     coordinator capability.

8. **CWM-008 · Dogfood one real phase-gate decision** — S
   - Files: private manager-connected state only; phase evidence report.
   - Action: before Phase 3, have the active Manager raise the actual go/no-go
     decision based on Phase 2 evidence. The owner responds in Decisions; on its
     next explicit poll the same active Manager reads and acknowledges the same
     decision ID through the relay. No self-message or unattended wake is used,
     and the state change implies neither merge, deploy, nor product acceptance.
   - Why: proves the core owner/Manager loop on consequential real work.
   - Dependencies: CWM-005–007 and owner participation.
   - Risk: Medium; active Manager may be idle, which must stay visible.
   - Proof: browser state, durable event sequence, Manager-observed notification,
     and separately recorded owner decision. No fixture satisfies this gate.

Phase 2 gate: one actual Faktori decision moves open → response recorded →
pending Manager acknowledgement → acknowledged/resolved or truthfully uncertain,
with its problem, cause basis, recommendation, impact, and owner visible
throughout.

### Phase 3 — First-class Sessions

Goal: show the real Manager/implementer/specialist task topology and its honest
capabilities without claiming desktop features that are not available.

9. **CWM-009 · Project safe session and capability facts** — M
   - Files: `src/manager-connected/index.ts`, `src/console/service.ts`,
     `tests/manager-connected/sessions.test.mjs`.
   - Action: separate private thread routing from the public session projection;
     validate one Manager, one phase implementer per phase, optional bounded
     ticket specialists/reviewer, scope consistency, provider facts, capability
     basis, and freshness.
   - Why: task identity is useful; private routing data and invented liveness are
     not.
   - Dependencies: CWM-001–002.
   - Risk: High; privacy and accidental session/liveness disclosure.
   - Proof: browser snapshot excludes relay token, raw prompts, and private paths;
     unobserved provider/model/capabilities render unavailable; Manager heartbeat
     does not mark child tasks active.

10. **CWM-010 · Build Sessions navigation and hierarchy** — M
    - Files: `console/src/sessions.tsx`, `console/src/main.tsx`,
      `console/src/manager-connected.tsx`, `console/src/styles.css`,
      `tests/console/sessions.test.mjs`.
    - Action: render Manager → numbered phase implementers → ticket specialists,
      task titles, roles, assigned work titles, provider facts, capability matrix,
      last recorded contact, and unknown/stale states.
    - Why: sessions are the people/agents doing the work, not a settings footnote.
    - Dependencies: CWM-009.
    - Risk: Medium; hierarchy density and misleading status labels.
    - Proof: desktop/mobile browser checks and negative copy assertions for
      `live`, `running`, `click to open`, and `approval supported` when unproved.

11. **CWM-011 · Prove normal Codex task correlation** — S
    - Files: private config/state and phase evidence only.
    - Action: create/use a fresh normal Codex task for Phase 3 and one bounded
      ticket specialist, record their actual titles/IDs through the active
      Manager, and show the same titles/scopes in Sessions.
    - Why: proves companion visibility while Codex remains the task host.
    - Dependencies: CWM-009–010 and explicit owner-approved task creation.
    - Risk: Medium; task creation is external state and is not inferred from plan
      approval.
    - Proof: user-visible Codex task list plus installed Console screenshot and
      correlated request callbacks. If deep-link capability is unavailable, the
      Console says so and the gate still passes by title correlation.

Phase 3 gate: the user can identify who is Manager, who owns the current phase,
which ticket specialists exist, and which interactions are supported or unknown.

### Phase 4 — Page jobs, rollups, and qualified evidence

Goal: make Overview concise and Work complete, with defensible progress and PR
counts rather than decorative totals.

12. **CWM-012 · Add qualified rollups and bounded GitHub observation** — L
    - Files: `src/console/work-management.ts`,
      `src/console/github-observer.ts`, `src/integrations/github.ts`,
      `src/console/startup.ts`, `src/console/service.ts`,
      `tests/console/work-metrics.test.mjs`,
      `tests/console/github-observer.test.mjs`.
    - Action: compute catalog completeness and explicit acceptance progress; add
      read-only, allowlisted PR observation with last-good stale retention and
      ticket correlation; publish numerator, denominator, basis, and freshness.
    - Why: active/reviewed/merged/completed mean different things.
    - Dependencies: Phase 1 graph and existing controller-owned `gh` environment.
    - Risk: High; remote pagination, stale state, and misqualified denominators.
    - Proof: paginated/partial/malformed/denied/stale tests; no GitHub config
      yields unavailable; merged never implies accepted; fixtures support tests,
      but Phase 4 acceptance also observes Faktori's actual repository.

13. **CWM-013 · Rebuild Overview around at-a-glance rollups** — M
    - Files: `console/src/main.tsx`, `console/src/projects.tsx`,
      `console/src/styles.css`, `tests/console/overview.test.mjs`.
    - Action: put qualified project/plan progress, open decisions, blocked work,
      capacity, and infrastructure warning links at the top; remove full activity,
      Manager Loop history, run lists, and the global picker.
    - Why: Overview should orient, not duplicate every page.
    - Dependencies: CWM-005–007, CWM-012.
    - Risk: Medium; information priority and small-screen density.
    - Proof: component tests assert forbidden detailed sections are absent;
      1440px/390px browser checks show at-a-glance content before scrolling.

14. **CWM-014 · Make Work the complete execution stream** — M
    - Files: `console/src/work-visibility.tsx`, `console/src/main.tsx`,
      `console/src/manager-loops.tsx`, `src/console/activity.ts`,
      `console/src/styles.css`, `tests/console/work-visibility.test.mjs`.
    - Action: move full activity, Jira, loops/reviews, Manager request history,
      and coordinator runs into Work; add All/Project local filter and human
      titles with IDs as trace details; keep contextual Run detail.
    - Why: one place should answer “what happened?” across execution systems.
    - Dependencies: CWM-002, CWM-012–013.
    - Risk: Medium; duplicate events, cross-project filtering, and long histories.
    - Proof: deterministic dedup/order/filter tests; stale sources remain labeled;
      Overview contains no duplicate detail; browser verifies internal board
      scrolling without page overflow.

15. **CWM-015 · Separate Factory health from delivery blockage** — M
    - Files: `src/gm/health-observer.ts`, `src/gm/coordinator-store.ts`,
      `src/console/service.ts`, `console/src/main.tsx`,
      `console/src/styles.css`, `tests/console/factory-health.test.mjs`.
    - Action: render three explicit sections: infrastructure/operational health,
      GM improvement backlog, and linked product-delivery blockers. Keep GM
      proposals approval-required and product blockers out of the factory-health
      status calculation.
    - Why: a blocked feature must not look like broken infrastructure.
    - Dependencies: CWM-001 and existing GM/preflight records.
    - Risk: Medium; classification drift and implied GM authority.
    - Proof: tests show healthy infrastructure plus blocked product remains
      `Factory healthy · delivery blocked`; GM proposal cannot become planned or
      approved from projection alone.

Phase 4 gate: installed Overview, Projects, Work, and Factory each answer one
question; every visible count names its basis or says unavailable/stale; live
Faktori PR observations are separate from ticket acceptance.

### Phase 5 — Recovery, privacy, installed self-proof, and rollout

Goal: prove the complete workflow against Faktori itself and ship a reversible,
documented increment.

16. **CWM-016 · Finish format compatibility, recovery, and privacy** — M
    - Files: `src/manager-connected/index.ts`, `src/console/startup.ts`,
      `src/console/service.ts`, `src/maintenance/backup.ts`,
      `tests/manager-connected/recovery.test.mjs`,
      `tests/security/local-service-protection.test.mjs`.
    - Action: support the current v1 Manager-connected journal without rewrite;
      append new versioned event kinds and derive the new snapshot. Unsupported
      future versions fail closed. Preserve single-owner locking, atomic writes,
      restart-to-uncertain behavior, journal-first rebuild, and backup exclusions
      for relay token/locks. Redact private thread routing from browser/export
      unless a bounded local display identity is explicitly required.
    - Why: a dashboard is dangerous if restart changes truth or leaks its relay.
    - Dependencies: all durable-contract tickets.
    - Risk: High; corruption, replay, and credential/session privacy.
    - Proof: restore old v1 journal, crash at each action boundary, rebuild the
      same safe projection, reconcile with same identity, reject symlinks/unsafe
      permissions/foreign formats, and verify backup excludes ephemeral relay
      material.

17. **CWM-017 · Run the complete Faktori self-dogfood journey** — M
    - Files: real private Faktori Console state, real Codex tasks, actual repo and
      configured tracker/provider observations, plus a bounded evidence report.
    - Action: use the accepted plan as the work catalog; execute phases through
      the active Manager with one implementer task per phase and bounded ticket
      specialists; record requests, one decision, reports, independent review,
      PR evidence if authorized, and explicit acceptance separately.
    - Why: fixture-only proof would miss the product's central promise.
    - Dependencies: CWM-001–016 and explicit authorization for each external
      task/PR/merge effect. Merge/deploy are not required unless separately
      authorized.
    - Risk: High; external state, concurrent writers, and provider availability.
    - Proof: installed Console can trace Project → Plan → Phase → Ticket → Session
      → Request/Decision → reported result → review/delivery/acceptance evidence;
      restarting between steps preserves or marks uncertainty without duplicate
      dispatch. The user manually inspects normal Codex tasks and all six pages.

18. **CWM-018 · Final gate, docs, package, and staged rollout** — M
    - Files: `docs/manager-connected.md`, `docs/console.md`,
      `docs/console-jira.md`, package-facing examples without private IDs,
      focused test files, and phase acceptance report.
    - Action: document exact setup, source authority, measures, recovery, and
      limits; verify the clean packed CLI/Console; run independent read-only
      behavior/security review; stage rollout with the feature optional.
    - Why: self-proof is only reusable if a fresh owner can operate and recover it.
    - Dependencies: CWM-016–017.
    - Risk: Medium; docs drifting from installed behavior.
    - Proof: pinned offline full gate, clean temporary package install, installed
      Console browser journey at desktop/mobile, no console errors, independent
      exact-head review, and rollback exercise by removing the optional catalog
      while retaining current Manager-connected requests.

Phase 5 gate: a clean installed package reproduces the truthful self-dogfood
projection and existing Manager-connected v1 installations remain operable.

## Assignment Map

| Phase | Single accountable implementer | Optional bounded specialists | Independent gate |
| --- | --- | --- | --- |
| 1 | Phase 1 Implementer-Orchestrator | Contract specialist owns only work-catalog tests; UI specialist owns only `projects.tsx` + scoped CSS after API shape freezes | Read-only data-integrity and UI behavior review |
| 2 | Fresh Phase 2 Implementer-Orchestrator | Authority specialist owns decision negative tests; UI specialist owns only `decisions.tsx` | Read-only authority/security review |
| 3 | Fresh Phase 3 Implementer-Orchestrator | Privacy specialist owns projection leak tests; UI specialist owns only `sessions.tsx` | Read-only privacy/capability review |
| 4 | Fresh Phase 4 Implementer-Orchestrator | GitHub specialist owns `github-observer.ts`; UI specialist works only after state contract freezes | Read-only metric and presentation review |
| 5 | Fresh Phase 5 Implementer-Orchestrator | Recovery specialist owns crash/restore tests; browser specialist owns installed journey evidence, not product code | Exact-head behavior/security review and Manager acceptance |

The Manager task is stable across this project. Phase implementers are fresh
normal Codex tasks. A specialist gets one ticket, exact scope, and exclusive
files or a separate worktree. For this construction plan the Manager coordinates
and reviewers stay read-only; this is not a global restriction on every product's
Manager role. The phase implementer integrates specialist results and owns the
phase report.

## Testing Strategy

Before adding a test, state the product failure it prevents. Prefer the highest
boundary that proves behavior.

- Contract/story tests: graph validation, scoped request immutability, decision
  authority, qualified denominators, deterministic summary, source freshness,
  and factory/delivery classification.
- Security/recovery tests: exact origin/token separation, relay secrecy, browser
  redaction, symlink/permission rejection, event replay, interrupted notification,
  store restart, old-format read, backup/restore, and corrupted/unknown formats.
- React behavior tests: page ownership, human title priority, numbered ordering,
  unavailable/stale labels, one truthful CTA, All/Project filtering, and no
  implied liveness/acceptance.
- Installed browser journey: start the real loopback service from an
  owner-controlled config, use Faktori's real catalog and private Manager store,
  inspect all six primary pages at 1440px and 390px, make one real request and
  one real decision, restart, and verify continuity. Fixture data may support
  deterministic tests but cannot satisfy phase acceptance.
- Remote observations: use the actual Faktori repository only with configured
  read-only authority. If GitHub/Jira is unavailable, the phase does not claim
  zero PRs/issues; it records the missing proof.

Use the repository's pinned Node 24.20.0/npm 12.0.2 toolchain. Each phase runs
focused Vitest files, strict typecheck, and both builds. Phase 5 runs the full
clean installed package gate:

```sh
npm exec --offline --package=node@24.20.0 --package=npm@12.0.2 -- npm run check
```

Record the exact candidate revision, commands, exit codes, test totals, installed
Console URL inspected, source timestamps, and any unavailable evidence. A green
suite is not a substitute for the real Manager-connected exercise.

## Versioning, Migration, and Recovery

- Keep `faktori.manager-connected-event/v1` events readable. Add new event types
  with exact schemas; do not rewrite or reinterpret historical completion
  reports as acceptance.
- Introduce a new public work-management snapshot format. The current
  `manager-connected-snapshot/v1` can remain available internally during the
  transition; the Console consumes the composed projection, not raw private
  store state.
- Make top-level `workCatalog` optional for one release. A v1 config still shows the current
  experimental Manager-connected panel and marks Projects/qualified completion
  unavailable rather than fabricating an empty project.
- On catalog validation failure, fail startup with the exact field path before
  opening the store or relay. Do not partially load a graph whose denominators
  would be wrong.
- Journal writes precede projections and relay acknowledgement. A crash after
  recording but before Manager acknowledgement remains `pending_manager_ack` or
  `uncertain`, never a retry under a new identity. Recovery reuses the same ID
  after inspecting the Manager relay/task state.
- Back up the owner-only journal and catalog with factory records. Exclude relay
  connection/token files, locks, browser local storage, and credentials. Restore
  only while stopped, then rebuild and reconcile uncertain work.
- Rollback is configuration-level: remove the optional catalog/new observers and
  restart. Existing Manager-connected v1 request records remain intact and
  readable; no down-migration rewrites the journal.

## Rollout

1. Land Phase 1 behind optional catalog configuration and dogfood it only on the
   Faktori local Console.
2. Land Phase 2 only after the real decision exercise. Keep generic request
   compose available as a fallback until attached requests are proven.
3. Add Sessions, then move page content in Phase 4. Do not redesign every card
   before the project/decision loop works.
4. Keep old v1 configs supported through the final gate. Publish no private
   Faktori task IDs or local state in examples or reports.
5. After Phase 5 evidence and independent review, decide separately whether to
   make Projects the default installed landing page. No automatic remote publish,
   merge, or deployment is part of this plan.

## Scope Cuts

- No standalone desktop/Codex API, app-storage inspection, daemon, automatic
  task discovery, unattended wake, background inference, or cross-host worker.
- No deep-link button until a supported navigation capability is independently
  observed. Use matching normal task titles in Codex and Console.
- No translation of Manager messages into native Codex/provider permission or
  approval events.
- No Jira mutation, general workflow editor, drag-and-drop planning, custom
  query language, hosted control plane, multiuser Console, or mobile app.
- No AI-generated daily summary, velocity score, productivity ranking, token
  leaderboard, or inferred cost.
- No rename of the runtime's Product/Pod hierarchy or rewrite of coordinator,
  Manager Loop, Jira, GitHub publication, or Factory GM engines.
- No claim that a report, passing test, review, PR, merge, or deployment alone
  completes a ticket. Only the configured explicit acceptance source does.

## Risks and Mitigations

- **Competing authorities**: project catalog, loop artifacts, Jira, GitHub, and
  Manager reports can disagree.
  - Mitigation: show each fact's source/freshness; never collapse them into one
    mutable status. Acceptance remains explicit.
- **False activity/liveness**: a configured task, old heartbeat, or `running`
  record can look alive.
  - Mitigation: use `configured`, `last contact`, `recorded running`, and
    `unknown`; count active implementers only from an explicit capability.
- **False approval**: an owner response observed by a Manager can look like
  native permission or merge approval.
  - Mitigation: distinct action kinds and copy; relay acknowledgement means only
    “Manager observed”; native provider responses reuse the existing supported
    coordinator command and negative tests forbid false approval labels.
- **Private task data leakage**: thread IDs, prompts, task output, local paths,
  and relay material are sensitive operational records.
  - Mitigation: split private routing/public projections, allowlist display
    fields, owner-only permissions, bounded text, credential filters, no raw
    transcript.
- **Wrong denominators**: truncated/stale sources produce impressive but false
  percentages.
  - Mitigation: require complete population metadata and timestamps; degrade the
    whole affected measure to stale/unavailable.
- **Page reorganization regression**: commands or source filters disappear when
  content moves.
  - Mitigation: move one page job at a time, preserve components first, and test
    the existing enqueue, answer, cancel, resume, Jira, loop, settings, and Factory
    actions through installed behavior.
- **Dogfood deadlock**: the feature is needed to describe its own implementation.
  - Mitigation: current Manager-connected generic requests start Phase 1; after
    CWM-003, remaining work is loaded and observed through the new project graph.

## Success Criteria

- [ ] Faktori appears as a real Project with this plan, ordered phases, stable
      CWM tickets, intent, safe artifacts, blockers, and daily summary.
- [ ] At least two plans can be represented under one project without an ID or
      ordering collision.
- [ ] A Manager-connected request is immutably attached to its project/plan/
      phase/ticket and survives restart without duplicate dispatch.
- [ ] One actual owner decision is resolved or truthfully left uncertain through
      the installed Decision Inbox and active Manager callback.
- [ ] Sessions shows the real Manager, a fresh phase implementer, and a bounded
      specialist as normal Codex tasks, with honest capabilities and unknowns.
- [ ] Overview starts with compact cross-project rollups and contains no full
      activity, Jira board, loop history, or run list.
- [ ] Work contains complete run/loop/request/Jira activity with an All/Project
      filter and human titles ahead of opaque IDs.
- [ ] Every count states its basis and denominator; unavailable/stale never
      becomes zero; Manager reports/PR merges never become acceptance.
- [ ] Factory infrastructure health, GM improvements, and product blockers are
      visibly and computationally distinct.
- [ ] Old Manager-connected v1 state remains readable, recovery preserves
      uncertainty, and private relay/session data is absent from public outputs.
- [ ] Pinned full check, clean installed-package verification, desktop/mobile
      browser QA, real Faktori self-dogfood, and independent exact-head review
      are all observed and recorded separately.
