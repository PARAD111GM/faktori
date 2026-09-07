---
name: faktori-maintain
description: This skill should be used when released Faktori or product work needs routine health, drift, incident, backup, update, or recovery handling with durable evidence.
---

# Maintain

Maintain a released surface without silently changing product scope, policy, or
authority. Distinguish product maintenance from Factory GM maintenance: product
work requires its accepted product context and owner authority; the GM may
diagnose or perform only configured factory-owned health work and may propose,
not self-authorize, product or policy changes.

## Trigger and inputs

Apply this skill to an observed health signal, drift, scheduled upkeep, support
incident, backup/restore, or approved runtime update. Require the affected
factory or product identity, release revision and environment, owner, observed
signal, allowed authority, recovery boundary, and current durable records. Do
not treat an expired heartbeat, stale dashboard projection, or previous
incident as proof of current worker state.

## Procedure

1. Classify the scope as product or factory-owned. Preserve product hierarchy
   and criteria for product work. For GM findings, record the factory symptom
   and proposed improvement, then route product, policy, architecture, budget,
   or authority changes through the normal approved lifecycle.
2. Capture the current observation with timestamp, environment, revision,
   source, and impact. Reconcile intended and observed effects before retrying
   an interrupted operation; late worker output may be inspected but cannot
   create a side effect.
3. For routine low-risk upkeep, apply only the approved bounded action and
   verify its observable health result. For drift, record the expected and
   actual state, identify the owning configuration/provider, and create a
   scoped follow-up instead of overwriting owner material.
4. For backup or recovery, use the documented local kit commands only when
   their inputs and authority are available: `npm run faktori -- backup create`,
   `backup restore`, and `backup reconcile`. Keep provider credentials out of
   backups, restore to a separate destination, and resolve every recovery ID
   with evidence before reopening affected admission.
5. For a runtime update, first run `npm run faktori -- update preview`, capture
   its exact `previewDigest`, and apply only an owner-approved request using
   `npm run faktori -- update apply`. Do not silently roll back, overwrite
   owner material, or activate an unsupported migration. Consult
   `docs/maintenance/README.md` and `docs/maintenance/compatibility.md` only
   when the relevant operation needs their detailed constraints.
6. Hand off an incident or planned change with observed state, actions taken,
   recovery disposition, remaining impact, and the exact safe resume point.

## Scale and handoff

Use compact packaging for routine, reversible, factory-owned upkeep: observation,
approved action, and health result. Use normal packaging for planned
maintenance: scope, drift/follow-up, window, evidence, and result. Use
high-risk packaging for incidents, data-impacting restore, credential boundary,
authority change, or irreversible action: owner approval, containment,
recovery decisions, and post-action observation.

Emit a maintenance record such as:

```text
scope: product <id> | factory <id>
observation: <signal> | <environment> | <revision> | <timestamp>
action/disposition: <approved action> | completed | blocked | failed
recovery: <recovery-id and evidence> | not invoked: <reason>
follow-up/resume: <stable node or receipt> | <next safe observation>
```

Escalate missing ownership, unhealthy or drifted state, unresolved effect,
absent recovery receipt, irreversible remediation, or any request to widen the
GM's product or policy authority. Preserve the failure and its resume evidence;
do not erase records or simulate recovery.
