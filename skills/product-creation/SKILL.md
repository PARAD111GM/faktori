---
name: faktori-product-creation
description: Add a product to an existing Faktori factory while preserving inherited defaults and explicit sparse overrides.
---

# Product creation

Inputs are the factory profile, product intent/owner, required environments, and explicit overrides. Output a product record, lifecycle package, and an optional separately justified pod assignment; never allocate a pod merely because a product was created. Select compact for a small independent product, normal for a feature-bearing product, and high-risk for regulated or cross-product dependencies. Evidence must show resolved inherited values, only requested overrides, incremental cost/workload, and observed repository/config changes. Escalate on invalid references, implicit authority expansion, or a request that would silently create a pod.
