# Install Faktori — instructions for coding agents

Use this guide when an owner asks you to create a factory from this repository.
It is an operational guide, not a request to continue Faktori's development
backlog. Read it before installing dependencies or provisioning resources.

## 1. Establish scope

1. Read [AGENTS.md](AGENTS.md), then the
   [bootstrap skill](skills/bootstrap/SKILL.md).
2. Identify whether the owner wants a new factory, a new product in an existing
   factory, or development of Faktori itself. For an existing factory, use
   [product creation](skills/product-creation/SKILL.md) instead of reinstalling.
3. Inspect the chosen checkout's revision and changes. Do not reset, clean,
   overwrite, or switch a working repository without appropriate authorization.
4. Keep three locations distinct: the Faktori source/kit, the owner-controlled
   factory configuration repository, and product repositories. Do not put private
   factory configuration, credentials, or product code in the public Faktori repo.

Use `main` unless the owner explicitly selects another revision. Phase branches
are development candidates, not installation upgrades. This remains an early
development kit; do not describe installation as full release acceptance.

## 2. Discover prerequisites, then confirm decisions

Run read-only discovery in the selected source checkout:

```sh
git status --short
git rev-parse HEAD
node --version
npm --version
git --version
```

| Requirement | What to establish |
| --- | --- |
| Host | Consult the checked-out [compatibility matrix](docs/maintenance/compatibility.md). Do not generalize another branch's host evidence to this revision. |
| Runtime | Node 24.x and npm 12.x; construction was verified with Node 24.20.0 and npm 12.0.2. Use the owner's version manager rather than replacing system tools. |
| Native dependency | `better-sqlite3` needs a compatible binary or native build tools. If compilation is necessary, identify the host's Python/C++ toolchain before proposing installation. |
| Coding agent | At least one selected Codex, Claude Code, or Cursor CLI. Inspect its installed version and supported commands. Installed does not mean authenticated. |
| Integrations | GitHub CLI/access for GitHub operations; Jira only if selected. No integration login is needed just to build the source or resolve a local example. |
| Isolation | Docker is needed only for a selected Docker execution path. Verify that its daemon works; do not silently switch to native host access when it fails. |

Use the [interview](skills/interview/SKILL.md) only for material unknowns. Establish
product intent, owner, stack, existing resources, provider choice, budget, human
availability, execution profile, review/release authority, and incident policy.
Start with one product and one provider; do not automatically provision all three.

Before effects, present the exact installation/provisioning proposal: paths,
dependencies, selected providers, network use, estimated cost, host access,
and actions requiring approval. Obtain approval for that concrete scope.
Financial estimates are not native goal token caps. Never invent a hard cap
from an estimate or claim a strict cost guarantee without supporting telemetry.

## 3. Install and verify the source kit

If no checkout exists, clone into the agreed location; do not clone over an
existing directory:

```sh
git clone https://github.com/PARAD111GM/faktori.git
cd faktori
```

After confirming the supported Node/npm versions and approving installation,
run these commands **from the Faktori source root**, stopping on a failure:

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
npm run skills:verify
npm run typecheck
npm test -- --maxWorkers=4
npm run pack:verify
npm run faktori -- config resolve examples/config/solo.json
npm run faktori -- preflight examples/diagnostics/preflight-projection.json
```

Keep the committed lockfile. Disable dependency lifecycle scripts during the
general install; explicitly rebuild only the pinned SQLite dependency. Do not
globally enable scripts to work around a failed native build. The build must
precede the tests because installed-runtime tests need emitted files.

Expected results: emitted runtime and Console assets; valid skill catalog;
passing typecheck and tests; a clean installed-package CLI check, including real
SQLite operations; resolved example configuration; and a fail-closed read-only
preflight example. The final two commands are diagnostic examples, not an
approved owner configuration, a running factory, or proof of execution/live
readiness.

These are **source checkout commands**. A packed distribution omits development
scripts and source files: do not run this sequence inside an installed tarball.
Use the installed `faktori` executable and its version-matched documentation for
operation. Do not assume an npm registry release or install an unrelated package
by name. Global installation is not required for the source path.

## 4. Configure and provision the owner's factory

Continue the [bootstrap procedure](skills/bootstrap/SKILL.md) and read the
[configuration](docs/configuration/README.md),
[interview](docs/onboarding/interview.md), and
[provisioning contracts](docs/provisioning/README.md).

Generate discovery, configuration, and proposal records using the current
contracts. Example files are references, not owner approvals. The current CLI
provides these forms; replace placeholders with actual validated records:

```text
npm run faktori -- provision proposal <request.json>
npm run faktori -- provision approve <request.json>
npm run faktori -- provision apply <bundle.json> <absolute-approved-factory-root>
```

Record the owner's actual approval before creating its approval record. If the
proposal or an imported source snapshot changes, renew approval. Initial
provisioning can bind each named local product through `localProductSources` in
the proposal request; omitting it intentionally creates the documented empty
scaffold. Current `main` provisions approved local resources, while unsupported
remote provisioning remains pending. Do not invent remote repositories or
deployment receipts.

For an existing factory, use the same discover, propose, and exact-approval
sequence, then apply the approved add-product bundle with the shipped command:

```text
faktori product new <approved-product-bundle.json> <absolute-existing-factory-root>
```

This preserves the approved factory defaults, existing products, repositories,
and pods; it adds exactly one approved product and does not create a pod
implicitly. See the [product-addition contract](docs/provisioning/README.md)
before constructing the bundle.

On interruption, inspect the approved root's
`.faktori/provisioning/operations.jsonl` and reconcile intended/observed effects
before retrying. Do not delete records or blindly rerun under a new identity.

## 5. Connect agents and open the Console

- Load the selected [provider entry map](provider-entrymaps/generated/codex.md)
  or corresponding Claude/Cursor map. All point to the same
  [16 bundled skills](docs/skills.md). Explicit file loading works without
  registering global skills; never overwrite personal agent instructions.
- Use each selected provider's own supported login flow. Let the owner complete
  interactive authentication. Never request, print, copy, or commit tokens.
- Create and review an integration inventory before admitting work. For every
  provider, runtime route, Jira mapping, and GM schedule, mark exactly one:
  **enabled and verified** (with a bounded observed exercise), **pending auth or
  observation**, or **deliberately deferred** with the owner's recorded reason.
  A provider listed in the catalog is not a configured route or authenticated
  provider. A configured GM is not evidence that its scheduler has run.
- Separate authentication status from observed execution. After approval, run a
  small bounded exercise in a disposable workspace and record the actual result.
  Do not activate paid routes or broaden permissions to make a check pass.
- Follow [the Console configuration guide](docs/console.md). Prepare its private
  configuration from the approved factory projection, then serve it from the
  source root:

```text
node dist/cli.js console prepare <approved-projection-request.json> > <absolute-path-to-local-console.json>
npm run faktori -- console serve <absolute-path-to-local-console.json>
```

Open the configured loopback URL. A visible Console is not evidence that a
provider, deployment, or product acceptance test passed. The current Console has
native Codex/Claude/Cursor routes and an isolated Codex route; capability parity
across execution profiles is not assumed.

Before admitting work, run `faktori preflight <request.json>` using the selected
factory/configuration scope. Public assertions cannot self-certify execution or
live readiness; negative observations fail closed, and only the supported
read-only installed SQLite inspector can establish projection readiness. Follow
the [operational clarity guide](docs/operational-clarity.md) for the request
shape, stable checks, and remediation semantics.

```sh
faktori readiness report /absolute/path/local-console.json
```

This command reads the local Console configuration and process-environment
**presence** only. It
does not contact a provider or Jira, invoke Claude, run the GM, start a worker,
or reveal credential values. Treat a missing GM/Jira item as unavailable unless
the owner separately records a deliberate deferral. The report still records
the missing item as unavailable; a deferred item remains unverified. Use the
report to prevent silent omissions,
then perform a separately approved, bounded exercise for anything called
enabled and verified.

## 6. Demonstrate and hand off

Use one small approved work item with explicit acceptance criteria and approved
test resources. Show its context, execution, verification, and remaining release
decisions in the Console. Respect configured review and deployment authority;
do not touch production merely to finish an installation checklist.

Report separately:

- **Kit:** revision, host/tool versions, install/build/package check results.
- **Factory:** approved configuration revision, paths, observed provisioning,
  pending or unsupported effects, and recovery records.
- **Agents:** selected providers, observed authentication/execution results,
  capability gaps, integration inventory state, and unknown usage—not inferred
  success.
- **Operations:** Console URL and stop/restart procedure for the process actually
  started, backup guidance, owner decisions, and next eligible work item.

Use [handoff](skills/handoff/SKILL.md) and the
[maintenance guide](docs/maintenance/README.md) for continued operation.
“Kit installed,” “factory configured,” and “delivery demonstrated” are distinct
claims. Mark blocked checks honestly and explain the smallest action needed.

## When setup fails

Stop at the failing boundary. Record a sanitized error and consult
[troubleshooting](docs/maintenance/troubleshooting.md). Preserve existing work.
Missing prerequisites require an explicit installation decision; failed login
requires the provider-owned flow; unknown operation outcomes require
reconciliation. Never substitute fixtures, widen authority, disable checks, or
claim success to finish setup.
