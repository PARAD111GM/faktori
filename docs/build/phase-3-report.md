# Phase 3 implementation report

Status: Phase 3 implementation, deterministic verification, and corrected live
provider-portability evidence are complete. Build Manager exact-head acceptance
remains pending.

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
| F3-01 | Complete | Claude streaming JSON, explicit start/resume, controlled environment, exact prompt authorization, truthful outcomes/usage, and durable native lifecycle pass direct/common-delivery tests and corrected live start plus exact-session resume. |
| F3-02 | Complete | Cursor ACP lifecycle, serialized permission/question/plan replies, notification handling, explicit session load, exact prompt authorization, cancellation, quarantine, and confirmed process-group exit pass tests and corrected live implementation plus exact-session load. |
| F3-03 | Complete | Durable child admission, ownership, per-workstream allocation, concurrent admission, artifact transfer, exact-schema sanitized results, restart recovery, cancellation, and orphan repair pass tests; corrected live handoffs survived restart without duplication. |
| F3-04 | Complete | The initial `CHANGES REQUIRED` verdict remains preserved. A fresh Codex session then accepted the recovered exact Claude plan and unchanged Cursor artifacts, named all three digests, and independently reproduced `verification passed`. |

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
| Full `npm run check` | Exit 0: strict TypeScript, 26 test files and 242 tests, emitted build, and packed CLI verification. |
| Summary/artifact separation | Claude regression confirms complete terminal result text remains in normalized events while `final.summary` stays diagnostic-sized. |
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

### Corrected live chain — `CHANGES REQUIRED`

After explicit owner approval, one corrected native chain ran through the
normal execution gate using existing subscription routes. It observed:

1. Claude planning and exact-session resume completed;
2. Cursor created and verified the expected fixture, then loaded the exact
   session successfully;
3. the coordinator restarted and recovered handoffs without duplication; and
4. Codex reran the verifier, confirmed the implementation and verifier digests,
   and returned `CHANGES REQUIRED` because `plan.md` ended mid-requirement.

The failure was a private harness defect, not provider output loss or shipped
handoff corruption. `final.summary` is intentionally diagnostic-sized. The
harness incorrectly treated it as an artifact channel. The complete 955-byte
Claude result remained in the durable normalized provider event. The harness
now derives `plan.md` from that exact retained terminal event and verifies its
session, outcome, type, and 16,000-byte artifact bound. A regression proves
complete provider text remains in normalized events while `final.summary`
stays bounded.

The preserved failed-chain evidence is:

| Artifact | Digest |
| --- | --- |
| Truncated summary-derived plan | `sha256:66cda2ba9dbc9aae85e4d57e5bdce0b47ea9ceb7ebe02e8111236bc3f5436984` |
| Recovered complete plan | `sha256:890fd47fff503da0c78ada9fadc74ffd83a21fc6d2fd310814cabebb8bcd23eb` |
| Cursor counter | `sha256:0f20c3565209c71b9d68497ec02339b4dfeadedbdbe50fd0c75f7af181de3099` |
| Cursor verifier | `sha256:d96481859a2058e237ff2760b801b717508efa5639a40a1aa2ea9698f94820af` |
| `CHANGES REQUIRED` review | `sha256:8cbc7ea37dfaf489ccec2f68dbab7c607498ff4d40df4c50926503c94fecdf66` |

Local recovery confirmed every required plan clause, the exact counter bytes,
and another `verification passed` verifier exit 0. No Claude or Cursor work was
restarted. With explicit owner approval, one fresh Codex session reviewed only
the recovered plan and unchanged saved artifacts. It returned `ACCEPTED`, named
the exact plan/counter/verifier digests, and independently produced another
verifier exit 0. The accepted review digest is
`sha256:332b5b7be0f0f5f8f64bfce9691cbdf99fa7939bd4ce0761f401c8425d9e5f31`.

## Trust, usage, and routing

The historical live work used explicit native host trust. It did not prove
isolated Claude or Cursor execution. The separate Phase 2 Docker evidence
remains Codex-specific and does not widen this claim. No credentials were
copied; authentication remained in each vendor CLI's own store.

Phase 3 revision 1 estimates 2,400,000 tokens. The latest committed public
summary records a 1,741,225-token overlap-safe lower bound; three specialist
measurements and parent/child coverage remain unknown, and the manager sample
is not added because overlap is unknown. The estimate is advisory planning
data, not a cap, invoice, spending permission, or completion criterion.

Specialist routing used Terra-high for the Claude, Cursor, and delegation
implementation lanes; Sol-high for orchestration and the consequential boundary
review; and Luna-medium for the public compatibility note. Ownership was
explicit and writers were instructed to preserve concurrent work. The final
constraint prohibited new specialist/reviewer inference. The owner authorized
one corrected live chain and, after its fail-closed verdict, one fresh Codex
review of the recovered artifact set. The harness fix and artifact recovery
were deterministic; Claude and Cursor work was not repeated.

The `agent-teams` skill shaped ownership, seam-first parallelism, and centralized
integration. User, manager, and repository construction rules remained
authoritative.

## Remaining gate

All Phase 3 acceptance evidence is present. The remaining gate is Build Manager
review and acceptance of the clean exact candidate. Passing tests and provider
finals do not substitute for that exact-head decision.
