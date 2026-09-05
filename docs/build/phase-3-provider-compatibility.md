# Phase 3 provider compatibility and portability

**Last updated:** 2026-09-05

**Runtime observed:** Node 24.20.0

**Historical live profile:** native execution with explicit host trust

**Current acceptance state:** corrected chain reached `CHANGES REQUIRED`; fresh independent review pending

This note records the Phase 3 compatibility boundary and the sanitized live
portability evidence. It does not claim provider behavior that was not
observed, and it contains no credentials, account identifiers, session IDs, or
personal filesystem paths.

## Common contract

Faktori starts a bounded turn with the current coordinator-approved context
packet. The approved input digest binds `packetRevision`, packet `digest`, and
the exact untrimmed prompt bytes. That digest also participates in the durable
provider-effect identity. Every adapter independently verifies the same input
authorization and sends the exact bound bytes. The adapter returns normalized
stream events, a final outcome, and usage telemetry when the provider emits it.
Provider output is untrusted data: it never grants authority, changes scope,
approves an action, selects credentials, or authorizes publication.

The exact durable scope is:

`factoryId + productId + repository + workspaceId + workspacePath + providerId`

Every resumed session must carry an explicit source run, source context
revision/digest, session ID, and source scope. The coordinator verifies that
the source and target scopes match exactly, including provider and workspace;
there is no `--last` or implicit latest-session recovery. A new turn may use
the current approved artifact revision, but it cannot cross the recorded
factory, product, repository, workspace, or provider boundary.

The workspace path is private operational data. Public handoffs use repository-
relative artifact references and content digests only. See the
[adapter contract](../providers/adapter-contract.md), [portable-artifact
ADR](../architecture/ADR-001-portable-artifacts.md), and
[coordinator-authority ADR](../architecture/ADR-002-coordinator-authority.md).

## Provider semantics

| Provider | Start | Explicit resume | Cancel | Observed limitations |
| --- | --- | --- | --- | --- |
| Claude Code | Native print mode with streaming JSON in the selected workspace | Explicit recorded session in the same scope | Process termination can be requested, but a native cancellation receipt is unavailable; absent a receipt the outcome is `interrupted_uncertain` | Permissions are tool suppression only; no approval/question replies. Usage is reported or partial only when emitted. |
| Cursor | ACP over stdio (`initialize`, authentication, and `session/new`) | ACP `session/load` with the explicit recorded session | ACP `session/cancel`; a terminal cancellation receipt is required | Permission, question, and plan request handlers exist in the protocol seam, but were not emitted in the observed profile. Usage was not emitted. |
| Codex | `exec --json` in the selected workspace | `exec resume` with the explicit recorded session | Wrapper termination is supported; native cancellation receipt is unavailable, so an interrupted result remains uncertain | No native approval/question replies or native sandbox capability. Usage is reported or partial only when emitted. |

All three adapters expose the same `start`, `resume`, normalized-events, final-
result, and optional `cancel` seam. Transport exits, missing worker receipts,
denials, authentication requirements, quota exhaustion, cancellation, and
uncertain interruption remain distinguishable outcomes. See the provider
implementations and common behavior coverage in
[provider-adapters.test.mjs](../../tests/runtime/provider-adapters.test.mjs),
[Claude tests](../../tests/providers/claude.test.mjs),
[Cursor tests](../../tests/providers/cursor.test.mjs), and
[Codex tests](../../tests/providers/codex.test.mjs).

## Delivery and provider composition

`CoordinatorProviderDelivery` is the provider-neutral delivery contract. The
coordinator owns admission, reservations, current context, durable effect
intents/receipts, worker identity, authority revocation, cancellation, usage
classification, and final recording. A provider adapter only reports what its
CLI observed.

The same factory can assign every role to one provider; role assignments still
have distinct session purposes, including independent review. A mixed-provider
path assigns planning, implementation, and independent review independently.
Cross-provider handoff transfers scoped intent/specification, accepted
artifacts, verification, and a concise summary. It transfers artifacts and
evidence only—not private reasoning, native conversation state, or authority.
The receiving provider starts its own explicitly scoped session.

Delegated child results cross the parent boundary only as exact
`faktori.delegated-result-evidence/v1` records. The allowlist excludes provider
session IDs, native cancellation fields, private paths, credentials, authority,
unknown nested fields, and provider-specific telemetry keys. Persisted result
envelopes with appended fields are rejected instead of normalized silently.

The portable handoff format is `faktori.provider-handoff/v1`. Its identity is
digest-bound and idempotent; artifact references must be safe relative
references, and the contract rejects private paths, credential/session/token
references, duplicate artifacts, and authority-bearing extra fields.

## Historical Claude → Cursor → Codex observation

Before the final consequential-review remediations, a private harness assigned
planning to Claude, implementation to Cursor, and independent review to Codex
under separate workspaces and a bounded scratch repository. The review
continued from the exact durable Cursor artifacts after the coordinator
restarted; the recovery recorded no duplicate handoff message. Both pre-review
and post-review executable checks recorded:

```text
node verify.mjs exited 0: verification passed
```

The accepted artifact chain and exact content digests were:

| Artifact | Revision | Reference | Digest |
| --- | --- | --- | --- |
| Portable plan | `plan@1` | `plan.md` | `sha256:36322f07ea42c862ae25127feb19b32b0c61ede72b863d747e3a88b50c698c19` |
| Cursor implementation | `implementation@1` | `counter.json` | `sha256:0f20c3565209c71b9d68497ec02339b4dfeadedbdbe50fd0c75f7af181de3099` |
| Independent verifier | `verification@1` | `verify.mjs` | `sha256:220b07a9e72821194481cd4d31af9d685c9f454adbca8bf4c9b429e75128c1c9` |
| Codex review | — | `review.md` | `sha256:0de924aa56e6ad6e15a43a8f1dfa3835bd5a75a547b1b5a7c3f1783887468f15` |

The executable verification was intentionally run from the assigned review
scratch workspace against the transferred `counter.json` and `verify.mjs`;
the live scratch contents are not public repository files. This is historical
provider-feasibility evidence, not final acceptance evidence for the later
prompt-binding, sanitized-result, admission-recovery, and exit-confirmation
changes. It is not a claim of deployment, publication, or merge authority.

After explicit owner approval, one corrected chain exercised the current path.
Claude planning/resume, Cursor implementation/session-load, executable
verification, and restart-safe handoffs succeeded. Codex independently reran
the verifier and confirmed the implementation/verifier digests, but returned
`CHANGES REQUIRED`: the private harness had persisted Claude's intentionally
bounded `final.summary` as `plan.md`, so the plan ended mid-requirement.

The complete 955-byte Claude result was not lost. It remained in the durable
normalized provider event and was recovered locally with digest
`sha256:890fd47fff503da0c78ada9fadc74ffd83a21fc6d2fd310814cabebb8bcd23eb`.
The harness now obtains the artifact from that exact terminal event while
retaining the bounded summary contract. Local checks confirmed every required
plan clause, exact counter bytes, and verifier exit 0 with
`verification passed`. Claude and Cursor were not rerun. A fresh Codex review
of the recovered plan and unchanged saved artifacts remains required and needs
explicit authorization as an additional external provider run.

## Trust and evidence boundaries

The historical live chain used native explicit host trust (`isolated: false`). It did not
copy credentials, publish externally, change billing, or change infrastructure.
No isolated Claude or Cursor execution was proven. Native host trust must be
selected explicitly and documented as broader access. The separate [Phase 2
Docker proof](phase-2-authenticated-conformance.md) remains a distinct Codex
transport/isolation result; it does not establish isolated Claude or Cursor
authentication or capability.

The observed native profile supplied an explicit allowlist of `HOME`, `USER`,
`LOGNAME`, `SHELL`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, and `TMPDIR`,
with values resolved by the controller for the selected local account. It did
not inherit the entire host environment. These are configuration fields, not
credentials; provider authentication remained in each vendor CLI's own store.

Usage and reservation telemetry has known gaps. Unknown usage is unknown, not
zero; an estimated reservation is not actual consumption, and an uncertain
reservation is not silently released or counted as consumed. The live record
therefore preserves provider-specific `consumed` and `uncertain` states and
does not make a spending guarantee where provider telemetry cannot support one.

Two bounded failures remain part of the historical evidence:

- Claude’s controlled-environment preflight required explicit non-secret user
  and locale fields. The exact individual causal field was not isolated.
- The first Codex review attempt failed in a non-Git scratch workspace. It
  succeeded after initializing only the assigned scratch workspace as a local
  Git repository.

Neither failure grants a broader trust boundary or changes the portability
contract. Provider output remains evidence for coordinator decisions, never
authority to perform them.

## Related documentation

- [Phase 3 implementation scope](../implementation-plan.md#phase-3--add-three-provider-team-orchestration)
- [Provider feasibility baseline](provider-feasibility/README.md)
- [Runtime architecture](../runtime/README.md)
- [Isolated execution ADR](../architecture/ADR-003-isolated-execution.md)
