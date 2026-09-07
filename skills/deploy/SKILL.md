---
name: faktori-deploy
description: This skill should be used when a tested Faktori artifact must be released to an explicitly approved environment with exact-revision and smoke evidence.
---

# Deploy

Release only a tested, exact artifact through configured authority. Treat a
release receipt, CI success, smoke check, and product acceptance as distinct
evidence.

## Trigger and inputs

Apply this skill after implementation, verification, and any required review
have handed off their exact revision. Require the artifact revision and digest
where available, environment identity, approved operation, current authority,
configured deploy or existing-CI observation, configured smoke check, and a
configured recovery hook if recovery is permitted. Do not infer a target,
command, credential, or rollback from a branch name or past release.

## Procedure

1. Compare the tested and requested revisions. Stop when they differ, the
   environment is not approved, authority is stale, or the target configuration
   lacks a compatible deploy and smoke command.
2. Persist or verify the intended operation through the coordinator before the
   external effect. Run only the target's configured local command or observe
   its configured existing-CI record; Faktori intentionally has no generic
   `faktori deploy` CLI command to guess at a product deployment.
3. Revalidate authority at the effect boundary. Record the environment,
   revision, deployment identifier, mode, timestamp, and observed deploy/CI
   outcome without exposing credentials.
4. Run the configured smoke check against that same environment and revision.
   Mark release evidence successful only when both the deployment observation
   and smoke observation succeed.
5. On a deploy or smoke failure, contain the result: record `failed`, create or
   preserve exactly one durable follow-up for that operation, and stop further
   releases of that artifact. Do not retry blindly and do not claim rollback.
6. Invoke recovery only when an already configured, approved, compatible
   recovery hook has current authority and satisfied preconditions. Otherwise
   hand off a blocked incident with the observed evidence; never invent a
   speculative rollback command.

## Scale and handoff

Use compact evidence for an approved local or preview release: exact revision,
environment, deploy observation, and smoke result. Use normal evidence for a
shared release: the compact record plus reviewer/check references and a release
handoff. Use high-risk evidence for production, data migration, money, or a
recovery-capable operation: explicit owner approval, impact boundary,
containment criteria, and separately observed recovery evidence if invoked.

Emit a release record such as:

```text
artifact/environment: <revision-or-digest> | <environment>
authority/operation: <approval-or-action-id> | <configured-operation>
deploy: observed | <local-command|existing-ci> | <receipt or CI URL>
smoke: passed | <observed check>    # or failed/not_verified with reason
disposition: ready for product acceptance | failed and follow-up <id>
```

Escalate a drifted artifact, missing approval, unavailable credentials,
incompatible CI observation, failed smoke, or ambiguous recovery. Leave the
release pending or failed with its exact identifiers, so resumption can
re-observe state before any retry.
