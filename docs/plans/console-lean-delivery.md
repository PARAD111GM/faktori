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
- [ ] Batch 2 implemented, reviewed and real decision proof accepted.
- [ ] Batch 3 assembled gate, installed journey and documentation accepted.

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

### Batch 2 candidate (owner proof pending)

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
