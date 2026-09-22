# Subscription-efficient delivery proof ledger

Status: source implementation and an isolated local browser drill are recorded
below; no installed-provider or live-product proof is claimed.
Do not infer a result from a source diff, green unit test, preview URL, provider
login, tracker row, PR, deployment receipt or model usage total.

## Required evidence

| Gate | Required observation | Current result |
| --- | --- | --- |
| Source | Routing, queue, Console facade, preview, packaging and release checks | Passed on `5cbc29d`: `npm run check`, 692 tests / 97 files, runtime + Console typecheck/build, clean packed-CLI install |
| Local browser | Registered loopback preview, revision check and two persisted feedback items, desktop and mobile | Passed; see [browser drill](subscription-efficient-delivery-browser.md); provider-free, no product edits or human acceptance implied |
| Local attended | One Faktori-only configured work item: durable intent, observed worker/transport receipt, restart reconciliation, candidate evidence | Pending |
| Automatic eligibility | Current transport, native goal, idle wake-up/supervision and witnessed-delivery bindings; duplicate/stale fault drills | Pending |
| Independent source review | Read-only delivery and security review of the frozen implementation | Passed for source `c81d814`; four blocking findings repaired and delta-reviewed; subsequent preview shutdown repair reviewed at `0f8d678` |
| Human candidate review | Actual human feedback and acceptance bound to the final candidate revision | Pending |
| Merge | Authorized human merge of that reviewed head | Pending |
| Deploy | Matching environment deployment receipt | Pending |
| Acceptance | Human/staging result bound to the deployed revision | Pending |
| Efficiency | Frozen comparable cohort, complete/labeled coverage and attributable lifecycle accounting | Unavailable until completed features exist |

## Verification commands

Final local release check: 2026-09-22, Node 24.20.0 / npm 12.0.2, source
`5cbc29d` (application source identical to independently reviewed `c81d814`).
All 692 tests passed across 97 files in 262.01 seconds with two workers.
`pack:verify` installed and verified `faktori-0.2.4.tgz` from a clean temporary
installation. All 16 packaged skills and generated provider entry maps verified.
Earlier failing runs exposed four review defects and short fixture startup
deadlines; they are not counted as passing evidence. Deliberate timeout, wrong
identity, stale/future readiness, duplicate/restart and cleanup assertions remain.
GitHub CI and installed-provider acceptance are separate observations.

The first Linux CI run found an exit-callback race in preview cleanup (689
passed, three failures). The repair keeps a stable identity through shutdown,
serializes stops, and requires leader plus group absence before clearing it.
Independent boundary review passed this delta at `0f8d678`; local preview/facade
checks passed 10/10 and the full browser drill passed again including Stop.
The next Linux run passed all preview cases and 692 of 693 tests, but exposed a
Slack fixture's nondeterministic assumption about which competing lock claimant
wins. That fixture now synchronizes on actual transport entry and drains pending
sends before cleanup. A fresh full Linux check is required on the final PR head;
its exact-head receipt belongs with the PR. Earlier failures are retained as
evidence rather than described as passes.

Run on the candidate head under the pinned Node 24/npm 12 toolchain:

```sh
npm run typecheck
npx vitest run tests/runtime/routing.test.mjs tests/workflow/role-queue-controller.test.mjs tests/console/workflow-runtime.test.mjs tests/preview/persistent-preview.test.mjs tests/preview/preview-runtime.test.mjs
npm run check
```

For the attended proof, record the exact owner-controlled Console configuration,
private source/readiness revisions, runtime work-item ID, journal path, local
preview registration, command outputs and observed result. Do not put provider
tokens, prompts, workspace paths or session credentials in this file.

Capture the Console mode plus `automaticReady` and `capabilityBlockers`; an
attended result is not proof of automatic wake-up readiness.

The authenticated Console endpoint and configured runtime bridge are wired.
Independent review of implementation revision `98c75d9` identified preview
launch uncertainty, mixed reservation units, non-expiring readiness and missing
terminal reservation receipts. All four were repaired; the delivery and
security reviewers bound their passing source/delta reviews to `c81d814`.
The subsequent preview shutdown source delta has its own independent security
review at `0f8d678`. Later proof documentation and Slack fixture synchronization
changes do not alter that reviewed application source.
The first operational gate remains **one owner-configured, attended Faktori-only
transport/restart witness**. Native-goal activation and idle-Foreman wake-up must
be observed before automatic admission; the shipped CLI does not fabricate
those capabilities. Authorized merge, deployment and acceptance follow their
own gates.

## Fault drills

Use deterministic inputs only: duplicate queue evaluation, duplicate/out-of-
order/stale callback, incomplete launch intent across restart, missing authority
candidate, stale capacity, revoked/absent readiness, changed candidate revision
and preview cleanup uncertainty. Each must leave records intact, launch no
duplicate worker and identify the owner/next action.

## Measurement note

This implementation run does not have complete model-invocation, token-category
or human-time telemetry. Those measurements remain unavailable rather than
estimated. Test-run durations and a provider-free UI drill are not shipped-feature
cost measurements; no baseline improvement or subscription savings is claimed.

Do not claim savings in advance. For a completed frozen-scope feature, report
provider/model route, lifecycle input/cached-input/output/reasoning counters
where supplied, account-pool observation freshness, unknown/unattributed usage,
queue wait, repair/reopen outcome, human time if observed and comparable cohort
coverage. A partial collection is a labeled lower bound, not an efficiency
claim. Never add overlapping PR, failed-attempt and accepted-feature totals.
