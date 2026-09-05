---
name: faktori-bootstrap
description: Bootstrap a new self-hosted Faktori factory from discovery through an approved, revision-bound local profile.
---

# Bootstrap

Read [the lifecycle contract](../../docs/lifecycle/contract.md) and run the [discover-first interview](../../docs/onboarding/interview.md). Inputs are discovery, owner/authority, products, resources, provider preferences, environments, budget, and constraints. Map every discovered fact and retained answer to config, discovery metadata, proposal costs/workload/tradeoffs/risks, or a named pending field; preserve unknowns with source and revision. When the request names an existing local product or bundled fixture, bind its absolute directory through `localProductSources` in the proposal request; do not silently replace it with an empty scaffold or manually copy it after approval. Output a readable proposal, approved profile, locked versions, and durable local effects; remote effects remain pending/unsupported when unavailable. Choose compact packaging for a solo low-risk factory, normal for multiple products, and high-risk when authority or isolation is material. Completion evidence includes proposal/config revisions, approval authority, source-snapshot digest when applicable, operation identities, observed filesystem/Git results, and unresolved gates. Explain that a new product inherits defaults, adds incremental cost/workload, and creates no pod automatically. Escalate on changed proposals or source snapshots, missing approval, credentials, budget, or unreconciled operations.
