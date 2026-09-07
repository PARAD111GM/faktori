---
name: faktori-build
description: This skill should be used when an accepted Faktori work item needs a bounded implementation change and revision-bound handoff evidence.
---

# Build

Implement only an accepted work item. Preserve the distinction between an approved
product change and factory-owned runtime work; do not turn either into authority
to change the other.

## Trigger and inputs

Apply this skill after Plan and, where required, Design have an accepted,
revision-bound handoff. Require a scoped context packet, accepted criteria and
authority, the exact base revision, relevant dependency contracts, and the
approved workspace. Treat a missing input as blocked work, not an invitation to
reconstruct intent from unrelated siblings.

## Procedure

1. Confirm the work-item identity, accepted revision, target workspace, allowed
   paths, dependency state, and allowed effects before editing. Assemble a
   scoped context packet with `faktori context assemble <hierarchy.json>
   <node-id>` when the installed Faktori CLI and hierarchy record are the
   accepted source.
2. Read the accepted plan and design, then inspect the target stack's own
   documented build and test commands. Preserve existing user edits and stop
   when a required change belongs to another owner or dependency.
3. Make the smallest coherent diff that satisfies a stated criterion. Keep
   credentials out of the workspace and product build/test processes. Do not
   publish, merge, deploy, or use controller credentials from a worker.
4. Run the accepted local verification. For Faktori-core changes, use only
   commands documented by this kit, such as `npm test`, `npm run build`, or
   `npm run check`, at the appropriate scope. For a product repository, record
   its discovered command verbatim instead of guessing one.
5. Record the exact resulting revision, changed paths, commands, environment,
   observed outcomes, remaining risks, and the next lifecycle handoff. State
   every inapplicable lifecycle outcome and why.

## Scale and handoff

Use compact packaging for a small bug or chore: criterion, approach, bounded
diff, and one behavior-level verification. Use normal packaging for a feature:
implementation notes, dependency effects, tests, and an independent-review
handoff. Use high-risk packaging for authority, concurrency, credentials,
publication, destructive work, or recovery: separate design/risk notes,
negative evidence, and an explicit recovery boundary.

## Receiving review findings

Read the complete finding set before changing code. Restate an unclear finding
or request clarification rather than implementing a partial interpretation.
Check each finding against the accepted criteria, current code, contracts, and
observed evidence. Accept a sound finding with its technical basis; push back
when it conflicts with the accepted scope, a working contract, or observed
behavior, naming that evidence without performative agreement.

Apply one understood, in-scope fix at a time and run the targeted verification
before taking the next finding. After the final fix, rerun the required
verification on the resulting final head before claiming it is ready. Treat an
earlier review as evidence only for its reviewed revision; request any further
review only as the configured policy requires.

Emit a handoff record such as:

```text
work: <stable-id>
base/result: <base-revision> -> <result-revision>
criteria addressed: <criterion IDs>
changed paths: <paths>
observed verification: <command> | <environment> | <result>
next: test | review | blocked: <reason>
```

Escalate a missing acceptance decision, incompatible dependency, changed base
revision, credential request, unexpected scope, failed verification, or
unresolved recovery state. Leave the work visibly blocked with the evidence
needed to resume; never substitute a fixture, process exit, or speculative
claim for the required behavior.
