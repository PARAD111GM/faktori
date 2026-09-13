# Runtime delivery improvements

Approved by Nathan in this task: implement the six patterns learned from
ai-software-factory, excluding Archon, and continue to completion. Baseline:
`dbcdedc4b0299a91b569c89b6ac4286eb2583c32`. The existing full-width tracker CSS
change is preserved. This is factory development, not authorization to publish,
merge, deploy Twinzy, send messages or change provider access.

## Plan and design

1. Add a bounded provider-neutral candidate runtime and verification contract.
   The controller binds source content, trusted commands, environment inputs and
   observed running identity; terminal cleanup is required. Commands remain
   operator-trusted, not a claimed same-user security sandbox.
2. Verify a healthy baseline and deliberate negative controls with distinct
   results for application assertion failure, infrastructure failure and wrong
   identity. Never count an unavailable verifier as catching a defect.
3. Extend existing graph dispatch ownership and admission, not a new engine.
   Unattended admission needs an owner-accepted witnessed journey bound to its
   configuration. Missing, changed and failed evidence blocks new admission;
   running product workers are left alone.
4. Preserve one independent reviewer and give repairs bounded prior findings
   and changed-candidate context, without allowing stale-head acceptance.
5. Make deployment progression require explicit deployed revision evidence and
   preserve separate staging/product acceptance. Healthy is not deployed.
6. Expose the verification contract through the existing CLI and lean path;
   document capability-oriented setup, release/update and recovery behavior.

## Verification and rollout

Use focused behavior tests per owned module, then typecheck/build/full regression
and packed CLI verification. Exercise a connected disposable local candidate,
positive/negative controls, failed admission and accepted witnessed admission.
Independent review covers command execution, identity, authority and recovery.
No new model is needed for bookkeeping or test execution. Usage from controlling
tasks is unknown unless explicitly registered; claim no comparative savings.

Deploy here means built local kit and isolated local exercise only. External
release/deployment is pending separate authority, not silently inapplicable.
Maintain by retaining evidence, blocking new admission on drift and explicitly
revalidating changed configuration. Do not erase or rewrite completed receipts.

## Local acceptance — 2026-09-13

- Node 24.20.0: typecheck and production build passed; full suite passed
  639 tests across 86 files in 106.95 seconds.
- Built CLI proof snapshots a disposable HTTP candidate, observes healthy
  arithmetic, detects deliberately broken arithmetic, verifies runtime identity
  and confirms both application/child process trees are gone. No provider call
  or external deployment is involved.
- Admission tests cover missing/expired/configuration-drift/failed/unknown/denied
  witnesses, retained completion after restart, and preserved attended behavior.
- Independent scoped reviews covered runtime safety and main integration.
  Findings corrected: configuration/environment binding, identity-safe bounded
  cleanup, no-op repair inference, and actionable predecessor failures.
- Verification and admission use zero model invocations. Test adapters are
  deterministic, not proof of a live model/subscription run. Implementation-agent
  token usage is not attributed here; no token or cost savings are claimed.
- Installation/release guidance and the public verification export are included
  in the offline package check. No push, merge, provider activation or product
  worker restart is part of this local acceptance.
