# Production implementation status

The factory goal is raw idea → requirements discovery → accepted full-feature
slice → working production web/native mobile application, followed by ongoing
feature development against the live product. This record separates executable
source from observed delivery. A source milestone cannot stand in for a deployed
product, signed native artifact or live acceptance.

## Implemented source

- All 16 lifecycle skills are inventoried in the capability map.
- Raw ideas start attended discovery sessions. Owner answers and model proposals
  have separate provenance; immutable revision history supports local resume.
- Product definitions capture users, outcomes, journeys, roles, data,
  integrations, requirements, exclusions and linked acceptance scenarios.
  Missing consequential decisions prevent design/execution handoff.
- The compiler supplies accepted scope and complete inherited constraints to the
  existing Lean loop. Definition/request files are pinned by digest and checked
  inside the approved workspace at execution preflight.
- Web, iOS and Android release contracts and a shared native-codebase default
  are represented. Live increments require baseline/client/schema/concurrent
  work context and release compatibility.
- Operations declarations cover recovery, data policy, security, incident owners,
  spending, attention and iteration limits. Declarations never become observations.
- The intervention ledger is append-only, resumable and idempotent, with explicit
  failures for alias paths, conflicting retries and incomplete history.
- Testing policy uses minimal full-feature acceptance and no micro-unit loops.

## Qualification sequence and first incomplete gates

| Slice | Current gate | Required outcome |
| --- | --- | --- |
| Attended web | Local attended qualification passed; human calibration pending | Real scoped provider execution, independent full-feature acceptance, retained full artifacts, restart/resume and intervention measurements |
| Production web | Resource selection and release authority pending | Exact candidate deployed to an approved HTTPS runtime with real persistence, sign-in/isolation where required, logs, restore and recovery proof |
| Live web increment | Live baseline pending | Feature development preserves current clients/data, bounds concurrent work, rehearses migration/recovery and proves signed-in behavior after release |
| Mobile feasibility | Android native build and broader native acceptance pending | Shared-codebase iOS and Android build plus representative native/device capabilities; signing/distribution ownership established separately |
| Qualified automation | Attended evidence pending | Verified transport/native supervision and wake/recovery evidence, independent admission, bounded iterations/cost/attention and safe restart reconciliation |
| Full release | All qualification gates pending | Installed operator journey, versioned release/update/recovery proof, calibrated independent evaluation and observation period |

Use `npm run accept:production` for the single consolidated local CLI feature
journey, then typecheck/build/packed acceptance for a release candidate. Existing
historical unit tests remain available; they are not repeated per change.
No external deployment account, billing authority, native signing identity or
production proof is inferred from a local CLI executable or authenticated model
session. Consult [infrastructure requirements](infrastructure-requirements.md)
to select the next environment after local qualification.

## Observed local acceptance

On the v0.2.6 candidate with Node 24.20.0/npm 12.0.2, consolidated typechecking,
the full source CLI feature journey and runtime/Console builds passed. The
clean-install package acceptance also passed, including the same complete new
CLI journey through installed `dist` commands and exports (`faktori-0.2.6.tgz`).
All 16 skills and the three provider maps passed the packed verifier.
Independent
source review found and resolved missing inherited worker constraints, aliased
ledger paths and product artifact containment through symlinked parents. The
source journey includes raw-idea session save/answer/resume, accepted-definition
inspection, scoped context, pending and ready compiler handoff, stale-digest
rejection, operations blockers and intervention retry/resume/alias rejection.

The existing CLI is installed and reports ChatGPT authentication; that observation
does not establish quota, sandbox qualification or a successful product run.
Xcode 26.3 is installed. Android Studio exists, but the expected Android SDK
platform-tools/emulator paths were absent. These observations are preparation
facts, not successful iOS/Android builds or distribution proof.

## Observed attended work after v0.2.6

The v0.2.7 candidate completed the source and installed CLI feature journey,
runtime/Console typechecking and builds, and clean-package verification. An actual
subscription-model discovery proposal was imported with exact response-file
provenance and an idempotent installed retry. A separately installed older CLI
rejected the requested model; qualification selected the compatible executable
and observed a representative request rather than silently changing models or
switching billing routes.

Actual Luna implementation and bounded repairs, followed by Sol diagnosis,
produced a local SQLite-backed web fixture. The controller's complete browser/API
journey passed sign-in, denied and cross-household access, persistence through
reload/restart and failed-save retry. Independent source review found additional
refresh/session and uncertain-save recovery defects; attended repairs and
expanded protected scenarios remain recorded as interventions. No independent
acceptance is inferred from those earlier passes. Full private native captures,
normalized events, failed candidates and evaluator/package identities are
retained. Recovered reconnect behavior passed a retained-stream transport replay
with fatal and incomplete-run controls; that replay is not a new provider call.

A private shared React Native/Expo scaffold generated iOS and Android projects
and Hermes bundles. The compatible iOS simulator app compiled, installed and
launched. Its native UI added an item, reloaded storage, then displayed the saved
item after stop/relaunch; the SQLite record was inspected independently. This
local-storage feasibility slice has no qualified shared backend/auth, physical
device, signing or store distribution. Android native compilation remains pending SDK installation. The owner approved
free SDK/emulator installation and standard SDK license acceptance; installation
has encountered local disk capacity limits. Neither platform is
claimed production-ready.

Hosted deployment, real-user/product acceptance, independent human calibration,
live-product increments and qualified automatic operation remain open. The
[hosted qualification proposal](hosted-qualification-proposal.md) supplies a
concrete starting resource configuration; its account and spending authority
remain unapproved. Existing product environments were not changed.

## Observed v0.2.8 discovery and release preparation

The v0.2.8 source and clean installed-package feature journeys, typechecking,
build and packed verifier passed. The installed `discovery propose` command
completed a real GPT-6.1-Sol request through the selected native Codex executable,
retained the response and appended its sourced adaptive question. Exact replay
returned `already_recorded` with zero provider attempts and the same session
digest. The proposal is unaccepted; it cannot change the owner's full factory
scope, authorize execution or establish live-product readiness. Independent
source security review reported no high-confidence blockers in this path.

The installed v0.2.7 attended web loop subsequently succeeded with two fresh
independent Sol reviews and both protected controller acceptance receipts.
Resuming the succeeded run retained the same stages and provider artifacts,
without another model launch. The browser journey includes immutable uncertain
save retry, confirmed-save refresh recovery, account-switch isolation and SQLite
persistence. A separate container journey proved unprivileged execution on a
fresh volume, idempotent save/retry and persisted sessions/data after restart.
Evaluators remain model-authored and have not been independently human-calibrated.

A separate hardened hosted candidate passed local HTTPS/browser/API, migration,
backup/restore and container feature journeys, including an AMD64 container on
local emulation. Its public HTTPS deployment and live-user operation remain
unverified. Local TLS, simulated users and emulated architecture are explicitly
separate from hosting qualification. No external resource was provisioned.
