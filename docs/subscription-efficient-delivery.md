# Subscription-efficient delivery

This is an owner-approved, opt-in delivery layer over Faktori's existing
coordinator, journal, graph, tracker adapters, provider routes and local
Console. It does not add a workflow engine, scheduler database, provider
account, merge permission, product deployment, or Twinzy integration.

Start with one local repository, one configured provider route and optional
GitHub observation. Jira, Slack and n8n remain optional. First identify the
capabilities you already have, then configure only the ones this path needs:

| Need | Minimal capability | Automatic mode additionally needs |
| --- | --- | --- |
| Work authority | Owner-owned private queue source; optional current Jira/graph authority observer | Current status, revision, rank, dependency and guard evidence |
| Execution | One preconfigured runtime work item and its existing delivery/relay adapter | Durable transport receipt, native goal and idle wake-up/supervision evidence |
| Review and release | Independent reviewer and human merge authority | Nothing grants a merge. Release remains human-authorized. |
| Preview | Local loopback persistent-preview registration | Separate agent and human browser contexts plus current identity evidence |

Missing capability means attended or blocked operation. It is not a reason to
add credentials, enable paid inference, start a permanent agent, or replace the
existing dispatcher.

## Configure routing

`runtime.routing` uses `SubscriptionRoutingConfiguration` from
`src/console/subscription-routing.ts`. This is a schema sketch, not a launchable
configuration; supply real observed routes and work bindings before enabling it:

```json
{
  "policy": { "policyRevision": "routing@1", "maxEvidenceAgeMs": 3600000, "taskClasses": {} },
  "candidates": [],
  "observations": [],
  "observationsPath": "/absolute/private/capacity-observations.json",
  "bindings": {}
}
```

`candidates` declares configured provider/model routes, their shared account
pool and observed capabilities. `observations` use provider-native units and
freshness. Token estimates are advisory only and are never converted into an
account percentage. The controller holds durable native-estimate or
concurrency-slot reservations, keeps configured completion capacity, and uses
only the configured economical fallback for stale or unknown capacity. Paid
routes require both policy and request-specific authority.

Reserve completion headroom with `completionReserveByPool`. New-work classes
retain it by default; review, repair and release-verification classes may set
`usesCompletionReserve: false` to consume that headroom. A fresh observation
must contain usable `availableUnits`. Estimates in another unit do not satisfy
strict-budget admission. Completed concurrency slots are released; uncertain
workers retain their holds across refreshed observations.

Use the optional private `observationsPath` only for an owner-controlled,
current export. It is bounded, no-follow and must be private. A missing or
stale observation is explicit. Strict-budget policy blocks when its guarantee
cannot be established.

## Configure role queues

The Console facade is `ConsoleWorkflowRuntime` in
`src/console/workflow-runtime.ts`. Its static, server-only configuration is:

```json
{
  "sourcePath": "/absolute/private/workflow-source.json",
  "executionScopes": ["faktori-dogfood"],
  "legacyExecutionScopes": []
}
```

The private source is reread for every evaluation and has this schema shape
(replace the empty stage list with your complete status-ID mapping):

```json
{
  "format": "faktori.console-workflow-source/v1",
  "revision": "queue-source@1",
  "validUntil": "2030-01-01T00:00:00.000Z",
  "policy": { "format": "faktori.role-queue-policy/v1", "revision": "queues@1", "stages": [] },
  "candidates": [{
    "workItemId": "tracker-ticket-id",
    "runtimeWorkItemId": "configured-runtime-item",
    "executionScope": "faktori-dogfood",
    "trackerStatusId": "stable-status-id",
    "revision": "candidate@1",
    "rank": 1,
    "accountPoolId": "observed-provider-pool",
    "sharedFileKey": "src/serialized-boundary.ts",
    "queuedAt": "2026-09-22T00:00:00.000Z",
    "dependencies": [],
    "entryEvidence": []
  }]
}
```

Each policy maps stable tracker status IDs to one logical stage: needs
specification, ready to build, ready for review, human review, ready to release,
staging acceptance or done. Queue activity (`queued`, `active`, `waiting`,
`blocked`) is separate from the business status. Candidate dependencies and
entry evidence must match the current candidate revision. The controller ranks
and ages eligible work, caps stage WIP, starts with at most the configured three
builders, and applies downstream WIP backpressure.

`runtimeWorkItemId` must resolve to one preconfigured Console runtime item; the
source never supplies a run ID, provider command, model, workspace, or prompt.
Its configured `workItem.revision` must equal the authoritative candidate
revision, and its configured role must equal the mapped stage role. A changed
tracker candidate therefore cannot replay an old builder run as a review or
release task.

`accountPoolId` is optional source context only; the configured routing
controller remains the authority for provider capacity. `sharedFileKey` is an
optional controller serialization key: concurrently eligible candidates with
the same key are queued one at a time.
The Console composition root injects a `QueueExecutor` that calls the existing
`CoordinatorProviderDelivery`. Manager-connected sprint work is rejected with
`visible_goal_task_requires_foreman_relay`; it cannot silently use a CLI task
instead of the required visible, native-goal task. It persists claim and launch
intent before calling that adapter, then persists the observed result. On
restart it inspects an uncertain intent and never launches it again merely
because a timer expired.

The shipped Console observer rechecks Jira status and issue revision, freshness
and completeness before execution. Rank, dependency and entry-guard evidence
remain in the private owner-maintained source; it is not an automatic import
of a Jira sprint. A custom `WorkflowAuthorityPort` can supply those observations
through the same interface. Missing current candidates remain blocked.

Set `legacyExecutionScopes` for any scope already owned by legacy graph
dispatch. The queue runtime excludes them, so two dispatchers cannot race for
the same work.

## Automatic versus attended

Use `evaluate({ mode: "shadow" })` first, then attended execution in a
Faktori-only test project. Shadow computes queue/routing decisions and launches
nothing. Attended mode still uses the configured executor but does not advertise
unattended operation.

In a running attended Console, source changes are evaluated by deterministic
polling and terminal receipts replenish eligible work without an LLM heartbeat.
Switching to shadow stops further launches; existing workers are not cancelled.
Restart returns to shadow. The shipped CLI composition does not inject trusted
native-goal/wake-up evidence, so its automatic command remains blocked. Do not
edit booleans to bypass this; a verified task transport is still required.

Automatic mode requires an injected `WorkflowTrustedReadinessPort` with current
transport, native-goal, supervision and witnessed-delivery observations. The
facade combines native goal plus supervision into its automatic admission gate;
transport and witness stay independent gates. A prompt containing `/goal`, a
tracker status, a heartbeat timeout or a static config boolean is not proof.
Readiness attestations expire after two minutes; future timestamps are rejected.
Cached decisions and Console readiness both expire without invoking an LLM.
Missing/expired/unavailable evidence blocks automatic admission and leaves the
attended path explicit.

Console state labels the active evaluation mode as `shadow`, `attended`, or
`automatic`; it never calls a valid source simply "ready". `automaticReady`
and `capabilityBlockers` report the separately observed gate, so an attended
queue may be eligible while automatic wake-up remains unavailable.

No queue stage merges a pull request. `ready_to_release` is a human/release
authority boundary, and staging acceptance remains separately revision-bound.

## Persistent local previews

`PersistentPreviewRuntimeConfiguration` in
`src/console/preview-runtime.ts` accepts owner-approved registrations and a
finite allowlist of `start`, `stop`, `verify`, feedback, or candidate-update
operation IDs. Process controls select an operation ID only; concise feedback
and confirmation also accept a revision-bound item through the authenticated
Console endpoint. Browser input cannot change commands or environments. A registration binds
the feature, implementer, worktree, candidate revision, loopback URL, absolute
startup/identity commands, bounded environment, and distinct agent and human
browser contexts.

`PersistentPreviewService` records process identity and current identity
evidence. Changed candidate revisions invalidate preview and final-review
evidence. Stop/restart requires observed process identity; unknown process state
is not signaled or restarted. Human feedback is requested, applied and confirmed
against the final revision. This service never pushes, merges, deploys or takes
over the human browser context.

## Senior advice and outcome accounting

`runtime.consultations` binds an original builder run and exact revision to a
server-configured senior template and explicit resume target. Only engineering
obstacles qualify. Permission, quota and transport failures remain incidents.
The senior receives bounded evidence and returns advice, not an approval; the
original builder resumes through its existing session binding. The current
native read-only consultation transport is Codex; unsupported routes block.

`workAttribution` maps configured work-item IDs to `featureId`, immutable
`acceptanceRevision`, and `workClass` (planning, implementation, consultation,
review, verification, rework or coordination). Bind the scope before measuring.
Omitting a binding later does not erase earlier expenditure. Model/provider
breakdowns preserve cached-input and reasoning subsets. In-progress and missing
usage remain unknown; only deployment-bound accepted features enter the shipped
denominator. No completed cohort means no tokens-per-shipped-feature ratio.

Legacy standalone loop configurations remain compatible and static by default.
An opt-in loop `subscriptionRouting` configuration requires an injected shared
routing port; without it preflight blocks. Separate Console journals do not
share account reservations: products using one pool must use one coordinator.
This cannot guarantee weekly allowance against spending outside that coordinator.

## Bounded proof and upgrade path

Run these local checks from the candidate revision before offering a feature PR.
They are source evidence, not proof of an installed factory or live provider.

```sh
npm run typecheck
npx vitest run tests/runtime/routing.test.mjs tests/workflow/role-queue-controller.test.mjs tests/console/workflow-runtime.test.mjs tests/preview/persistent-preview.test.mjs tests/preview/preview-runtime.test.mjs
npm run check
```

Then, with new admission paused, run one attended configured local work item,
observe the durable journal through restart, and use the registered loopback
preview in separate agent and human contexts. Record the exact source/config
revisions, candidate revision, command output, preview identity and user result.
Source and local browser evidence is recorded in
[`docs/proof/subscription-efficient-delivery.md`](proof/subscription-efficient-delivery.md)
separately from the still-required attended provider/transport witness.

Upgrade as a feature-sized batch: preserve the journal and active workers,
install the matching package and Console assets, validate in shadow mode, then
enable one attended Faktori-only item. Do not alter active product workers,
credentials, provider subscriptions, GitHub merge authority or any live Twinzy
surface. On failure, disable new admission and reconcile uncertain records;
never delete records or restart an unknown worker to make the dashboard green.

After source review, the first operational gate is the attended Faktori-only
transport/restart witness. Authorized merge, deployment receipt and human/staging
acceptance retain their own gates. A green source test,
queue decision, preview, PR or health check does not pass a later gate.

Keep one feature-sized PR per coherent delivery outcome. Batch related UI
feedback and repair evidence into that PR, but create a separate work item when
the scope, authority or risk changes.
