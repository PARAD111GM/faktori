# Phase 7 Linux Node and Python fixture evidence — 2026-09-06

Disposable Linux arm64 containers were used with the network disabled for test
execution, a read-only root filesystem, all Linux capabilities dropped and
bounded CPU, memory and process counts. No Docker socket, provider session,
credential store or active workload was mounted.

## Immutable runtimes

- Playwright image: `mcr.microsoft.com/playwright:v1.63.0-noble`, digest
  `sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`,
  Node 24.20.0, Chromium revision 1243.
- Python image: `python@sha256:2c941e860699f878900b0edc2403613c234d4b32eda3cc9fa7036991a2a63c4a`,
  Python 3.12.14.

The Node input archive contained only the public fixtures plus the pinned local
Playwright package/core. Its SHA-256 was
`9acf104985a88c662e93a6ce20829716357b75c0e2c8af86a6642e481266c47f`.
Every run checked the frozen fixture manifest before executing a contract.

## Python result

Pinned pytest dependencies were prepared before the network-disabled run. The
container reproduced the expected baseline exactly: two tests passed and
`test_boundary_today_is_not_overdue` failed. The container command completed
successfully because that RED result is the frozen expected outcome, not a
repaired product claim.

## Node browser attempt history (status before the 2026-09-07 follow-up)

1. The first archive extraction failed because macOS ownership and extended
   attributes were incompatible with the capability-dropped container. The
   public archive was rebuilt without those attributes and extracted with
   ownership preservation disabled; fixture bytes did not change.
2. Checksums, browser prewarm and task-board RED passed, but due-dates base
   could not find the default Chrome channel because the channel variable had
   not been exported into the child.
3. With the channel exported, due-dates base passed in 2.677 seconds and the
   due-dates feature process hung during teardown. The exact disposable
   container was stopped.
4. A matching 25-second outer bound prevented another hang, but due-dates base
   failed quickly with a Playwright-core assertion and unhandled rejection.
5. Adding a container init process produced the same Playwright-core assertion
   after roughly 210 ms. Further retries stopped to preserve bounded evidence.

The Linux Node browser path is unresolved. WSL2 is unavailable on the observed
macOS host. The successful Linux package gate and Python baseline do not prove
the complete Node/Python product matrix, native provider delivery or WSL2, so
F7-02 remains blocked.

## Subsequent focused diagnosis and environment repair — 2026-09-07

The preserved run configuration left `HOME=/root` while enforcing a read-only
root filesystem. A diagnostic browser launch recorded concrete environment
failures: crashpad could not create its database, fontconfig had no writable
cache directory, and dconf could not create `/root/.cache/dconf`. The same
focused due-dates base contract happened to pass in that diagnostic, so the
earlier Playwright-core assertion is not claimed as deterministically caused by
one of those messages.

The harness environment was repaired without changing a fixture or product
criterion: `HOME` and `XDG_CACHE_HOME` were pointed at directories on the
existing ephemeral `/tmp` tmpfs. With the same image digest, public input
archive, Node/Playwright versions, Chromium channel, network isolation,
read-only root, dropped capabilities, resource limits and 25-second child
bounds, the complete Node fixture envelope then passed:

- all frozen checksums passed;
- task-board starter reproduced its expected RED;
- due-dates base passed in 2.595 seconds;
- due-dates feature starter reproduced its expected RED; and
- the container exited successfully without a forced stop.

This resolves the Linux frozen Node harness baseline. It does not repair either
starter product, prove a fresh native Linux provider delivery, satisfy WSL2 or
complete F7-02.

## Independent Build Manager reproduction

Before launch, the manager verified that the archive's embedded
`fixtures/SHA256SUMS` exactly matched the source manifest and that all 20
archived fixture files matched that manifest. The manager then ran the inspected
script using the immutable image digest
`sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`
with the same network, filesystem, capability and resource controls.

The independent run exited 0 on Node 24.20.0, Playwright 1.63.0 and Chromium
revision 1243: all 20 checksums and browser prewarm passed, task-board reproduced
expected RED, due-dates base passed in 2.660 seconds, due-dates feature
reproduced expected RED, and the envelope reported GREEN.

The archive hash above comes from both its original creation record and the
unchanged current file. An earlier report transcribed a different hash; the
manager stopped before execution, the discrepancy was reconciled against the
creation record, and no mismatched archive was run.
