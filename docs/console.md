# Local Console and Factory GM

Run the installed Console with an owner-controlled JSON file:

```sh
faktori console serve /absolute/path/to/local-console.json
```

The service binds only to `127.0.0.1`. It serves the built React Console and a
redacted coordinator projection from the same process. Commands require both
an exact configured loopback `Origin` and the per-start local command token
injected into the served document. The token, provider environments, workspace
paths, prompts, session IDs, and raw provider events are never returned in the
Console state projection.

## Configuration boundary

The local file contains:

- `factoryId`, absolute `journalPath` and `projectionPath`, loopback `port`,
  exact `allowedOrigins`, and bounded coordinator `limits`;
- optionally, the canonical `factoryConfiguration` accepted by the normal
  configuration resolver, which supplies real factory/product/pod labels;
- `runtime.providers`, with one or more owner-selected `codex`, `claude`, or
  `cursor` native routes and their exact controlled environment; Codex may
  instead select the shipped `isolated` Docker route with an immutable image,
  shared-scratch boundary, explicit controller paths and approved inputs,
  network mode, resource ceilings, and inner-sandbox policy;
- `runtime.workItems`, each containing an already approved `RunIntent`, exact
  current context, and optional dependency work-item IDs;
- optional `runtime.resumePlans`, mapping a durable source run to one approved
  target work item; and
- optional GM instructions and one owner-approved `diagnosisTemplate.intent`.

Browser input selects only configured work-item or run IDs. It cannot supply a
provider, model, workspace, session binding, authority snapshot, or budget.
Starting work durably admits the intent and returns immediately while provider
delivery continues, so messages and cancellation remain available during a
long turn. Resume derives the explicit provider session and its exact scope
from the durable source result; there is no latest-session fallback.

Codex and Claude cancellation use their shipped native runners. Cursor uses
the shipped ACP stdio transport and its explicit session-cancel flow. Isolated
Codex uses the hardened Docker execution-plan builder and validates the exact
container identity before stop. In every case, the coordinator revokes
authority and records the exact worker termination intent before the transport
can signal a native process group or stop a container; the post-exit
observation is recorded without inventing a provider-native receipt.

Cursor permission, question, and plan requests enter a bounded durable owner
request bridge. The Console displays only safe prompt/option fields and sends
one answer by request ID. Duplicate or expired answers fail closed. Codex and
Claude currently expose no equivalent interactive request protocol, so the UI
does not manufacture one.

## Factory GM

The GM is event-driven, not a permanently running model. A local observer reads
new durable coordinator facts. The second provider failure for the same
product/work-item/provider route opens or updates one repeated-handoff finding;
replayed source event IDs are ignored across restarts. Long merge waits can be
submitted through the same GM signal contract and raise owner attention once.

For a new repeated failure, the trusted controller constructs a bounded JSON
diagnosis prompt from the durable, sanitized health signal and fixed GM
instructions. It derives a fresh run identity, reservation, context digest, and
approved input digest inside the owner-approved diagnosis intent template, then
uses the normal admission and selected provider delivery path. This template
does not authorize product changes, merges, releases, or policy expansion.
Unconfigured maintenance is rejected; factory improvements remain proposals
requiring the normal approval path.

## Live state and command replay

SSE watches the append-only journal, so provider results, GM findings, owner
requests, and commands update already-connected clients. A command ID is
durable. Replaying the same ID and payload returns its latest recorded receipt;
reusing the ID with different content is rejected. The browser keeps pending
command identities in local storage so a refresh does not create a second
operation.
