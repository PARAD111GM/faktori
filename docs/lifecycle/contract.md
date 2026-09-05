# Faktori lifecycle contract

Every work item uses the same six outcomes: Plan, Design, Build, Test, Deploy, and Maintain. A small bug may combine the artifacts; a stage that does not apply must record why and what evidence supports that decision.

The context packet is authoritative for objective, acceptance criteria, applicable ancestor constraints, approved design references, artifact revisions, commands, authority, and explicit dependency contracts. Never infer permission from a sibling or from a green command. Planning nodes and executable nodes stay distinct even when labels differ.

## Scale and evidence

Select the smallest package that can carry the risk:

- Small: one compact intent/acceptance record, approach, diff, verification result, and release evidence.
- Normal: intent, specification, implementation plan, diff/tests, review record, and release evidence.
- Large or high-risk: separate planning and design artifacts, dependency breakdown, risk-specific tests, approval/authority record, and recovery plan.

Completion evidence names the observed revision, command or interaction, result, and authority. A checked box, process exit, PR, or deployment receipt alone is not acceptance evidence. Escalate when authority, scope, dependency, credentials, budget, acceptance behavior, or recovery state is ambiguous; stop before widening scope.

## Stage handoffs

Plan establishes objective, criteria, scale, dependencies, authority, and unknowns. Design records approved references, interfaces, data and risk decisions. Build changes only the accepted scope and records the diff. Test exercises acceptance and relevant failure/recovery paths. Deploy records the approved environment, exact artifact revision, command/workflow, and observed receipt. Maintain records health, follow-up work, rollback/recovery, and drift.
