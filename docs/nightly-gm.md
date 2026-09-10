# Consolidated nightly Factory GM

Nightly GM is opt-in. Existing `runtime.gm` configurations without
`mode: "nightly"` retain the event-triggered behavior documented in
`docs/console.md`. Enabling the schedule does not prove that a scheduler is
installed or healthy: Console reports **degraded** until it observes a due
scheduled evaluation.

## Configure

Start from [`examples/config/nightly-gm.json`](../examples/config/nightly-gm.json).
The important fields are:

- `commandToken` and a fixed loopback `port`: the local scheduler calls the
  authenticated running Console. It does not start a second coordinator.
- `reviewRoutes`: owner-approved native intent templates in cheapest adequate
  order. One attempt uses only the first route. A failure or uncertain result
  does not fall through to another provider or model.
- `schedule`: an IANA `timezone` and local `HH:MM`; the default local time is
  `02:00`. A disabled schedule is reported as not configured.
- `deliveryDeadlineHours`: optional. Delivery becomes overdue only when this
  deadline exists and observed local acceptance is older than it.
- `ownerDecisions`: bounded decisions supplied to the next materially changed
  review. They are context, not provider authority.

The route may use an existing provider subscription and authentication flow.
Faktori never changes a billing route or copies credentials. The review intent
must preserve human merge/release authority and must not allow separate
billing. Routine maintenance remains limited to already configured actions.

## Run and schedule

An explicit owner request has an owner-chosen idempotency identity:

```sh
faktori gm review /absolute/path/to/local-console.json --request-id owner-review-2026-09-09
```

The scheduler route is:

```sh
faktori gm review /absolute/path/to/local-console.json --scheduled
```

It checks the configured timezone and due time in the running Console. The
first scheduled attempt for a timezone day records durable intent before model
invocation. Concurrent calls and restarts return that same identity. A failed
or uncertain attempt remains visible and is not retried until the next
scheduled day or a new explicit owner request. When deterministic facts,
metrics, owner decisions, and instruction revision are unchanged since the
last successful review, the new daily identity is recorded as
`skipped_unchanged` and no model is called. Prior GM recommendations are prompt
context but are deliberately excluded from the material-change fingerprint.
The next prompt contains changed findings rather than replaying resolved
history. GM review expenditure is displayed separately as supervision overhead;
changes to that overhead alone do not trigger another model invocation.

Generate, inspect, and install a definition yourself:

```sh
faktori gm scheduler render /absolute/path/to/local-console.json launchd
faktori gm scheduler render /absolute/path/to/local-console.json systemd
```

Rendering never installs or starts a host service. Both definitions poll the
local due gate every 15 minutes so the application, rather than the host clock,
applies the configured IANA timezone. The systemd output is generated for
Linux; generating it on macOS is not Linux scheduler evidence.

## Input and output boundary

The GM receives one compact JSON prompt containing changed actionable findings,
factory-wide qualified metrics, prior recommendations, and owner decisions. It
does not receive raw journals, chats, transcripts, or agent fan-out. Positive
evidence (for example nine sessions with reported usage) stays in metrics;
only an actionable problem with an accountable role and next action is a
finding.

The only accepted result shape is this single JSON object (all shown fields are
required; `findingId` on a recommendation is optional):

```json
{
  "findingActions": [
    {
      "findingId": "finding-0123456789abcdef01234567",
      "action": "retain",
      "evidence": "The registered usage export is still unavailable."
    }
  ],
  "recommendations": [
    {
      "priority": "high",
      "findingId": "finding-0123456789abcdef01234567",
      "recommendation": "Repair the registered usage export.",
      "expectedBenefit": "Restore measured coverage without estimating missing tokens.",
      "evidence": ["loop:small-delivery:usage-unavailable"],
      "nextAction": "Factory operator opens the registered source and corrects its export path."
    }
  ]
}
```

`action` is `retain` or `propose_resolve`. A proposed resolution does not
silently resolve an active deterministic fact. Unknown finding IDs, extra
fields, unsupported actions, or authority/policy/product changes make the
attempt visibly fail; Faktori does not launch a schema-repair retry.

## Reading the Console

Overview shows compact distinct counts for local acceptance, merged PRs,
deployment, and deployment-bound product acceptance, plus source coverage and
unknown usage. The expanded activity feed remains on Work. Factory shows
supervision health, last evaluation and successful review, qualified metrics,
and actionable findings separated into infrastructure and delivery.
Deterministic metrics remain available even when no nightly GM is configured.

Tokens per merged PR and per product-accepted feature include attributed
failed, review, and repair spend, deduplicated globally by PR/feature identity.
Those overlapping views are alternatives and are never added. When no merged
PR or deployment-bound acceptance exists, the denominator and ratio are
unavailable—not zero. Lead-time medians use only complete observed timestamp
pairs. Shared/unattributed overhead, unfinished spend, missing telemetry,
human intervention, reopenings, and regressions remain separate or unknown.
