# Frozen comparison fixtures

These cases measure implementation against stable behavior contracts, not
provider intelligence or product quality. Each case has independent tests and
the same model availability, human-attention, network, and paid-service
envelope. Run candidates in a clean copy; record model, elapsed agent time,
human time, test command, and observed result. Do not infer scores from token
percentages. Triforge runs require an isolated, frozen-input Phase 7 resource;
active operations are never a substitute, and unsupported benchmark claims are
never published.

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

Phase 7 received no isolated incumbent Triforge resource and did not touch the
active system. Its comparison report therefore keeps every incumbent result
unknown and publishes no unsupported winner or benchmark claim. A future paired
run must use these fixtures under the equal, predeclared rubric and evidence
envelope, remain isolated from active operations, and report unknowns as
unknowns.

The target Faktori host paths are macOS and Linux with Node 24 and npm 12.
Compatibility is claimed per host only after an independent observed run. WSL2
remains unverified until evidence exists; documentation is not a compatibility
claim.

Assess functional correctness first. For a passing or blocked case, record actual and unknown token telemetry, separately documented cost when one exists, elapsed execution, infrastructure preparation, human waiting separately from human intervention, rework, failed handoffs, maintainability, and visibility into evidence. Do not collapse these dimensions into an opaque score; one run is a case study, not a benchmark claim. Paired systems receive identical frozen per-case inputs, model availability, financial envelope, and human-attention allowance.
