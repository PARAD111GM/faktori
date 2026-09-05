# Compatibility matrix

This is an evidence boundary, not a promise of indefinite backward
compatibility. Claims below describe the supported path in this phase; Phase 7
must add independent host evidence before expanding them.

| Host/path | Status | Notes |
| --- | --- | --- |
| macOS, Node 24 LTS, npm 12 | Phase 7 observed repository/package path | The pinned typecheck, 39-file/311-test suite, Console/package build, and clean packed-CLI verification pass. `better-sqlite3` opens, writes, queries, and rebuilds successfully. A compliant solved Node/Python product matrix is not yet complete. |
| Linux, Node 24 LTS, npm 12 | Documented target, unverified in Phase 7 | No independent Linux runtime was available. Use the same commands and a separate factory directory; do not infer support from the macOS Docker client. |
| WSL2 | Unverified | Do not claim support until Phase 7 exercises and records it. |
| Node <24 or npm <12 | Unsupported | The package declares `engines` and the construction toolchain above. |
| Provider credentials | External prerequisite | Credentials remain in the vendor CLI/provider store and are not backed up by Faktori. |

For an update, the state format and release version are checked before any
activation. A supported migration is previewed and requires owner approval;
unsupported state is refused rather than silently rolled back. Install scripts
remain disabled globally; Faktori explicitly rebuilds only the pinned
`better-sqlite3` dependency and exercises `runtime rebuild` before selecting a
release.
