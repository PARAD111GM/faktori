# Phase 7 fresh installed Console validation — 2026-09-07

This record preserves fresh-agent validation of the projection-only Console
repair. It is evidence for Build Manager review, not self-acceptance of F7-01.
Provider session identifiers, command tokens, credential material, and raw
provider events are intentionally omitted.

## Bound inputs

- Public source revision:
  `af958a28f8366e91683f3f67615cc2ec5ea0ee88`
- Metadata-free public archive SHA-256:
  `b527a6a10642fe65f1d705b401111ed282fad526271f17f41caf4f60bb11c359`
- Retained approved raw configuration SHA-256:
  `0b2937c826ed64886b6082c8547a5f2651e1e9e6796600990223c9962aa85da6`
- Immutable worker image:
  `sha256:4655fe29859991e999f5ffd9aec80a1f880a6549986807f98f1af8bd900fe8ed`
- Previously accepted product commit:
  `5b4836d393c6d02c8b3668f72e786edc8c328ec3`

The accepted factory and product were copied into a new disposable workspace.
The current public archive, its archive file, the exact retained configuration,
an inspectable deterministic validation harness, and the request were the only
non-credential inputs. The dedicated credential profile was mounted separately
from the ephemeral home and was not inspected.

## Hardened execution boundary

The successful fresh-agent run used the immutable image above with a read-only
root, UID/GID `501:20`, all Linux capabilities dropped,
`no-new-privileges`, 2 CPUs, 4 GiB memory, 256 PIDs, and a 2 GiB writable
ephemeral `/tmp`. Only the disposable workspace and dedicated Codex profile
were mounted. Bridge networking was required for the clean npm install; the
request restricted external use to exact locked npm dependencies and all
Console traffic to loopback. The profile was exposed through `CODEX_HOME`,
leaving npm a writable ephemeral `HOME`.

The agent read the public instructions and inspected the complete validation
harness before running it. The harness used neither source imports nor Fastify
injection. A provider-free run had already exercised the same harness under the
same UID/GID, filesystem, resource, and home-directory layout.

## Observed installed proof

The fresh agent and controller-observed sanitized result reported:

- Node `v24.20.0` and npm `12.0.2`;
- locked install, narrow `better-sqlite3` rebuild, real
  open/create/insert/query/assert/close SQLite behavior, and the public build
  all exited zero;
- the built `faktori@0.0.0` package tarball had SHA-256
  `08c09f4d1b1e54ebf22dc2f99304eaa5c54768109fda5b6cfefd9b173f6c90cd`;
- a separate consumer installed that tarball with dependency scripts and bin
  links disabled, rebuilt only installed `better-sqlite3`, and repeated the
  real SQLite check;
- the consumer invoked only
  `node node_modules/faktori/dist/cli.js` for Console preparation and service;
- installed `console prepare` accepted the exact retained approved
  configuration in explicit projection mode;
- the prepared file contained no `runtime` or provider/work/resume/GM execution
  authority;
- the first real TCP GET to `/api/console/state` returned HTTP 200 from
  `127.0.0.1:37683` with factory `local-faktori-factory`, product `task-board`,
  pod `task-board-pod`, and zero work-item nodes;
- SIGTERM shutdown exited zero;
- restart from the same file acquired ownership and a second real TCP GET
  returned HTTP 200 from `127.0.0.1:34579` with the same hierarchy and zero
  work-item nodes;
- the second SIGTERM shutdown exited zero and both service stderr files were
  empty;
- the runtime journal contained only
  `coordinator.claimed`, `coordinator.released`, `coordinator.claimed`, and
  `coordinator.released`;
- no provider, work, Console command, or GM event was observed; and
- the task-board remained clean at the exact accepted commit.

The outer Codex command exited zero, the result was `passed` with no remaining
unknowns for this bounded proof, and Docker auto-removal left no validation
container.

## Retained stopped attempts

Earlier fresh attempts were retained as failures rather than rewritten into
passes. They stopped before Console start because the request disabled
development bin links, reconstructed a non-approved configuration instead of
using the retained artifact, treated the expected metadata-free archive as a
Git checkout, or installed the consumer tarball from the wrong working
directory. A later hardened attempt exposed a root-owned npm cache caused by
nesting the profile mount below `HOME`. Provider-free checks isolated each
harness or environment error before the final run. None launched a Faktori
provider, created work, triggered GM, changed the product, or mutated a remote
system.

These stopped attempts are not counted as successful product evidence. The
final pass uses the documented development install, exact approval-bound
configuration, real installed consumer CLI, real TCP listener, and the same
hardened non-root boundary as the accepted cold-start run.

The Build Manager independently inspected the deterministic harness and
retained HTTP, shutdown, and event-class artifacts; recomputed the public
archive, retained configuration, and package tarball hashes; and accepted exact
head `a4dff21b6ae83cd627c1e32970316efd23e5c035` for F7-01's outstanding
installed projection-Console scope. The verdict is specifically
harness-assisted fresh-agent validation using the retained approved factory.
It is not a new unaided end-to-end cold start, provider orchestration through
projection mode, Phase 7 acceptance, or release acceptance.
