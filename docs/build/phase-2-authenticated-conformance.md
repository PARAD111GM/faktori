# Phase 2 authenticated conformance evidence

Status: passed. The required authenticated Docker edit/test, exact-session
resume, durable cancellation, and recovery exercise completed. Build Manager
exact-head acceptance remains separate from this evidence.

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

No result was promoted from either attempt merely because the provider emitted
a terminal event. Both failures remain part of the evidence chain.

## Successful authorized exercise

The owner delegated the pending technical judgment, and the Build Manager
authorized the existing Docker-only inner-sandbox override for this bounded
scratch exercise. The option remained disabled by default, was accepted only
on an unchanged plan returned by the hardened Docker builder, and did not alter
native execution.

The resulting exercise observed all of the following:

- **Start:** the shipped coordinator, adapter, and Docker transport admitted one
  worker, changed only `fixture.txt`, ran `npm test` with exit 0, returned a
  structured `completed` result, and independently passed the fixture verifier.
- **Resume:** a second admitted run used the exact durable source session and
  same factory/product/repository/workspace/provider scope without `--last`,
  changed only `resume.txt` in addition to the prior fixture change, ran
  `npm run test:resume` with exit 0, returned `completed`, and independently
  passed the resume verifier.
- **Cancellation:** a third admitted run started the controlled `sleep 120`
  command. Explicit cancellation durably recorded authority revocation and
  termination intent before exactly one container stop. The container was then
  confirmed absent, the scratch status remained unchanged from before the
  cancellation turn, and the provider result correctly remained
  `interrupted_uncertain` because no native Codex cancellation receipt exists.
- **Recovery:** rebuilding the disposable SQLite projection from the journal
  produced `succeeded`, `succeeded`, and `cancelled` for the three runs.

The start reported 107,441 input tokens, of which 88,320 were cached, and 504
output tokens. The resume reported 229,156 input tokens, of which 204,288 were
cached, and 1,066 output tokens. Cached input is a subset of input, not an
additional total. The cancelled run emitted no usage telemetry; none was
invented.

All three actual containers used the immutable image, UID `65532:65532`,
`/workspace`, bridge networking, and only the workspace plus dedicated vendor
profile mounts. Observed environment keys were limited to `CODEX_HOME`, `LANG`,
`PATH`, and image-provided Node/Yarn version metadata. No host home, Docker
socket, controller storage, journal, or publisher credential/environment was
present.

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

## Remaining gate

The live evidence satisfies the F2-02 and F2-03 acceptance requirements. The
remaining phase gate is a clean assembled check and Build Manager acceptance of
the exact final candidate. No push, merge, deployment, publication, billing
change, or product effect is part of this exercise.
