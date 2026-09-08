# Discover-first onboarding interview

Use this guide before proposing a factory. Discovery is read-only: inspect the selected repository (status, remotes, stack and existing ownership), available provider CLIs and reported capabilities, host hardware/resources, deployment environments, and existing release/incident ownership. Record each fact with its source and revision. Ask only what inspection cannot resolve.

## Recommended profile

Present this first when it fits: one owner, one product, one pod, one provider, GitHub, local execution, and existing repositories/environments. It minimizes cost and human workload while retaining explicit approval and release authority. Offer alternatives only when they materially change cost, control, workload, isolation, or recovery (for example, multiple products, a second provider, a preview environment, or a high-risk approval path).

## Required questions and mapping

Cover product scope; stack; organization and owners; hierarchy terminology; provider preference; financial budget; human attention/availability; approval, merge, and release authority; environments; and incident, notification, and recovery preferences. For every retained answer or discovered fact, record its destination: a real `factory.defaults` config field (`providerId`, `budget`, or `authority`), `discovery.interview`/`discovery.inventory` metadata, proposal cost/workload/tradeoff/risk, or a named later-phase pending field. Preserve unresolved items as `unknowns` with source/revision; never infer or silently discard a preference.

Explain that a new product inherits factory defaults and incurs only incremental cost/workload. It does not automatically receive a new pod; pod assignment is explicit.
For an existing factory, retain the current resolved configuration as the
previous revision, propose a next configuration with exactly the one discovered
product, and use the normal proposal/approval flow before `faktori product new`.
Any change to existing factory, product, provider, environment, or pod settings
requires its own authority and is not folded into product creation.

## Finish gate

Produce a revisioned discovery record, then a readable proposal that names concrete effects, costs, human workload, tradeoffs, risks, authority, and pending/unsupported remote effects. Approval must bind to the exact proposal and configuration revisions. A changed answer or proposal requires a new proposal revision and approval.

Use [the interview record template](../../templates/provisioning/interview-record.json) as the starting shape; replace unresolved entries only with observed or explicitly answered values. The [completed example](../../examples/provisioning/interview-complete.json) shows the same answers retained in a valid configuration, discovery input, and concrete proposal inputs.

If discovery finds an existing local repository or the request names a bundled
fixture, identify which configured product it belongs to. The provisioning
proposal must bind that source through `localProductSources`; an empty product
scaffold is not a substitute for the requested starting product.
