# Recoverable runtime

Phase 2 adds one coordinator-owned local execution loop. Its operational JSONL
journal is authoritative; SQLite is a disposable query projection that can be
rebuilt with:

```sh
faktori runtime rebuild <journal.jsonl> <projection.sqlite>
```

Every launch, resume, termination, and admitted action records an intent before
the effect and a receipt afterward. A committed malformed journal entry blocks
startup. Only an unterminated final tail is discarded. An intent without a
receipt remains unresolved and is not silently retried.

`CoordinatorCodexDelivery` is the thin shipped bridge from an already-admitted
run to one actual Codex worker. It verifies the exact context reference (and a
durably proven source session for resume), appends the launch or resume intent,
and accepts the worker identity only from that transport's start callback.
Provider events, final result, usage availability, and reservation disposition
then enter the same journal. A second preliminary worker is never launched.

One coordinator owns a factory. Ownership and worker records include start-time
identity, not only a PID. Heartbeat expiry never proves a surviving process is
gone, and an unknown or mismatched probe result blocks the affected work.
Admission serializes concurrency, retry, runtime, and estimated-token
reservations. Missing provider usage is unknown, not zero. A strict spending
policy is refused when the selected route cannot enforce a hard cap.

## Execution profiles

Native execution records that the worker receives the broader access of its
operating-system identity. It is not equivalent to isolation.

The isolated profile stages each job under an explicitly approved Docker-shared
scratch root. It uses a non-root user, read-only container root, bounded CPU,
memory and processes, dropped capabilities, no-new-privileges, a private
temporary directory, and explicit mounts:

- one writable job workspace;
- approved read-only inputs;
- at most one selected provider credential profile.

Networking defaults to `none`. Provider access requires an explicit `bridge`
decision; host networking is unsupported. The provider profile defaults to
read-only and can be made writable only when the unmodified vendor CLI must
write its own session or refresh state. The profile never includes host home,
the Docker socket, the factory journal, or GitHub, Jira, publisher, and
deployment credentials.

The `faktori/execution/transports` package entry exports argv-only native and
Docker CLI transports. They use the plan's exact working directory and
environment rather than inheriting host variables, bound stdout and stderr,
and report PID/start-time/process-group or container-ID/start-time identity.
Deadline or output-bound termination calls the coordinator-supplied durable
termination hook before signaling the process group or stopping the container.
Docker log following begins before `wait`, so an `--rm` container cannot erase
its output before collection.

The base-digest-pinned Codex worker image can be built locally:

```sh
docker build --file docker/codex-worker.Dockerfile \
  --tag faktori/codex-worker:0.146.0 docker
```

An isolated run accepts only a registry digest reference or an immutable local
`sha256:` image ID; a mutable tag is not an execution identity.

Authentication remains in the vendor CLI. Create a dedicated profile below the
approved shared scratch root and run `codex login --device-auth` inside that
image with only the job workspace and dedicated profile mounted. Do not copy a
host profile, token, or home directory into the container.

## Provider and action boundaries

The Codex adapter uses `exec --json` and explicit session resume in the
recorded OS working directory with an explicit compatible model. It never uses
`--last` or silently widens sandbox settings. Completed, unchanged and
verified, denial, authentication, quota, failure, cancellation, and uncertain
interruption remain distinct. A wrapper exit without a native cancellation
receipt is uncertain.

Provider output is evidence, not action authority. The controller mints a
per-run HMAC capability bound to the admitted run, immutable repository,
branch, base and expected revision, operation scope, and current authority
epoch. Public records contain only verification metadata; the verifier secret
stays in controller storage. The controller persists action intent, rechecks
current authority at the local effect boundary, and records the result.
Duplicates return the stored receipt, while forged, stale, replayed, revoked,
or unresolved requests cannot perform another effect. Remote publication
transports remain Phase 4 work.

See the executable [interrupted-run example](../../examples/runtime/README.md)
for a projection rebuild that truthfully retains an unresolved launch.
