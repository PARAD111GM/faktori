# Prove the product, not just the process

Runtime verification is deterministic and provider-neutral: no coding-agent
calls, Archon dependency or new engine. Configure the capabilities you already
use; no particular ticketing or messaging vendor is required.

## Candidate contract

`faktori verification snapshot <absolute-candidate-directory>` captures bounded
candidate identity. `faktori verification run <owner-runtime-contract.json>`
runs the healthy scenario and negative controls, prints a structured result and
exits nonzero unless passed. Use it as an existing lean verification command;
keep its manifest outside reviewed source and bind it as a file dependency.
Changed candidate, manifest or declared environment requires fresh verification.
The result carries separate candidate and configuration digests, scenario
outcomes and cleanup confirmation; environment values are not echoed in it.
If cleanup is unconfirmed, the failed result retains a `recoveryDirectory` and
observed process identities. Inspect those identities before recovery; never
kill a reused PID or delete a directory while an unknown worker may still use it.

Commands are trusted owner-supplied executable/argument arrays run in disposable
candidate copies with bounded execution and cleanup. This is process lifecycle
isolation, not a security sandbox for malicious application code. Do not supply
production credentials or point commands at active workers. Identity commands
must query the running application, not echo the expected identity; check
commands must exercise behavior, not return constant success.

Healthy behavior must pass; deliberately broken behavior must fail the expected
assertion. Crashes, checker failures, wrong identity and timeouts never count as
catching a defect. Passing measures only the configured controls, not universal
quality, merge authority or human product acceptance. Retain the report.

A runtime manifest has this shape (replace executable, path, digest and owner
with explicitly approved values; the scripts belong to the candidate):

```json
{
  "format": "faktori.candidate-verification/v1",
  "execution": { "nativeAccessApproved": true, "approvedBy": "project owner" },
  "candidate": { "path": "/absolute/candidate", "expectedDigest": "sha256:<snapshot digest>" },
  "startup": { "command": "/absolute/node", "args": ["verify/server.mjs"] },
  "identity": { "command": "/absolute/node", "args": ["verify/identity.mjs"] },
  "check": { "command": "/absolute/node", "args": ["verify/check.mjs"] },
  "environment": {},
  "negativeControls": [{ "id": "broken-total", "environment": { "BREAK_TOTAL": "1" }, "expectedFailureCode": "wrong-total" }],
  "limits": { "startupTimeoutMs": 10000, "checkTimeoutMs": 30000, "shutdownTimeoutMs": 1000, "outputMaxBytes": 65536 }
}
```

No parent environment is inherited. The controller adds `FAKTORI_VERIFY_RUN_ID`,
`FAKTORI_VERIFY_CANDIDATE_DIGEST`, `FAKTORI_VERIFY_VARIANT` and
`FAKTORI_VERIFY_DIRECTORY`. Use the last directory for scratch files and an
ephemeral endpoint rendezvous file; do not write into the copied candidate.
Identity scripts query the running app and emit one JSON object with format
`faktori.runtime-identity/v1`, `runId`, `candidateDigest`, `variant` and optional
`endpoint`. Check scripts emit `faktori.runtime-check/v1` with the same bindings,
`status` (`passed` or `failed`) and a `failureCode` for the expected defect.
A valid checker exits zero even when it detects that defect; a nonzero checker
exit is infrastructure failure. Candidate snapshots reject symlinks and special
files and exclude only root `.git`; prepare a bounded verification candidate
without dependency symlinks or unapproved secrets.

Verification environments close after the exercise. A persistent human preview
or simulator is a separate project-owned delivery capability; do not advertise
a stopped verification endpoint as an available preview.

## Lean review and delivery

After substantive findings, non-sensitive review receives prior findings and
candidate identity to focus on corrections and affected behavior, widening
inspection when needed. It still produces a new independent exact-head verdict.
Sensitive work retains full-candidate review and all required passes. No default
specialist fan-out or acceptance inference is added.
An unchanged candidate after a claimed repair blocks before another review call.
Resolve a disputed finding explicitly rather than relaunching unchanged work.

For `loop delivery record`, passing merge evidence needs `mergeCommit`; passing
deployment needs matching `deployedRevision`; staging verification needs matching
`acceptedRevision`. Preceding gates must pass. Health alone is insufficient.
Older receipts remain on disk; missing revision evidence must be reconciled
before the corresponding state is displayed as passed. Never invent identities
or rewrite historical receipts automatically.

## Setup and update

Start attended. Verify the selected tools' capabilities, exercise a bounded
delivery and collect explicit owner acceptance. Unattended graph admission needs
a configuration-bound witnessed-delivery record and an observed completed
assignment, plus runtime/delivery evidence. A completion message alone does not
establish product acceptance. Existing signed authority and the relay's
single-owner lock remain required. Do not add a competing n8n dispatcher.

The private readiness JSON accepts `witnessedDelivery` with format
`faktori.witnessed-delivery/v1`, `sprintRevision`, `catalogRevision`,
`configurationDigest`, `validUntil`, and:

- `journey`: retained `requestId`, `state: "completed"`, exact `completedAt`.
- `validations`: unique `kind`, `state`, retained `evidence` reference and
  `observedAt`; require candidate, runtime and delivery or staging results.
- `ownerAcceptance`: `state: "accepted"`, `owner`, retained `evidence` and
  `observedAt`.

Use the exported `witnessedDeliveryConfigurationDigest(readiness)` to bind the
configuration without hashing the witness itself. The evaluator checks retained
request completion and structured attestations; it does not fetch or independently
authenticate arbitrary evidence links. Only the authorized readiness writer may
record these attestations after reviewing the actual evidence. A witness grants
no merge, spending or provider authority.

Preserve active workers during updates. Install/build the kit, inspect readiness
with admission paused, supply missing evidence explicitly, then enable unattended
admission only after the gate passes. On evidence drift, block new admission and
reconcile rather than repeatedly asking an LLM to diagnose unchanged failures.
