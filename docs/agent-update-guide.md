# Faktori v0.2 agent setup and update guide

Use this guide with [INSTALL.md](../INSTALL.md) and the canonical
[`faktori-update`](../skills/update/SKILL.md) skill when an agent sets up or
updates a factory. It prevents an apparently complete Console from hiding an
unselected or unproved integration.

## Required integration inventory

Before handoff, enumerate every selected provider route, Jira project mapping,
and GM schedule. Give each one exactly one status:

| Status | Meaning | Required evidence or decision |
| --- | --- | --- |
| Enabled and verified | The owner selected it and its bounded exercise succeeded. | Record the date, scope, and sanitized observed result. |
| Pending auth or observation | It is wanted, but login, route setup, authorization, or its exercise is not complete. | State the smallest next action. |
| Deliberately deferred | The owner chose not to enable it for this factory now. | Record the owner decision and reason. |

Do not use a provider catalog entry as evidence of a route, authentication, or
execution. Do not use an existing `runtime.gm` object as evidence that the
nightly scheduler is installed or observed. A visible Console and a passing
offline report are configuration evidence only.

Run:

```sh
faktori readiness report /absolute/path/local-console.json
```

The command is deterministic and offline. It reads the existing local Console
configuration and only the
presence of relevant environment variables; it does not expose their values,
call Jira, authenticate a provider, invoke Claude, start the GM, or perform a
provider exercise. Missing GM/Jira configuration is always unavailable in the
report. Record an owner's deliberate deferral alongside it as the operating
decision; deferred is not verification.

## Jira and local work

Configure Jira only for products the owner manages there. Reuse one
server-environment authorization reference for all explicitly mapped projects
on the same Jira site; do not create a login per project. A product without a
Jira mapping uses Faktori local work-catalog tickets. The Console observer is
read-only, so a successful poll is activity visibility, not ticket mutation or
delivery proof.

## Safe existing-install update

1. Discover the running runtime, factory/config paths, workers, unresolved
   operations, and local edits without scanning credential stores.
2. Create/review a backup and the exact update preview/diff before cutover.
3. Keep the old runtime recoverable. Do not restart workers or the Console until
   an approved safe window; do not overwrite a loaded runtime.
4. Never copy credentials, change authentication, increase spending/billing, or
   broaden provider permissions to make the update look complete.
5. Verify the served revision and preserve configuration/records, then regenerate
   the inventory. Report live refresh, provider exercises, and scheduler activity
   as untested unless actually observed.

v0.2.0's offline report is a guard against silent omission, not full E2E or
live-integration acceptance.
