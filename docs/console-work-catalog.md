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
