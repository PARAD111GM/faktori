# Manager Loop proof of concept

Owner request: build only enough of the Manager / multi-session Implementer /
quality-loop pattern to test it. Plugin installation and a general workflow
framework are out of scope.

## Acceptance

- One documented CLI command runs an owner-configured, phased local project.
- An AI manager produces a bounded brief and evaluates the resulting evidence.
- Each phase uses a fresh implementer session, with independent review.
- Review findings drive a bounded repair loop, never automatic acceptance.
- Phase acceptance requires successful owner-configured verification and review,
  followed by the manager's decision. Failure and uncertainty remain visible.
- Durable records expose phase/session progress and results. Interrupted work
  is not blindly repeated. No automatic merge, push, or deployment.
- A small two-phase disposable project exercises the actual Codex CLI, using
  existing owner authentication. Report live outcomes separately from tests.

## Initial scope

Codex native execution only, with explicit owner-selected workspace and model
settings. This is host execution, not container isolation. Product Manager is
distinct from Factory GM. Existing provider primitives should be reused; no
second general scheduler, marketplace, plugin host, or dashboard redesign.

## Verification record

Verified on 2026-09-09 with the pinned Node 24.20.0 toolchain:

- Typecheck and production build passed.
- Full regression suite: 386 tests across 47 files passed with four workers.
- Installed-package CLI verification passed.
- Independent runtime review passed after correcting brief delivery,
  contradictory review decisions, workspace evidence, concurrent state access,
  and verification-to-repair handoff.
- Real Codex subscription execution used GPT-5.6-Luna at medium reasoning in a
  disposable repository. Two phases created `add` and `multiply` exports, with
  deterministic checks maintained outside the worker workspace.
- Both phases passed implementation, external verification, independent review,
  and Manager acceptance. Eight provider stages used eight distinct sessions,
  including two fresh implementers and two independent reviewers.
- A separate rerun of the external final checks passed. Product code remained
  uncommitted; no remote, push, merge, or deployment was performed.

The first live attempt accepted phase one but stopped at phase two because the
Manager interpreted its read-only turn as prohibiting later implementation.
The prompt was clarified to distinguish role-local restrictions. That blocked
run was preserved; the successful proof used a fresh disposable repository.

Bounded same-session repairs from failed verification and reviewer findings
were exercised in deterministic subprocess tests. The successful live proof
did not require repairs; do not describe live repair behavior as proven by it.
This validates the small two-phase concept, not arbitrary long-horizon quality,
container isolation, other providers, or unattended production operation.
