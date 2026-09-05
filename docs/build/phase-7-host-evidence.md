# Phase 7 host and frozen-input evidence

Evidence date: 2026-09-05. Candidate checkpoint: `0448f00`.

This record distinguishes observed execution from documented targets. It does
not convert a macOS Docker client, a frozen RED starter, or historical evidence
into a Linux or completed-product result.

## Host inventory

| Path | Observed result | Classification |
| --- | --- | --- |
| macOS | macOS 26.0 (`25A354`), Darwin 25.0.0, arm64 | Available host |
| Default Node/npm | Node 22.15.0 and npm 10.9.2 | Unsupported by the published engines |
| Pinned Node/npm | Offline Node 24.20.0 and npm 12.0.2 launched successfully | Available supported toolchain |
| Python | CPython 3.14.6 and `pytest` available | Available stack path |
| Docker | Client 29.5.3 on `desktop-linux`; bounded daemon probe returned no server and stalled until interrupted | Linux execution unavailable |
| Other local Linux VM | No Podman, Colima, Lima, Multipass, OrbStack CLI, or QEMU executable found | Unavailable |
| WSL2 | No `wsl.exe`; host is macOS and has no Linux `/proc` | Not applicable on this host; still unverified |
| Provider CLIs | Codex 0.146.0, Claude Code 2.1.207, Cursor Agent 2026.08.11-e8db854 | Installed binaries only, not Phase 7 conformance evidence |

The independent Linux instance required by F7-02 was not available. The
compatibility matrix must not claim observed Linux or WSL2 support from this
run.

## Frozen inputs

`shasum -a 256 -c fixtures/SHA256SUMS` reported `OK` for all 20 entries. The
independent manager check reported the same result. No fixture or rubric file
changed.

The available macOS stack reproduced each individual frozen contract under
the pinned Node runtime (browser cases required loopback permission):

| Case | Command class | Observed result | Meaning |
| --- | --- | --- | --- |
| Task-board starter | Node browser acceptance | RED in 1.62 s: `candidate UI root returned 404` | Intended starting state, not a completed product |
| Due-dates base | Node browser base contract | GREEN in 16.69 s | Frozen pre-feature behavior works |
| Due-dates feature starter | Node browser acceptance | RED in 9.70 s: missing `Set due date Yesterday task` | Intended starting state, not a completed feature |
| Python boundary starter | `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest -q` | RED in 0.02 s: 1 failed, 2 passed; today incorrectly overdue | Intended starting bug, not a repair |

The aggregate verifier reproduced task-board RED, then its 25-second per-child
guard expired during a due-date base run. Running that same base contract alone
completed GREEN inside its own 20-second test bound. The aggregate timeout is
recorded as a harness observation, not misreported as fixture failure or pass.

## Assembled repository gate

After building the distribution once, the pinned full gate ran outside the
socket-restricted construction sandbox:

- typecheck: passed;
- tests: 39 files, 311 tests passed;
- Console and TypeScript build: passed; and
- clean packed-CLI verification: passed with Node 24.20.0.

This proves the assembled repository and package on the observed macOS host.
It does not satisfy the missing independent Linux instance, solve the frozen
RED cases, or replace live provider/product evidence.

## Subsequent manager verification after Docker recovery

After an owner-approved force-quit and reopen, Docker Engine 29.5.3 responded
again. Existing workloads were not used for verification. Cached images were
launched with network disabled, read-only root filesystems, bounded memory/CPU
and process counts; no images were downloaded. Project bind mounts failed with
`bind source path does not exist`, so only selected public files were streamed
into temporary container memory instead.

- Cached Node 24.20.0 ran on Linux arm64. The compiled configuration module
  resolved the unchanged solo and multiple-product examples, retaining their
  product/pod counts and provider/environment assignments (exit 0).
- Cached Python 3.12.14 ran on Linux aarch64. Direct invocation of the three
  unchanged plain test functions reproduced the frozen baseline: two passed,
  and `test_boundary_today_is_not_overdue` failed (exit 1). An earlier unittest
  discovery attempt found zero tests (exit 5); it is not passing evidence.

These are bounded Linux-container observations, not a complete independent
Linux factory installation, browser journey, provider isolation proof, or
completed Python bug fix. Host bind-mount behavior still requires diagnosis;
the complete F7-02 gate remains open. The frozen inputs were not changed.

The manager subsequently identified the bind-mount cause: Docker Desktop's
configured shared paths excluded `/Users`. A public-only Git archive of the
configuration source/examples and Python fixture was placed under an already
shared temporary path. A read-only bind from that location succeeded, and the
same two configuration examples passed in cached Linux Node 24.20.0 with no
network. This verifies a working mount alternative without changing Docker
settings, restarting workloads, or sharing a home directory. Installations
must discover and validate their configured workspace-sharing boundary before
admitting isolated jobs. It still does not prove the full Linux factory gate.
