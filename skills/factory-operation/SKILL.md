---
name: faktori-factory-operation
description: Operate a configured self-hosted factory while preserving coordinator authority and recoverable records.
---

# Factory operation

Inputs are the resolved factory profile, ownership lock, run/request, budgets, provider session identity, and environment policy. Output an admitted or rejected operation, durable intent/result journal, scoped context packet, and terminal classification. Compact is suitable for one local run; normal covers routine parallel work; high-risk covers recovery, cancellation, or authority boundaries. Evidence names operation identity, owner, provider outcome, resources, and observed result. Escalate stale ownership, unreconciled intent, budget exhaustion, cancellation uncertainty, or any request to expose credentials.
