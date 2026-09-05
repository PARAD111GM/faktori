# Phase 3 implementation checkpoint

Status: implementation and deterministic verification are complete. Phase 3
acceptance is blocked on one corrected live provider-portability run and Build
Manager exact-head acceptance.

## Scope and source

- Phase: 3 — three-provider team orchestration.
- Tickets: F3-01 through F3-04 only.
- Accepted starting revision:
  `79f970a150826ea14d9c9f6fb2f86eb2804a4ace`.
- Last committed implementation checkpoint before review remediation:
  `72c8d1c10f9e41695e54b8d64faa93cee4f3716e`.
- Publication: no push, merge, deployment, production action, billing change,
  usage reset, or separately billed route was performed.
- Product isolation: no Twinzy, Triforge, provider-account configuration, or
  active product infrastructure was changed.

## Checklist

| Ticket | Current state | Evidence |
| --- | --- | --- |
| F3-01 | In progress | Claude streaming JSON, explicit start/resume, controlled environment, exact prompt authorization, truthful outcomes/usage, and durable native lifecycle are implemented. Direct and common-delivery tests pass. A historical live start/resume succeeded before the final prompt-binding remediation; the corrected live route is pending. |
| F3-02 | In progress | Cursor ACP lifecycle, serialized permission/question/plan replies, notification handling, explicit session load, exact prompt authorization, cancellation, and confirmed process-group exit are implemented. Unknown or mismatched initial identities quarantine the transport without blind signaling. Tests pass; corrected live confirmation is pending. |
| F3-03 | In progress | Durable child admission, explicit ownership, per-workstream workspace allocation, concurrent admission, artifact transfer, exact-schema sanitized result evidence, restart recovery, cancellation, and orphaned-admission repair are implemented and tested. Phase completion remains gated by the corrected live chain. |
| F3-04 | In progress | One historical Claude → Cursor → Codex artifact chain completed, but consequential review changed prompt binding, result handoff, admission recovery, and exit confirmation afterward. Deterministic regression coverage passes; the corrected chain has not run. |

Canonical status and append-only transitions are in
`construction/checklist.json`; `construction/dashboard.html` is the generated
projection. Public-safe compatibility details are in
`docs/build/phase-3-provider-compatibility.md`.

## Implemented boundaries

### Exact coordinator-approved input

`providerContextPayloadDigest` binds the packet revision, packet digest, and
exact prompt bytes. The coordinator requires that digest in the admitted run,
includes it in the provider effect identity, and refuses a conflicting replay.
Claude, Codex, and Cursor independently check the same authorization and send
the exact untrimmed prompt bytes. Whitespace changes therefore require a new
approved digest rather than silently changing executed content.

### Claude adapter

The Claude adapter uses native print mode with streaming JSON, manual
permissions, an explicit tool allowlist, and a minted start session or exact
recorded resume session. Resume binds the source run, context and complete
factory/product/repository/workspace/provider scope; implicit latest-session
recovery is forbidden. Authentication, quota, denial, failure, cancellation,
uncertain interruption, and unavailable telemetry remain distinct.

The native process transport records PID, process start, process group, and run
nonce before provider output is consumed. Runtime, output, and cancellation
termination require the durable coordinator hook before identity-checked
signaling.

### Cursor adapter and transport

The Cursor adapter performs ACP initialize/authenticate/session-new or exact
session-load, then submits the authorized prompt. Blocking permission,
question, and plan requests receive one serialized policy reply or fail closed.
Id-less and unknown valid notifications remain bounded observations; they do
not become authority or terminal outcomes.

The stdio transport bounds JSON-RPC lines, correlates responses, rejects
duplicates, orphan responses, malformed output, oversized output, and handler
failure, and closes pending calls deterministically. A terminal provider result
is returned only after both the exact child and its process group are observed
absent. If EOF leaves an identified group alive, durable revocation precedes
identity-checked TERM/KILL. If initial identity is unknown, mismatched, or the
probe fails, the transport sends EOF only, never signals the unproven process,
and permanently retains its slot until an operator recreates the instance.

### Delegation and portable handoffs

The coordinator derives child identity, budget, authority, provider, model,
workspace, and reservation from trusted parent state and allocator policy.
Requests cannot self-select those fields. Ownership paths must be normalized,
non-overlapping, and explicitly serialized when shared. Admission is durable;
an interruption between `run.admitted` and the ownership envelope is detected
as an orphan and blocks different sibling work until the exact retry repairs it.

Child result handoff uses the exact
`faktori.delegated-result-evidence/v1` allowlist. Provider session IDs, native
cancellation fields, private paths, credentials, authority material, unknown
nested data, and provider-specific telemetry fields never cross to the parent.
Persisted envelopes are exact-schema checked rather than accepting appended
fields. Artifact ID/digest pairs can feed a later child only after submission
and forwarding for the same durable parent.

`faktori.provider-handoff/v1` separately binds source and target providers,
scope, saved artifact revisions/digests, verification, and summary. It rejects
same-provider use, duplicate artifacts, unsafe paths, private/session/credential
material, authority-bearing fields, and unsupported nested fields. Provider
substitution always starts a fresh target session from saved artifacts.

## Consequential review and remediation

The scoped Sol-high boundary review found four material issues:

1. prompt bytes were not bound to the admitted intent/effect;
2. delegated results could forward provider-native session material and nested
   portable fields were not exact-schema checked;
3. Cursor could report terminal completion without confirmed child/group exit;
4. delegation ownership could be lost after run admission but before its first
   message.

All four were remediated. A focused follow-up confirmed the handoff and orphan
repairs and identified two remaining cases: Claude/Codex direct-adapter prompt
authorization and Cursor pre-identity quarantine. Those cases are also now
remediated and covered by deterministic tests. Under the remaining-account
constraint, no additional reviewer or specialist turn was started.

## Evidence status

### Current deterministic evidence

Observed with Node `v24.20.0` and npm `12.0.2`:

| Gate | Result |
| --- | --- |
| Focused changed-boundary suite | 8 files, 113 tests passed. |
| Full `npm run check` | Exit 0: strict TypeScript, 26 test files and 241 tests, emitted build, and packed CLI verification. |
| Prompt mutation/authorization | Exact-byte success and unapproved-prompt denial pass for Claude, Cursor, and Codex paths. |
| Cursor identity/exit negatives | Unknown, mismatched, and failed identity probes quarantine without signals; lingering exact groups retain the slot through failed TERM/KILL confirmation. |
| Delegation/handoff negatives | Private/session/native/nested fields, forged artifacts, cross-parent artifacts, duplicate ownership, and orphaned admission paths fail closed. |

### Historical live observation — not final acceptance evidence

Before the consequential remediations, a bounded native-host-trust chain
observed:

1. Claude planning and exact-session same-scope resume;
2. Cursor creation of `counter.json` and `verify.mjs`, an executable
   `verification passed`, and exact-session load;
3. coordinator restart without duplicate handoff delivery; and
4. fresh Codex review with exact artifact digests and a second verifier pass.

The recorded historical digests were:

| Artifact | Digest |
| --- | --- |
| Plan | `sha256:36322f07ea42c862ae25127feb19b32b0c61ede72b863d747e3a88b50c698c19` |
| Counter | `sha256:0f20c3565209c71b9d68497ec02339b4dfeadedbdbe50fd0c75f7af181de3099` |
| Verifier | `sha256:220b07a9e72821194481cd4d31af9d685c9f454adbca8bf4c9b429e75128c1c9` |
| Review | `sha256:0de924aa56e6ad6e15a43a8f1dfa3835bd5a75a547b1b5a7c3f1783887468f15` |

This observation remains useful provider-feasibility evidence, but it cannot
prove the post-review prompt-binding, sanitized-handoff, and confirmed-exit
code. It is therefore not used to mark F3-01 through F3-04 complete.

### Blocked corrected proof

The Build Manager bounded one corrected native chain using existing subscription
routes. The local execution gate rejected that run before launch because it
would transmit the Phase 3 prompts and scratch artifacts to external Claude,
Cursor, and Codex services without explicit user approval. The run did not
start, no provider work was repeated, and the gate was not bypassed.

Completion requires the user to approve that exact bounded external-provider
transmission. After it passes, the orchestrator must record the new evidence,
mark the four tickets complete, regenerate construction records, commit the
exact candidate, and obtain Build Manager exact-head acceptance.

## Trust, usage, and routing

The historical live work used explicit native host trust. It did not prove
isolated Claude or Cursor execution. The separate Phase 2 Docker evidence
remains Codex-specific and does not widen this claim. No credentials were
copied; authentication remained in each vendor CLI's own store.

Phase 3 revision 1 estimates 2,400,000 tokens. The latest committed public
summary records a 1,588,601-token overlap-safe lower bound; three specialist
measurements and parent/child coverage remain unknown, and the manager sample
is not added because overlap is unknown. The estimate is advisory planning
data, not a cap, invoice, spending permission, or completion criterion.

Specialist routing used Terra-high for the Claude, Cursor, and delegation
implementation lanes; Sol-high for orchestration and the consequential boundary
review; and Luna-medium for the public compatibility note. Ownership was
explicit and writers were instructed to preserve concurrent work. The final
constraint prohibited new specialist/reviewer inference; remaining work stayed
deterministic except for the single live chain that was authorized by the
manager but stopped by the external-transmission approval gate.

The `agent-teams` skill shaped ownership, seam-first parallelism, and centralized
integration. User, manager, and repository construction rules remained
authoritative.

## Remaining gate

Phase 3 is not complete. The first exact blocking gate is explicit user approval
for the one bounded corrected Claude → Cursor → Codex native chain. Build
Manager exact-head review remains a separate later gate; passing tests or a
provider final cannot substitute for it.
