# Local Console and Factory GM

## Prepare an approved projection-only Console

An approved isolated or native factory can start the real loopback Console
without granting provider, work-item, or Factory GM authority. Use the explicit
projection mode:

```sh
faktori console prepare /absolute/path/to/projection-request.json > /absolute/path/to/local-console.json
faktori console serve /absolute/path/to/local-console.json
```

`projection-request.json` contains only the approved factory root, the same
canonical configuration bound by provisioning, the explicit mode, and an
optional loopback port:

```json
{
  "mode": "projection",
  "factoryRoot": "/absolute/path/to/approved-factory",
  "configuration": { "factory": {}, "providers": [], "environments": [], "products": [], "pods": [] },
  "port": 4173
}
```

Preparation verifies that the supplied configuration still matches the
approved factory revision. The emitted Console configuration contains the
canonical factory/product/pod hierarchy and fail-closed coordinator limits, but
no runtime provider routes, eligible work items, resume plans, or GM template.
Projection mode rejects provider and work-item fields instead of silently
ignoring them. Consequently the Console can be inspected and restarted, but it
cannot launch work; adding execution remains a separate owner-controlled
configuration step.

## Prepare one approved native Codex proof

The public bootstrap path can derive the otherwise low-level Console file from
an approved factory and one scoped work item:

```sh
faktori console prepare /absolute/path/to/console-request.json > /absolute/path/to/local-console.json
faktori console serve /absolute/path/to/local-console.json
```

The factory must already have been applied with `faktori provision apply`. Its
selected product must have been bound through `localProductSources`, must be an
exact clean Git repository with a named branch and commit, and must resolve to
a native Codex provider. The preparation command records that exact commit,
branch, context payload, authority policy, and budget reservation in the
generated run intent. It rejects a dirty or parent-owned repository.

`console-request.json` has this shape (replace every example value):

```json
{
  "factoryRoot": "/absolute/path/to/approved-factory",
  "configuration": { "factory": {}, "providers": [], "environments": [], "products": [], "pods": [] },
  "productId": "task-board",
  "model": "gpt-5.5",
  "environment": { "PATH": "/owner/controlled/provider/path" },
  "estimatedTokens": 30000,
  "contextRevision": "task-board-context@1",
  "authorityRevision": "task-board-authority@1",
  "createdAt": "2026-09-05T18:00:00.000Z",
  "port": 4173,
  "workItem": {
    "id": "task-board-implementation",
    "revision": "task-board-work@1",
    "objective": "Implement the frozen task-board behavior.",
    "acceptanceCriteria": ["Run the documented acceptance command successfully."],
    "constraints": ["Do not change the test oracle.", "Do not use network access."]
  }
}
```

The full canonical factory configuration is required in `configuration`; the
abbreviated object above only shows its fields. Inherited parent constraints
belong in `workItem.constraints` and are included in the prompt and its bound
digest. This convenience route does not implement a hard provider token cap,
so it truthfully rejects any selected product whose resolved budget has
`strictSpending: true`. A token estimate and coordinator accounting are not a
hard spending control.

The generated Codex route uses the unmodified CLI's bounded context mode: it
ignores user configuration and exec-policy rules, disables memories, apps,
plugins, and multi-agent fan-out, sets approval policy to `never`, and requests
`workspace-write`. Authentication may still come from the existing provider
store. This prevents ambient context injection and escalation; it is not a
claim that a native provider process cannot read host paths. Only the isolated
container profile supplies a separately validated filesystem boundary.

This is a convenience for an owner-selected native Codex proof, not the generic
bootstrap default. The default remains isolated execution, and a complete
factory evaluation still covers Codex, Claude, and Cursor rather than treating
one successful native route as universal provider evidence.

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

An owner-controlled Console file may also include `preflightRequest`. Parsing
binds that request to the selected resolved `factoryConfiguration`, factory ID,
and actual `projectionPath`, then opens the existing SQLite projection strictly
read-only with `fileMustExist`. The same installed check powers `faktori
preflight`; a valid projection with matching durable factory admissions can be
projection-ready while execution and live evidence remain unknown. A valid
empty projection is reported as unbound/`not_tested`, but the Console can still
start and render its empty state. Missing or foreign/invalid projections return
a specific nonexecuting rebuild remediation and are not created during
preflight. Only the sanitized result reaches the Factory view. The report cannot
approve, repair, admit, or launch work.

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
