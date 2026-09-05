# Faktori

Faktori is a self-hosted, vendor-neutral software factory for an individual
developer or small team. It turns an approved product intent into a bounded
Plan, Design, Build, Test, Deploy, and Maintain loop while keeping documents,
configuration, evidence, and authority portable.

This repository is the public source for the factory. Generated factory
configuration belongs in an owner-controlled repository; product artifacts
remain with the product. No credentials, private machine paths, or live
integration identifiers belong here.

## Status

Phases 0–6 are accepted. Phase 7 is the assembled-product proof: cold-start,
host/stack compatibility, the authority-gated isolated Twinzy delivery, and the
frozen paired comparison. Phase 6 added installed backup/restore and supported
runtime-update boundaries, plus a public maintenance kit. The Phase 5
candidate added an installed loopback
Console over the durable coordinator, native Codex/Claude/Cursor and isolated
Codex runtime routes, replay-safe owner controls, explicit provider request
responses, bounded event-driven Factory GM diagnosis, and resource/attention
visibility. The package build emits installable JavaScript and declarations;
its packed CLI is verified from a clean temporary install. Frozen fixtures
remain test contracts, not benchmark results; unsupported host or incumbent
evidence remains explicitly unverified.

## Start here

- [Project intent](docs/intent.md) — scope, boundaries, and principles.
- [Architecture decisions](docs/architecture/README.md) — portable source of truth,
  authority, recovery, and execution boundaries.
- [Provider guidance](docs/providers/README.md) — neutral adapter expectations.
- [Configuration contract](docs/configuration/README.md) — inheritance,
  capabilities, budgets, authority, products, and optional pods.
- [Onboarding interview](docs/onboarding/interview.md) and
  [provisioning contract](docs/provisioning/README.md) — discover, propose,
  approve, scaffold, interrupt, and reconcile.
- [Hierarchy and context](docs/context/README.md) — stable work identities and
  narrowly assembled context packets.
- [Lifecycle contract](docs/lifecycle/contract.md) — proportional artifacts,
  six lifecycle outcomes, evidence, and provider-neutral handoffs.
- [Recoverable runtime](docs/runtime/README.md) — journal, SQLite, execution
  profiles, Codex adapter, cancellation, and action authority boundaries.
- [Local Console and Factory GM](docs/console.md) — loopback service, live
  views, owner controls, provider routes, and bounded health diagnosis.
- [Maintenance kit](docs/maintenance/README.md) — backup, separate restore,
  reconciliation, update preview/apply, troubleshooting, and compatibility.
- [Comparison fixtures](docs/comparison/README.md) — frozen, reproducible cases.
- [Implementation plan](docs/implementation-plan.md) — accepted V1 specification.

## Commands

After the package is installed, use `npm ci`, `npm test`, `npm run build`,
`npm run pack:verify`, `npm run check`, `npm run build:dashboard`,
`npm run build:usage`, and `npm run build:usage:watch`. The source CLI runs on
the supported Node 24 runtime, for example:

```sh
npm run faktori -- config resolve examples/config/solo.json
```

After initial provisioning, add a separately discovered and approved product
with `faktori product new <approved-bundle.json> <absolute-factory-root>`; see
the [provisioning contract](docs/provisioning/README.md). It preserves the
existing configuration/repositories and creates no implicit pod.

Status updates require explicit safe arguments:

```sh
npm run build:status -- --checklist construction/checklist.json --ticket F0-02 --status in_progress --reason "..."
```

Node.js 24 LTS and npm 12 are the supported construction setup on macOS and
Linux. WSL2 is not yet verified; see the [compatibility matrix](docs/maintenance/compatibility.md).
Install with
dependency scripts disabled, then verify the pinned `better-sqlite3` native
artifact through a real open, write, query, and rebuild before runtime use. The canonical
construction records are [checklist](construction/checklist.json)
and [dashboard](construction/dashboard.html). Start by reading `AGENTS.md` and
the implementation plan, then identify the product, constraints, build
process, and first eligible task. A phase candidate does not authorize the next
phase; the Build Manager must accept it first.
The fixture commands are independent: each fixture README gives its exact
runtime and test command. A passing fixture test demonstrates only that the
fixture contract is present; it says nothing about provider quality.

## Contributions

Changes should preserve explicit authority, bounded execution, restart
recovery, and portable documents. Add behavior-level tests with changes and
record observed commands. See `AGENTS.md` for construction protocol.

## License

Apache-2.0. See [LICENSE](LICENSE).
