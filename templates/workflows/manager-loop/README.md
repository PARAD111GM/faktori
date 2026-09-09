# Manager Loop

A minimal phased quality loop using real Codex sessions. The included example
builds a tiny Node task-list library and then adds task completion. Change the
objectives and checks to test your own project; Faktori's loop is not tied to Node.

## Before running

Follow [INSTALL.md](../../../INSTALL.md) to install and build Faktori using
Node 24 and npm 12. Authenticate through Codex's own login flow and select a model
available to your account. This template uses Codex only; it does not use the
Console's role settings or create a Factory GM.

Use a separate disposable Git repository with an initial commit. Native execution
uses your operating-system identity; bounded Codex context is not Docker
isolation. Do not use active production work or store credentials in the project.
Provider runs consume your Codex allowance. No paid API route is configured.

## Copy and configure

From the Faktori source root, copy the template to an owner-controlled location:

```sh
cp templates/workflows/manager-loop/config.json /absolute/path/to/my-loop.json
```

Edit that copy, not the distributed template:

| Field | Set it to |
| --- | --- |
| `loopId` | A unique name for this experiment |
| `workspace.path` | Absolute path to the disposable Git repository |
| `artifactsDirectory` | A fresh absolute directory outside the product repository for this run's records |
| `provider.model` | A Codex model available to your account |
| `provider.reasoning` | `low`, `medium`, or `high` |
| `phases` | Ordered objectives, acceptance criteria, and verification commands |
| `limits.maxRuntimeMinutes` | Runtime bound per provider stage / verification command |
| `limits.maxRepairRounds` | Maximum repair rounds per phase |

Keep `provider.contextIsolation` set to `bounded`. Leave `maxTokens` at `0`
unless you understand the current runtime's token accounting; it is not a
subscription spending guarantee.

Every phase needs at least one verification command. Commands use separate
`command` and `args` fields, execute in the workspace, and are not shell strings.
Review them as executable code. Prefer independent acceptance checks where
practical: a test suite written by the implementer alone can miss requirements.

Only after approving the workspace access, objectives, verification commands,
and resource limits, set `workspace.nativeAccessApproved` to `true`. The shipped
template deliberately refuses to run until this approval is recorded.

## Run

From the built Faktori source root:

```sh
node dist/cli.js loop run /absolute/path/to/my-loop.json
```

If the installed `faktori` executable is on your PATH:

```sh
faktori loop run /absolute/path/to/my-loop.json
```

Use the same Node 24 environment in either case. This command runs the loop; it
does not install a plugin or register a workflow in the Console.

## What to expect

Each phase gets a manager brief and a fresh implementer. Configured checks and a
separate review must pass before manager acceptance. Failed checks or review
findings go back to the same implementer session within the repair limit.

The artifacts directory contains `state.json`, `events.jsonl`, `stages/`, and a
successful final `report.json`. Inspect `status` and `completedPhases` in the
printed result; process exit alone is not proof of acceptance. There are no
automatic commits, pushes, merges, or deployments.

Repeating a completed run returns its saved result without rebuilding. A failed
or blocked run retains its outcome; editing its configuration does not reset it.
For a different experiment, use a new loop ID and records directory. An uncertain
interrupted stage or existing lock requires inspection of records and surviving
workers before any new run—never delete records to bypass recovery checks.

### Optional read-only Console registration

To see this run in an already configured local Console, add a `managerLoops`
entry to its owner-controlled `local-console.json` and restart the Console:

```json
{
  "managerLoops": [
    {
      "id": "task-list-proof",
      "artifactsDirectory": "/absolute/path/to/loop-records",
      "productId": "optional-product-filter",
      "podId": "optional-pod-filter"
    }
  ]
}
```

Use the same `loopId` and `artifactsDirectory` as the Manager Loop configuration.
The product mapping is optional; a pod mapping is optional but requires its
product mapping. This registration is server-owned
and read-only: it shows sanitized recorded progress and cannot start, repair,
resume, cancel, or otherwise control the loop. A recorded `running` state is
marked stale after five minutes without an update; it is not a process-liveness
claim. See [the Manager Loop guide](../../../docs/manager-loop.md#observe-a-loop-in-the-console)
for the projected fields and safety boundary.

See [workflow behavior and limitations](../../../docs/manager-loop.md) for details.
