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

Phase 2 adds a durable coordinator journal, rebuildable SQLite projection,
bounded native and isolated execution profiles, a Codex adapter, and
controller-owned action admission. The package build emits installable
JavaScript and declarations; its packed CLI rebuilds a real SQLite projection
from a clean temporary install. Remote publication remains a later-phase
transport. The frozen fixtures remain test contracts, not benchmark results.

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

Status updates require explicit safe arguments:

```sh
npm run build:status -- --checklist construction/checklist.json --ticket F0-02 --status in_progress --reason "..."
```

Node.js 24 LTS and npm 12 are the supported construction setup. Install with
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
