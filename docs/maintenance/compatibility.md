# Compatibility matrix

This is an evidence boundary, not a promise of indefinite backward
compatibility. Claims below describe the supported path in this phase; Phase 7
must add independent host evidence before expanding them.

| Host/path | Status | Notes |
| --- | --- | --- |
| macOS, Node 24 LTS, npm 12 | Phase 7 observed repository/package path | The pinned typecheck, 39-file/311-test suite, Console/package build, and clean packed-CLI verification pass. `better-sqlite3` opens, writes, queries, and rebuilds successfully. A compliant solved Node/Python product matrix is not yet complete. |
| Linux arm64 container, Node 24.20.0, npm 12.0.2 | Observed repository/package path | After explicit toolchain and offline-cache preparation, the full 39-file/313-test suite, builds, and packed CLI passed in a disposable Linux instance. See [verification evidence](../build/evidence/phase-7-linux-portability-repair.md). This does not prove a native Linux host deployment or the solved Node/Python product matrix. |
| Native Linux host | Product-level verification outstanding | Complete factory erection, provider execution, and deployment still require host-specific evidence; container package checks alone do not establish those outcomes. |
| WSL2 | Unverified | Do not claim support until Phase 7 exercises and records it. |
| Node <24 or npm <12 | Unsupported | The package declares `engines` and the construction toolchain above. |
| Provider credentials | External prerequisite | Credentials remain in the vendor CLI/provider store and are not backed up by Faktori. |

For an update, the state format and release version are checked before any
activation. A supported migration is previewed and requires owner approval;
unsupported state is refused rather than silently rolled back. Install scripts
remain disabled globally; Faktori explicitly rebuilds only the pinned
`better-sqlite3` dependency and exercises `runtime rebuild` before selecting a
release.
