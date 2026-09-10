# Lean iteration proof records

These are disposable local task-list cases, not product deployment or general performance claims. The independent verifier lives outside the candidate workspace. No PR, deployment, API billing route, or Creator mutation is authorized by these tests.

## Frozen contract

Seed: `fixtures/lean/task-list.mjs`. Verifier: `fixtures/lean/verify.mjs`.
The existing candidate must add uniquely identified, incomplete tasks with trimmed titles, reject invalid titles, and preserve its input. The small implementation must add immutable task completion, unknown-ID rejection and idempotent completion while preserving existing behavior. The existing contract passed before any inference; the implementation contract failed because `completeTask` was absent.

## Phase 1: four-stage existing-candidate baseline

Observed 2026-09-10 UTC using Codex CLI 0.146.0, GPT-5.6-Luna, medium reasoning, existing ChatGPT subscription, bounded native execution, pinned Node 24.20.0 verification. The candidate remained unchanged and the workspace clean. Every stage retained digest `sha256:a5a34e97542132aaeb76336d1b47260898658ae5a4d0839af4125025ad600ed8`.

| Stage | Input | Cached input (subset) | Output | Result |
| --- | ---: | ---: | ---: | --- |
| Manager brief | 15,140 | 0 | 86 | Ready |
| Implement | 96,356 | 44,288 | 1,826 | Completed; unchanged candidate |
| Independent review | 47,200 | 15,104 | 880 | Pass |
| Manager accept | 15,381 | 0 | 107 | Accepted |
| Total | 174,077 | 59,392 | 2,899 | 4 provider invocations |

Total reported tokens: **176,976**, including **114,685 uncached input**. Reasoning subset unavailable. No dollar conversion is made. The interval from first-stage completion to final acceptance was 80.905 seconds; this is not full execution wall time (launch timestamps remain in private operational records).

The already-running isolated Console accepted hot registration with HTTP 200 / `created: true`; repeating the identical request returned HTTP 200 / `created: false`. It automatically projected the brief, running implementation, all four terminal receipts, and the same usage totals without a restart. At terminal state it reported 4/4 sessions with usable usage. This validates live observation, not worker liveness or product acceptance.

A controlled restart of only that isolated observer recovered the single persisted registration from a configuration with an empty static `managerLoops` list. It again reported four stages and 176,976 tokens, without re-registering or rerunning the candidate.

Early live projection revealed missing active-session coverage and missing unfinished-work attribution. Both were repaired and covered by the final focused tests before Phase 1 acceptance.

Phase 1 accepted: Manager's independent run passed 39 focused tests; final streamed-observer/registry run passed 12 tests in 2.07 seconds under the 15-second test bound. Typecheck, build and packed-CLI verification passed. The broader pre-final-repair suite passed 455 tests; a final assembled regression run remains required. Subagent goal/usage telemetry was unavailable, so no aggregate construction-token attribution is claimed.

## Phase 2 first live attempt (retained failure)

The first installed-package validation-only attempt launched one Luna/medium
reviewer and no implementation or AI Manager. The reviewer returned `pass` but
the wrong evidence digest; Faktori rejected it with
`work:review_evidence_mismatch`. The candidate remained clean and unchanged.
Observed wall time: 30.420 seconds. Reported usage: 63,482 input, including
45,312 cached input; 756 output; 64,238 total. This attempt is failed work, not
accepted throughput, and remains part of the validation case's expenditure.
The follow-up changes the digest instruction, not the acceptance comparison.

The second attempt copied the correct candidate digest but returned positive
observations in `findings` with a `pass` verdict. The strict contract reserves
findings for defects and rejected the response. Usage: 47,093 input, including
30,208 cached; 661 output; 47,754 total. Wall time: 24.339 seconds. This failed
attempt is retained too. The follow-up explicitly requests empty findings on a
pass and moves positive observations to the summary; it does not relax parsing.

## Phase 2 validation-only acceptance

The corrected installed package accepted the same unchanged candidate with one
Luna/medium independent review and one explicitly deterministic acceptance
receipt. No implementer, AI briefing or AI acceptance launched. Wall time:
29.375 seconds. Reported usage: 63,221 input (58,368 cached), 672 output;
63,893 total. Reasoning subset unavailable.

Including both failed attempts, this validation case consumed **175,885 tokens**
over three reviewer calls and 84.134 seconds of execution wall time. The
four-call baseline consumed 176,976 tokens. This is effectively parity for the
initial trial, not evidence of substantial savings. The successful path alone
is smaller, but excluding its preceding failures would misrepresent iteration
cost. Prompt-contract repairs required Build Manager intervention. None of
these receipts establishes publication, deployment or product acceptance.

## Remaining gates

- Small implementation passed from the installed package in 54.307 seconds:
  one Luna/medium builder (62,804 input; 29,184 cached; 930 output), one
  independent Luna/medium reviewer (55,222 input; 34,304 cached; 768 output),
  then deterministic acceptance. Total 119,724 tokens; 63,488 cached input;
  54,538 uncached input; 1,698 output. No repairs or human intervention during
  this run. The Manager independently reran the external verifier successfully;
  only seven lines in the disposable candidate changed. There is no equivalent
  implementation baseline, so no comparative savings claim.
- Nightly GM: one useful evidence-linked response, unchanged-input skip, durable daily ownership and visible failed/disabled states.
- Assembled regression/package checks, opt-in documentation, and qualified comparison.

Phase 2's live execution gates passed. GM supervision and complete rollout
remain unaccepted; no general efficiency improvement is claimed.
