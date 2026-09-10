# Lean execution profiles

Lean execution is opt-in. Use `faktori loop lean <config.json>` with
`faktori.lean-loop/v1`. Existing `faktori.manager-loop/v1` files and
`faktori loop run` keep their established manager-brief, implementation,
verification, review, and manager-acceptance behavior.

Choose `implementation` only when an owner has approved the exact brief and
scope. It launches the implementation owner directly, runs every configured
verifier, obtains independent fixed-candidate review, routes substantive
findings back to that same implementation session, and reruns verification and
review after repair. It does not spend an inference turn restating the approved
brief and does not ask a model to manufacture an acceptance decision.

Choose `validation_only` for an existing candidate. It launches no implementer
when the candidate passes. A failing verifier or review finding blocks with
`validation_repair_not_approved` unless the configuration contains a separate
explicit `repairApproval`. That approval authorizes only a bounded repair; it
does not grant publication, merge, deployment, product-change, or billing-route
authority.

## Evidence and deterministic acceptance

The preflight runs before any provider call. It checks the exact approval,
workspace ownership and access, `PATH` and provider executable, declared
toolchain, required environment inputs, candidate/base relationship, exact
dependency revisions, configured route availability, and owner-declared quota
state. `knownQuota: "unknown"` remains unknown and does not trigger a paid
probe. A known failure launches nothing. A second identical failure records
`launchSuppressed: true`; subsequent calls remain blocked until the observed
cause changes.

Empty dependency and environment-input arrays are valid. Declare a Git checkout
as `{ "id": "...", "kind": "git", "path": "/absolute/...", "revision":
"<exact hex>" }` and an external verifier or other immutable file as `{ "id":
"...", "kind": "file", "path": "/absolute/...", "digest": "sha256:..." }`.
Symlinked dependency files are rejected. Set
`candidate.inputCompleteness` to `unknown` when some input cannot be declared.
The work is freshly verified, but its acceptance receipt is marked
`reusable: false`. Reusing that completed run returns
`fresh_revalidation_required_new_artifacts_directory`; perform a new validation
run without modifying the historical records. A reusable receipt is still
rechecked against the current candidate, dependencies, environment inputs, and
toolchain before it is returned. This iteration intentionally has no general
evidence cache.

Successful execution writes `acceptance.json` with format
`faktori.lean-acceptance-receipt/v1`. Its actor is explicitly
`faktori.lean.accept/v1` with kind `deterministic`; it is not a provider reply
and carries no provider usage. The receipt binds:

- exact candidate head, branch, dirty-tree content digest, and approved base;
- exact dependency revisions and declared environment-input value digests;
- requirements and structural acceptance-criteria digests;
- verifier command, output, and candidate-evidence digests;
- every required passing independent-review stage on that same candidate;
- selected role routes, owner cost order, and any escalation reason.

Any candidate change between verification, review, and acceptance fails closed.
Sensitive work requires two passing fixed-candidate review receipts. The Console
shows deterministic acceptance without counting it as an agent invocation or a
missing-telemetry session.

Local acceptance remains the first delivery gate. Publication is never
automatic. The existing publication handoff accepts a valid deterministic
receipt only after rechecking its exact review and verification bindings, and
the independent publication, external review, merge, deployment, and staging
verification gates remain unchanged. See [publication](loop-publication.md),
[delivery](loop-delivery.md), and [loop observation](loop-observation.md).

## Routing

Each role's routes are an owner-ordered cost/availability list. The first route
not declared unavailable wins; Faktori never invents prices or switches to a
separately billed provider. Missing model or reasoning fields inherit the
current `provider` settings. A skipped route and its reason are recorded. A Sol
override requires a recorded complexity, risk, or observed-failure
justification. Compact packets contain the objective, constraints, changed
facts, evidence references, and next action—not accumulated conversation
history.

Start from the checked-in templates under
`templates/workflows/lean-loop/`. Keep artifacts outside reviewed source and
under owner control. Do not point a proof at active or completed product runs.
