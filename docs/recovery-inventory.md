# Delivery recovery inventory

Baseline: Faktori `f7ced4959e6bdf43658ae56b6df9fc7750ea3d4a`, Triforge
`ca0c70dbed3f2ae2bf53292b9e09c346ae6a462d`. Owner approved the recovery plan
on 2026-09-11. This record is an implementation baseline, not release acceptance.

| Responsibility | Reuse | Repair / missing | Observed capability |
| --- | --- | --- | --- |
| Jira | Existing REST action executor, Console observer; Triforge rank/dependency policy | Active-sprint reads, correlated lifecycle synchronization, discovered transitions | No Jira connector available in this construction task; installed authorization unverified |
| GitHub | `gh` transport, registered PR observer, exact-head progression, deployment verification | Connect evidence to authorized Jira transitions regardless of PR author | Read-only remote Triforge revision check succeeded; product mutation and deployment not tested |
| Codex Foreman | Private Manager relay, durable claims, uncertain restart recovery | Shared admission gate and native-goal/bootstrap evidence | Construction goal activated; app bridge idle wake-up and product builder goals not verified here |
| Slack | Triforge allowlisted router, PR-thread and receipt recovery design | Durable intent, serialized subject delivery, ambiguous-result reconciliation | Read of recorded Twinzy PR channel returned `channel_not_found`; no n8n management connector available |
| Console | Work catalog, sanitized artifacts, Jira/PR observers, task links | Artifacts navigation and readiness visibility | Source inspected; current installed backend not restarted |

Triforge n8n records are not necessarily executable exports or proof of live
configuration. Retrieve deployed workflow definitions through the authorized
operator before changing routing. Never copy credentials from another task.
Slack HTTP 500 after a successful post is a documented historical failure mode,
not a diagnosis of the overnight incident. No live notification was sent here.

## Boundaries and recovery

Use one Foreman and at most three ticket builders. Jira owns tickets; GitHub owns
PR/merge/deployment evidence; Codex owns execution; Slack owns notification
receipts; Console projects these facts. Asad retains merge authority. No timed
authority transfer, new billing, product provider activation, or worker restart.
Opt-in configuration must not change existing admitted work. A source/transport
failure stops affected new admission, preserves records and permits unrelated
work. Unknown submission is reconciled, never blindly repeated.

## Release gate

Local tests cannot establish the connected journey. Release acceptance remains
pending until an authorized Jira ticket is claimed, a visible goal-driven builder
delivers a PR, substantive review passes, Slack delivery is verified, the merge
owner merges, deployment and staging acceptance pass, and Jira/Console reconcile.

## Construction verification — 2026-09-11

Graph/readiness fixes at `08a5a367ff3155ccc43622c164b078272436f587` passed
typecheck, build and the focused graph/admission suites (12 tests). Independent
read-only review verified both final fixes: current tracker blockers override
older satisfied graph evidence, and readiness expiry uses applicable checks.

The serial full-suite run completed with 574 passing tests across 77 files.
That run began at `67ecf6e` and overlapped the final two regression fixes; the
focused suites above were rerun after those changes. Earlier concurrent runs
had timeouts, not assertion failures; their unchanged affected suites passed
when run alone. No timeout threshold was weakened.

Packed CLI verification passed under Node 24.20.0 / npm 12.0.2 in a clean
temporary install. The final source was rebuilt after the last fix. These
receipts establish local construction behavior, not installed integration,
native task wake-up, notification delivery or staging acceptance. No product
worker was restarted and no release was published during this verification.

The subsequent owner-triggered graph enqueue change at `c4b3c87` passed build,
typecheck and 49 Console/relay/prepare tests. A further focused admission test
also passed after closing and reopening the relay: refreshed passing readiness
still cannot authorize a request queued with older evidence. This is an
owner-triggered queue operation, not proof of automatic replacement dispatch or
platform task execution.

Final catalog-binding repair at `0e2226d` passed independent read-only review,
typecheck, build and six focused graph/admission tests. A queued claim now checks
the actual catalog bytes through readiness, not only the earlier observer
snapshot. Owner-triggered graph enqueue is connected in Console startup.

Live access recheck: Slack channel-name searches for `twinzy` and the documented
`pr-review`, including visible private channels, returned no results. This does
not prove those channels are absent; this task's connected Slack identity cannot
currently discover them. No Jira or n8n connector is exposed here. An authorized
operator or connected environment is needed for the deployed capability report;
credentials must not be copied into the construction task.

### Still incomplete, not merely unverified

The installed automatic observer-to-signed-action composition and desktop task
launch remain incomplete. A
verified idle-Foreman wake-up is
also not supplied by a readiness document. These remain implementation/integration
work; granting access alone will not make this release complete. The connected
staging exercise remains the release gate after those seams are finished.

### Queue replenishment increment

At `7e2213b`, opt-in automatic queue replenishment is connected to Console startup.
The actual service startup queues A; its next timer evaluation after cancellation
queues eligible B. Relay reservations prevent duplicate selection, including
uncertain work, and terminal assignments do not become new implementation work.
The same private packet, catalog and readiness bindings apply. Build, typecheck
and 52 Console/relay/graph regression tests passed. This advances automatic queue
replenishment only: a queued request is not a launched desktop task, a native goal,
a delivered notification, or accepted product work.

### Native goal capability probe

On 2026-09-11, vendor CLI `codex-cli 0.146.0` answered a read-only
`thread/goal/get` for the explicitly named Foreman task
`01a08469-997a-7070-a2dc-677638594579`: an active goal with a nonempty objective
was observed. No objective text or credentials were exported. The probe sent
only initialize, initialized and goal/get; it did not resume the task, start a
turn or set a goal. Its initial sandboxed attempt could not initialize Codex's
local SQLite runtime; the authorized local retry returned the observation.

The default managed app-server control socket was absent. A short-lived stdio
server nevertheless read the persisted goal. This proves native goal observation,
not a shared desktop connection, matching approved sprint objective, live worker,
task launch or wake-up. The bounded `sprint goal` diagnostic exposes this seam;
other readiness checks and the connected delivery release gate remain separate.

The implemented source CLI was then exercised against the same named task at
`2026-09-11T17:22:53.924Z` and returned `status: active`, exit 0. Its focused
behavior tests passed (three cases covering the read-only protocol, transport
failure and evidence classification), and strict typecheck passed. This is
read-only native-goal integration proof, not proof of the complete sprint.
The final goal/admission regression run passed eight tests across two files;
build passed and independent read-only review cleared the repaired protocol,
redaction and process-cleanup boundary.

### Fresh goals at execution handoff

Recovery-mode relay claims now query the native Foreman and builder goals before
recording the claim. The final focused regression run passed 29 tests across
four files, including an ended builder goal leaving work queued, active goals
allowing a claim, and artifact changes during observation blocking admission.
Typecheck, build and independent read-only review passed. Enqueue, dashboard
polling and legacy relays remain free of native goal probes. This closes the
stale-goal handoff gap; it does not launch desktop tasks or prove callbacks.

### Live Triforge operator-route inspection

On 2026-09-11 the existing GitHub `ops` route was readable. Run `34627149163`
was observed in progress for TWZ-81 at Triforge revision
`ca0c70dbed3f2ae2bf53292b9e09c346ae6a462d`; preceding runs `34624318592` and
`34621444455` had failed. Thus an old scheduler is still issuing work; a new
Faktori scheduler must not assume exclusive ownership from local Console state.

The completed run `34624318592` failed at publication: GitHub refused creation
or update of `.github/workflows/pr-playtest.yml` by the publisher App without
`workflows` permission. This is a publishing capability failure, not a builder
quality or merge-owner response failure. An authorized App owner must resolve
the permission boundary or approve a different publication route. No permission
was changed, run cancelled/retried, notification sent, or product file edited.

The repository's `ops.yml` defaults `deploy` to true and syncs source before
execution; it must not be invoked as an innocent status probe. No workflow was
dispatched during this inspection. Jira/n8n direct connector access remains
unavailable to the construction task. Required recovery preflight now includes
`dispatch_ownership`, with existing workers and scheduler scope reconciled before
new admission; a source-defined check is not a claim that live cutover occurred.
The focused admission/graph regression passed six tests, with strict typecheck
and build passing after the required-check addition.

### Publisher permission recovery

On 2026-09-11, after the owner approved the installation update, GitHub's
installation API for `triforge-publisher` installation `157373512` reported
`workflows: write` alongside its existing contents and pull-request write
permissions. The installation grant is now verified; successful publication is
still a separate gate.

Run `34641023779` retained TWZ-81 candidate
`24a33286f98cb3998665abea0fedf5bbd44f2082` in
`/bundles/job-20260911-195051-TWZ-81`. Its builder completed successfully;
publication was refused for `.github/workflows/ci.yml`. No PR was returned for
`feat/pipeline-TWZ-81-pr-playtest` during reconciliation. The active Twinzy
Foreman received this evidence and a publish-only recovery handoff using the
existing authentication route, subject to current candidate/job reconciliation.
No replacement builder, workflow retry, deployment or merge was initiated by
this construction task. Approval of the App permission does not clear review,
merge authority, scheduler ownership or the connected staging release gate.

The resumed source pass removed the Slack adapter's hardcoded `TWZ-` ticket
restriction. A non-Twinzy project ticket now reaches the configured route;
invalid keys and unapproved destinations remain rejected. All ten Slack outbox
behavior tests, strict typecheck and build passed, with an independent read-only
review reporting no findings. These are deterministic local tests, not a live
Slack delivery receipt.

### Observation-to-action construction increment

The resumed build added a live inspection reconciliation adapter and a signed
delivery-transition controller. Fresh Jira status and GitHub checks replace
stored snapshots; closed/unavailable/out-of-sprint or mismatched work cannot
advance. Retained independent review and deployment/acceptance evidence must
match current revisions. PR identity is included in operation idempotency.

The production constructor always connects the post-reconciliation evidence
check before the existing final authority guard. It consumes existing grants;
it does not mint authority. Repeated/concurrent synchronization and uncertain
prior actions do not submit duplicate writes. The final focused run passed 22
tests across composer, observation, inspection and Jira suites. Independent
review verified the repaired PR-identity and mandatory-hook boundaries.

At this increment, Console startup configuration, durable installed authority
bindings and actual observation sources were not yet connected. These components
do not by themselves restore the installed factory. The earlier integration
suite had one localhost-server failure under the sandbox; all five deployment
adapter tests passed when rerun with loopback binding permitted. No product
deployment was performed by that test.

### Opt-in Console connection

Console startup now accepts explicit `deliverySynchronization` configuration and
projects its sanitized status into Factory and the Console API. It remains off
when omitted. Missing private packets keep the Console available but visibly
blocked; the runtime uses existing grants and action journals, not new authority.
Evaluation begins only after the Console listener and initial startup succeed.

The three startup behavior tests passed with temporary loopback binding allowed,
including disabled operation, missing-packet failure, and an occupied-port check
that proves no delivery evaluation starts after failed binding. Typecheck and
the Console/runtime build passed. The final focused run passed 32 tests across
startup, runtime, composer, observation, inspection and Jira. Runtime tests prove
a completed transition, runtime restart without a second write, missing signed
bindings, packet expiry/change, revoked authority and unresolved prior effects.
Repository storage (including symlinked parents) is rejected. The Jira/GitHub
boundaries in these tests are simulated; they are not live integration proof.

Independent review verified the storage/status fixes and the narrowly scoped
in-flight action exception: only this invocation's freshly admitted intent can
pass its final guard, never an older unresolved action. The initial positive
test exposed a denied action hidden by incorrect monitoring status; this was
fixed rather than counted as successful synchronization.

No active installation was changed. Installed signed bindings, actual approved
Jira/Slack capabilities, native-task completion transport and the connected
staging journey remain unproven. Tool discovery in this task still exposes no
Jira or n8n management connector. This is not a release-acceptance claim.

### Live publication recovery observation — 2026-09-11

Read-only GitHub inspection now confirms the retained TWZ-81 candidate
`24a33286f98cb3998665abea0fedf5bbd44f2082` is published as
[Twinzy web PR #341](https://github.com/Twinzy-app/twinzy-web/pull/341), open
against `app/main`. This clears the previously observed workflow-permission
publication boundary for that candidate, not the delivery release gate.

The current-head Cursor review requests changes. Direct inspection of
[run 34645034484](https://github.com/Twinzy-app/twinzy-web/actions/runs/34645034484),
playtest job `103413650498`, confirms step 2 remained on `/` instead of reaching
`/account-type`; steps 3–5 were not reached. The sixth step was explicitly not
browser-drivable. Green `verify` and reporting-only `playtest` checks do not
override this result. `staging-e2e` was skipped, and the PR was not merged.

The exact evidence was handed to the existing Twinzy Foreman for reconciliation
with its current repair owner. No new builder, product edit, merge, or live
notification was initiated by the construction task. This observation verifies
publication and locates the next repair gate; it does not prove a goal-driven
builder bootstrap, successful review, Slack receipt, or staging acceptance.

### Package and compatibility verification — 2026-09-11

At recovery source revision `d82bdb2`, the pinned Node 24.20.0/npm 12.0.2
full test command (`npm test -- --maxWorkers=4`) passed 602 tests across 83
files in 77.59 seconds. Temporary loopback/subprocess test access was allowed;
no active installation or provider was changed.

The packed CLI verification passed from an offline clean temporary consumer.
The verifier now additionally checks recovery runtime/docs inclusion, imports
the delivery composition and observation APIs through public package exports,
and parses the opt-in Console configuration from the installed package without
starting it. The strengthened verifier also passed. Its temporary package and
consumer are cleaned up by the verifier; this is not a published download.

These checks establish package usability and regression evidence, not the live
connected release gate. In particular they do not establish installed grants,
native-task wake-up, Jira/Slack access, or an accepted staging journey.
