# Decision Inbox

Decisions record a specific problem, evidence, owner, recommendation, impact,
and bounded choices. They are not provider approvals or delivery permissions.

Enable [Manager-connected mode](manager-connected.md) and configure the matching
[work catalog](console-work-catalog.md). The active Manager creates a decision
using its private relay; the browser cannot create or resolve decisions.

```text
faktori manager decision create <relay-connection.json> <decision.json>
faktori manager state <relay-connection.json>
faktori manager decision acknowledge <relay-connection.json> <ack.json>
faktori manager decision resolve <relay-connection.json> <resolve.json>
faktori manager decision uncertain <relay-connection.json> <uncertain.json>
```

The create document has `id`, catalog `scope`, `problem`,
`cause: { basis, summary }`, `evidence: [{ label, summary }]`,
`accountableOwner`, `recommendedNextAction`, `impact`, `capability`,
`action: { kind, label }`, and `options: [{ id, label }]`.
Use `record_owner_response` for bounded owner choices. Cause basis is
`observed`, `reported`, or `unknown`; never invent an observation.

The owner opens Decisions, selects a configured choice, and records it using
the existing local Console authentication. The durable result is **pending
Manager acknowledgement**, not execution or resolution. This does not wake the
Manager. Its next explicit relay read observes the response.

Acknowledgement and resolution documents contain `id` and the currently observed
`expectedRevision`. Read state before each transition; do not hardcode revisions.
An uncertain document also includes `reason`. If interrupted, inspect the retained
state before retrying. An uncertain decision requires Manager reconciliation,
not another owner response. Repeated conflicting responses are rejected.

Other action kinds carry an `action.target` and navigate to existing controls: `answer_provider_request`
uses observed `runId`/`requestId`, `enqueue_agent_task` uses configured
`sessionId`, and `open_external_record` uses an observed scoped Jira `url`.
Supported targets must pass the service's scope and observation checks.
Missing evidence means unavailable—not permission to invent a target.
Opening a destination does not answer a request or dispatch an agent.

Resolved records remain in expandable history. Activity links open their retained
details. Catalog progress and delivery acceptance remain separate from decisions.

Never expose the private relay credential to the browser, prompts, or Git.
