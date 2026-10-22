# Finish production qualification

**First incomplete gate: a prospective, installed owner lifecycle.** A real
owner must accept the definition and design before generation, then independently
accept the delivered result, approve its release, observe adoption and request
the next feature on that same baseline. The accepted shopping-list quantities
and units release supplies useful delivery and recovery evidence; it cannot
retroactively supply that approval order.

This plan closes the remaining gates through complete product outcomes:
requirements discovery, a greenfield web product, one shared native iOS/Android
product and continued development of a live product. Run one coherent outcome
and one human review batch at a time. Keep implementation, acceptance, recovery
and related visual refinements in that batch. Do not split it into micro-unit
loops or count administrative activity as progress.

## Starting position and decisions

| Evidence or decision | How to use it |
|---|---|
| v0.2.17 source and installed qualification | Preserve the exact candidate, package and observed check receipts in [current gates](current-gates.md); passing that version does not qualify changed bytes. Merge, package publication and replacement of an active installation remain separate decisions. |
| Shopping-list candidate C / quantities and units | Preserve the owner acceptance, exact schema-3 image, public HTTPS web/native simulator/emulator receipts, local native offline proof, restart and actual-public-backup local restore described in the [owner increment](owner-shopping-list-increment.md). Do not rerun these just to accumulate checks. |
| v0.2.18 polish candidate | Require its own complete source, installed-package, independent review and applicable rendered-behavior evidence in [current gates](current-gates.md). The synthetic Chromium journey passed 23 checks across five widths and short landscape; it does not qualify real devices or Safari. v0.2.17 receipts do not transfer to changed bytes. |
| Automatic native transport | Keep automatic dispatch disabled. The observed runtime started an unsolicited turn on goal activation; no passing readiness witness exists. Use attended bounded execution through the existing provider. |
| People and resources | Role assignments, human-authored briefs/labels, actual cohort dates, physical devices and publisher resources remain pending until supplied. This document supplies no acceptance, new authority or booked resources. |

The temporary Fly exercise permits synthetic data only, one 512 MB Machine and
one encrypted 1 GB volume, a **$10 total monitored ceiling**, and cleanup on
**October 20, 2026 at 1:33 PM America/Chicago**. This is not a billing-enforced
cap. It cannot fund or authorize a new 14-day cohort or real user data. Before
admitting that cohort, obtain an explicit resource/data decision: an approved
replacement environment or a separately authorized hosting arrangement, cost
ceiling, monitoring owner, data policy and cleanup/recovery plan. Do not extend,
spend or repurpose the current exercise by assumption. See the [hosting
authority and cleanup record](attended-public-qualification.md).

Assign these roles before their respective work starts; retain actual people and
authority in the private [qualification packet](qualification-review-packet.md).

| Role — assignment pending | Responsibility |
|---|---|
| Product owner / delegated human acceptor | Supply the idea, resolve scope, accept exact definition/design and delivered outcomes, request the next feature. |
| Qualification lead | Freeze the candidate and evaluation setup, arrange resources, own the evidence chain and decide final qualified scope. |
| Attended operator / implementer | Run the approved installed path, record interventions, contain failures and hand off complete outcomes. |
| Independent human evaluator / usability reviewer | Protect holdouts, label before seeing system verdicts, inspect real behavior and judge usability; preserve independence from the builder. |
| Release and operations owner | Approve concrete release effects, own hosting/data/backup custody, monitoring, incidents, recovery and cleanup. |
| Native account/device custodian | Supply authorized signing/accounts, real iOS/Android devices and distribution access; approve each applicable signing/upload phase. |

One person may hold compatible roles when recorded. The builder cannot provide
its own independent human labels or silently approve its own release effects.

## 1. Freeze and qualify the kit selected for the owner run

**Outcome:** one identified installable kit whose actual bytes passed the
applicable complete feature slices. This is technical preparation for the owner
lifecycle, not full production qualification.

**Start:** qualification lead selects v0.2.17 or the completed v0.2.18 candidate,
records the exact source revision, package bytes/digest and intended installed
location, and preserves existing configuration, credentials and journals. If
selecting changed source, the implementer runs the documented source command
under Node 24/npm 12:

```sh
npm run check
```

Run it in the selected source checkout, not inside an installed package. It
typechecks/builds, executes complete production feature acceptance and verifies
the packed CLI from a clean temporary installation. Review the actual results
and changed-slice evidence independently; use the normal owner-controlled
[installation/update path](../../INSTALL.md) for the chosen exact package.
Do not replace an active installation merely to test packaging.

**Pass:** applicable source and clean installed full-feature checks pass on the
selected bytes, independent review has no unresolved blocking finding, and the
installed entry path opens the shipped [operator runbook](attended-operator-runbook.md).
For v0.2.18 UI polish, include the visual/accessibility acceptance in step 2 on
the actual changed screens. After building, run `npm run accept:console` in the
source checkout with the pinned toolchain and Playwright Chromium available.
This owns a disposable populated local factory and browser; it launches no real
provider or product. Retain its report and screenshots, then review the rendered
screens. It does not replace real-phone, Safari or independent human acceptance.
Record source, checks, review and installed identity
separately from merge/publication/deployment status.

**Evidence/recovery:** retain the package length/digest, toolchain/host identity,
check logs and review disposition. On failure, retain the failed run, repair the
complete affected slice, freeze new bytes and rerun the affected qualification.
Use a temporary install for checks; preserve the last working active kit and
private state. Stop release admission on missing or mismatched receipts.

## 2. Deliver a prospective owner product from discovery through adoption

**Outcome:** a greenfield authenticated persistent web product with an unbroken
installed discovery → accepted definition → accepted design → generation →
independent acceptance → authorized release → observation/adoption chain.

**Prerequisites:** step 1, actual product owner and independent reviewer,
approved private workspace/provider route, bounded execution authority, and
release resources appropriate to the intended data. Preserve the shopping-list
whole-product proposal as proposed unless the owner actually accepts it; do not
backdate it or rename the earlier release as this prospective run.

**Start:** follow steps 1–3 of the [attended operator runbook](attended-operator-runbook.md)
using the owner's actual idea. Resume an existing prepared discovery record only
after inspecting its identity and history; for a new product use the shipped
seed and save a fresh record. For an existing prepared private history the first
read-only action has this form:

```sh
faktori discovery resume /absolute/private/product/discovery.jsonl
```

Replace example paths with approved canonical private locations. Record missing
answers as unknown/deferred. Freeze sourced requirements, user journeys,
exclusions, data/permission boundaries, error/recovery behavior and release
owners. The owner separately accepts definition and design before the approved
generation begins. `discovery inspect` must report `readyForDesign: true`; design
inspection must include the real digest-bound approval. A generated proposal
does not supply owner approval or provider/release authority.

Compile the exact accepted artifacts using the runbook's existing
`product design-compile` and `product design-loop-config` requests. Inspect the
envelope's `status` and `requiredBindings`; only `ready_for_loop` permits saving
its `configuration` object as the input to `faktori loop run`. Keep protected
acceptance outside the builder's writable scope. Deliver one complete usable
feature with positive, denied, error and recovery behavior.

**Pass — functionality and experience:** independent acceptance demonstrates
authenticated persistence, isolation, correct shared state where required,
validation, denied access, retries without duplicate effects, restart and backup
recovery against the exact accepted scope. A human reviews the rendered product
and Faktori's applicable operator screens against the accepted design:

- Desktop, tablet and mobile layouts remain readable and usable without clipped
  controls or lost actions; record actual viewport/device sizes.
- Review at 320, 390, 768, 1024 and 1440 CSS pixels, phone landscape and 200%
  browser zoom. Use populated work, long names, errors and open forms, not only
  empty screens. Page-level horizontal scrolling fails acceptance; intentional
  board/code scrolling must remain contained and discoverable.
- Phone inputs use at least 16px text to avoid unwanted focus zoom. Primary
  touch actions have at least 44px targets. Check real iOS Safari and Android
  Chrome with the on-screen keyboard, rotation and increased text size; desktop
  browser viewport emulation alone does not qualify those device behaviors.
- Keyboard-only navigation reaches every action in a logical order; visible
  focus, labels, validation announcements and focus after errors/dialogs work.
- Reduced-motion preference is respected; essential state remains understandable
  without animation. Text/control contrast and touch target usability meet the
  accepted accessibility criteria.
- Empty, loading, denied, offline, expired-session and failed-save states explain
  the next action and preserve input or explicitly disclose loss. Retry/recovery
  actually succeeds without duplicate or stale cross-account updates.
- Human-observed screenshots/recordings and criterion-level findings bind to the
  exact build. Fix material usability defects within the same outcome batch;
  automated checks alone cannot accept visual quality.

**Pass — delivery and adoption:** the release owner approves the concrete
publication/deployment scope; exact artifact provenance, HTTPS, signed-in live
behavior, isolation, restart and independent off-volume restore pass for the
claimed environment. An approved observer records the unchanged release and
the owner separately accepts adoption. Use the runbook's observation scope,
`product observe`, `product adopt` and live-journal contracts; an externally
hosted product uses the [external adoption profile](existing-product-adoption.md)
without inventing Faktori publication receipts.

**Evidence/recovery:** retain original idea/history, corrections, timestamped
approvals, exact definition/design/source/package/runtime bindings, independent
acceptance, interventions, release/backup/restore receipts and live journal.
Before release rehearse the agreed recovery route on an isolated copy. On an
uncertain effect inspect the original intent and owned operation before retry;
on data risk or failed restore stop release/adoption, preserve the working
baseline and reconcile with its operations owner.

## 3. Complete the next owner-requested feature on the live baseline

**Outcome:** prove ongoing development, not just one generated first release.

**Prerequisites/start:** step 2's current adopted baseline and the owner's actual
next request. Prepare its increment request under the [live-product contract](live-product.md),
then run:

```sh
faktori product next-discovery /absolute/private/product/increment-request-1.json
```

Resume the resulting discovery history. Retain the live journal parent, exact
deployed/client/schema baseline, data ownership, concurrent work and rollback
constraints. Accept the amended definition/design before generation, then run
one coherent feature through independent acceptance, authorized staged release,
observed outcome and adoption. Use the existing quantities/units receipts as
prior recovery knowledge, not proof of this new run.

**Pass:** the requested outcome works after release; existing signed-in clients,
data and contracts remain compatible; migration, immutable retry/offline
reconciliation, denied/error paths, restart and recovery pass where applicable.
Observe both an older supported client and the new client when contracts change.
Include the visual/accessibility review from step 2 for changed user journeys.

**Evidence/recovery:** retain baseline and increment artifacts, approval order,
exact old/new artifact identities, migration/recovery rehearsal, independent
review, owner acceptance and observation/adoption receipts. Choose forward fix
versus compatible stopped-backup restore before deployment; do not assume an
old binary can read a newer schema. The current shopping-list schema 3 cannot
roll back to its schema-2-only binary alone. Stop on unexplained drift,
concurrent-work conflicts, missing backup custody or uncertain data loss.

## 4. Calibrate discovery, acceptance and multimodal judgment with humans

**Outcome:** a frozen evaluator demonstrably agrees with independent people on
representative discovery and product behavior. Preparation can proceed alongside
steps 1–3; labels and unseen answers must remain protected from builders.

**Start:** the independent evaluator fills sections 1–5 of the
[qualification packet](qualification-review-packet.md), freezes the candidate,
harness/rubric and access boundary, and collects real human-authored cases.
Run complete discovery/product journeys using the installed route, not isolated
prompt fragments. No fabricated briefs, people, labels or acceptance dates count.

**Pass:** all of the following are observed and reviewed together:

- Ten human-authored idea briefs cover greenfield and existing-product work;
  at least three were designated unseen before evaluation, with access evidence.
  Retain requirements coverage, unsupported assumptions, missed questions,
  corrections, sourced definition/design and actual approval quality per run.
- Independent humans author/approve protected critical holdouts, including
  authorization and data loss. Seed defects only in disposable isolated targets
  without production credentials/data; the evaluator detects them and cleanup is
  observed. Builder-generated fixtures cannot satisfy this human gate.
- Twenty distinct positive/negative cases have human labels and rationale fixed
  before system verdicts; evaluator agreement is at least **18/20 (90%)**, with
  **zero critical false acceptance**. Retain disagreements and optional second
  labels/adjudication, raw counts and the small-sample limitation.
- Human multimodal/usability judgment covers the actual artifacts and claimed
  surfaces, including step 2's layout/accessibility/error criteria. Keep this
  distinct from deterministic correctness and security checks.

**Evidence/recovery:** retain protected artifact digests/access history, seeded
diffs, all verdicts, failures, interventions and human disposition in the packet.
A critical false acceptance blocks evaluator qualification. Repair, freeze a new
run identity, refresh contaminated/seen holdouts and rerun the complete affected
comparison; never erase a failure or retroactively call a case unseen.

## 5. Qualify shared native delivery on physical iOS and Android

**Outcome:** one shared native codebase, genuine native UI, shared backend
contracts and supported real-device release/update behavior. Existing simulator
and emulator evidence remains useful at its stated scope.

**Prerequisites/start:** accepted native requirements/design specify device/OS
coverage, capabilities/permissions, offline behavior and distribution route.
The device/account custodian supplies authorized real devices, vendor accounts,
signing resources and testers; missing or paid enrollment remains a hard external
dependency requiring the owner's decision. Follow [native local delivery](native-delivery.md)
and [native release](native-release.md). After approved request files exist:

```sh
faktori product native-release-prepare /absolute/private/product/configuration-binding-request.json
faktori product native-release-build /absolute/private/product/approved-build-request.json
faktori product native-release-upload-prepare /absolute/private/product/signed-build-receipt-request.json
faktori product native-release-upload /absolute/private/product/separately-approved-upload-request.json
```

Preparation does not authorize signing or upload. Obtain separate actual
approvals bound to the concrete signing/export plan and then the sealed-artifact
upload plan. Keep vendor authentication in its existing flow.

**Pass:** independently observe exact signed artifact/app/build/account/track on
real iOS and Android devices. Exercise sign-in, shared changes, secure session
relaunch/logout/expiry, household isolation, validation, permission refusal and
recovery, offline queued changes across process restart, reconnect exactly once,
older-client compatibility and upgrade with retained data. Review native layout,
accessibility, text input/Unicode, keyboard and reduced motion on the applicable
devices. Verify the actual distribution route, installed version and available
store/beta state; an upload or pending review is not availability. A beta receipt
supports beta claims only. Retain a rehearsed supported update/recovery route;
store rollback limits may require a forward release plus backend compatibility.

**Evidence/recovery:** record artifact/source/signing provenance, device/OS and
installed-byte/build identities, real account/distribution observations, human
acceptance and recovery evidence. No credentials enter public records. For an
interrupted signing/upload effect use `product native-release-inspect`, then
separately approved read-only `product native-release-reconcile` against the
same intent; do not resubmit uncertain uploads. Failed availability, upgrade or
recovery blocks the applicable native tier, not an already qualified web tier.

## 6. Resolve automatic transport only if its exact runtime becomes safe

**Outcome:** either qualified bounded native supervision on an exact supported
runtime or an explicit retained attended-only capability boundary. This work
must not displace discovery, web/native delivery or the next live feature.

**Start:** an assigned runtime qualification owner first reviews the retained
unsolicited-turn failure and [native supervision contract](native-supervision.md).
Only attempt a changed, plausibly safe runtime/configuration under fresh bounded
authority in an isolated approved workspace. Keep automatic admission disabled
throughout qualification; a configuration boolean or protocol fixture is no
readiness witness.

**Pass:** observe safe activation, exactly one explicitly requested bounded turn,
its exact terminal result, paused goal and owned process exit; independently
verify idle wake, durable restart, cancellation, disconnect/timeout handling,
uncertain-effect reconciliation and no duplicate launch. Prove an independently
accepted full product slice. Retain exact executable/profile/source, protected
MCP-exclusion inventory, independent evidence and the contract's expiring witness
before any separately authorized automatic admission.

**Stop/recovery:** unsolicited inference, lost authority, inventory drift,
ambiguous terminal state or uncertain process exit fails closed. Contain and
inspect only the owned operation; preserve uncertainty and do not relaunch.
After **ten engineering days** without an observed safe launch/inspect/goal/
supervision path, end that implementation attempt, record the boundary and
continue attended bounded execution. This limit is unrelated to cohort duration
and grants no inference allowance, automatic admission or publication authority.

## 7. Observe 14 days and 20 human-accepted outcomes

**Outcome:** sustained measured operation across real Node and Python work,
including bug, feature and recovery classes, with comparable baselines.

**Prerequisites/start:** usable named qualification release; completed human
calibration for the full claim; assigned observer/acceptors; approved cohort
scope, data handling, attention allowance, incident/recovery ownership and
resource decision described above. Use packet section 6 to record actual start
and end timestamps. Do not start a clock against an expiring synthetic host and
assume it will be extended. Attended operation is eligible when honestly scoped;
automatic transport is not required to measure that tier.

For each outcome freeze task, starting state, candidate/package, harness,
runtime, model/account availability and attention allowance for candidate and
baseline. Use comparable baseline work and explain any differences; missing
baseline evidence cannot support a savings claim. Count one complete delivered
outcome once, only when the authorized human acceptor records its observed
acceptance. Preserve rejected, abandoned and repaired attempts as well.

**Pass:** at least **14 dated daily observation records** and **20 distinct
human-accepted outcomes** cover Node and Python and bug/feature/recovery work.
Quality and acceptance are reviewed first; report measured human attention,
consultations, repair/rework, failures, latency and observable tokens/spend.
Unavailable measures remain `Unknown`. Daily records include outages, pauses
and coverage gaps. The independent reviewer signs the actual evidence and its
limitations; this case study is not a statistical reliability guarantee.

**Evidence/recovery:** retain comparable baseline identities, original outcome
artifacts, dated acceptance, usage/attention traces, incidents and restore
receipts. On an incident stop affected admissions, preserve data/evidence and
follow the approved recovery route. Material candidate/evaluator/resource
changes need a new run identity and a recorded qualification-owner decision on
restart/extension/comparability; never backfill unobserved days or relabel
synthetic fixtures as human-accepted outcomes.

## Completion and honest release scope

The qualification lead and independent reviewer use packet section 8 to make
one evidence-bound disposition. Report each gate separately: source/checks,
independent review, merge/package publication, installation, provider/runtime
activation, authorized release, observed product behavior, human calibration
and sustained cohort. Name the first incomplete gate and its next owner/action.

Full qualification requires the prospective owner chain, greenfield web,
ongoing live increment, supported shared native/device/distribution paths,
calibration, recoverability and sustained outcomes described above. A narrower
attended tier may ship when its own gates pass, with platform/autonomy/data
limits explicit. No elapsed time, green build, store upload or model assertion
substitutes for the missing human, device, account, recovery or live evidence.
