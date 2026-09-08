# Phase 7 comparison report

Evidence updated: 2026-09-07. Rubric and fixture bytes remain those frozen in
Phase 0 and pinned by `fixtures/SHA256SUMS`. A specifically approved isolated
Triforge run now supplies the previously unknown comparison cells; the older
pre-run boundary is retained below as historical evidence.

## Current paired result

Under the same frozen contracts, model family, financial envelope, and trusted
credential-free verification environment, the accepted Faktori candidates
passed task-board, due-dates, and Python. The one-shot Triforge candidates
passed Python, but task-board failed delete-after-restart and due-dates failed
the strict today boundary after its base contract passed.

| Dimension | Faktori observation | Triforge observation | Interpretation |
| --- | --- | --- | --- |
| Functional correctness | 3/3 cases passed | 1/3 cases passed | One bounded case study, not a general benchmark |
| Model/provider | Codex `gpt-5.5` | Codex `gpt-5.5` | Same provider/model selection |
| Reported tokens | Separate input/cached/output fields; task-board included broader cold-start work | 144,450 aggregate CLI-reported total across three lanes | Schemas and task scope differ; no efficiency percentage is valid |
| Provider elapsed | Due dates plus Python about 365 s; task-board exact elapsed unknown | 662 s across three lane-to-bundle intervals | Incomplete paired timing, so no aggregate speed claim |
| Direct incremental cost | unknown; existing subscription | unknown; existing subscription | No paid-route change or invoice evidence |
| Functional rework | Earlier retained factory/runtime repairs; final candidates passed | No candidate revision; two failures retained | Failures were not edited away |
| Infrastructure intervention | Prior isolated-runtime and verifier preparation | Missing `jq` caused one exit-127 handoff; local image and metadata repair | Separate from product correctness |
| Maintainability | Passing committed products; due-date and Python changes stayed within stated source scope | Due dates added a prohibited extra test; task-board concentrated a large change in one file | Scope adherence favors the Faktori outputs in this run |
| Evidence visibility | Durable Faktori events with split usage plus frozen checks | SHA-bound packets/diffs/bundles and job logs; task metadata repair explicit | Both expose useful evidence with different telemetry depth |

Exact commits, timings, hashes, interventions, and frozen-test output are in
`docs/build/evidence/phase-7-f704-paired-comparison-2026-09-07.md`.

The comparison evidence is complete, but F7-04 release acceptance remains
blocked because F7-03 is owner-deferred and unmet. No generalized winner or V1
release claim is published.

## Historical result boundary — 2026-09-05

There is not yet a valid paired Faktori-versus-Triforge comparison. No isolated
Triforge comparison resource or incumbent run was supplied, and active
Triforge/Twinzy operation was explicitly excluded. The report therefore keeps
the incumbent cells `unknown`; it does not substitute historical anecdotes,
repository implementation tests, or an active delivery run.

| Dimension | Faktori task-board evidence | Triforge task board | Evidence limit |
| --- | --- | --- | --- |
| Functional correctness | Attempt 2 passed with genuine Playwright reached through an invalid external symlink; Attempt 3's substituted harness reported pass, but trusted frozen rerun failed delete-after-restart (`1 !== 0`) | unknown | No compliant Faktori pass exists |
| Model/provider | Codex, `gpt-5.5` | unknown | Not an all-provider conformance result |
| Reported tokens | Attempt 2: 495,378 aggregate; Attempt 3: 646,489 aggregate | unknown | Provider telemetry is partially reported; cached-input overlap is not double-counted |
| Direct incremental cost | unknown; existing subscription used | unknown | No invoice or paid-route measurement |
| Provider elapsed time | Attempt 2 about 5 min 5 s; Attempt 3 exact elapsed unavailable | unknown | Infrastructure preparation and waiting are separate |
| Human intervention | Build-team diagnosis, runtime repairs, and one bounded rerun required | unknown | Therefore the original F7-01 acceptance was not met |
| Rework / failed handoffs | Empty-product attempt; ambient/external-link attempt; dependency-stub attempt; stale-owner repair | unknown | Preserved rather than scored away |
| Maintainability | Attempt 2 externally linked; Attempt 3 uncommitted with a hand-written dependency compatibility package | unknown | Both invalid for portable release; Attempt 3 also failed trusted behavior |
| Visibility | Approval/digests and 82/97-event journals exposed each outcome and constraint gap | unknown | Visibility exposed the violations; it did not authorize them |

The task-board result is a case study, not a benchmark claim. The due-date
feature and Python boundary cases have only verified frozen starting-state
results on macOS; no Faktori candidate or paired Triforge candidate exists for
either case. Functional correctness must precede comparative efficiency, so no
opaque score or winner is published.

## Construction-wide planning observation

The original Phase 7 estimate was 600,000 tokens. The first cold start exposed
missing product import and public work-item assembly, then the functional run
exposed ambient-context, external-dependency, and crash-recovery defects. The
estimate was revised first to 850,000 and then to 1,300,000 after the bounded
rerun remained invalid and the original executable product-add path was found
missing. These revisions are planning data, not hard stops or weakened
acceptance thresholds. Root telemetry and specialist attribution remain
lower-bound/unknown until the final construction record is generated.

## Requirements recorded before the reproducible pair

1. Finish one compliant Faktori task-board run and retain all invalid attempts.
2. Supply an isolated Triforge resource that can receive the identical frozen
   input, provider/model availability, financial envelope, and human-attention
   allowance without touching active operations.
3. Run due-date and Python candidates under the same paired conditions.
4. Record functional correctness first, then tokens, cost, elapsed execution,
   infrastructure preparation, human waiting/intervention, rework, failed
   handoffs, maintainability, and evidence visibility as separate dimensions.

## 2026-09-06 continuation

The trusted local fixture harness prerequisite is now reproducible through the
committed Node 24/Chromium envelope at `7797200`, and an independent Build
Manager run observed every frozen expected RED/base GREEN outcome. That is
harness evidence, not a candidate product result.

A read-only Triforge resource audit confirmed the documented isolated
untrusted-runner / trusted-publisher boundary but found no specifically approved
provider-authenticated read-only mirror and result-bundle path for this pair.
No active configuration or runner was used. The incumbent cells therefore
remain `unknown`, and F7-04 remains blocked. See
`docs/build/evidence/phase-7-comparison-resource-audit-2026-09-06.md`.

## 2026-09-07 approved continuation

The owner authorized the exact Triforge revision, three disposable frozen
mirrors, bridge-network provider access through only the selected read-only auth
file, and local result bundles with no publisher or active-system mutation. All
three bundles were reconstructed and independently verified without credentials
or network. The task-board and due-date Triforge candidates failed distinct
frozen assertions; Python passed. Their result cells are measured rather than
unknown, while cost, Faktori task-board elapsed time, and human waiting time
remain explicitly unknown.
