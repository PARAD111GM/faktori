# Subscription-efficient delivery proof ledger

Status: no installed/runtime or live-product proof recorded by this document.
Do not infer a result from a source diff, green unit test, preview URL, provider
login, tracker row, PR, deployment receipt or model usage total.

## Required evidence

| Gate | Required observation | Current result |
| --- | --- | --- |
| Source | Targeted routing, queue, Console facade and preview tests; `npm run check` on the candidate head | Pending root run |
| Local attended | One Faktori-only configured work item: durable intent, observed worker/transport receipt, restart reconciliation, candidate evidence | Pending |
| Automatic eligibility | Current transport, native goal, idle wake-up/supervision and witnessed-delivery bindings; duplicate/stale fault drills | Pending |
| Human review | Independent exact-head verdict after the final candidate/feedback revision | Pending |
| Merge | Authorized human merge of that reviewed head | Pending |
| Deploy | Matching environment deployment receipt | Pending |
| Acceptance | Human/staging result bound to the deployed revision | Pending |
| Efficiency | Frozen comparable cohort, complete/labeled coverage and attributable lifecycle accounting | Unavailable until completed features exist |

## Commands to record after root wiring

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

The root integration adds the final Console endpoint and native transport
commands only after it has wired them and tested them locally. Until then the
first incomplete gate is **root Console/transport integration**, followed by
independent review, authorized merge, deployment and acceptance.

## Fault drills

Use deterministic inputs only: duplicate queue evaluation, duplicate/out-of-
order/stale callback, incomplete launch intent across restart, missing authority
candidate, stale capacity, revoked/absent readiness, changed candidate revision
and preview cleanup uncertainty. Each must leave records intact, launch no
duplicate worker and identify the owner/next action.

## Measurement note

Do not claim savings in advance. For a completed frozen-scope feature, report
provider/model route, lifecycle input/cached-input/output/reasoning counters
where supplied, account-pool observation freshness, unknown/unattributed usage,
queue wait, repair/reopen outcome, human time if observed and comparable cohort
coverage. A partial collection is a labeled lower bound, not an efficiency
claim. Never add overlapping PR, failed-attempt and accepted-feature totals.
