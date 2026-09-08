# Phase 7 Linux portability repair evidence

Observed: 2026-09-05

Candidate: `af4ad82d1e059c8616f3593bef1fe2a211823236` on
`build/phase-7`, following `a54e3a56483d4e170c356669bc9823a50866b1b3`.
The source worktree was clean after the candidate commit.

## Local focused verification

Pinned offline Node 24.20.0/npm 12.0.2 ran strict TypeScript followed by:

```sh
vitest run tests/actions/action-admission.test.mjs \
  tests/execution/execution-profiles.test.mjs \
  tests/execution/transports.test.mjs \
  tests/maintenance/update.test.mjs
```

Result: exit 0; 4 files and 43 tests passed. The transport regression uses a
real missing `ps` resolution through an intentionally empty PATH and observes
both `inspect` and `inspectAll` return `unknown` without an unhandled process
event.

## Disposable Linux gate

A public Git archive of the exact candidate ran in the cached
`faktori/codex-worker:0.146.0` Linux/arm64 image under Docker Engine 29.5.3.
The disposable container used two CPUs, 2 GiB memory, 256 PIDs, and temporary
`/work`, `/tmp`, and `/tools` filesystems. It installed only Python, `make`,
`g++`, `procps`, and `gh`; used npm 12.0.2; rebuilt only pinned
`better-sqlite3`; and exposed no host credential store, provider session,
Docker socket, or active product checkout.

`npm run check` exited 1 with 38 of 39 files and 311 of 313 tests passing. The
two failures are both `tests/maintenance/update.test.mjs` cases. They stop at
the existing managed-update requirement for an approved offline npm cache:
`better-sqlite3` package metadata was absent and npm returned `ENOTCACHED`.
The update path deliberately retains `--offline`; no policy was changed to
turn that missing prerequisite into a pass.

The gate confirmed the repaired portable temporary paths, Linux scratch-root
selection, build-before-test ordering, installed `ps`/`gh` prerequisites, and
bounded missing-process-tool handling. It does not complete F7-02 or any
other Phase 7 ticket.

## Authorized cache-primer follow-up

The initial exit-1 result identified a missing test-environment prerequisite,
not a reason to relax the updater's offline policy. In one separately recorded
disposable preparation step, the already-built exact Faktori tarball was
installed online into `/work/cache-primer/consumer` with
`--ignore-scripts --no-audit --no-fund`. This populated only that container's
npm cache with public package metadata and transitives. No provider command,
credential, host checkout, Docker socket, or active product operation was
exposed; the temporary container auto-removed afterwards.

With that cache present, the unchanged `npm run check` (including the
managed updater's existing `--offline` install and rebuild flags) exited 0:
strict typecheck, 39 test files / 313 tests, Console and TypeScript builds,
and packed-CLI verification all passed on Linux/arm64. This is Linux
repository/package evidence only. It does not supply the independent
all-provider product proof, Twinzy authority, paired Triforge comparison, or
Build Manager Phase 7 acceptance required for V1 completion.
