# Phase 2 authenticated conformance checkpoint

Status: authenticated execution reached the vendor CLI, but the required
edit/test/resume/cancel proof has not completed. This is retained failure
evidence, not acceptance.

## Boundary used

- An immutable local worker image ran as UID 65532 with `/workspace` as its
  working directory.
- The only writable mounts were the dedicated throwaway Git workspace and the
  dedicated Codex credential profile.
- No Docker socket, host home, controller storage, journal, publisher
  credential, or publisher environment was mounted into the worker.
- Host Docker control remained outside the container. Credentials remained in
  the vendor-owned profile and were never copied into evidence.
- The shipped `DockerCodexProcessRunner`, `CodexAdapter`, and
  `CoordinatorCodexDelivery` were composed by the private harness. Fixture
  state was verified independently of provider terminal events.

## Retained attempts

1. The first authenticated attempt used a 64-PID, one-CPU, 512 MiB worker. The
   vendor process failed while creating a thread with an operating-system
   resource-unavailable error. The adapter classified the result as
   `interrupted_uncertain`; the fixture remained unchanged. The attempt is
   retained privately as `.build/phase-2-auth-conformance-attempt-1.json`.
2. The second attempt raised the still-bounded worker limit to 256 PIDs and two
   CPUs. Authentication succeeded and structured thread, turn, command,
   completion, and usage events were observed. The inner Codex sandbox could
   not create its namespace inside the already hardened container, so it made
   no fixture edit. Although the provider emitted a terminal completion event,
   the harness rejected the run because the independently checked fixture was
   unchanged. This attempt is retained privately as
   `.build/phase-2-auth-conformance.json`.

No successful source session exists from these attempts, so resume and the
controlled long-turn cancellation proof were not run. No result is promoted
from a terminal event without the requested workspace effect and test receipt.

## Deterministic checkpoint after the attempts

The failure path led to additional production hardening through commit
`fa23242a19a05dacd171e0aff2f539d5379480f9`:

- explicit cancellation and runtime-bound termination coalesce into one
  durable authority hook and one worker stop path;
- hook failure sends no signal and permits a later authorized retry;
- native SIGKILL escalation requires exact, continuous process-group identity;
- leader exit is not treated as whole-process-tree exit;
- every nonzero PID inspection is `unknown`, and group absence is established
  through a separate full process-group observation; and
- a Docker-only inner-sandbox override is disabled by default and accepted only
  for an unchanged plan produced by the hardened Docker builder. A native
  transport cannot enable it by claiming an isolated intent profile.

The implementer and Build Manager independently ran the pinned Node 24.20.0
full check at that exact revision. Strict TypeScript, 18 test files with 158
tests, emitted build, and packed CLI verification passed.

## Remaining live gate

The vendor CLI documents its inner-sandbox bypass for environments that are
already externally sandboxed. Enabling that override is a security-significant
owner decision. No approval has been received, the option remains disabled,
and no bypassed execution has run.

If the owner approves the Docker-only override, the same dedicated profile,
immutable image, validated mount boundary, controlled environment, and scratch
workspace will be reused for one bounded edit/test run, exact-session resume,
and durable cancellation exercise. F2-02 and F2-03 remain `in_progress` until
those effects and boundaries are observed and the Build Manager accepts the
resulting exact head.
