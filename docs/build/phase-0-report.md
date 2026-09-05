# Phase 0 completion report

Status: candidate complete; Build Manager acceptance pending.

## Scope and candidate

- Phase: 0 — foundation, construction tracking, provider feasibility, and frozen comparison fixtures.
- Tickets: F0-01 through F0-04 only; all four are `complete` in the canonical checklist.
- Starting revision: `d7dbfa80242765458527aa12ef543ef5fe1a7971`.
- Candidate revision: the exact commit containing this report is supplied in the manager handoff after the commit is created.
- Publication: no merge or push was authorized or performed.
- Product isolation: no Twinzy or Triforge repository, service, credential, or infrastructure was changed.

## Accepted ticket evidence

| Ticket | Result | Evidence |
| --- | --- | --- |
| F0-01 | Complete | Public README and intent, four architecture decisions, provider-neutral adapter contract, scoped agent instructions, complete Apache-2.0 text, pinned Node 24/npm 12 package, and committed lockfile. |
| F0-02 | Complete | Canonical 32-ticket state, append-only status events, safe split handling, static dashboard, budget revisions, normalized usage monitor, ten-second watch mode, privacy filtering, and behavior tests. |
| F0-03 | Complete for Phase 0 feasibility | Sanitized, versioned capability report from bounded native exercises for Codex, Claude Code, Cursor, and hardened Docker mechanics. Failed or uncertain controls remain explicit rather than inferred as passing. |
| F0-04 | Complete | Three frozen cases, executable browser/Python contracts, stable named RED reasons, a working base-board GREEN contract, SHA-256 manifest, and comparison rules that keep correctness, usage, time, human work, rework, and maintainability separate. |

The detailed state and append-only events are authoritative in
`construction/checklist.json`; `construction/dashboard.html` is a generated
projection.

## Model routing and rework

- GPT-5.6-Sol high: phase orchestration, integration, canonical state, final verification, and manager coordination.
- GPT-5.6-Luna medium: initial public foundation and frozen-fixture construction.
- GPT-5.6-Terra high: construction tracking/usage plus F0-04 remediation after the first fixture pass did not yet prove stable expected-RED reasons and a real base-GREEN browser contract.
- GPT-5.6-Terra medium: provider feasibility exercises and sanitized capability reporting.

File ownership was disjoint while specialists worked. Specialists did not
commit, merge, publish, or mutate product infrastructure. The Luna-to-Terra
escalation and its evidence-based reason are recorded in
`construction/model-routing.json`.

## Provider feasibility boundary

Observed local versions were Codex CLI `0.146.0`, Claude Code `2.1.207`, Cursor
CLI `3.19.7` (build `90de232…`, arm64), and Docker `29.5.3`.

The Phase 0 feasibility exit is met for bounded native profiles:

- Codex, Claude Code, and Cursor each completed an authenticated native launch/edit and an explicit-ID resume in a dedicated scratch workspace.
- Cursor returned an ACP cancellation receipt and its disposable project policy blocked the target write.
- Docker enforced a non-root, network-disabled, read-only-root and read-only-bind scratch exercise without mounting a host home, provider credentials, or the Docker socket.
- Codex and Claude emitted useful usage fields; Cursor did not emit usage in the tested ACP flow.

This is not acceptance of autonomous isolated execution. Codex `read-only`
still wrote in its dedicated scratch under an unresolved control context;
Claude tool suppression did not produce a native permission-denial receipt;
Codex and Claude wrapper interruptions did not produce provider cancellation
receipts; Cursor emitted no interactive permission request; and Docker Desktop
could not share the assigned worktree. F2-02 and provider-adapter work must
prove authenticated durable isolation, coordinator-owned environment policy,
publication revocation, and process-tree termination/reconciliation before an
autonomous profile is admitted. Provider-native permission and cancellation
receipts are capabilities, not universal admission requirements: an unavailable
interactive reply stays unsupported, and a locally terminated provider without
a native receipt stays `interrupted_uncertain`. Credentials remain exclusively
inside the unmodified vendor login flows.

## Verification

Observed from the assigned isolated Faktori worktree root:

| Command | Observed result |
| --- | --- |
| Node 24/npm 12 package-lock regeneration, `npm ci`, then `npm run check` | Node `v24.20.0`, npm `12.0.2`; 4 Vitest files and 21 tests passed; TypeScript passed; npm audit reported 0 vulnerabilities. |
| `node fixtures/verify-fixtures.mjs` under Node 24 | Exit 0; task-board starter expected RED, due-dates base browser contract GREEN, due-dates feature expected RED, Python boundary expected RED, and checksums verified. |
| Dashboard and usage generation under Node 24 | Exit 0; all 32 canonical tickets rendered, Phase 0 completion history rendered, and sanitized overlap-safe usage summary refreshed. |

npm 12 blocked dependency install scripts by default, including the
`better-sqlite3` build script. Phase 0 does not execute SQLite, so this did not
affect its tests; Phase 1 must explicitly review and allow the required native
build before treating SQLite as runnable.

## Usage and budget

The initial soft estimate was 160,000 tokens. After early observed usage and
fixture rework, the manager revised it to 360,000 with revision history and
allocations preserved in `construction/phase-estimates.json`.

The final pre-commit sanitized summary reports a 1,089,917-token
**overlap-safe lower bound**, 302.75% of the revised estimate. This is not a
fully attributed total: the implementer cumulative sample is retained, the
manager's latest observed 131,206-token sample is excluded from addition
because manager/implementer coverage may overlap, and all four specialist
token totals remain unknown rather than zero. Input, output, cached, reasoning,
and dollar-cost splits remain unknown. Raw session records stay under ignored
`.build/usage/`; only the sanitized aggregate is committed.

Primary variance causes were inherited coordination/context cost, an initially
underestimated manager loop, two fixture acceptance passes and Luna-to-Terra
escalation, live provider exercises, and final integration/verification. The
estimate was never used to weaken acceptance.

## Residual gates and next-phase lessons

- Build Manager acceptance is still required before Phase 1 begins.
- Phase 1 should consume the provider capability matrix as constraints, not as a claim that isolated execution is solved.
- Provider adapters must preflight model compatibility and recorded workspace identity; resume may never rely on an ambient cwd or a "last session" shortcut.
- Coordinator cancellation must terminate and reconcile the process tree. A provider-native receipt is recorded when available; without one, the provider outcome remains `interrupted_uncertain`, distinct from cancelled, failed, and completed.
- Unsupported interactive approval replies stay unsupported or blocked; V1 does not require a new transport bridge solely to manufacture a missing native capability.
- The coordinator, not a provider CLI default, must own filesystem, network, credential, publisher, and process-tree boundaries.
- Reuse the frozen inputs without rubric changes; any fixture change requires a new explicit version and checksum manifest.
- Keep future manager sessions phase-attributable with a phase-start baseline; otherwise exclude their lifetime cumulative telemetry from phase actuals.
- Review npm 12 install-script approval for `better-sqlite3` before F1 runtime work.
