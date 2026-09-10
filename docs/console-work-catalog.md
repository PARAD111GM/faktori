# Projects, plans, and connected tasks

The optional work catalog gives the Console human-readable work structure. It
does not schedule work or turn an agent's report into acceptance.

Add `workCatalog: { "path": "/absolute/owner-controlled/catalog.json" }` to
your private Console configuration. Enable it when starting your own Console;
do not restart active factories merely to try this feature. After startup,
catalog edits reload automatically. Invalid edits retain the last good view,
mark it stale, and block new catalog-bound requests until corrected.

Minimal catalog:

```json
{
  "format": "faktori.work-catalog/v1",
  "projects": [{
    "productId": "example",
    "title": "Example project",
    "goal": "Deliver a useful first release",
    "artifacts": [{
      "id": "intent",
      "title": "Approved intent snapshot",
      "role": "intent",
      "path": "intent.md",
      "content": "Build a task board with persistent tasks and keyboard access."
    }],
    "plans": [{
      "id": "first-release",
      "order": 1,
      "title": "First release",
      "goal": "Prove the core journey",
      "phases": [{
        "id": "core",
        "order": 1,
        "title": "Persistent task board",
        "goal": "Create and complete tasks",
        "acceptance": "Task state survives reload and server restart",
        "tickets": [{
          "id": "APP-001",
          "order": 1,
          "title": "Create a persistent task",
          "goal": "Save a named task and retrieve it after restart",
          "dependencies": []
        }]
      }]
    }]
  }]
}
```

Use existing factory `productId` values. Orders are positive and unique within
their parent. Tickets may link explicit `runIds`, `loopIds`, and an `issueKey`.
Dependencies must refer to tickets in the same project and cannot form cycles.

Artifact `content` is an explicitly published, bounded text snapshot—not a live
file read. Optional `sourceRevision` and ISO `snapshotAt` record its provenance.
The agent maintaining the catalog must deliberately refresh outdated snapshots.
Never put secrets in them; displayed text is sanitized and rendered inertly.

Linux supports descriptor-anchored reads beneath an owner-configured
`artifactHome` where the required filesystem facility exists. Other hosts fail
closed for file reads and should use snapshots. An unavailable artifact is not
an empty document. No insecure traversal fallback is used.

Projects shows the hierarchy, artifact content, assignments, and reported
accomplishments. Sessions shows configured task identities; configuration and
contact timestamps do not prove that a worker is active. Work owns requests and
activity. Activity links open the relevant retained record.

For interactive task handoffs, configure the explicit session assignments from
[Manager-connected mode](manager-connected.md), including matching `productId`,
`planId`, `phaseId`, and optional `ticketId`. The Console sends the catalog
revision and scope with a request; later catalog changes cannot silently move it.
The active Manager still performs the documented private relay handoff. There
is no automatic task discovery or wakeup.

## Publish work status deliberately

Each ticket may include `status`: `remaining`, `in_progress`, `blocked`, or
`done`. Omitting it means unknown, not remaining or complete. These are
owner-published catalog states; a task report, successful local loop, or merged
PR does not edit them automatically. Only publish `done` after the applicable
acceptance decision. Keep the catalog population complete for the selected plan
before interpreting any ratio as progress toward that plan.

Optional `statusEvents` retain explicit changes, for example:

```json
{
  "status": "in_progress",
  "statusEvents": [
    { "at": "2026-09-10T12:00:00.000Z", "status": "in_progress" }
  ]
}
```

This snippet extends a ticket; it is not a complete catalog. Preserve prior
events when updating the current status. Do not backfill invented timestamps or
translate old reports into accepted work. Daily summaries are deterministic,
not an AI stand-up, and can only summarize retained observations.

The summary separates current catalog totals from today's retained ticket changes,
Manager reports, decision transitions, and linked loop-stage events. Its local
day advances even when the catalog has not changed. Retained PR-change history
is currently unavailable; a present-day PR snapshot is not reconstructed into a
historical merge event. The Console labels that coverage gap explicitly.

Optional ticket `evidence` contains separate `local`, `reviewed`, `merged`,
`deployed`, and `productAccepted` fields, each `owner_published` or `unknown`. These
values are owner-published annotations, not verified external
proof. None implies another; absent evidence remains unknown. Keep authoritative
acceptance and deployment records in the product's artifact home and linked
systems. GitHub observation is displayed separately.

## Observe explicitly linked pull requests

PR observation is read-only and opt-in. Extend the private Console configuration:

```json
{
  "workCatalog": {
    "path": "/absolute/owner-controlled/catalog.json",
    "observeLinkedPullRequests": true,
    "timezone": "America/Chicago"
  }
}
```

Add an explicit project-level allowlist referencing tickets in that project:

```json
{
  "linkedPullRequests": [
    { "ticketId": "APP-001", "repository": "your-org/your-repo", "number": 12 }
  ]
}
```

Use your existing `gh` login; Faktori does not collect credentials or scan the
organization for work. Links remain inert without the configuration opt-in.
Catalog link edits hot-reload without restarting. Enabling observation in the
Console startup configuration requires restarting only that Console when safe;
it does not authorize restarting workers or another installation.

`timezone` is a validated IANA timezone for midnight-to-midnight daily summaries.
If omitted, the host's timezone is used and shown with the summary. Set it
explicitly when the factory owner and host use different local days.

Observation permits at most 1,000 explicit links and four concurrent reads.
Each shipped `gh` read has a 15-second terminating deadline. Unchanged or failed
polls back off from the 30-second base interval to a maximum of five minutes;
they do not launch model calls. A slow observation is not proof of active work.

A merge observation proves a GitHub merge, not deployment or product acceptance.
GitHub review state alone does not prove Faktori's independent review gate.
Unavailable or stale observations must not be interpreted as zero PRs or passed
review. Outcome and token metrics describe their measured population separately;
catalog status is not a substitute for measured usage or delivery receipts.

## Recovery and rollback

- Invalid catalog edits preserve the last valid view with a stale warning and
  prevent new catalog-bound requests. Correct the file; do not recreate the
  factory or replay completed work.
- Missing PR access, network failures, or `gh` failures remain visible as unknown
  or stale observations. Repair the existing login/network route; do not add a
  paid probe or infer success from old data.
- Removing a link stops its observation and removes it from the catalog view;
  it does not close the PR, change Jira, or mutate the repository.
- To disable the feature, remove the observation opt-in (or the whole optional
  `workCatalog` setting) and restart only the affected Console when safe. Preserve
  its journal and catalog. Disabling a view does not revoke or erase durable
  decisions, requests, or existing work.
