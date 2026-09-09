# Manager-connected mode (experimental)

Use Faktori as a companion display while an **active Manager in the Codex app**
coordinates existing, visible Codex tasks. CLI Manager Loops continue to work
unchanged. This mode does not launch a desktop daemon or replace provider CLIs.

## What works

The owner queues a scoped instruction in Work. The Manager claims it through
the private local relay, sends it with the app's task tools, and records an
observed callback. The Console shows the durable progression. Assignment records
name a product, optional plan/phase/ticket, role, and the exact Codex task.

There is no automatic wake-up of an idle Manager. Last contact is a timestamp,
not proof of a running model. A reported result is **not** independent acceptance,
merge, deployment, or a successful product test. Native permission prompts still
belong to Codex; this mode does not translate a queue message into native approval.
Use the displayed task title to find it in Codex. Automatic deep-link navigation
is not a supported capability in this experiment.

## Configure an existing factory

1. Have the Manager inspect available app tools and resolve the actual Manager
   and implementer task IDs/titles. Do not invent IDs or reuse a busy task without
   the owner's direction. The Manager must have task messaging and callback access.
2. Add `managerConnected` to the owner-controlled Console JSON. Keep its directory
   outside Git and outside product worker workspaces. Replace all example values:

   New state directories are created owner-only. Existing directories and journals
   must already be private and owned by the Console's operating-system user;
   startup refuses permissive or foreign-owned records rather than silently
   changing their permissions.

   ```json
   {
     "managerConnected": {
       "directory": "/absolute/private/factory-state/manager-connected",
       "manager": {
         "threadId": "11111111-1111-4111-8111-111111111111",
         "title": "Factory build manager"
       },
       "sessions": [{
         "id": "console-phase-one",
         "threadId": "22222222-2222-4222-8222-222222222222",
         "title": "Console phase one implementer",
         "role": "implementer",
         "productId": "faktori",
         "planId": "console-work-management",
         "phaseId": "phase-one"
       }]
     }
   }
   ```

3. Restart only this Console with `faktori console serve <console.json>`.
   Assignment edits take effect on restart. If a factory catalog is configured,
   product/pod references must match it. This does not change CLI provider routes.
4. Give the active Manager the private path
   `<managerConnected.directory>/relay-connection.json`. Do not paste its contents
   into a task, browser, log, or repository. It authorizes local relay operations;
   it is not a Codex provider credential. It is refreshed on Console restart.
5. In Work, queue a harmless request for the configured task. Have the Manager
   execute the protocol below, then verify its response appears in the Console.

No daemon, subscription, extra API route, or separately billed inference is
provisioned. An agent without desktop task tools should use the existing CLI
Manager Loop, not reverse-engineer private app storage or bypass browser policy.

## Manager protocol

Run these commands using the private connection **file path**, never its token.

```text
faktori manager heartbeat <relay-connection.json>
faktori manager state <relay-connection.json>
faktori manager claim <relay-connection.json> <request-id>
faktori manager submitted <relay-connection.json> <request-id>
faktori manager complete <relay-connection.json> <response.json>
```

For each request:

1. Read the queue and applicable product authority. The owner's text is an
   instruction, not permission to bypass product safety or merge governance.
2. Claim exactly once. **Check successful exit and parse the returned assignment
   and instruction before sending.** Do not chain a failed claim to an app send.
3. Address only the returned target task. Include the request ID, scope, exact
   task instruction, and the returned Manager callback identity. Ask for a concise
   result, verification evidence, and an explicit callback via task messaging.
4. Only after a successful app send, record `submitted`. This means the app
   accepted the message; it does not mean the task finished.
5. Wait for the actual callback. Check its source task ID and correlation ID.
   A tool returning empty task history or a completed status alone is not a result.
6. Write a response JSON file (outside Git) using the observed source identity:

   ```json
   { "id": "the-request-id", "threadId": "22222222-2222-4222-8222-222222222222", "summary": "Observed result and evidence, with any limitations" }
   ```

7. Record `complete`. This records a **Manager-observed report**, not a signed
   provider callback. The local Manager is trusted to verify its provenance.
   Perform independent review and acceptance through the project's quality loop.
8. Send a heartbeat when checking the relay. Do not keep making inference calls
   merely to refresh the timestamp. Tell the owner when the Manager goes idle.

Do not place secrets or private reasoning in request titles, prompts or summaries.
Prompts are private local journal data (not browser state), but are not encrypted.
The Console's local-owner access model still applies; this is not multiuser auth.
Browser access has queue/cancel authority, not the private relay's dispatch/report
authority. Same-OS-user processes are trusted, not isolated from one another.

## Interruptions and recovery

- Duplicate enqueue with the same identity/content does not create another task.
  Keep the same request ID after a timeout until its state is reconciled.
- A claim is not retryable delivery. On restart, claimed or submitted requests
  become uncertain. Check the target task and app send result before any action.
- A matching observed callback can resolve uncertain delivery. If no evidence
  exists, leave it visibly uncertain and ask the owner; never automatically resend.
- Changing or removing an assignment prevents queued work from silently sending
  to a different task. Cancel and deliberately enqueue a new request if needed.
- Changing the Manager task identity does not transfer pending callbacks. Restore
  the recorded Manager identity to reconcile its pending reports; do not attribute
  an old callback to a replacement Manager.
- Cancellation only cancels queued instructions. It does not terminate Codex tasks.
- Only one Console owns the store. After an unclean shutdown, verify the recorded
  owner process is actually dead before manually retiring its stale lock. Heartbeat
  age alone does not establish this. Back up the journal before recovery edits.
- Back up the private state directory with owner-controlled factory records, but
  exclude `relay-connection.json` and owner locks from portable backups. Restore
  only while stopped, reconcile uncertain work, and let startup issue a new token.

## Minimal acceptance exercise

Use a disposable fixture, not production: queue a bounded arithmetic change,
observe the implementer's callback, ask a separate task to review its exact file
hash, deliberately exercise a review finding, repair and re-review. Restart the
Console between claim and callback once and prove no duplicate send occurs.
Record source changes, callback reporting and independent acceptance separately.
The earlier prototype validated this agent-mediated pattern; it did not prove
unattended desktop execution or universal task-stream visibility.
