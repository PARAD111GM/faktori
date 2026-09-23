# Console token tracker — bounded local proof

The tracker observes only registered Manager Loop receipts and explicitly
registered usage exports. It adds no model
invocations, provider probes or conversation-history scans. Factory-wide
Coordinator efficiency remains a separate metric with a different scope.

## Accounting boundary

- Input includes cached input; total is input plus output, never plus cache.
- Uncached input is available only when contributing cache partitions are known.
- Duplicate observations must not inflate totals.
- Ambiguous resumed-session counters are excluded from attributed totals and
  remain visible as unknown; terminal provider counters are not assumed per-turn.
- Coverage counts registered observations, not inferred provider sessions.
- Missing model labels stay unknown. Local success is not shipped acceptance.

## Exercise

An isolated observation-only Console registered three real checklist exercise
runs: the original failure, the receipt-binding retry, and the approved
corrupt-storage repair. No active product Console or worker was restarted.
The controlling Codex conversation is not included in these measurements.

Proposal 3 changed only the disposable checklist's storage mutation guard.
The actual Manager Loop completed four stages in 137.486 seconds. Independent
model tests and original plus corrupt-storage browser checks passed at 390x844
and 1280x800. This establishes local repair evidence, not GitHub, Jira, Slack,
deployment or human product acceptance.

## Verified result

The rendered Console reconciled 15/15 usable observations from three runs:

| Measurement | Tokens |
| --- | ---: |
| Input | 1,028,760 |
| Cached input (included above) | 724,992 |
| Uncached input | 303,768 |
| Output | 17,343 |
| Total | 1,046,103 |

Run totals are 174,139, 479,642 and 392,322. The third run's expansion matched
its four stage receipts. Overview showed the same total and linked to Factory;
the help modal opened and closed. The visible tracker layout was inspected.

Independent source review found resumed-counter and mixed-scope issues, both
corrected with regression coverage. Real-data browser verification additionally
found generated stage IDs exceeding the generic 64-character limit; the parser
now accepts the bounded generated composite shape without broadening other IDs.

Typecheck and build passed. The full suite passed 616 tests after the accounting
corrections; the final focused suite passed 26 tests including the subsequent
long-stage-ID regression. No savings or whole-factory coverage is claimed.
The packed CLI also passed clean-consumer verification on Node 24.20.0.
