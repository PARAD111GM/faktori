# Phase 6 implementation report

Status: complete implementation commit `b1816eb`; the exact review head is the
records-only commit containing this report and is supplied in the Build Manager
handoff. Base was accepted Phase 5 revision
`00ca7009ac01d6ec5a89b7b61d8bdf0a3c8a2e5d`. This phase made no remote
publication, merge, live issue-tracker call, production deployment, credential
export, usage reset, paid-route switch, or product-repository mutation.

## Delivered tickets

- **F6-01:** local Console startup now recovers the durable coordinator before
  it listens. Restore rebuilds the disposable projection from the append-only
  journal, marks interrupted or uncertain work with explicit recovery
  requirements, and blocks new admission until every requirement has an
  evidence-bearing `retry`, `failed`, `succeeded`, or `blocked` disposition.
  Resolution is append-only and projected on restart; historical journal bytes
  are not rewritten.
- **F6-02:** the local command boundary retains exact loopback-origin and
  per-start token checks, conflict-safe command replay, and caller-independent
  admission authority. Static files now reject traversal, encoded traversal,
  malformed URLs, unsupported methods, and symlink escapes after canonical
  path resolution. Public state exposes recovery needs without credential or
  private-path material.
- **F6-03:** offline backup takes the coordinator lock, rejects incomplete or
  duplicate journal records, reserves a new backup directory without
  overwriting, copies only declared portable material, excludes projections,
  locks, and explicit credential paths, scrubs documented credential-shaped
  configuration keys, and emits a content manifest with per-file digests.
  Restore validates the entire manifest before reserving a distinct target,
  verifies expected factory and source identity, explicitly rebinds owner
  configuration paths, and leaves incomplete work visible. Managed updates
  compare immutable kits and supported state formats, bind approval to a
  preview recomputed under the update lock, preserve all owner paths outside
  release control, reject rollback/prerelease/same-version replacement, and
  atomically move the active manifest only after a clean installed release
  executes.
- **F6-04:** the public package includes maintenance APIs and CLI commands,
  operator, compatibility, troubleshooting, and customization guidance, frozen
  comparison checksums and verifier references, and portable request examples.
  The packed smoke installs the tarball into a clean consumer, creates and
  restores a scrubbed backup, initializes a managed release, and runs the
  manifest-selected installed CLI against real SQLite.

## Native dependency and activation boundary

All package installation lifecycle scripts remain disabled. A candidate must
pin `better-sqlite3` exactly to version `13.0.3`; the managed release then runs
only that dependency's explicit offline rebuild. Before either initialization
or update activation, the selected installed CLI must complete a real
`runtime rebuild` into a temporary SQLite projection. Failure leaves the new
content-addressed release unreferenced and does not move the active manifest.

This closes a manager-review finding in the first assembled update proof, which
had executed only `--help` and therefore did not prove the native binding could
load. Other manager findings closed in this candidate are the preview/apply
mutation race, clean independent release construction, final-version ordering,
restore path rebinding with actual Console startup, broader credential-key
scrubbing, transient lock exclusion, and the Phase 6/Phase 7 comparison-status
boundary.

## Observed verification

- Implementer pinned full gate: `npm exec --offline
  --package=node@24.20.0 --package=npm@12.0.2 -- npm run check` passed with
  strict typecheck, 38 test files / 298 tests, Console Vite build, TypeScript
  package build, and packed CLI verification under Node 24.20.0/npm 12.0.2.
- The packed verifier installed the tarball without general lifecycle scripts,
  imported public runtime and maintenance exports, rebuilt the pinned native
  dependency only, rebuilt SQLite projections through both the clean consumer
  and managed selected entrypoint, and completed installed backup/restore and
  initialization journeys.
- Build Manager independent corrected update gate passed 2/2 tests in session
  `96852` under the same pinned toolchain and explicit native-build allowance.
  The earlier manager maintenance gate passed 2 files / 7 tests in session
  `95156`; the corrected update run supersedes its help-only activation proof.
- An initial assembled gate retained useful evidence—37 files / 297 tests were
  green—but stopped on the construction-record assertion because the summary
  still identified Phase 5 after the checklist advanced to Phase 6. Regenerating
  the canonical Phase 6 usage summary and dashboard corrected that records-only
  ordering error before the passing full gate.
- JSON parsing and `git diff --check` passed before the implementation commit.
  Construction records were regenerated from the ignored raw usage snapshots.

## Routing and construction accounting

The phase implementer owned shared recovery, maintenance, installation, and
record paths on Sol high. One Terra-medium specialist owned only recovery and
security tests; one Luna-medium specialist owned only public documentation,
examples, and package verification. Their counters were unavailable and
parent/child overlap is unknown, so they are not added to the root measurement.
The material review-driven contract changes are retained in
`construction/model-routing.json`.

At the final pre-report checkpoint, goal-local telemetry reported 645,987
tokens against the advisory 700,000-token planning estimate: 92.28%, leaving
54,013 estimated tokens. This is an overlap-safe lower bound, not a measured
multi-agent aggregate, invoice, native cap, or completion criterion. Account
capacity was observed separately at 92% used / 8% remaining, with no paid
credits and two reset credits left unused.

## Remaining authority gate

Build Manager exact-head acceptance is required before Phase 7 and before
closing the uncapped Phase 6 goal. Phase 7 cold-start onboarding, independent
macOS/Linux host evidence, and the isolated paired comparison under the frozen
rubric are not implied by this candidate.
