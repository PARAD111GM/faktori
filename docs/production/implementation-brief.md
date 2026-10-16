# Requirements-discovery spike preparation: implementation brief

Owner request: inventory existing skills and map gaps, then prepare the attended
requirements-discovery-to-production web spike. This increment implements the
preparation outcome; it does not claim to have run or deployed the product.

## Scope and authority

- Work item: `discovery-spike-preparation@1`.
- Base: `3c9de5ed520d74ef0a92b574265e576db96c7928`, refreshed from remote main.
- Accepted source: the owner's October 12 production plan and instruction to
  begin with the skill inventory and attended-spike preparation.
- Workspace: the isolated `feat/requirements-discovery-spike` worktree.
- Allowed effects: local kit implementation, tests, documentation and disposable
  test artifacts. No live-product edits, provider activation, separately billed
  inference, external account changes, publication or deployment.
- Model routing: GPT-6-Luna medium for mechanical inventory and straightforward
  bounded coding; GPT-6.1-Sol high for integration analysis and independent
  review. The owner-selected routing supersedes older construction model names.
- Actual per-agent token/financial attribution is unavailable unless reported by
  the runtime. Engineering time-boxes are advisory, not native goal caps.

## Acceptance

1. Map all 16 canonical skills to discovery/lifecycle outputs and actual source,
   CLI, examples and tests. Guidance, deterministic tests, historical evidence
   and current live evidence remain distinct.
2. Identify the smallest real attended path and prioritize gaps that prevent an
   owner from going from raw idea through discovery to accepted production work.
3. Supply a bounded preparation artifact/inspection path that reports missing
   idea, resources, authority and stage evidence without launching anything or
   treating preparation as product acceptance.
4. Prepare an operator runbook, raw-idea/decision handoff, intervention ledger
   and independently verifiable stage criteria. Preserve unknown answers and
   never prewrite a product specification in place of requirements discovery.
5. Verify meaningful positive/negative behavior and the shipped package surface
   where changed, under Node 24/npm 12. Review the final candidate independently.

## Lifecycle and recovery

Plan: this scoped brief; design: reuse existing lifecycle/context/delivery
contracts and avoid a second scheduler or evidence authority. Build: bounded
read-only preparation and portable artifacts. Test: changed-boundary behavior,
typecheck/build, package/skill verification and exact-candidate evidence.
Deploy: local built kit only; provider/product production exercise is pending
the separately named idea, resources and authority. Maintain: keep the gap map,
interventions and preparation status honest; no automatic readiness claim.

If preparation fails, retain the input/evidence and surface the failed check.
Re-run inspection after corrected inputs; never generate a passing receipt or
perform a missing consequential action to make preparation green. Reviewers are
read-only; the parent integrates writes and owns the acceptance record.
