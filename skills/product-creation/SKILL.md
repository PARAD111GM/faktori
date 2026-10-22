---
name: faktori-product-creation
description: This skill should be used when an owner adds a product to an existing Faktori factory. Bypass it for a change within an existing product; use bootstrap for the first factory and shaping after the new product record is accepted.
---

# Create a product in a Faktori factory

Add one product without silently allocating capacity, changing factory defaults,
or treating planned commands as installed behavior.

## Read and select scope

- Resolve `<faktori-kit-root>` and read
  `<faktori-kit-root>/docs/configuration/README.md`,
  `<faktori-kit-root>/docs/onboarding/interview.md`,
  `<faktori-kit-root>/docs/provisioning/README.md`, and
  `<faktori-kit-root>/docs/lifecycle/contract.md`.
- Inspect the accepted factory profile, existing products and pods, provider and
  environment capabilities, relevant repository state, capacity, and authority.
- For the first or a new web/native product, follow
  `<faktori-kit-root>/docs/production/attended-operator-runbook.md` from saved
  requirements discovery. Use `faktori discovery session`, `discovery save`,
  and the configured attended `discovery propose`/`discovery answer` path before
  drafting scope. Keep model proposals separate from actual owner answers.
  A change to an existing product enters that runbook's baseline/next-discovery
  route instead of creating another product or reinstalling the factory.
  Read discoverable constraints rather than asking the owner to repeat them.
- Run a narrow interview only when product scope, ownership, environments,
  resource impact, or an override is unknown and could change execution. Capture
  an owner decision or an explicit unknown; do not infer approval from silence.

## Create a sparse, reviewable addition

1. Define the product intent, owner, repositories, required environments, and
   inherited constraints. Add only explicit sparse overrides; preserve explicit
   `false`, `0`, and empty values rather than treating them as inheritance.
2. Preview resolved defaults and incremental resource, provider, cost, and human
   workload effects. Never claim a `faktori product new` command exists unless
   the installed runtime documents it; use the installed provisioning/configuration
   surface or produce a pending proposal when it does not.
3. Create no pod by default. Add one only when an owner explicitly chooses it
   and an ownership, concurrency, repository, environment, or product-surface
   reason makes it necessary.
4. Bind material local effects and any authority relaxation to a revisioned
   proposal and explicit approval. Run only approved, documented local effects.
5. On interruption, inspect the durable provisioning journal, reconcile the
   stable operation identity, and refuse to overwrite existing user-controlled
   repositories or changed configuration.

## Package and hand off

- Select compact packaging for a small independent product; select normal
  packaging for product work with features or dependencies; select high-risk
  packaging for regulated, destructive, cross-product, or authority-sensitive
  work.
- Emit a product record, resolved inherited settings, explicit overrides,
  incremental cost/workload statement, authority record, observed local effects,
  and named pending/unsupported effects. Example: `Product ledger inherits
  codex/local/50k tokens; override: preview deployment false; pods created: 0.`
- Hand the sourced discovery and product record to the **shaping skill**.
  Use `faktori discovery draft` for a proposed full definition; inspect it with
  `faktori discovery inspect` and record actual owner definition acceptance
  separately before design. Preserve the complete product goal while accepting
  a coherent next slice. Neither a provisioned repository nor a model draft is
  an accepted definition or execution grant.
  Escalate invalid provider/environment references, a hidden authority expansion,
  unavailable capacity, missing approval, or a request that implicitly creates a
  pod.
