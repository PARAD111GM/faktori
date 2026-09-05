# Frozen comparison fixtures

These cases measure implementation against stable behavior contracts, not
provider intelligence or product quality. Each case has independent tests and
the same model availability, human-attention, network, and paid-service
envelope. Run candidates in a clean copy; record model, elapsed agent time,
human time, test command, and observed result. Do not infer scores from token
percentages, and do not run Triforge or publish benchmark claims.

| Fixture | Frozen input | Acceptance |
| --- | --- | --- |
| [task board](../../fixtures/task-board/) | intentionally-red starter plus Playwright contract | CRUD/edit/cancel, complete/uncomplete, delete, filters, keyboard, persistence |
| [due dates](../../fixtures/due-dates/) | `starter.json` plus working base board | base contract green; dates, strict overdue boundary, reload/restart red until feature work |
| [Python boundary](../../fixtures/python-date-boundary/) | source and regression tests | yesterday/today/tomorrow/missing-date behavior |

Baseline reference: branch `build/phase-0` at the phase-freeze commit. The
repository-level [SHA256SUMS](../../fixtures/SHA256SUMS) pins every fixture
input and test; verify it with [`fixtures/verify-fixtures.mjs`](../../fixtures/verify-fixtures.mjs).
Browser suites have a 20-second bound; verification distinguishes a required
feature assertion from a runtime, spawn, syntax, or timeout failure. Any change
requires a new fixture version and a new explicit comparison run.

Phase 6 does not run an active or incumbent Triforge system and does not publish
unsupported comparison claims. After Phase 6 acceptance, Phase 7 may run the
paired comparison against these frozen fixtures under the equal, predeclared
rubric and evidence envelope. That future run must be isolated from active
operations and report unknowns as unknowns.

The supported Faktori host path currently covers macOS and Linux with Node 24
and npm 12. WSL2 remains unverified until Phase 7 evidence exists; it is not a
comparison or compatibility claim in this phase.

Assess functional correctness first. For a passing or blocked case, record actual and unknown token telemetry, separately documented cost when one exists, elapsed execution, infrastructure preparation, human waiting separately from human intervention, rework, failed handoffs, maintainability, and visibility into evidence. Do not collapse these dimensions into an opaque score; one run is a case study, not a benchmark claim. Paired systems receive identical frozen per-case inputs, model availability, financial envelope, and human-attention allowance.
