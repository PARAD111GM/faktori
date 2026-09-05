# Phase 2 implementation report

Status: Phase 2 implementation and authenticated Docker acceptance evidence are
complete. Build Manager exact-head acceptance remains pending.

## Scope and checkpoint

- Phase: 2 — one recoverable execution loop.
- Tickets: F2-01 through F2-04 only.
- Starting revision: `c0f33d958210daab54d606d7f69b64705aec6bdf`.
- Current implementation and evidence checkpoint before this report commit:
  `f84db3bf165b08415aea13d28b1eafda03c84099`
  (`docs: record phase 2 conformance checkpoint`).
- Final candidate revision: the commit containing this report and generated
  records; its exact head is supplied to the Build Manager for acceptance.
- Publication: no push, merge, publication, deployment, production action,
  billing change, usage reset, or separately billed model switch was performed.
- Product isolation: no Twinzy, Triforge, provider-account configuration, or
  active product infrastructure was changed.

## Full Phase 2 checklist

| Ticket | Status | Implementation and acceptance evidence |
| --- | --- | --- |
| F2-01 | Complete | The append-only JSONL journal is authoritative. Exclusive coordinator ownership, atomic admission and reservations, semantic run/effect identity, exact worker identity, queued messages, terminal results, restart recovery, and disposable SQLite reconstruction are behavior-tested. A committed malformed record blocks recovery; only an unterminated final tail is discarded. |
| F2-02 | Complete | Digest-pinned isolated and explicit native profiles, exact-environment argv transports, resource/output/runtime bounds, process/container identity probes, and fail-closed process-tree cancellation are implemented. Cancellation is coalesced, native escalation requires continuous group identity, and leader exit cannot prove whole-tree exit. Authenticated start/resume/cancel runs observed the immutable non-root Docker boundary, only approved mounts/environment, no Docker socket, host home, control storage, journal, or publisher credentials/environment, durable revocation before one stop, and confirmed absence afterward. |
| F2-03 | Complete | The Codex adapter and coordinator-owned single-worker delivery path implement explicit start/resume, current-context binding, durable source-session and scope binding, exact lifecycle identity, normalized events, structured results, usage disposition, and truthful failures. Live evidence proves one bounded edit/test, exact-session same-scope resume without `--last` plus a second edit/test, explicit durable cancellation of a started long command, truthful uncertain provider cancellation, and succeeded/succeeded/cancelled recovery. Earlier failed attempts remain retained. |
| F2-04 | Complete | Controller-minted per-run HMAC capabilities bind action scope, expected revisions, authorization, target, and authority epoch. Restart-safe private verifier storage, cross-controller claims, effect-boundary revalidation, idempotency, and malformed/forged/stale/revoked denial are behavior-tested. No remote publisher is implemented. |

The canonical status, owners, evidence links, and append-only completion events
are in `construction/checklist.json`; `construction/dashboard.html` is its
generated projection.

## Per-ticket implementation notes

### F2-01 — coordinator and durable run records

`src/runtime/journal.ts` appends canonical JSON-only events and replays deep
clones. `src/runtime/coordinator.ts` requires an exclusive claim before every
mutation, revalidates stale locks before deletion, serializes admission, and
prevalidates semantic conflicts before authoritative append. Identical run or
effect replay is idempotent; conflicting identity reuse blocks.

Reservations with unavailable usage remain uncertain rather than being
released as zero. Recovery preserves exact native or container identity and
blocks unknown or mismatched surviving workers. `src/runtime/sqlite-projection.ts`
rebuilds the query view from the journal, including unresolved work. The packed
CLI exposes `faktori runtime rebuild` and the interrupted-run fixture exercises
the recovery contract with actual SQLite.

### F2-02 — workspaces and execution profiles

`src/execution/index.ts` rejects mutable Docker tags, ambiguous or overlapping
mount roots, host home paths, the Docker socket, and control-storage exposure.
The isolated plan uses a non-root user, read-only root, dropped capabilities,
no-new-privileges, bounded PIDs/memory/CPU, private tmpfs, and networking off by
default. Provider access requires an explicit bridge decision. Native execution
records its broader host trust instead of presenting it as isolation.

`src/execution/transports.ts` launches argv directly with an exact working
directory and allowlisted environment. It bounds output and runtime, captures
PID/start-time/process-group or container-ID/start-time identity, and invokes
the coordinator's durable termination hook before a signal or container stop.
Cancellation preflights that exact identity; absent workers are safe no-ops,
while unknown or mismatched identity remains uncertain and receives no signal.
Explicit and runtime-bound termination share one durable operation. Native
SIGKILL escalation requires a continuously observed process-group member, and
whole-tree exit is checked independently of the leader PID. Nonzero PID
inspection is always unknown rather than absence.

A credential-free real Docker exercise observed UID 65532, `/workspace` as the
container working directory, no Docker socket, no publisher environment, no
credential profile, revocation before stop, confirmed exit, and an absent
container afterward. Raw operational paths and identities remain only in the
ignored private evidence area.

Two failed authenticated attempts subsequently reached the same hardened boundary.
The first observed a thread-spawn EAGAIN/resource-unavailable failure under the
64-PID profile; no cgroup counter established a stronger cause. The second
ran with a still-bounded 256-PID/two-CPU profile and emitted structured vendor
events, but the inner Codex sandbox could not create its namespace and no edit
occurred. The harness rejected that terminal event after independent fixture
verification. They remain in the sanitized evidence chain.

After owner-delegated approval of the Docker-only inner-sandbox override, one
bounded exercise passed on an unchanged hardened plan. All three containers
used UID `65532:65532`, `/workspace`, bridge networking, only the scratch
workspace and dedicated vendor-profile mounts, and controlled environment
keys. The shipped coordinator, adapter, and transport completed the fixture
edit and provider/local test; explicitly resumed the exact durable source
session in the same scope without `--last` for a second edit/test; then started
the controlled long command and performed exactly one stop after durable
authority revocation and termination intent. The container was confirmed
absent, cancellation changed no files, and projection rebuild yielded
`succeeded`, `succeeded`, and `cancelled`. The sanitized record is
`docs/build/phase-2-authenticated-conformance.md`.

### F2-03 — Codex adapter and local delivery loop

`src/providers/codex.ts` requires exact current context, approved model/runtime
bounds, a nonempty controlled environment, and explicit session resume. It
never uses `--last` or ambient host environment. Only a recognized
`turn.completed` record with clean JSONL and exit zero can complete; empty,
thread-only, item-only, malformed, or nonzero-exit output cannot invent
success. Authentication, quota, permission, and cancellation classifications
come only from recognized error channels or bounded sanitized stderr, never
ordinary agent text.

`src/runtime/delivery.ts` admits one actual transport worker after persisting
the effect intent, records the exact callback identity before provider events,
and persists final result, usage availability, and reservation disposition.
Resume requires a durable source final with the exact session and source
context. The final manager correction additionally binds factory, product,
repository, workspace ID, private workspace path, and provider at the delivery
and adapter boundaries. Cross-workspace, cross-product, and cross-repository
attempts fail before any launch intent or adapter call; current packet and
artifact revisions may still advance.

### F2-04 — controller-owned action admission

`src/actions/index.ts` mints per-run HMAC grants bound to immutable action scope,
base and expected revisions, current authority epoch, and current run. The
private verifier vault rejects symlink components, uses hashed filenames,
exclusive no-follow creation, mode 0600, and fsync. The append-only action
journal coordinates admission across independent controller instances. The
effect boundary rechecks current authority and target; duplicates return the
stored receipt and cannot execute twice. Provider output never grants action
authority. Remote publication remains later-phase work.

## Specialist contributions and model routing

- GPT-5.6-Sol high: phase orchestration, shared integration, package and CLI
  surface, canonical records, consequential verification, and manager handoff.
- GPT-5.6-Terra high (`shared_contract`): one read-only architecture pass across
  recovery, identity, cancellation, usage, provider results, and action caller
  authentication before writer fan-out.
- GPT-5.6-Terra high (`durable_state`): F2-01 contracts, journal, coordinator,
  SQLite projection, cancellation/delivery foundations, recovery tests, CLI,
  and fixture.
- GPT-5.6-Terra high (`execution_profiles`): F2-02 plan validation, isolated and
  native profiles, cancellation boundaries, tests, and worker Dockerfile.
- GPT-5.6-Terra high (`codex_adapter`): F2-03 Codex normalization, explicit
  start/resume, context/model/environment checks, lifecycle handling, and tests.
- GPT-5.6-Terra high (`action_admission`): F2-04 authenticated capabilities,
  durable vault/journal, cross-controller idempotency, revalidation, and tests.
- GPT-5.6-Terra high (`execution_profiles`, reused): concrete native and Docker
  argv transports with bounded output, exact identities, and lifecycle hooks.
- GPT-5.6-Terra high (`durable_state`, reused): the single-worker
  coordinator-to-Codex delivery integration.
- GPT-5.6-Sol high (`boundary_review`): one targeted read-only review found
  consequential durability, isolation, outcome, revocation, and integration
  defects. Each was remediated with regression evidence; no second broad review
  was run.

All writers had explicit ownership and were told to preserve concurrent work.
Specialists did not commit, merge, push, publish, deploy, or alter product
infrastructure. A final bounded read-only resume-scope audit was stopped without
output when an incorrectly inferred native goal cap was encountered; the Build
Manager independently identified and verified the correction instead.

## Skills used

The local `agent-teams` guidance kept phase-owned specialists bounded and
ownership-scoped rather than creating user-owned tasks. `backend-patterns`
guided the durable journal/projection, adapter, and controller separation.
`coding-standards` kept TypeScript contracts strict, effects explicit, and
tests behavior-focused. User and repository construction rules remained
authoritative where generic guidance differed.

## Manager corrections and resolved judgments

The deterministic candidate loop produced these material corrections:

1. Interfaces and fake runners were insufficient proof of executable delivery.
   Concrete native and Docker transports plus the coordinator-owned delivery
   loop now connect admission to one real worker, exact lifecycle evidence, and
   durable finalization.
2. Journal inputs initially admitted nested `undefined` and mutable object
   references. The journal now accepts canonical JSON-only values and isolates
   committed data from caller mutation.
3. Coordinator mutation, stale-lock removal, reservations, semantic identity,
   and unknown recovery paths were hardened to fail closed under ownership,
   replay, and interruption races.
4. Docker plans now reject structural option injection and every ancestor,
   descendant, or equal overlap among workspace, input, credential, and control
   roots. Cancellation never signals before exact identity preflight.
5. Codex success, error classification, lifecycle callbacks, and unavailable
   usage were tightened so local exit or agent text cannot invent provider
   success, denial, cancellation, or zero usage.
6. Action admission gained restart-safe verifier storage, malformed-request
   denial, current-run binding, and cross-controller serialization.
7. Explicit resume originally proved the source session and context but did not
   bind the target to the durable source workspace and product scope. Commit
   `198e7c3` adds adapter and delivery gates plus pre-launch regressions.
8. Simultaneous explicit cancellation and a runtime bound could both pass the
   durable hook before termination state was visible. Commit `ff9375a`
   coalesces the operation, preserves hook-denial retry, and keeps Docker stop
   single-shot.
9. Native PID inspection and escalation could confuse inspection failure or
   leader exit with whole-tree exit. Commit `fa23242` separates group
   observation, requires continuous identity before SIGKILL, and preserves
   explicit uncertainty for unanchored or unobservable groups.

The first Phase 2 estimate was mistakenly copied into native goal metadata as a
hard token cap. The owner removed it without resetting the original goal. The
repository now states explicitly that construction estimates stay in
construction records and native hard caps require an explicit owner request.

## Verification

Observed in the assigned worktree using Node `v24.20.0` and npm `12.0.2`:

| Command or exercise | Observed result |
| --- | --- |
| Full `npm run check` through the cached toolchain at deterministic checkpoint `fa23242` | Implementer and Build Manager independently observed exit 0: strict TypeScript, 18 test files and 158 tests, emitted build, and packed-package CLI/SQLite/import verification passed. |
| Full `npm run check` on the assembled final-candidate tree after live evidence and record refresh | Implementer observed exit 0: strict TypeScript, 18 test files and 158 tests, emitted build, and packed-package CLI verification passed. Build Manager exact-head verification remains pending. |
| Resume-scope targeted tests plus strict typecheck | Implementer observed exit 0 before commit: two test files and 34 tests passed; `tsc --noEmit` and `git diff --check` passed. |
| Actual native `better-sqlite3` load | Built narrowly for Node 24.20.0 and exercised real open/create/insert/query behavior; packed runtime rebuild also passed. |
| Credential-free real Docker transport exercise | Exit 0 with immutable local image identity; observed hardened UID/cwd/mount/environment boundary, durable revoke-before-stop, confirmed exit, and absence afterward. |
| Authenticated Docker Codex start/edit/test/resume/cancel | **Passed after two retained failures.** Owner-delegated approval enabled the existing Docker-only opt-in on unchanged hardened plans. Start and exact-session resume each produced only their requested edit, provider test exit 0, independent local verification, structured completion, and reported usage. The controlled `sleep 120` was observed before explicit cancellation; authority revocation and termination intent preceded exactly one stop; container absence and unchanged cancellation workspace state were confirmed; provider cancellation remained truthfully `interrupted_uncertain`; projection rebuild returned succeeded/succeeded/cancelled. The Build Manager independently inspected this evidence and reran both scratch verifiers successfully. |

The fresh full check after the construction-record refresh passed. Build
Manager exact-head acceptance remains distinct from both the live exercise and
the implementer's deterministic suite.

## Usage and planning estimate

Phase 2 planning revision 1 estimated 1,800,000 tokens. Revision 2 raised the
soft forecast to 2,200,000 after observed integration and boundary rework. It is
not an invoice, permission to spend, completion target, or native hard cap.

After the live exercise and final assembled check, the original goal's
cumulative counter reported 2,078,333 tokens. This is retained as the overlap-safe
construction lower bound;
specialist totals are unavailable and parent/child coverage is unknown. The
manager's separately baseline-derived 356,378-token sample is not added because
coverage overlap is unknown. That sample exceeded the manager's advisory
200,000-token allocation during live-path verification and remediation; it is
reported honestly but is neither a hard goal cap nor a reason to weaken scope.
Input, output, cached-input, reasoning, complete specialist
attribution, overlap, and dollar cost remain unavailable. Raw task and session
identities remain in ignored `.build/usage/`; only sanitized aggregates are
committed.

The successful start separately reported 107,441 input tokens (including
88,320 cached) and 504 output tokens. Resume reported 229,156 input (including
204,288 cached) and 1,066 output. These are recorded as child measurements and
not added to the parent counter because overlap is unknown. Cancellation usage
was unavailable and remains unknown. The overlap-safe lower bound remains below
the 2.2M forecast, but the goal itself is uncapped. Final record verification
and manager acceptance remain.

## Final gate and remaining concerns

All four Phase 2 tickets now meet their stated acceptance evidence. The
remaining gate is Build Manager acceptance of the clean exact candidate after
the final full assembled check. No further live run is required unless that
review finds evidence-specific cause.

Other explicit limitations:

- No remote publisher exists in Phase 2; F2-04 proves admission, not remote
  publication.
- The dedicated Codex profile must be writable only for the unmodified vendor
  CLI's own session/refresh behavior. It is not a host-home mount.
- Provider-native cancellation receipt remains capability-specific. A wrapper
  or container exit alone remains `interrupted_uncertain`.
- Missing provider usage remains unavailable and its reservation uncertain.
- JSONL is operational truth and SQLite remains disposable; neither an HTML
  dashboard nor a passing projection test overrides journal evidence.

## Deviations and lessons for Phase 3

- Authenticated isolated behavior required an explicit outer-versus-inner
  sandbox judgment. Keep the override opt-in Docker-only, validate the exact
  outer plan before inserting it, and never generalize owner approval to native
  execution or a weaker container.
- Establish a concrete transport-plus-coordinator slice before broad component
  fan-out in future runtime phases; interfaces and fake runners hide lifecycle
  gaps.
- Bind every provider session to durable workspace and product scope at both
  coordinator and adapter boundaries before the first live resume.
- Run the narrow authority/recovery/isolation review after the shared contract
  stabilizes, then remediate findings without repeating broad review.
- Build and exercise required native dependencies early under the accepted
  toolchain; installed package behavior matters separately from source tests.
- Keep soft construction forecasts in construction records. Never infer native
  goal limits, billing authority, or scope changes from them.
- Retain non-secret exact run identities only in private operational evidence;
  credentials belong solely in the vendor credential store and must never be
  copied into operational evidence. Public reports contain sanitized outcomes
  and truthful unknowns.
- Start Phase 3 only after Build Manager exact-head acceptance of the final
  Phase 2 candidate.
