# Production qualification review packet

**Purpose:** collect the human and time-based evidence required for full production qualification while the team continues the attended product path. This packet is a blank working record. No briefs, labels, reviewer decisions, accepted outcomes, or cohort dates have been supplied here. Complete it only from observed work and named human reviewers.

**Decision boundary:** these items are prerequisites for the full qualification claim. They do not prevent a narrower attended web tier from proceeding when that tier's own discovery, independent acceptance, authorized release, recovery, and observation gates pass. The 14-day/20-outcome cohort is a measurement case study, not a statistical reliability guarantee. It is separate from the ten-engineering-day transport investigation limit.

## 1. Qualification owner and frozen evaluation setup

| Field | Record |
|---|---|
| Qualification lead / contact | Pending |
| Independent reviewer(s), role and conflict check | Pending |
| Evaluation harness revision and trusted digest | Pending |
| Candidate source revision and package version | Pending |
| Package artifact filename, byte length, SHA-256 | Pending |
| Runtime/toolchain and host OS/architecture | Pending |
| Evaluator/rubric version and digest | Pending |
| Evidence store, access owner, retention period | Pending |
| Qualification start/end (local time and UTC) | Not started |

Freeze the candidate, harness, evaluator, rubric, task, model/account availability, initial state, and human-attention allowance for each comparison. A changed candidate or evaluation instrument creates a new run identity; retain the old run and its outcome. Store original artifacts read-only where practical. Record both byte length and cryptographic digest for every executable/package, harness, rubric, fixture bundle, and submitted evidence archive. Never place credentials, session tokens, or production personal data in the packet.

## 2. Ten idea briefs: discovery coverage and unseen cases

Use real human-authored briefs spanning greenfield and brownfield work and a range of complexity. Identify at least three cases as unseen before evaluation; do not reveal their acceptance details to the discovery/build route. Rotate cases after use. Do not create or backfill a brief as though it had been evaluated.

| # | Case ID / brief artifact digest | Greenfield or brownfield | Complexity / task class | Seen by system before run? | Human author / date | Run ID / disposition |
|---:|---|---|---|---|---|---|
| 1 | Pending | Pending | Pending | Pending | Pending | Pending |
| 2 | Pending | Pending | Pending | Pending | Pending | Pending |
| 3 | Pending | Pending | Pending | Pending | Pending | Pending |
| 4 | Pending | Pending | Pending | Pending | Pending | Pending |
| 5 | Pending | Pending | Pending | Pending | Pending | Pending |
| 6 | Pending | Pending | Pending | Pending | Pending | Pending |
| 7 | Pending | Pending | Pending | Pending | Pending | Pending |
| 8 | Pending | Pending | Pending | Pending | Pending | Pending |
| 9 | Pending | Pending | Pending | Pending | Pending | Pending |
| 10 | Pending | Pending | Pending | Pending | Pending | Pending |

For every run, retain the raw brief, source material/permissions, conversation or interaction trace, proposed requirements, uncertainties and assumptions, human corrections, accepted definition/design revisions, and scoring notes. Score requirement coverage, unsupported assumptions, missed material questions, traceability, and acceptance quality. Record human bridges, waits, repairs, and evaluator disagreements. A brief being marked unseen is an evaluator-controlled fact and must be supported by access history, not a retrospective assertion.

## 3. Human-authored critical holdouts and seeded defects

The independent qualification owner authors or approves these cases outside the builder's writable scope. Discovery-model-generated fixtures may supplement, but cannot count as independent human holdouts. Seed only in a disposable, isolated evaluation target with no production credentials/data. Include authorization and data-loss failures at minimum; add cases grounded in the actual product surfaces. A critical false acceptance blocks this evaluator gate until a corrected, newly frozen run demonstrates detection.

| Holdout ID | Human author / independent approver | Risk and intended invariant | Seeded defect or challenge | Protected artifact digest / access boundary | Expected result | Observed result / evidence link | Disposition |
|---|---|---|---|---|---|---|---|
| H-01 | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| H-02 | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| H-03 | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| H-04 | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| H-05 | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

Retain the authored scenario before seeding, exact seeded diff or reproducible seed procedure, candidate/harness digests, run logs, exploit/reproduction evidence, evaluator output, and post-run cleanup proof. Record each failed, inconclusive, or contaminated run; do not replace it with only the successful rerun.

## 4. Twenty human-labeled positive/negative cases

An independent human labels each case against a written rubric before seeing the system verdict. Include positive and negative outcomes, representative product behavior/usability, and critical authorization/data-loss negatives. A second human label and adjudication are optional for ambiguous cases; preserve disagreements and reasons when collected. Compare the frozen evaluator's pass/fail decision with the retained human label. Acceptance threshold: at least 18/20 agreement (90%) and zero false acceptance of a critical case. Report raw counts and the small-sample limitation.

| # | Case ID / artifact digest | Positive or negative | Human label + rationale | Optional second label | Optional adjudication | Evaluator verdict | Agreement? | Critical false accept? | Run/evidence |
|---:|---|---|---|---|---|---|---|---|---|
| 1 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 2 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 3 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 4 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 5 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 6 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 7 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 8 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 9 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 10 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 11 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 12 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 13 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 14 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 15 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 16 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 17 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 18 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 19 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 20 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

Summary (fill after scoring): human-label agreement/adjudications `Pending`; evaluator agreement `Pending/20`; critical false accepts `Pending`; misses and disagreements `Pending`; reviewer conclusion `Pending`. Do not count missing labels, duplicate cases, or system-generated labels toward 20.

## 5. Multimodal usability qualification

Name the actual modalities and platform surfaces exercised (for example, reference images/prototypes, browser behavior, simulator/emulator, or physical device), the capability being judged, and the human reviewer. Keep usability judgments distinct from deterministic correctness/security checks. Preserve input artifact digest and usage rights, exact rendered/build revision, evaluator prompt/version, annotated observations, criterion-level verdict, accessibility findings, and any human intervention or rework.

| Run / platform | Modality and input artifact digest | Usability/accessibility criteria | Human reviewer | Observed evidence and intervention | Result / open issue |
|---|---|---|---|---|---|
| Pending | Pending | Pending | Pending | Pending | Pending |
| Pending | Pending | Pending | Pending | Pending | Pending |
| Pending | Pending | Pending | Pending | Pending | Pending |

## 6. Fourteen-day / twenty accepted-outcome cohort

Start only after the named qualification release is usable and the cohort scope, baseline, observation plan, human-attention allowance, and data handling are approved. Record actual start and end timestamps; no retrospective soak. Collect at least 20 accepted work outcomes over 14 observed days, covering bug, feature, and recovery classes and both Node and Python. Acceptance is the authorized product owner's or delegated human acceptor's observed decision on the delivered outcome; build completion, green checks, merge, deployment, or a model claim alone do not count.

For comparability, freeze and record the task, starting state, harness, runtime, model/account availability, and attention allowance for baseline and candidate runs. Report quality/acceptance first, then usage (tokens and spend only where actually observable), latency, human attention, consultations, repair/rework, and failures. Mark unavailable measures `Unknown`; do not infer savings. Preserve rejected and abandoned attempts alongside accepted outcomes.

| # | Date / outcome ID | Node or Python | Bug / feature / recovery | Baseline ID and comparable state | Candidate/package digest | Delivered result + acceptance evidence | Human attention / interventions | Usage and latency evidence or Unknown | Recovery/failure receipt | Accepted by / date |
|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 2 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 3 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 4 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 5 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 6 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 7 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 8 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 9 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 10 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 11 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 12 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 13 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 14 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 15 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 16 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 17 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 18 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 19 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |
| 20 | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending | Pending |

Daily observation ledger:

| Day | Date/time window | Eligible work / admitted work | Accepted outcomes | Incidents, outages, pauses | Attention and usage coverage | Observer / evidence |
|---:|---|---|---|---|---|---|
| 1–14 | Pending per day | Pending | Pending | Pending | Pending | Pending |

Do not claim cohort completion until there are 14 dated daily records, at least 20 accepted outcomes, the required Node/Python and task-class coverage, comparable baselines, and a signed human review of limitations. A pause or material change must be documented; restart/extension decisions belong to the qualification owner, and elapsed time cannot be filled in later.

## 7. What can proceed now and what needs people, time, or hosts

| Item | Can be prepared now from current source/evidence | Genuinely required to close |
|---|---|---|
| Packet, rubric outline, case schema, digest/evidence conventions | Yes; this document is preparation only | Qualification owner freezes the actual evaluator, rubric and candidate identities |
| Ten briefs and three unseen assignments | Blank slots and coverage plan can be prepared | Human-authored briefs; evaluator controls unseen assignment/access history; observed runs |
| Critical holdouts and seeded defects | Threat categories and safe procedure can be planned | Independent human-authored cases; isolated disposable target; execution and retained detection/cleanup evidence |
| Twenty labeled cases | Table and threshold can be prepared | Independent human labels, disagreement handling where needed, frozen evaluator run, measured agreement |
| Multimodal usability | Criteria and evidence fields can be prepared | Human review of actual multimodal artifacts and named target surfaces; physical-host evidence where the advertised claim requires it |
| 14-day cohort / 20 outcomes | Instrumentation and comparable-baseline plan can be prepared | 14 observed days, actual accepted work, Node and Python coverage, human acceptance, measured attention/usage and baselines |
| Attended web production and live feature cycle | May advance under its scoped gates with authorized infrastructure and reviewer | Real owner journey, authorized public release, observed adoption and next owner-requested feature on the same bound evidence chain |
| Native iOS/Android scope | Simulator/emulator feasibility and shared-codebase work may proceed when resourced | Physical-device, signing, distribution/store evidence only for tiers/claims that include those routes; available devices/accounts/testers and owner authority |

The cohort and human calibration are full-qualification gates. They do not hold a narrower attended tier whose own release gates are satisfied. Similarly, simulator/emulator results support only those stated surfaces; they do not prove physical-device or distribution claims. Web discovery, public delivery, and a subsequent live-product feature remain central product evidence, not work to defer until automation or cohort completion.

## 8. Independent reviewer disposition

| Review question | Reviewer evidence / conclusion |
|---|---|
| Candidate, package bytes, harness, evaluator, rubric and fixtures are frozen and identifiable | Pending |
| Brief coverage and at least three predesignated unseen cases are supported by access evidence | Pending |
| Critical scenarios are human-authored, protected, representative, and safely seeded | Pending |
| Twenty cases have independent human labels and disagreement handling | Pending |
| Evaluator reaches at least 90% agreement with no critical false acceptance | Pending |
| Multimodal usability has human-observed evidence on the claimed surfaces | Pending |
| Cohort has 14 observed days and 20 accepted outcomes with required coverage/baselines | Pending |
| Failure, intervention, recovery, usage gaps and limitations are honestly retained | Pending |
| Tier justified by evidence; unsupported platform/autonomy/reliability claims removed | Pending |
| Reviewer name, date, decision, dissent, and evidence archive digest | Pending |

Final disposition: **Not reviewed. Full production qualification remains open.** This packet does not grant publication, provider activation, spending, deployment, signing, store submission, or live-product authority.

## Evidence references

- [Current production gates](current-gates.md)
- [Production roadmap](production-roadmap.md)
- Approved October 11 production review, especially PRD-05, PRD-09, and section 6 on attended tiers/cohort bounds; the linked roadmap carries its repository-facing requirements.
