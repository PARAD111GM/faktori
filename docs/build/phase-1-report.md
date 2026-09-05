# Phase 1 completion report

Status: candidate complete after bounded manager remediation; Build Manager re-acceptance pending. Supersedes candidate `2ed48828e78d1ded5f53fd7f54a0e0d0f3b9ec88`.

## Scope and candidate

- Phase: 1 — greenfield bootstrap, configuration, scoped context, and lifecycle artifacts.
- Tickets: F1-01 through F1-04 only; all four are `complete` in the canonical checklist.
- Starting revision: `5cb9ce2a9837426517319444c59f897bfbf05765`.
- Candidate revision: the exact commit containing this report is supplied in the manager handoff after the commit is created.
- Publication: no merge, push, publication, deployment, account change, credential change, billing action, or Docker action was authorized or performed.
- Product isolation: no Twinzy, Triforge, provider-authentication, or active product infrastructure was changed.

## Full Phase 1 checklist

| Ticket | Status | Implementation and acceptance evidence |
| --- | --- | --- |
| F1-01 | Complete | Strict TypeScript sources model factories, products, optional pods, providers/capabilities, budgets, authority, environments, and sparse overrides. Solo and multi-product examples resolve; invalid paths and corrections are actionable. The build emits JavaScript and declarations, and the packed CLI runs from a clean install. |
| F1-02 | Complete | A discover-first interview maps every required dimension to configuration, discovery, proposal, or named pending work. Proposals lock versions, effects, cost, workload, tradeoffs, risks, and resolved configuration. Exact-revision approval, intent-before-effect journaling, interruption reconciliation, symlink/root containment, Git reuse, and user-edit protection are behavior-tested. Remote effects remain visibly unsupported. |
| F1-03 | Complete | Stable one-parent hierarchy records reject cycles and invalid references while keeping planning and executable kinds distinct. Context packets carry global and ancestor constraints, local refinements, lineage artifacts/commands/authority/evidence, approved designs, and dependency contracts with source identity and revision; unrelated sibling material is excluded. |
| F1-04 | Complete | Eleven first-party skills cover bootstrap, product creation, shaping, Plan, Design, Build, Test, Deploy, Maintain, factory operation, and factory improvement. Compact, normal, and high-risk forms address all six outcomes. Node and Python examples share the same stack-neutral core lifecycle, and provider entry maps are deterministically generated and checked for drift. |

The authoritative ticket state, owners, evidence links, and append-only events
are in `construction/checklist.json`; `construction/dashboard.html` is its
generated projection.

## Public runtime and package behavior

The public library exports configuration resolution, hierarchy/context
assembly, and provisioning contracts from actual `.ts` implementation files.
`tsconfig.json` strictly checks those implementations. `tsconfig.build.json`
emits `.js`, `.d.ts`, and source maps into ignored `dist/`, rewriting relative
TypeScript imports for Node consumption. Package exports and the `faktori` bin
target only emitted files.

The CLI exposes explicit JSON-file commands for configuration resolution,
context assembly, proposal creation, approval, approved local application, and
new-product preview. Only `provision apply` mutates local state. It requires an
approved bundle and an absolute dedicated root; product preview creates no pod.

## Provisioning authority and recovery boundary

Approval is bound to the current proposal revision, configuration revision,
complete effect identity set, and each current authority relaxation. A forged,
partial, duplicated, or stale approval is rejected again at consumption.
Provisioning writes a stable `intended` operation before each effect and an
observed result afterward. Reruns reconcile known interrupted states rather
than duplicating repositories. Existing unknown targets and edited profiles are
blocked instead of overwritten.

Root and existing path components are canonicalized and checked for symlinks
before journal, profile, directory, and Git effects. Parent containment is
rechecked after creation. This does not claim descriptor-relative or
kernel-enforced protection against a concurrent filesystem replacement between
a check and system call; that TOCTOU class remains a later hardening concern.

No remote provisioner is implemented. The only remote transport is explicitly
fake and yields `pending`, `supported: false`. Provider credentials stay inside
unmodified vendor login flows.

## Specialist contributions and model routing

- GPT-5.6-Sol high: phase orchestration, shared integration and CLI/package surface, canonical records, consequential verification, and manager coordination.
- GPT-5.6-Terra high (`config_contract`): F1-01 configuration and F1-03 hierarchy/context contracts, examples, tests, and documentation.
- GPT-5.6-Terra high (`bootstrap_provisioning`): F1-02 proposal, approval, journal, local effects, recovery, templates, tests, and documentation.
- GPT-5.6-Luna medium (`lifecycle_skills`): F1-04 first-party skills, proportional templates, stack-neutral examples, onboarding guide, generated provider entry maps, and semantic/drift tests.
- GPT-5.6-Sol medium (`provisioning_boundary_review`): one targeted read-only review of approval consumption, path containment, drift handling, interruption windows, and journal durability. It found forged-approval bypass, symlink escapes, hidden drift, pre-`git init` recovery, and partial-journal weaknesses; the provisioning specialist corrected each finding and added regressions.
- GPT-5.6-Terra high (`typescript_runtime_conversion`): converted the configuration and context runtime from `.mjs` plus manually maintained declarations to strict TypeScript after manager verification rejected the original representation.
- GPT-5.6-Sol high (`strict_provisioning_cli`): narrow evidence-based escalation after repeated Terra passes left suppressions in the larger provisioning/CLI graph; completed strictification without `any`, blanket casts, or TypeScript suppression.

All writers had explicit ownership and were told to preserve concurrent work.
Specialists did not commit, merge, push, publish, deploy, or alter product
infrastructure. Routing and material changes are recorded in
`construction/model-routing.json`.

## Skills used

The local `agent-teams` instructions were used to distinguish ephemeral,
phase-owned specialists from user-owned tasks and to keep ownership and model
routing explicit. The `skill-creator` instructions materially shaped F1-04:
skill entry points are concise, use progressive disclosure, state inputs and
outputs, and reuse shared lifecycle documents and templates instead of copying
large instructions into every skill.

The bundled `quick_validate.py` could not run because its optional PyYAML
module is unavailable in the approved offline environment. No package install
was authorized. Equivalent repository-native semantic tests inspected all
skill frontmatter and required contract sections and passed; this report does
not claim the unavailable validator itself passed.

## Manager corrections and judgments

The manager rejected four initially incomplete interpretations during the
candidate loop:

1. `.mjs` runtime files with hand-maintained `.d.ts` declarations were not the
   requested TypeScript runtime. The sources were converted and strictly
   checked.
2. Source execution alone did not prove an installable Node package. A separate
   emit configuration, package exports to `dist`, and a real `npm pack` plus
   clean offline install and installed-bin smoke test were added.
3. Provisioning artifacts did not initially cover the full bounded onboarding
   interview. A discover-first guide and structured interview record were added
   for product, stack, ownership, terminology, provider, finance, human
   availability, authority, environment, incident, notification, and recovery
   decisions.
4. Exact-head review found that several interview-template mappings named
   fields the actual configuration and discovery contracts do not retain. The
   mappings now use explicit arrays of real configuration, discovery, proposal,
   or pending-field destinations. A completed example and behavior test prove
   valid configuration/discovery/proposal construction, owner/attention/incident
   retention, and approval invalidation after an answer changes.

The product-creation guidance was also tightened so a new product inherits
defaults and reports incremental cost without automatically creating a pod.

## Verification

Observed from the assigned isolated worktree using the manager-supplied cached
Node `v24.20.0` runtime and npm `12.0.2`:

| Command or exercise | Observed result |
| --- | --- |
| `npm run check` through cached Node 24/npm 12 | Exit 0: strict TypeScript check passed; 11 Vitest files and 64 tests passed; emitted build passed; packed CLI verification passed. |
| Five Phase 1 core/onboarding suites | Exit 0: 39 configuration, context, provisioning, onboarding, and CLI tests passed. |
| `node src/cli.ts config resolve examples/config/solo.json` under Node 24 | Exit 0; resolved the documented solo product and Codex provider. |
| `npm run pack:verify` through cached Node 24/npm 12 | Exit 0; created `faktori-0.0.0.tgz`, installed it into a clean temporary prefix with scripts disabled, and ran the installed `faktori` shim under Node `v24.20.0`. |
| `PYTHON=<installed-python-3.12-with-pytest> node fixtures/verify-fixtures.mjs` under Node 24 with localhost/browser access | Exit 0; Phase 0 frozen checksum and expected RED/base GREEN contracts still reproduced unchanged. |
| Usage summary and dashboard generation under Node 24 | Exit 0; all 32 tickets rendered, eight were complete, Phase 1 history rendered, and sanitized overlap-safe telemetry was refreshed. |
| Source suppression scan | No `@ts-nocheck`, `any`, `unknown as`, or `as any` matches in `src/`. |

npm 12 continues to block the `better-sqlite3` install script. Phase 1 does not
execute SQLite, and no approval was sought to build it. That native dependency
remains a Phase 2 gate before SQLite-backed coordinator behavior can be claimed.

## Usage and budget

The Phase 1 estimate is 1,600,000 tokens and is a soft forecast, not a stopping
condition. The final pre-commit public summary reports a 1,180,239-token
**overlap-safe lower bound**, 73.76% of the estimate with 419,761 tokens of the
forecast remaining. This is not a complete actual: it retains the implementer
cumulative counter, while seven specialist totals are unknown and parent-child
coverage is unknown. The manager's separately baseline-derived 146,988-token
sample is excluded from addition because it may overlap the implementer scope.
Input, output, cached, reasoning, full-agent attribution, and dollar cost remain
unknown. Raw identities stay in ignored `.build/usage/`; only the sanitized
aggregate is committed.

The account-level checkpoint reported 68% of a shared weekly window used and
32% remaining. It is neither Phase 1 telemetry nor a token count and is not
included in the phase actual. No usage reset, credit redemption, billing change,
or model switch was requested or performed.

The lower bound is 419,761 below the estimate, but incomplete specialist and
overlap telemetry prevents claiming a final under-budget total. Material rework
included the runtime-language correction, package-install proof, interview
coverage correction, targeted provisioning review, and narrow strictness
escalation. Acceptance was never weakened to fit the estimate.
The committed summary and dashboard expose the crossed 70% forecast threshold.

## Residual gates and Phase 2 lessons

- Build Manager exact-head acceptance is required before Phase 2 begins.
- Phase 2 must establish coordinator ownership, durable SQLite projection, controlled environment inputs, authenticated isolation, process-tree termination and reconciliation, and publication revocation. Phase 1 proves none of those execution properties.
- Docker worktree sharing remains unresolved; no Docker action was taken in this phase.
- Provider-native permission and cancellation receipts remain capability-specific. Unavailable receipts must stay unsupported or `interrupted_uncertain`, never inferred from local process exit.
- Provisioning path checks do not close concurrent TOCTOU replacement; later high-risk mutation code should prefer descriptor-relative or kernel-enforced containment where available.
- Review and explicitly approve the `better-sqlite3` native build before first SQLite runtime use.
- Start future runtime phases with actual `.ts` sources and install the packed artifact in the first acceptance slice, not only at final integration.
- Put the supported cached toolchain command and the onboarding dimension matrix directly in future phase briefs.
- Run one narrow authority/path/recovery review soon after the shared mutation contract stabilizes, then preserve targeted remediation rather than repeating broad reviews.
- Continue evidence-based model escalation: Luna for bounded documents, Terra for bounded implementation, and Sol only for consequential integration or a demonstrated unresolved specialist failure.
- Keep manager telemetry anchored to a phase-start baseline and treat unknown parent-child overlap as unknown rather than additive.
