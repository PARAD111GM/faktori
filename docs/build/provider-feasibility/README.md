# F0-03 provider-feasibility evidence

Status: **partial** (live native evidence gathered; no provider is yet approved
for an isolated Faktori worker). This record is public-safe: it contains no
account identity, token, absolute personal path, or provider session ID. Exact
local transcripts and scratch files are ignored under `.build/provider-feasibility/`.

## Method

The exercises used the already-installed vendor CLIs and their unmodified native
authentication. Each provider received a new, bounded scratch workspace. No
API key, login command, credential file, product repository, or external
service was changed. Commands were first checked against the official command
documentation and local `--help`; every run was bounded with a local timeout.

The status vocabulary is deliberately specific:

| Status | Meaning |
| --- | --- |
| `passed` | The stated behavior was observed in this exercise. |
| `blocked` | An external prerequisite stopped the exercise. |
| `unverified` | The transport exists, but the needed native behavior did not occur. |
| `uncertain` | The local wrapper terminated a process without a provider completion receipt. |
| `failed` | The exercise contradicted the safety assumption. |

## Capability matrix

| Provider / observed version | Launch + scratch edit | Explicit resume | Permission denial | Cancellation | Usage / capabilities | F0-03 judgment |
| --- | --- | --- | --- | --- | --- | --- |
| Codex CLI `0.146.0` | `passed` with `exec --json`, `workspace-write`, and an explicitly compatible model | `passed` for the recorded ID **when the wrapper OS cwd was the recorded scratch root** | `failed`: a `read-only` exercise still produced the requested scratch file | `uncertain`: SIGINT ended the wrapper with timeout exit `124`; no normalized cancellation event was emitted | JSON completion included input, cached-input, output, and reasoning-output counters; local `exec --help` confirms explicit `resume` | A wrapper must `chdir` to its recorded workspace before spawning resume and independently enforce write isolation. |
| Claude Code `2.1.207` | `passed` through native subscription headless `-p` streaming JSON and one scratch edit | `passed` with an explicit recorded ID when OS cwd was the recorded scratch root | `passed` only as tool-suppression: `manual` plus no available tools left the scratch unchanged; no native denial event was emitted | `uncertain`: wrapper sent SIGINT to its bounded command group and exited `124`, while the stream's terminal record remained `completed` | Successful stream result exposed input, output, cache, model, service-tier, and iteration fields; subscription output cost metadata is not invoice evidence | Native launch/resume work; permission-reply and provider-cancellation receipts remain unproven. |
| Cursor CLI `3.19.7` (build `90de232…`, arm64) | `passed` through ACP stdio with `initialize`, existing-login `authenticate`, `session/new`, and one scratch edit | `passed` using documented `session/load` with the explicit prior session ID | `passed` for direct project-policy blocking; `unverified` for ACP reply semantics because no `session/request_permission` was emitted | `passed`: a documented `session/cancel` notification returned `stopReason: cancelled` | `initialize` advertised `loadSession: true`; no token/cost/usage event was observed in this minimal ACP flow | Promising transport, but a coordinator cannot claim interactive permission-reply support from this profile. |
| Docker `29.5.3` / Docker Desktop | `passed` for an unprivileged, network-disabled, read-only-root, tmpfs-only container; a shared temporary scratch bind also passed with read-only mount enforcement | N/A | N/A | N/A | Local help confirms `--network`, `--mount`, `--read-only`, `--user`, and `--workdir` | Scratch bind mechanics are proven; the assigned worktree is not currently shareable, and authenticated isolation/durable workspace design remain unverified. |

## Observed commands (portable, session IDs omitted)

The paths below are placeholders for an ignored scratch root. They are not a
prescription to copy credentials into a container.

```sh
# Probe first
codex --version && codex exec --help && codex exec resume --help
claude --version && claude --help
cursor --version && cursor agent acp --help
docker --version && docker run --help

# Codex launch (a known compatible model was required by the installed CLI)
timeout 75 codex exec --json -m gpt-5.5 -s workspace-write \
  -C <scratch/codex> 'Create only codex-scratch.txt ...'

# Codex recovery: launch from the recorded scratch OS cwd; never --last
cd <scratch/codex> && timeout 75 codex exec resume --json -m gpt-5.5 \
  <recorded-session-id> '...'

# Codex sandbox observation, only in a dedicated ignored scratch directory
timeout 75 codex exec --json -m gpt-5.5 -s read-only -C <scratch/permission> '...'

# Claude native subscription launch in a dedicated scratch
timeout 75 claude -p --output-format stream-json --verbose \
  --include-partial-messages --session-id <new-uuid> '...'

# Claude explicit resume: launch from its recorded scratch OS cwd, never --continue
cd <scratch/claude> && timeout 75 claude -p --output-format stream-json --verbose \
  --resume <recorded-session-id> '...'

# Claude tool-suppression check in a separate scratch (not native approval evidence)
timeout 75 claude -p --permission-mode manual --tools '' --session-id <new-uuid> '...'

# Claude bounded process-group interruption; receipt remains required for a cancellation claim
timeout -v -s INT -k 5 12 claude -p --output-format stream-json --verbose '...'

# Cursor ACP tests; raw session IDs stay in ignored local transcripts
timeout 55 node scripts/provider-feasibility/cursor-acp-exercise.mjs allow
timeout 55 node scripts/provider-feasibility/cursor-acp-exercise.mjs allow <recorded-session-id>
timeout 55 node scripts/provider-feasibility/cursor-acp-exercise.mjs cancel

# Docker mechanics only: no host-home/auth mount and no network
docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --user 65534:65534 --workdir /tmp python:3.12-slim python -c '...'
```

## Transport and safety findings

1. **Codex defaults are not safe to assume.** The configured default model was
   rejected by the installed CLI as requiring a newer version; an explicit
   compatible model completed the same scratch edit. A coordinator must probe
   and record effective model compatibility before reservation or launch.
2. **Codex resume needs a pre-launch workspace guard.** Local
   `codex exec resume --help` has no `--cd` or sandbox option. An earlier
   resume was launched from the repository root and therefore wrote there; that
   was a harness defect, not evidence that explicit resume ignores its process
   cwd. The correction launched the same explicit session ID with the OS cwd
   set to the recorded scratch root and its only file-change event stayed in
   that scratch root. The wrapper must `chdir` to the recorded workspace before
   spawn and refuse to start if its OS cwd is not that value. Checking an
   escaped file event after a write is evidence, not enforcement.
3. **Codex `read-only` cannot yet be accepted as enforcement evidence.** In
   this installed configuration, the attempted scratch edit still completed.
   Treat provider sandbox labels as capabilities to verify per launch, not as a
   substitute for coordinator isolation.

### Codex control-context audit (non-secret)

The failed read-only exercise was launched with the public command shape above:
`exec --json -m gpt-5.5 -s read-only -C <dedicated-scratch>`. It did **not**
pass a profile, either dangerous-bypass flag, or an ignore flag. Local help
defines `-s/--sandbox` as the sandbox-policy selector and exposes the separate
`--profile`, `--ignore-user-config`, `--ignore-rules`, and dangerous-bypass
controls.

Only control names—not values or configuration payloads—were inspected. The
process had sandbox-related Codex environment variable names, and the loaded
user configuration contains model, sandbox, and approval-policy key names. The
assigned worktree has `AGENTS.md` and no discovered `.rules` file. Because the
run did not use `--ignore-user-config`, inherited user configuration remains a
possible influence; this audit cannot attribute the observed write to either a
CLI defect or a specific inherited setting without inspecting prohibited values
or repeating a write-capable test. The observed completed write is therefore a
failed enforcement result, regardless of cause. A later controlled adapter test
may isolate user configuration, but it must remain a dedicated-scratch test.
4. **Claude native launch and resume are now observed.** After an
   owner-performed vendor login refresh, a fresh headless stream created the
   dedicated scratch file, and `--resume <recorded-id>` changed only that file
   when its OS cwd was the recorded scratch directory. The successful stream
   exposed input/output/cache counters, model usage, service tier, and
   iterations. Its `total_cost_usd` metadata must not be treated as a new API
   invoice or subscription charge. A first `--disallowedTools Write` test still
   wrote via a different available tool, which was an insufficient harness
   policy rather than evidence of provider permission bypass. A stricter
   `--permission-mode manual --tools ''` run left the target absent, but emitted
   no native `permission_denials` record: this proves tool suppression only.
   A process-group timeout sent SIGINT, yet the wrapper exited `124` while the
   provider stream retained `terminal_reason: completed`; it is not a provider
   cancellation receipt.
5. **Cursor ACP is a real stdio/JSON-RPC integration point.** It advertised
   `loadSession`, accepted existing Cursor login, resumed an explicit session,
   and honored `session/cancel`. Permission reply support is documented, but
   this profile generated no request, so denial behavior remains unproven. The
   documented controlled-profile mechanism is a project-local
   `.cursor/cli.json` `permissions` object, whose required `allow` and `deny`
   arrays support `Write(...)` and `Shell(...)` patterns. In a disposable
   ignored project, a policy denying both general write and shell tools left the
   target file absent. No `session/request_permission` appeared, so the result
   is direct policy blocking—not evidence that the ACP client can answer native
   approval requests. The current ACP help exposes no per-session
   permission-profile switch, and the documentation does not promise that a
   denied rule will emit a request rather than directly refusing the tool.
6. **Docker did not prove credential isolation.** The no-mount mechanics test
   proves selected flags can run; it does not prove vendor CLI authentication
   works in a container. In the current Docker Desktop `desktop-linux`
   environment, the assigned worktree source is outside the Desktop shared
   locations: host `stat` saw it while the daemon reported it absent. A bounded
   test in an already-shared temporary scratch then passed with network disabled,
   read-only root and bind mount, dropped capabilities, no-new-privileges,
   non-root UID, workspace visibility, absent Docker socket/host home, and an
   expected read-only write rejection. Scratch bind mechanics are therefore
   proven; authenticated isolation and the durable job-workspace design are not.
   Do not move, copy, or mount a personal vendor-auth profile to work around
   those remaining limits.

## Evidence pointers and official references

- Local raw launch/resume/cancel output: ignored
  `.build/provider-feasibility/transcripts/`.
- Local scratch artifacts: ignored `.build/provider-feasibility/workspaces/`.
- Reusable ACP client: `scripts/provider-feasibility/cursor-acp-exercise.mjs`.
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
  documents `codex exec`; local help established the exact installed resume flags.
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
  documents print mode, `stream-json`, result metadata, and streaming events.
- [Cursor ACP](https://cursor.com/docs/cli/acp) documents stdio JSON-RPC,
  explicit `session/load`, permission requests, and `session/cancel`.
- [Cursor CLI permissions](https://prod.cursor.com/docs/cli/reference/permissions)
  documents project-local `.cursor/cli.json` allow/deny patterns; it does not
  document an ACP launch parameter that forces a permission request.
- [Docker run](https://docs.docker.com/engine/containers/run/) documents the
  container controls exercised above.

## Integration request

The Phase Implementer should preserve this ticket as partial and add the
following Phase 1 gates before enabling a live provider adapter:

1. Keep Claude authentication in its vendor-owned login flow. Before admitting
   it for autonomous work, obtain a native permission-denial receipt and a
   provider cancellation receipt; tool suppression and wrapper SIGINT are not
   substitutes.
2. Design a durable job workspace inside an approved Docker Desktop shared
   location, then test a bind-mounted job workspace with **no** home/auth mount.
   If a CLI needs a
   vendor login inside that isolation boundary, stop and present that exact
   owner-login requirement; do not infer that native auth transfers.
3. Implement an adapter preflight that rejects an incompatible Codex model,
   verifies effective sandbox behavior, persists expected workspace identity,
   `chdir`s before an explicit resume spawn, and treats process signal
   termination as `interrupted_uncertain` unless a provider cancellation receipt
   is received.
4. Cursor's disposable project policy already blocks its target write directly.
   Find a supported configuration that produces a real ACP
   `session/request_permission`; only then verify `reject-once` leaves the job
   workspace unchanged. Add usage reporting only when Cursor actually exposes
   it through the supported transport.

## Phase 0 feasibility exit recommendation

**Met for bounded native profiles.** Observed authenticated launch and explicit
resume now exist for Codex, Claude Code, and Cursor, with provider-specific
capability reports and truthful limitations. This establishes the narrow Phase
0 question: Faktori can model and launch bounded native transports without
intermediating credentials.

**Not met for isolated authenticated execution.** Docker scratch mechanics do
not prove a durable authenticated job workspace; Codex read-only enforcement
failed under an unresolved control context; and Claude/Cursor native
permission-reply/cancellation mechanics are not fully evidenced. Keep isolated
authenticated execution as an explicit F2/F3 gate. These are limitations of
specific native mechanics, not a claim that all provider transports fail.
