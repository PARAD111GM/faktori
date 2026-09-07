# Phase 7 cold-start evidence

Evidence date: 2026-09-05. Public-flow implementation commits:
`46342a9c0d88e5fe1ec762910221d6dc3ad63d97` and
`121a4c34f46f1969b5d555be1f7727766bddfe7e`.

This record separates factory erection, provider execution, product acceptance,
scope compliance, and restart behavior. A success in one column is not used as
evidence for another.

## Attempt 1: empty provisioned product

A fresh specialist installed and built the packed public kit in a new temporary
root, completed the documented interview/approval/apply flow, and started the
Console. The resulting product repository was empty: provisioning had no
approval-bound way to import the requested local starter, and the public
Console path had no command that assembled a work item from an accepted product
request. No product run was claimed as evidence.

The product defect was repaired in `46342a9`: a proposal now binds each declared
local source to sorted, no-follow file bytes and modes; apply revalidates before
and during exclusive copying and verifies the final manifest. Symlinks, special
files, concurrent source mutation, and implicit adoption of a parent Git
repository are rejected. Provisioning creates an exact product-local Git root.
The new `faktori console prepare` command validates that product and emits a
digest-bound native Codex work item without claiming an unsupported hard token
cap.

## Attempt 2: functional result with invalid scope

The repaired public flow then completed a real single-provider task-board run:

- the proposal, accepted configuration, approval, imported six-file source,
  generated work item, starting commit, and run were bound by recorded digests;
- the native Codex route used `gpt-5.5`, completed in about 5 minutes 5 seconds,
  emitted 82 normalized events, and reported 488,058 input, 7,320 output, and
  439,168 cached-input tokens (495,378 reported aggregate tokens);
- the unchanged frozen browser acceptance passed 1/1 in about 14.85 seconds;
  and
- Console state exposed the one succeeded run and its partially reported usage.

That runtime success is **not** a compliant cold-start result. Immutable run
evidence shows the provider deliberately inspected a user memory file outside
the product despite the work-item constraint. The product also ended dirty with
an external `node_modules` symlink rather than a product-local declared
dependency, and the provider used an ambient approval path for a loopback test.
No release or task acceptance is inferred from the passing test.

The first Console was also interrupted through an npm/npx wrapper, leaving one
claim and no release. Its coordinator PID was gone, but restart failed closed as
`unknown`; no lock or journal file was manually removed. That exposed a separate
recoverability defect.

## Repairs and deterministic verification

Commit `121a4c3` makes Console ownership use the exact observed native process
start time and process group. Restart reclaims a coordinator lock only after a
successful complete process listing proves the exact PID absent; PID reuse is a
mismatch and observation failure stays unknown. Worker recovery deliberately
stays group-aware and is not weakened by coordinator evidence. The preserved
Attempt 2 factory was then restarted without deleting or editing lock/journal
state, showed the original succeeded run without another provider final, shut
down cleanly, and repeated a second clean start/shutdown. The journal contained
three claims, two releases, and exactly one provider final.

The same commit adds an explicit bounded native Codex route. It asks the
unmodified CLI to ignore user configuration and rules, disables memories, apps,
plugins, and agent fanout, enables strict configuration, fixes approval policy
to `never`, and fixes the sandbox request to `workspace-write`. The work-item
prompt forbids ambient/outside reads and external links and requires any
already-approved offline dependency to be declared in the product manifest and
lockfile and installed product-locally. A no-inference CLI prompt diagnostic
validated the configuration and found zero memory markers. These controls
suppress known ambient context and escalation; they do not constitute native
filesystem read isolation, which remains available only through the validated
container profile.

## Authorized bounded rerun

The Build Manager authorized one new native task-board run below a 98%-used
account threshold, with no retry, reset credit, paid route, new network service,
or hidden dependency repair. The preflight was 96% used. The same committed
public kit erected a third fresh factory, bound the source, configuration,
approval, initial Git head, prepared work item, and one native `gpt-5.5` run,
and recorded `maxRetries: 0` plus the bounded route. Exactly one run reached
`succeeded`; there was no retry or resume. Its 97 journal events contained one
admission, one worker start, one provider final, one usage observation, and one
reservation release. It reported 633,403 input, 13,086 output, and 586,368
cached-input tokens (646,489 Console aggregate tokens). The product's test
command reported 1/1 in 2.03 seconds, but that result was not trusted because
the test dependency had been substituted.

This result also remains **scope-invalid**. The product declared exact
`playwright` 1.55.0 and wrote a v3 lockfile, but the real offline install failed
with `ENOTCACHED`; the provider then wrote a minimal product-local compatibility
package under `node_modules/playwright`. That is neither the genuine dependency
nor a valid product-local offline installation. The final Git head remained the
initial head and the work was uncommitted. No symlink or hardlinked file was
present, and the event scan found no user memory or config-file read, but the
journal still contained a host-home path, so absence of all outside-path reads
was not established.

An independent deterministic rerun then invoked the unchanged frozen browser
contract from Faktori's genuine installed Playwright against the Attempt 3
server. It failed at the final delete-after-restart assertion: one `Persisted
task` remained where zero was required (`1 !== 0`). This is separate evidence
that the substituted test harness masked a real product behavior defect.

Clean CLI shutdown and restart required no journal/lock deletion, projected one
succeeded run with zero active/failed runs, and created no second provider
final. Restart recovery therefore passed independently; product behavior
did not pass trusted acceptance, and cold-start scope and portability also
failed. F7-01 remains blocked rather than accepted.

## 2026-09-06 continuation prerequisite

The trusted Node 24/Chromium envelope now reproduces the unchanged frozen
baseline, so the earlier aggregate timeout is no longer the first F7-01 gate.
The previously sanctioned isolated container credential profile is absent, and
no approved provider-authentication profile exists under the Docker-shared
scratch boundary. Host provider credentials were not copied or exported.

No new F7-01 provider run was attempted. A compliant continuation requires a
fresh vendor-owned login inside the unchanged hardened worker (or another
explicitly approved equivalent) before public onboarding and product work may
begin. Native host provider execution for the separate TWZ-83 comparison is a
different authority decision and does not satisfy this cold-start isolation
gate.

## 2026-09-07 isolated attempt

After a fresh vendor-owned login and direct informed owner approval, one
bounded worker used the immutable Node 24/npm 12/Chromium/Codex image and only a
disposable workspace plus dedicated credential-profile mount. The tracked
public snapshot remained byte-identical. Public proposal, approval, apply, and
replay all succeeded; the unchanged browser contract passed in the worker and
again in a credential-free, network-disabled controller rerun.

The run stopped at the required final product commit because the provisioned
repository had no local Git author identity. The output therefore remained
staged and F7-01 was not accepted. Controller inspection also found npm's two
normal product-internal `.bin` symlinks, so the literal no-symlinks-anywhere
criterion was not met. Commit `9f0cdba` repairs the isolated commit prerequisite
with a neutral repository-local Faktori identity and focused tests, but no
second provider run was authorized. Exact sanitized evidence is in
`docs/build/evidence/phase-7-isolated-cold-start-2026-09-07.md`.

## 2026-09-07 repaired rerun and manager boundary

The owner later authorized exactly one repaired rerun. It used public revision
`7355410`, genuine product-local Playwright 1.63.0 installed with bin links
disabled, and the same hardened worker boundary. Proposal, approval, apply,
replay, final product commits, a clean complete-tree link check, retained
configuration resolution, and the unchanged frozen browser contract all
passed. A credential-free, network-disabled controller rerun passed the same
contract after the final commit, and the public snapshot remained byte-exact.

This still does not close F7-01. npm 12 blocked the native SQLite install script;
although a subsequent read-only controller diagnostic proved the included
Linux native artifact can open, write, and query, the fresh worker did not make
that documented observation. More importantly, it did not prepare or start the
loopback Console or prove canonical factory projection. The Build Manager
therefore rejected completion: a finished product and durable provisioning
records are not by themselves a usable factory. No further provider turn was
authorized. Exact evidence is in
`docs/build/evidence/phase-7-isolated-cold-start-rerun-2026-09-07.md`.

## Runtime-only continuation and preparation repair

One additional owner-authorized continuation resumed the exact isolated
session solely for the missing runtime observations. It completed the narrow
`better-sqlite3` rebuild and real open/create/insert/query/close check, preserved
the product commit, and launched no Faktori provider. Public Console preparation
then failed closed because the only preparer required a native Codex work item,
while the approved factory is isolated and strict-spending. The agent did not
weaken configuration or hand-write a Console file.

Commit `5784f41` adds an explicit approval-bound projection-only preparation
mode with no provider, work item, resume, or GM authority. A real loopback test
proves canonical factory/product/pod projection and zero work nodes for an
isolated strict-spending factory. This repair was made after the authorized
continuation stopped, so F7-01 remains blocked pending fresh-agent validation on
the repaired public revision. Exact evidence is in
`docs/build/evidence/phase-7-console-continuation-2026-09-07.md`.

## Fresh installed Console validation

The owner subsequently authorized fresh validation on public revision
`af958a28`. After several truthfully retained harness and environment stops, a
final fresh agent ran a deterministic, provider-free-checked harness in the
hardened non-root worker envelope. It built and packed the public kit, installed
the tarball into a separate consumer, exercised real SQLite in both trees, and
used only the installed CLI to prepare projection mode. Two real TCP HTTP reads
across a clean SIGTERM restart each returned the canonical factory,
`task-board`, and `task-board-pod` hierarchy with zero work nodes. The prepared
file contained no execution authority, the runtime journal contained only two
claim/release pairs, the product stayed clean at its accepted commit, and the
container was removed.

Exact sanitized evidence is in
`docs/build/evidence/phase-7-console-fresh-validation-2026-09-07.md`. This closes
the known fresh-agent runtime evidence gap. The Build Manager independently
inspected the harness and artifacts, recomputed all three evidence hashes, and
accepted exact head `a4dff21` for this outstanding F7-01 scope. The acceptance
is precisely harness-assisted validation using the retained approved factory,
not a new unaided cold start or provider orchestration through projection mode.
