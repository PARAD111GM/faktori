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
