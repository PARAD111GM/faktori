<div align="center">

# FAKTORI

### Your agents. Your workflow. Your software factory.

Turn product intent into a coordinated software delivery loop.<br>
Self-hosted. Open source. Built to work across coding agents.

[Get started](#start-with-an-intent) · [Explore the skills](docs/skills.md) · [Architecture](docs/architecture/README.md) · [Status](#where-we-are)

</div>

---

## Own the factory. Choose the intelligence.

Coding agents can write software. Running a software operation takes more:
clear requirements, coordinated work, review, releases, recovery, and a way to
see what is actually happening.

**Faktori gives those agents a shared operating system for delivery.**
Intent, specifications, policies, and evidence stay yours—not trapped in one
provider's conversation history. Codex, Claude Code, and Cursor work against
the same source of truth, with explicit scope and portable handoffs.

Start with one developer, one product, and one provider. Add products, pods,
or specialists when the work calls for them—not because the framework does.

```text
                       Your intent
                            │
                  Interview + configuration
                            │
          Plan → Design → Build → Test → Deploy → Maintain
                            │                       │
                  Your coding agents          New work + feedback
                            │
             Shared artifacts · Explicit authority · Evidence
```

## What makes it a factory?

| Capability | What it gives you |
| --- | --- |
| **Agent-guided setup** | Discover resources, clarify intent, approve a concrete configuration, and provision with interruption recovery. |
| **15 bundled skills** | Interviews, research, planning, design, implementation, testing, independent review, deployment, maintenance, and handoffs. No external skill collection required. |
| **Three provider adapters** | Codex, Claude Code, and Cursor, with explicit sessions and visible capability differences. Use one or combine them. |
| **A local Console** | Work board and hierarchy, run timelines, waiting decisions, agent state, resource visibility, and factory health. |
| **Recoverable coordination** | Durable run records, bounded admission, workspaces, cancellation, and reconciliation before retrying uncertain actions. |
| **Owner-controlled delivery** | GitHub integration, optional Jira, revision-bound evidence, and configurable review and release authority. |
| **An AI Factory GM** | Diagnose factory problems and propose improvements without taking over product requirements or granting itself authority. |

### Small by default. Yours by design.

- **Fit the resources you have.** Configure spending, concurrency, providers,
  and human attention. Missing cost telemetry stays unknown; subscriptions are
  not treated as unlimited inference budgets.
- **Keep the stack you need.** The lifecycle is stack-neutral. Product commands
  and contracts belong with the product, not in a universal framework.
- **Scale the work, not the ceremony.** A small bug gets a compact record.
  A consequential change gets deeper design and verification.
- **Keep control.** Defaults favor human approval at consequential boundaries.
  Owners can change policies after acknowledging the specific risks.
- **Keep it local.** No required Faktori account, hosted control plane,
  marketplace, or billing service. Provider and integration access remain yours.

## Start with an intent

Clone the repo and open it in your coding agent:

```sh
git clone https://github.com/PARAD111GM/faktori.git
cd faktori
```

Then ask:

> Read AGENTS.md and skills/bootstrap/SKILL.md. Use Faktori to build me a
> software factory for **[my product]**. Discover my existing resources, interview
> me about what matters, and propose the simplest suitable setup before provisioning.

The agent should work from your resources, budget, and authority—not assume
you want three providers, a new pod, or another paid service. Logins stay in
the providers' own flows. Unavailable capabilities and blocked steps must be
reported rather than silently substituted.

**This is an early development kit, not a one-click production release.**
Start with a disposable product and approved test resources. Read
[onboarding](docs/onboarding/interview.md), [provisioning](docs/provisioning/README.md),
and the [compatibility matrix](docs/maintenance/compatibility.md) before connecting
important work.

### Run the source checks

Use **Node.js 24 LTS and npm 12**. Native SQLite support may require platform
build tools. From the source checkout:

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
npm run skills:verify
npm run typecheck
npm test -- --maxWorkers=4
npm run pack:verify
```

The packed check exercises a clean installed CLI, including SQLite behavior
and the shipped skill kit. It does not prove live provider authentication.
For a small read-only configuration example:

```sh
npm run faktori -- config resolve examples/config/solo.json
```

To configure and launch the Console, follow the
[local Console guide](docs/console.md). The current Console supports native
Codex, Claude, and Cursor routes and an isolated Codex route; it does not promise
identical sandboxing or interaction across all three.

## The operating model

**Documents define the work. Providers hold their own records. The coordinator
records execution. The Console makes it visible.**

Accepted intent, plans, policies, and configuration live in version control.
Issues, PRs, CI results, and deployments remain authoritative in their configured
systems. A local operational journal supports restart recovery; SQLite provides
rebuildable views.

The runtime is one Node.js/TypeScript application with Fastify, React/Vite,
SQLite, and agent workers. There is no cluster to operate just to get started.
Generated factory configuration belongs in a separate owner-controlled
repository; product artifacts normally live beside product code.

## Where we are

**Early development. Useful foundations; release validation still in progress.**

`main` includes accepted Phases 0–6 plus the complete SDLC skill kit. The skill
update passed 301 tests, installed-package checks, and independent instruction
review. These are engineering checks—not a claim that every live workflow has
been proved.

- [Phase 7](https://github.com/PARAD111GM/faktori/tree/build/phase-7)
  contains ongoing installation, host, and delivery validation. The Twinzy
  comparison is deferred; no comparative performance win is claimed.
- [Phase 8](https://github.com/PARAD111GM/faktori/tree/build/phase-8)
  contains separate operational-clarity work: structured blockers, redacted run
  manifests, and preflight reports. It is not yet integrated into `main`.
- Windows through WSL2 remains unverified. Consult the compatibility matrix
  for observed host and provider coverage.

Longer term: migration assistance, extension tooling, remote workers, and richer
collaboration. They are directions—not shipped features or prerequisites.

## Go deeper

| Start here | When you need it |
| --- | --- |
| [Skill kit and routing](docs/skills.md) | Choose the right playbook without loading everything. |
| [Product intent](docs/intent.md) | Understand scope and design principles. |
| [Configuration](docs/configuration/README.md) | Products, pods, providers, budgets, and overrides. |
| [Lifecycle and artifacts](docs/lifecycle/contract.md) | Trace intent through evidence and release. |
| [Hierarchy and context](docs/context/README.md) | Give agents relevant scope without unrelated baggage. |
| [Providers](docs/providers/README.md) | Understand adapter contracts and capability boundaries. |
| [Runtime](docs/runtime/README.md) | Explore execution, cancellation, publication, and recovery. |
| [Maintenance](docs/maintenance/README.md) | Back up, restore, reconcile, and update. |
| [Implementation plan](docs/implementation-plan.md) | Read the full V1 commitment and acceptance criteria. |
| [Skill verification report](docs/build/sdlc-skills-report.md) | See what was checked and what remains unproved. |

## Build with us

Bring a real workflow, a reproducible problem, or a smaller way to solve one.
Read [AGENTS.md](AGENTS.md) before changing code. Keep contributions bounded,
preserve owner authority, and include behavior-level evidence.

Faktori is licensed under [Apache 2.0](LICENSE). Adapted third-party guidance is
credited in [the notices](docs/third-party-notices.md).

---

<div align="center">

**Better models will keep arriving. Your factory should keep getting better with them.**

</div>
