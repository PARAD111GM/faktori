# Phase 5 implementation report

Status: complete implementation candidate `ab67dc2`; the exact review head is
the records-only commit containing this report and is supplied in the Build
Manager handoff. Base was accepted Phase 4 revision `7d3988f`. This phase made
no remote publication, merge, live issue-tracker call, production deployment,
credential export, usage reset, paid-route switch, or product-repository
mutation.

## Delivered tickets

- **F5-01:** the built React/Vite Console exposes Overview, Work, Run detail,
  and Factory views from the redacted coordinator API. One shared product/pod
  filter applies across views. The Work view renders the configured factory,
  product, pod, and work-item hierarchy plus explicit dependency edges; it does
  not infer relationships. SSE follows the append-only journal, including
  provider and GM events, and disconnected state is disclosed as stale.
- **F5-02:** owner commands require the per-start token and an exact loopback
  origin, enter one serialized durable command path, and replay the latest
  receipt for the same command ID and payload. Conflicting ID reuse fails
  closed. Starting work returns after durable admission while provider delivery
  continues, leaving next-turn messaging and cancellation available. The
  installed runtime constructs the shipped native Codex, Claude, and Cursor
  transports plus the hardened isolated Codex Docker path. Resume uses only an
  explicitly configured target and the exact durable source session/scope.
  Native and container cancellation revoke authority and persist termination
  intent before signaling. Cursor question, permission, and plan requests are
  durably projected and answered exactly once without journaling the answer.
- **F5-03:** the Factory GM remains event-driven. Its observer derives bounded
  facts from durable provider-final events; the second failure for the same
  product/work-item/provider route opens one repeated-handoff finding, and
  exact source-event IDs make restart replay idempotent. A new finding invokes
  the normal admitted provider-delivery path using an owner-approved diagnosis
  intent template with controller-derived run, admission, reservation, context,
  and approved-input digests. Privileged product, merge, release, and policy
  recommendations remain rejected; improvement work remains proposed and
  approval-required.
- **F5-04:** the Factory view keeps reported usage, held reservations,
  unavailable measurements, queue age, waiting decisions, GM findings,
  owner-once attention, and the improvement backlog distinct. It never converts
  estimates or missing telemetry into measured use or cost. Merge-wait signals
  retain the existing one-alert behavior and do not change human merge
  authority.

## Observed verification

- Build Manager independent pinned `npm run check`: strict typecheck, 35 test
  files / 289 tests, Console Vite build, TypeScript package build, and packed
  CLI verification all passed in session `32717` under Node 24.20.0/npm 12.0.2.
- Focused Phase 5 runtime gate: 4 files / 28 tests passed, covering Console
  service and provider requests, installed provider selection, isolated Codex
  construction, non-blocking start, durable cancellation, exact-session resume,
  SSE journal observation, command conflict/replay, and automatic dynamic GM
  diagnosis.
- Local browser proof at the fixed loopback fixture exercised the Overview,
  Work, Run detail, and Factory surfaces. It observed both products in the
  shared filter, reduced the hierarchy to the selected Console product, showed
  `Browser verification depends on Installed provider runtime`, displayed and
  submitted the provider permission response, observed the pending request
  disappear over live state, kept zero reported tokens separate from ten held
  tokens, and toggled admission from Pause to Resume. Browser diagnostic logs
  were empty.
- `git diff --check` and JSON parsing passed before the implementation commit.
  The construction checklist, model routing, phase usage summary, and dashboard
  were regenerated from canonical records.

## Routing and construction accounting

The Console UI and Factory GM specialists began on Terra medium. The initial
cross-layer candidate used Terra high, but exact-head review showed material
installed-runtime, cancellation, replay, hierarchy, provider-request, and GM
execution gaps. The phase implementer was therefore escalated to Sol high for
the bounded remediation recorded in `construction/model-routing.json`.

At the final evidence checkpoint, goal-local telemetry reported 1,107,792
tokens against the advisory 800,000-token planning estimate: 138.47% of the
estimate, a 307,792-token / 38.47% overrun. This was not a hard stop. The
summary treats the root measurement as an overlap-safe lower bound because
parent/child overlap is unknown; the GM specialist separately reported 50,282
tokens and Console UI specialist telemetry remained unavailable, so neither is
double-counted. Account capacity was observed separately at 90% used / 10%
remaining, with no paid credits and two reset credits left unused.

## Remaining authority gate

Build Manager acceptance of the exact records commit is required before Phase
6 and before closing the uncapped Phase 5 goal. Phase 6 recovery and service
protection work is not implied by this candidate, and no Console action gains
merge or production-release authority.
