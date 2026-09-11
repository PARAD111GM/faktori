# Recovery setup and operator handoff

Jira owns tickets. GitHub owns PR and delivery evidence. The Codex Foreman
coordinates visible tasks. Slack carries actionable notifications. Console
projects these records. Do not create a parallel work board or manually copy
status essays to compensate for a disconnected integration.

## What is connected by this source change

- `faktori delivery inspect <connections.json>` performs bounded read-only Jira
  active-sprint / transition and registered GitHub PR inspection. It performs no
  transitions, claims, merges, dispatches or notifications.
- The exported delivery planner prepares per-ticket transitions and eligible
  assignments. Its executor requires existing signed action admission and a
  controller-sealed Jira operation resolver. It is not an autonomous scheduler.
- The exported Slack outbox/adapters provide durable, serialized delivery and
  reconciliation. An installed router must supply actual correlated Slack
  receipts; an HTTP success or an empty response is insufficient.
- Manager-connected `sprintReadinessPath` enforces private readiness at enqueue
  and claim. The Work page displays its report, including legacy unconfigured
  state. Standalone legacy loops are not converted to goal-driven app tasks.
- The Artifacts tab reuses the project catalog's safe artifact projection.

**Not yet demonstrated:** automatic observation-to-signed-action wiring in an
installed factory, native-goal evidence collection, idle-Foreman wake-up, and the
authorized staging journey. Do not call an installation recovered until these
are demonstrated. See `recovery-inventory.md` for current access limitations.

## Inspect existing connections before changing them

Use the owner's existing authentication flows. One Jira authorization reference
can serve all projects on that site; board IDs and project membership differ.
An inspection document contains references, never secrets:

```json
{
  "format": "faktori.delivery-connections/v1",
  "jira": {
    "baseUrl": "https://example.atlassian.net",
    "boardId": "1",
    "authorizationEnv": "JIRA_AUTHORIZATION"
  },
  "connections": [
    { "ticketKey": "APP-1", "repository": "owner/repository", "pullRequest": 1 }
  ]
}
```

Run inspection in the controller environment where its existing private auth is
available. Unknown review or deployment remains unknown. Check Jira transitions
per issue and use the current repository review policy. Do not inherit old
Triforge status IDs, publisher-only identity filters or timed merge authority.

For local-ticket projects, retain the existing local catalog. This Jira
inspection command is intentionally not a local-ticket importer.

## Canonical artifacts and sprint admission

1. Register one canonical project `artifactHome` in the existing work catalog,
   outside installation/update directories. Register the approved intent with
   role `intent` and its relative path. Reuse approved documents; draft missing
   intent for owner approval, never infer approval from a filename.
2. Give each assigned builder read access to those same files. Preserve explicit
   writing ownership; shared reading is not a shared-file edit grant.
3. Bootstrap visible tasks, establish native goals and collect real platform
   observations through supported tools. A slash command or agent report is not
   proof. If the platform cannot supply evidence, keep the check unknown.
4. Write a private owner-owned readiness file (mode 0600) from retained
   controller observations. Reference it through
   `managerConnected.sprintReadinessPath` in the local Console configuration.
   Do not retrofit an active sprint without reconciling existing tasks first.
5. Use role `builder` or `implementer` for coding tasks; the opted-in relay caps
   their claimed/submitted/uncertain assignments at three. Completed
   implementation releases a slot; a reviewer is a separate task. Outstanding
   duplicate ticket or task assignments are refused.

Readiness document shape:

```json
{
  "format": "faktori.sprint-readiness/v1",
  "sprintId": "sprint-1",
  "revision": "approved-sprint-revision",
  "mode": "attended",
  "managerThreadId": "actual-foreman-task-id",
  "targets": [{ "workItemId": "APP-1", "threadId": "actual-builder-task-id" }],
  "artifactBindings": [{ "path": "/absolute/project/INTENT.md", "sha256": "actual-64-character-sha256" }],
  "checks": []
}
```

This example intentionally cannot pass. Required check IDs are exported as
`SPRINT_CHECKS`: intent, scope, ticket_reconciliation, dependencies, ready_queue,
shared_files, execution_environment, jira, github, slack, review_policy,
merge_owner, staging_access, foreman_goal, completion_transport, manager_wakeup,
builder_goal and builder_artifacts. Every applicable check needs `state`,
`revision`, `owner`, `source`, `evidence`, `observedAt` and `validUntil`.
Passing means `state: passed`, current revision and unexpired retained evidence.
Sources are controller, platform or owner_decision; native goal checks require
platform evidence and exact task correlation. Builder checks also bind
workItemId and threadId. Foreman goal binds managerThreadId through threadId.
Source labels describe the retained evidence; the evaluator is not a platform
signature verifier and must never receive worker-controlled records.

`unattended` additionally requires verified manager_wakeup. Attended mode does
not claim automatic wake-up. Every bound artifact is hashed again at admission;
missing or changed content blocks. A failed check has no browser override.
`faktori sprint readiness <absolute-private-readiness.json>` prints the report
and exits nonzero when blocked. Registered recovery tickets cannot bypass the
relay through the Console's native Start work control.

## Notification and delivery authority

Wire Slack through `SlackRouterActionExecutor` and the existing signed
`slack.notify` action boundary. Configure logical-channel allowlists, fixed
router URLs and private auth callbacks in the controller, never browser input.
Do not deploy a pretend receipt endpoint. Verify the actual installed router's
receipt contract first. Uncertain delivery is reconciled before any resend;
unknown or missing receipt endpoints do not prove absence.

Wire planned Jira transitions through `executePlannedDeliveryTransitions` and
the controller's existing signed grants. Deployment targets `deployedStatus`;
`acceptedStatus` additionally requires merge-revision-bound staging acceptance.
Asad retains the merge decision. Neither elapsed review windows nor notification
failure grant authority.

## Upgrade and proof

Run the pinned `npm run check` before packaging. Install an explicitly reviewed
artifact only in the agreed installation. Do not restart product workers or
activate providers. Keep old and new dispatch ownership mutually exclusive;
until scheduler ownership and wake-up are verified, operate attended-only.
Rollback disables new admission and preserves journals; never delete uncertain
intents to make them retryable.

Prove the full Jira → builder goal → PR → substantive review → Slack receipt →
authorized merge → deployment → Jira/Console → staging acceptance journey.
Record elapsed stages, interventions, rework and available usage; unknown usage
stays unknown, and no outcome means no tokens-per-outcome ratio. Source tests
are not evidence of a working installed sprint.
