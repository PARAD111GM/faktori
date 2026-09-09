# Delivery evidence after local acceptance

A successful Manager Loop means **Locally accepted**, not merged, deployed, or
verified on staging. The Console displays six independent gates and the next
responsible role. Missing evidence stays unobserved. Roles describe responsibility;
they do not grant permissions or assign a person automatically.

Use the approved [publication handoff](loop-publication.md) to freeze reviewed
content and publish a matching commit. Its receipt links the PR to the loop.
Publication is an explicit operation, not an automatic consequence of acceptance.

For later gates, an authorized operator can record evidence from the existing
delivery process:

```sh
faktori loop delivery record delivery-request.json
```

```json
{
  "format": "faktori.loop-delivery-record/v1",
  "artifactsDirectory": "/absolute/path/to/loop-records",
  "reviewedCommit": "<exact published commit SHA>",
  "recordedBy": "release-owner",
  "confirmed": true,
  "gate": "review",
  "status": "passed",
  "evidenceUrl": "https://github.com/example/product/pull/123"
}
```

Replace the example URL with a permanent HTTPS evidence link **without a query or
fragment**; replace the commit placeholder with the real SHA. Supported gates are
`review`, `merge`, `deployment`, and `staging_verification`. Status is `pending`,
`passed`, or `failed`. Repeated recording replaces that gate rather than adding a
duplicate. A changed publication binding requires reconciliation.

These are **owner-recorded attestations**, not independently fetched verification.
The operator must inspect the linked review, deployment, or acceptance evidence.
The Console does not use these records to authorize actions, merge code, deploy,
or move Jira tickets. Existing review and release authority remains unchanged.
The CLI trusts the local filesystem owner; keep loop records controller-owned.

The observer reads bounded `publication.json` and `delivery.json` alongside
`state.json`. Invalid or mismatched records show a reconciliation action instead
of clearing a gate. Last-progress time reports recorded activity, not worker
liveness: silence alone never proves that an agent stopped.
