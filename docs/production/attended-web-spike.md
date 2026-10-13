# Prepare an attended requirements-discovery-to-production web spike

This is the first product-feasibility exercise, not an automatic dispatch pilot.
Start with the owner's raw idea, exercise existing skills, and measure every
place a human has to bridge the stages. Keep requirements discovery central.

Read [the skill capability map](skill-capability-map.md) and
[this increment's brief](implementation-brief.md). The smallest path uses one
product, one existing provider and local/GitHub evidence; Jira, Slack, n8n and a
GM scheduler are not prerequisites for this spike.

## Offline preparation

From the kit directory containing the shipped `examples/` directory (or pass
the absolute path to that packaged example when calling from another directory):

```sh
faktori spike prepare examples/production/attended-spike.json
```

Use your own request file outside the public kit. The example deliberately has
no selected idea or owner/resources, so preparation reports unresolved inputs.
Add `rawIdea` only from the owner and an `ownerId` for the person responsible for
product decisions. Keep the idea vague enough to exercise discovery; do not
prewrite a technical specification or fabricate answers. Resource entries are
only declarations, with `unknown`, `proposed` or `owner_selected` status and an
optional non-sensitive `reference`. They are not live observations or grants.
An owner-selected resource still needs a nonempty reference to clear its naming
decision. Execution/deployment authority, resource policy and approved command
handoffs always remain pending here because this preparation schema cannot
validate them; resolve those through the existing lifecycle/action contracts.

The command validates data and prints a deterministic, request-digest-bound
packet, stage handoffs, unresolved decisions and an intervention template. It
reads only the named request JSON; it creates no files, starts no commands,
contacts no provider and grants no authority. `prepared_for_discovery` means an
idea packet exists, not that the provider, repository, deployment or product is
ready. `executionReady` and `productionReady` are always false; all stage
results start `not_started`. Never put credentials or production user data in
the preparation file.

## Owner and resource handoff

Before exercising the spike, identify the selected raw idea and owner, the
disposable product repository/workspace, an existing authenticated provider
route, implementation/evaluator/release responsibilities and resource limits.
Name a deployment environment/account, data/auth integration requirements,
product-data backup/recovery, incident owner and required model-data policy.
No choice is inferred from the example. New accounts, billing, sensitive data,
credential changes and external publication/deployment retain their own gates.

Give the first exercise a 3-5 engineering-day time-box. This is planning time,
not a native token cap. Select bounded repair/iteration and spending policy
before a run; retain uncertainty when provider usage is unavailable. If the
exercise does not finish, deliver its intervention/failure evidence and replan.

## Stage sequence and existing seams

| Stage | Existing skill / executable handoff | Required product evidence |
|---|---|---|
| Requirements discovery | `skills/interview/SKILL.md`, bounded `research` | Users, outcomes/journeys, domain/error/permission rules, NFRs, roles/data/integrations, reusable resources, scope and independent acceptance criteria; separate owner decisions, facts, assumptions and unknowns |
| Shape | `skills/shaping/SKILL.md`; `faktori context assemble <hierarchy.json> <node-id>` | Source-revision-bound work/context, ancestor constraints, dependencies and traceable criteria |
| Plan/design | `skills/plan/SKILL.md`, `skills/design/SKILL.md` | Accepted bounded design, user flows, data/API/auth contracts, target commands, verification, security, rollout and recovery |
| Factory/product setup | Existing `provision proposal/approve/apply`, `product new`, `console prepare` | Current resolved configuration, revision-bound approval and actual local provisioning receipts when required; no implicit new pod |
| Build/test | Existing provider delivery; `loop lean` for its configured Codex route or explicit supported provider path | Actual worker/session identity, candidate and behavior evidence; record any human compilation of inputs as an intervention |
| Independent verification/review | `verification snapshot/run` and review skill | Protected evaluator scenario/command identity, healthy and negative controls, fresh exact-candidate review and human acceptance; test exits do not replace product behavior |
| Publication/release | `loop publication prepare/publish`, `loop delivery record` | Existing controller-owned publication authority, current checks/review, authorized human merge and bound revisions |
| Deployment/maintenance | Existing deployment observer/executor, deploy/maintain skills | Matching artifact/environment deployed revision, real user journey, app security, data restore/recovery, monitoring and incident ownership |

Read each command's actual request contract before use; this table is not a
launchable configuration. The lean loop takes already accepted requirements,
commands and routes; it runs preflight commands and provider execution. Do not
invoke it as an offline readiness probe. Existing generic onboarding discovery
JSON is not a product requirements schema or an adaptive interview engine.

## Independent acceptance and interventions

Freeze a small set of human-reviewed user journeys before implementation; add
human-authored negative authorization/data-loss cases and preserve evaluator
ownership. Run a genuine browser against the actual app, API and database;
exercise persistence across reload/restart, denied access, error states and
required integrations. Keep configured, observed, verified and accepted facts
separate. The factory's localhost or a build artifact is not production proof.

Maintain an owner-private append-only intervention ledger containing stage,
reason, human action, automation gap, evidence reference and measured time/cost
only where observed. Log manual requirements clarification, graph/manifest
assembly, configuration repair, verifier preparation, provider recovery,
publication/deploy actions and product acceptance. Do not store raw prompts,
credentials or private reasoning. Human assistance can prove feasibility; it
cannot be relabeled as unattended factory automation.

## Exit and next work

Exit with a requirements/acceptance map, design/context handoff, candidate,
independent verification/review, authorized deployed revision and observed user
result, plus interventions, unknowns, resource/account receipts and recovery
evidence. Missing production authority or resources remains pending. Do not
replace a missed assertion with a successful health check.

Prioritize the next kit repairs from observed acceptance blockers, intervention
effort and recurrence. Next prove a meaningful feature increment on an existing
web product; characterize undocumented behavior before changing it. Run early
shared-codebase mobile feasibility separately. Full mobile distribution and
automatic supervision remain later qualified capabilities.
