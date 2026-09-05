# Construction usage monitoring

`scripts/build-usage.mjs` is a local construction utility. It reads exported, normalized JSONL snapshots; it never invokes a model or reads provider credentials. Use `watch` to refresh the derived summary every ten seconds.

```sh
node scripts/build-usage.mjs summarize --input .build/usage/records.jsonl --output construction/phase-summary.json --estimate 360000 --phase 0
node scripts/build-usage.mjs watch --input .build/usage/records.jsonl --output construction/phase-summary.json --estimate 360000 --phase 0
```

The active Phase 0 estimate is revision 2 in
`construction/phase-estimates.json`; that file preserves the initial 160,000
estimate and the 360,000 revision with their allocations and rationale.

The raw input belongs below ignored `.build/usage/`. It may contain local session identity or source-specific fields and is never published. `construction/phase-summary.json` is the sanitized, machine-readable export used by the static dashboard. It contains only aggregated counters, phase/ticket identifiers, and telemetry gaps; it must not contain local paths, native telemetry payloads, prompts, credential material, or account identifiers.

## Snapshot schema

Each non-empty line is one object. Required fields for a measured sample are `phase`, `ticket`, `agentId`, `sessionId`, `at`, `source`, `cumulative`, and `counters.total`.

```json
{
  "phase": 0,
  "ticket": "F0-02",
  "agentId": "phase-implementer",
  "sessionId": "provider-session-id",
  "parentAgentId": "optional-parent-agent-id",
  "childScope": "inclusive",
  "coverageScope": "unknown",
  "coverageGroup": "phase-0-construction",
  "model": "gpt-5.6-terra",
  "reasoning": "high",
  "at": "2026-09-04T00:00:00Z",
  "source": "codex-goal",
  "cumulative": true,
  "counters": { "input": 120, "output": 80, "cached": 20, "reasoning": 30, "total": 200 },
  "estimate": { "tokens": 250 }
}
```

`cumulative: true` means the latest changed snapshot for an agent/session replaces earlier snapshots. Identical cumulative snapshots are deduplicated. Use `cumulative: false` only for a standalone incremental measurement; those records are added.

For a persistent manager session that spans phases, a record must carry either phase-attributable normalized counters or explicit phase-start baseline provenance (for example `phaseAttribution: "baseline-derived"` and a source/baseline reference). Do not relabel its raw lifetime cumulative total as a new phase’s usage. Set `phaseAttribution: "unknown"` when that baseline is absent; the tool excludes it from phase actuals and emits `phase-attribution:unknown`. Fresh implementer sessions can use normal cumulative snapshots when their session scope is phase-local.

`childScope` is `inclusive`, `exclusive`, or `unknown`. An inclusive parent with a measured total excludes every measured descendant from the aggregate. With `unknown`, child totals are also excluded and the summary reports `parent-child-overlap:unknown`; the tool will not guess or add possibly overlapping usage. If the parent has no measured total, child measurements stay included. Omit it only when the sample is explicitly exclusive.

`coverageScope: "unknown"` and a shared `coverageGroup` identify sessions that may overlap but have no trustworthy hierarchy—such as a manager and implementer whose goal telemetry may include each other or subagents. The summary retains the highest measured total for that group as an overlap-safe lower bound, never adds competing totals, and reports a sanitized `coverage-overlap:unknown` gap. Use `coverageScope: "exclusive"` only when the source confirms its total excludes the other measured work. A source that has no token telemetry records `telemetry: "unknown"` and can separately provide `estimate.tokens`.

`total` is the billable/observed aggregate. `cached` and `reasoning` are annotations that may be subsets of input/output, so they are displayed separately and are never added to `total`. `actual` and `estimated` remain distinct. Missing values remain `null`/unknown, not zero. Sanitized summaries never expose an `agentId`, `sessionId`, local path, or raw provider payload.

Budget notices are emitted in the summary when observed actual usage reaches 70%, 90%, or 100% of the supplied estimate. Subscription allowances, account percentages, API charges, and optional dollar estimates are deliberately outside this tool unless a separate, documented pricing basis is supplied.
