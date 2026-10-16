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

### Native artifacts and distribution

For iOS/Android, carry requirements discovery, separately accepted definition
and design, exact source and independent candidate verification into the
native release adapter (repository reference: `docs/production/native-release.md`). Prepare the
build/sign/export plan before requesting its concrete owner approval. Use
`product native-release-build` only with that exact phase and current approval.
Observe signing through the configured SDK tools and seal the resulting IPA/AAB.

Prepare upload from those actual bytes with
`product native-release-upload-prepare`; request a separate owner approval for
the artifact, publisher/account/app/build, track and upload command. Design or
build approval does not authorize upload. Existing vendor authentication owns
credentials; do not copy them into the product, model context or factory records.
Missing accounts/signing resources remain explicit release prerequisites.

Retain pending store review as pending. Use
`product native-release-inspect` for safe stored inspection. Prepare a separate
read-only approval for `product native-release-reconcile`, bound to the original
receipt and protected observer; never resubmit an interrupted or ambiguous upload.
Bind observed availability
and the independent target journey before `product observe` and `product adopt`.
The next discovery cycle inherits the observed baseline and client/backend
contracts. Simulator/emulator `native_local` evidence and synthetic release
fixtures cannot qualify real signing, physical devices or store distribution.

### Evidence size

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
