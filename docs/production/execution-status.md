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
| Attended web | Installed provider-to-product journey pending | Real scoped provider execution, independent full-feature acceptance, retained full artifacts, restart/resume and intervention measurements |
| Production web | Resource selection and release authority pending | Exact candidate deployed to an approved HTTPS runtime with real persistence, sign-in/isolation where required, logs, restore and recovery proof |
| Live web increment | Live baseline pending | Feature development preserves current clients/data, bounds concurrent work, rehearses migration/recovery and proves signed-in behavior after release |
| Mobile feasibility | Native toolchain/build proof pending | Shared-codebase iOS and Android build plus representative native/device capabilities; signing/distribution ownership established separately |
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
