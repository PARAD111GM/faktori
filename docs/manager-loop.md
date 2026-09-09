# Test the Manager Loop

This experimental workflow runs a phased local project through an AI Manager,
Implementer, and independent Reviewer. It is not a plugin system or an automatic
release pipeline. The product Manager is separate from the Factory GM.

## What you need

- Faktori built with the supported Node/npm versions in `INSTALL.md`.
- An authenticated Codex CLI and a model available to your account.
- A disposable Git repository, separate from active product work.
- Explicit approval for native host execution and the local verification commands.

Native execution uses your operating-system identity. The bounded CLI profile
reduces ambient context but is **not container isolation**. Use a test project;
do not put production credentials or private factory records in it.

## Run a two-phase example

1. Create an empty Git repository with an initial commit in your chosen test
   directory.
2. Copy `templates/workflows/manager-loop/config.json` outside that repository. Set its two
   absolute paths and select your Codex model. Review the phases and verification
   commands, then set `nativeAccessApproved` to `true` only when you approve
   native execution in that workspace.
3. From your built Faktori source checkout, run:

   ```sh
   node dist/cli.js loop run /absolute/path/to/your-loop-config.json
   ```

   With an installed package, use `faktori loop run` instead.

For the complete copy-and-configure walkthrough, see the
[Manager Loop template](../templates/workflows/manager-loop/README.md).

The example builds a tiny task-list library, then adds task completion. It uses
Node's built-in test runner and needs no product dependencies. Running the loop
consumes your existing Codex allowance. No API billing route is provisioned.

## The quality loop

For each phase, the Manager writes a bounded brief. A fresh Implementer session
builds the phase. The configured local verification runs, and a separate Reviewer
checks the result. Findings return to the same Implementer session for repair,
up to the configured limit. The Manager accepts only after verification and
review pass. The next phase starts with a new Implementer and saved evidence
from earlier phases.

Review is tied to the observed workspace content, not just a Git commit that
might omit uncommitted changes. Provider failure, malformed decisions, exhausted
repair rounds, and missing verification are not treated as success.

## Limits and records

`maxRuntimeMinutes` bounds each provider stage. `maxRepairRounds` bounds repair
attempts. `maxTokens: 0` does not impose a token ceiling; subscription allowances
and unavailable usage telemetry are not invented token counts or dollar charges.

The selected artifacts directory holds durable stage state, an event journal,
stage reports, and the final report. Keep it outside the product repository and
out of public Git: prompts and reports can contain product information.

## Observe a loop in the Console

The local Console can observe an existing Manager Loop without gaining control
of it. Add the loop's ID and absolute artifacts directory to the
owner-controlled `local-console.json`, then restart the Console:

```json
{
  "managerLoops": [
    {
      "id": "task-list-proof",
      "artifactsDirectory": "/absolute/path/to/loop-records",
      "productId": "task-board",
      "podId": "task-board-pod"
    }
  ]
}
```

`id` must exactly match the loop configuration's `loopId`. `productId` is an
optional filter mapping; `podId` is also optional but requires `productId` so
the entry cannot disappear under the product filter. When the Console has a
canonical factory configuration, configured mappings must reference that hierarchy. Each
artifacts directory is an explicit server-side allowlist entry. The browser
cannot provide a path or request a file read.

The observer reads `state.json` plus optional bounded publication and delivery
receipts (see [delivery evidence](loop-delivery.md)) and projects status, completed phase IDs,
the current stage, sanitized stage outcomes, configured-verification results,
and review or manager decisions. It never returns raw paths, prompts, provider
responses, session IDs, evidence, or verification output. Missing or malformed
records remain visible as `unavailable` with a safe reason rather than
disappearing.

A persisted `running` status means the loop most recently recorded running
activity; it is not proof that a provider process is alive. After five minutes
without a state-file update it is marked stale. Terminal states retain their
recorded distinction. The Console does not invent a total phase count when the
state record contains only completed phases.

If interrupted between a recorded launch and its receipt, the loop reports an
uncertain stage and does not blindly relaunch it. Inspect the records and any
surviving process before attempting another run. Do not delete state to bypass
that check. Successful repeated invocation must not redo accepted work.

## Deliberately absent in this proof

- Claude/Cursor workflow drivers, plugin installation, or a marketplace.
- Automatic commits, pushes, PRs, merges, or deployments.
- A new Console workflow editor or automatic creation of a product backlog.
- A guarantee that a provider's native `/goal` feature is active.

This is a bounded controller around real provider sessions, intended to prove
the multi-session quality loop before adding product surfaces and packaging.
