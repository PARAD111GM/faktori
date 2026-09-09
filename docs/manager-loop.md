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
2. Copy `examples/manager-loop/config.json` outside that repository. Set its two
   absolute paths and select your Codex model. Review the phases and verification
   commands, then set `nativeAccessApproved` to `true` only when you approve
   native execution in that workspace.
3. From your built Faktori source checkout, run:

   ```sh
   node dist/cli.js loop run /absolute/path/to/your-loop-config.json
   ```

   With an installed package, use `faktori loop run` instead.

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
