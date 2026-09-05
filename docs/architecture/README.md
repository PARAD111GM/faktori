# Architecture

Faktori is one local coordinator, a rebuildable Console projection, and
bounded provider workers. The smallest installation is one owner, product,
pod, provider, and GitHub repository.

## Authorities

| Concern | Authority |
| --- | --- |
| Intent, plans, policies, approved configuration | Version-controlled documents |
| Issues, PRs, CI, deployments | Configured external provider |
| Runs, reservations, pending actions, receipts | Coordinator journal |
| Dashboard indexes | Rebuildable SQLite projection |

## Decisions

- [ADR-001: portable artifacts](ADR-001-portable-artifacts.md)
- [ADR-002: coordinator authority](ADR-002-coordinator-authority.md)
- [ADR-003: isolated execution](ADR-003-isolated-execution.md)
- [ADR-004: recovery journal](ADR-004-recovery-journal.md)
