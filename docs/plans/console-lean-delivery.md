# Console work management: accepted lean delivery

This supersedes the implementation sequencing and restart-only catalog in
`console-work-management.md`. Preserve that document's product/authority
requirements; use three integrated batches rather than eighteen ceremonies.
Base: merged lean iteration b8955f4. Creator and active workers are out of scope.

## Batch 1: understand work

Agent-maintained optional catalog, safe hot reload, Projects/Plans/ordered
Phases/Tickets, readable titles, bounded read-only artifacts, scoped requests,
Sessions, and clickable activity. Reuse productId and Manager-connected records.
No catalog editor, raw transcript collector, liveness inference or new scheduler.
Real proof: this plan's catalog appears in an isolated installed Console; an edit
reloads without restart; a scoped real task report appears without implying acceptance.

## Batch 2: resolve blockers

Durable scoped decisions, explicit problem/cause basis/owner/next action/impact,
supported response controls, private Manager acknowledgement and uncertainty.
Reuse existing journals/relay/provider answer controls. No automatic wake or
translation of a message into provider, merge or deployment authority.
Prove one actual owner decision and interrupted response/ack recovery without
duplicate dispatch. Work activity must navigate to the relevant retained details.

## Batch 3: trust the whole picture

Qualified catalog/PR progress using existing lean accounting; bounded read-only
observation of explicitly linked PRs; compact cross-project Overview; detailed
Work/Jira with local filters/search; deterministic project daily summaries;
existing GM infrastructure/delivery distinctions; compatibility/security/recovery,
installed desktop/mobile browser proof, package and documentation.
Unknown counts remain unknown. Acceptance, review, merge, deployment and product
acceptance remain distinct. No Graft, new provider, automated publication or
Creator rollout.

## Cost and execution

Three fresh batch orchestrators, compact briefs, exclusive ownership, parallel
independent work only. Terra/high for bounded implementation; Luna/medium for
mechanical work; Sol only for evidenced complexity. Root integrates and independently
accepts. No native goal caps. Batch 1 advisory estimate 140k tokens (backend 65k,
UI 35k, integration/review/proof 30k, contingency 10k), low confidence; revise
honestly, do not stop at estimate. Batch 2/3 estimates are set from observed work
before admission. Existing goal telemetry is aggregate with unknown child overlap,
not an invoice. Routine observation and bookkeeping must be deterministic.

Use pinned Node 24.20.0/npm 12.0.2, focused behavior tests while editing, full
gate at final assembled candidate. Local listener/process tests need executor
permission; EPERM is not a product defect. Preserve rejected attempts. No push
or merge by specialists. No work outside assigned isolated checkout.

## Batch 1 shared contract

Backend owns `src/console/work-management.ts` and exports browser-safe types.
Console configuration: optional `workCatalog: { path: absolutePath }`.
Catalog: `{ format: 'faktori.work-catalog/v1', projects: [...] }`.
Nested project `{ productId, title, goal, artifactHome?, artifacts?, plans }`;
plan `{ id, order, title, goal, phases }`; phase
`{ id, order, title, goal, acceptance, tickets }`; ticket
`{ id, order, title, goal, dependencies, issueKey?, runIds?, loopIds? }`.
IDs and scope are explicit; project title comes from configured product when
available. Artifacts are `{ id, title, role, path }`, relative to server-only home.
No absolute roots in public state. Ticket dependency IDs are unique within project.

Artifact portability: content may be an explicit bounded owner-published snapshot
in the catalog, labeled as such with its optional source revision and snapshot
time. This is not a live repository read. Linux may use descriptor-anchored file
traversal where available; unsupported hosts fail closed for file reads and can
use the snapshot form. No unsafe check-then-open fallback or native dependency is
introduced. Agents refresh snapshots deliberately when publishing catalog changes.

Additive state field `workManagement`:
`{ status: 'available'|'stale'|'unavailable', revision?, observedAt?, error?, projects, sessions, requests }`.
Public projects preserve nested catalog without artifactHome, artifacts gain
`status` and optional `content`; sessions/requests reuse existing public-safe
Manager-connected types. No raw prompts/private relay credentials.
Initial invalid configured catalog fails before opening stores. Subsequent invalid
reload preserves last valid snapshot, marks stale, and emits actionable error.
One bounded poller/digest refresh, serialized updates, SSE notification; no LLM.
Enqueue optionally includes `catalogRevision`; catalog-enabled UI supplies it.
Require current revision and validate snapshotted assignment scope; replay keeps
original scope and reports do not become acceptance. Legacy no-catalog works.

UI owns console/src and UI-only tests. Backend owns src and backend tests.
Agree changes to this seam directly before proceeding; do not edit each other's files.
Keep industrial bento styling/4px spacing; human titles first, IDs secondary.

## Acceptance ledger

- [x] Batch 1 implemented, reviewed and installed proof accepted.
- [x] Batch 2 implemented, reviewed and real decision proof accepted.
- [x] Batch 3 assembled gate, installed journey and documentation accepted.

Manager maintains this ledger; agents return compact diffs, commands, evidence,
remaining concerns and usage gaps. No separate dashboards or progress services.

### Batch 1 observed evidence

- Fresh packed installation served an isolated Console. Its real Faktori catalog
  showed three ordered batches, eighteen tickets, and the accepted plan artifact.
- Deterministic live HTTP proof passed: valid catalog reload without restart,
  malformed update retaining a visibly stale last-good view, and restoration.
- Browser enqueue completed a real round trip through an explicitly assigned
  existing Codex task, private relay claim/submission, correlated task callback,
  and retained Console report. Activity navigation scrolled to that report.
  The UI said “Result Reported” and “product acceptance not evaluated.” This is
  transport evidence, not proof of fresh implementation orchestration.
- Independent review identified stale admission, path redaction, artifact read
  containment, and cross-project navigation defects. Acceptance remains pending
  their correction and verification; the original installed proof predates repairs.
- Backend reported 146,907 tokens plus 13,866 for an identifier correction.
  Other participants and parent-inclusive overlap are not fully measured. The
  original 140k aggregate estimate was exceeded; no total or savings is inferred.
- Repairs passed independent targeted review. The integrated focused gate passed
  29 tests across three files; typecheck and package build passed. The rebuilt,
  packed installation passed hot reload again and retained the real task report
  across restart. Browser reload verified snapshot labels and timestamps.
- Linux descriptor-based artifact reads have source review but no independent
  Linux runtime proof in this batch. macOS snapshot behavior was exercised.
- Snapshot/security remediation reported another 64,379 backend tokens; a final
  no-change check reported 10,151. These remain participant observations, not a
  double-counted aggregate. Batch 2 advisory estimate: 200k specialist tokens plus
  explicitly unmeasured root coordination, low confidence. Use compact briefs,
  two exclusive workstreams, one review, and a single installed proof.

### Batch 2 evidence (accepted; earlier attempts retained below)

- Parallel backend/UI implementation provides durable scoped choice decisions,
  separate private acknowledgement/resolution, a Decisions page, compact Overview
  queue, and navigation from activity to retained decisions.
- Independent review found and verified fixes for an unusable response control
  on uncertain decisions and overbroad redaction of ordinary authority prose.
- Integrated focused checks passed: 46 tests across six files. Typecheck and
  production build passed. The isolated installed Console displays a real
  presentation-preference decision awaiting the owner's response.
- Required remaining gate: observe the owner's actual UI response, restart the
  isolated Console before Manager acknowledgement, confirm one retained response,
  acknowledge and resolve truthfully, and verify the resulting UI.
- Reported specialist usage: backend 131,499 plus 5,802 remediation; UI 172,634
  plus 4,124 remediation. Review/root telemetry remains incomplete. These reported
  participant measurements exceed the 200k estimate and do not establish savings.
  Explicit launch routing was Terra/high for both workers and review; model
  self-descriptions are not a substitute for launch records.
- Subsequent completeness check found missing concrete destinations for the
  non-response decision actions. Repairs are in progress to link existing scoped
  run/task controls and observed external records, not create new authority.
- Assembled check initially failed five legacy loop tests at the default 5s
  harness timeout. The documented four-worker rerun passed 495/498, with three
  remaining timeout failures. These attempts are retained; the full gate is not
  passed. Assertions and runtime execution limits have not been weakened.
- The same fifteen loop journeys passed with a 15s harness allowance. Test
  defaults now match the documented four-worker bound and allow 15s for tests,
  without changing assertions or product execution limits. Final assembled
  `npm run check` passed: 499 tests/66 files, typecheck, production build, and
  clean-package CLI verification under Node 24.20.0.
- Concrete action destinations now navigate to observed scoped run requests,
  configured task composers, or observed Jira records; navigation does not execute
  those actions. Resolved decision links expand retained history before scrolling.
- The updated isolated installation retains the open real preference decision
  and displays its full impact text. Owner response remains pending; no response
  or acknowledgement has been fabricated. Batch 3 is not admitted yet.
- Final targeted review tightened session destinations to exact plan/phase/ticket
  scope, rejecting product-only assignments that the composer cannot use. Six
  focused work-management tests and typecheck passed after that correction; the
  499-test assembled gate above predates only this targeted correction and docs.
- Owner chose “Collapsed by default” in the installed UI at
  2026-09-10T05:39:47.507Z. After restarting only the isolated proof Console,
  the same single decision retained that response at pending_manager_ack/revision 3.
  Private acknowledgement advanced to revision 4, resolution to revision 5.
  Browser verification showed zero pending items and one collapsed history item.
  No provider/task dispatch or operational permission was created. Batch 2 accepted.

### Batch 3 admission

Qualified progress and page ownership remain the final batch. Advisory specialist
estimate 250k (backend 110k, UI 90k, review/rework 50k), low confidence, with root
coordination separately unmeasured. Reduce overhead by reusing existing metrics,
one shared typed projection, deterministic summaries, and a single final installed
journey. No native goal cap. Prior estimates were exceeded, not treated as stops.

Linux artifact smoke proof passed in the existing Node 24.20.0 image, with network
disabled, a read-only root filesystem, dropped capabilities, and a bounded tmpfs.
The actual reader returned a regular file, rejected final/intermediate symlinks,
and did not expose the outside sentinel. This is static path-boundary runtime
evidence, not a claim of exhaustive race testing. Host bind mounts were unavailable;
only the explicit reader/test sources were streamed to the disposable container.

### Batch 3 verification in progress

- Live, read-only observation of this repository's merged PR 7 returned a real
  merge observation. Review remained unknown; merge was not promoted to deployment
  or product acceptance. No remote write was performed.
- The first assembled gate passed 503/504 tests; an old Overview test still
  expected expanded activity rows. Its expectation was updated to the accepted
  compact Overview behavior, and focused UI checks passed.
- Independent review found unbounded PR process fan-out, stale ticket associations
  during hot reload, and ambiguous owner-published evidence labels. Repairs add
  four concurrent reads, real process deadlines, unchanged/failure backoff,
  coalesced refresh, current-scope projection, and explicit evidence provenance.
- Review also found daily summaries tied to the last catalog update rather than
  the current local day, plus incomplete retained-event coverage. These are being
  corrected before the final installed acceptance. Batch 3 is not yet accepted.

Final verification evidence (before the final link-contrast-only adjustment):

- Independent targeted source review found no remaining high-confidence blocker.
  Follow-up integration fixes preserve backoff during identical catalog reloads
  and prevent timestamp-only SSE churn while notifying once on local-day rollover.
- Frozen assembled `npm run check` passed: 513 tests in 67 files, typecheck,
  production build, and clean-package CLI verification under Node 24.20.0.
  Earlier failing runs remain recorded above; they were not acceptance evidence.
- The updated isolated package retained the real resolved owner decision, twelve
  explicitly accepted catalog tickets and six in-progress tickets. Catalog totals
  did not become deployment evidence. Configured session liveness remained unknown.
- Installed hot reload passed again: valid edit, malformed edit retaining a stale
  last-good view, and exact restoration without restarting the Console.
- Real-browser checks at 390x844 and 1440x1000 showed no document horizontal
  overflow. Projects displayed the owner-local day and unavailable PR history;
  Overview contained only compact rollups and decisions. Work retained its detailed
  surfaces; Sessions and Factory showed unknown liveness and GM-not-configured
  honestly. A fresh navigation after installation was necessary to load the new
  asset bundle rather than merely changing the old page's hash. No browser errors
  were observed after that fresh load and subsequent navigation.
- Explicit limits: PR-change history and independent exact-head review aggregate
  coverage remain unavailable, not fabricated. This proof does not establish live
  Jira synchronization, product deployment, or new provider execution.
- Construction accounting remains incomplete: the native Manager goal stayed
  blocked after the owner wait, with its last recorded 2,421,263-token value
  unchanged. Continued work and child overlap are not fully captured; no aggregate
  budget variance or token-savings claim can be made. Estimates remained advisory.

Manager acceptance: Batch 3 is accepted locally. The final contrast-only link
adjustment passed 33 focused UI checks and typecheck, followed by a fresh build,
package install and in-app screenshot verification. No runtime behavior changed
after the 513-test gate. The isolated Console is the installed proof surface;
the active product Console and Creator installation were not upgraded. These
Console batches are local commits, not a GitHub publication or deployment claim.
