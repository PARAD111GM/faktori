---
name: faktori-bootstrap
description: This skill should be used when an owner asks to create or install a self-hosted Faktori factory. Bypass it for work inside an already accepted factory; use the product-creation skill for a new product and the interview skill only to clarify a product request.
---

# Bootstrap a Faktori factory

Create an approved, recoverable local factory profile without claiming support
that the installed runtime does not have.

## Establish the boundary

- Resolve `<faktori-kit-root>` to the installed Faktori checkout or package
  root. Read `<faktori-kit-root>/docs/onboarding/interview.md`,
  `<faktori-kit-root>/docs/provisioning/README.md`,
  `<faktori-kit-root>/docs/configuration/README.md`, and
  `<faktori-kit-root>/docs/lifecycle/contract.md` before selecting a profile.
- Inspect, read-only, the selected repositories and their revisions, provider
  CLI versions and reported capabilities, host resources, existing environments,
  and release/incident ownership. Never ask for an inspectable fact, credentials,
  or a provider session token.
- Run the Faktori interview only for owner decisions or unresolved facts that
  could materially change the profile, authority, isolation, cost, workload, or
  recovery. Record answers and unknowns as facts with source and revision; keep
  any private transcript out of factory artifacts.

## Propose before effects

1. Start with the smallest fitting profile: one owner, one product, one pod,
   one available provider, GitHub, local execution, and existing resources.
2. Explain only alternatives that materially change cost, control, human work,
   isolation, or recovery. Name provider capability gaps and unsupported remote
   effects rather than simulating them.
3. Produce a revisioned discovery record, resolved configuration, and readable
   proposal. Lock component versions; map each fact to configuration, discovery
   metadata, proposal content, or a named pending field.
4. Request explicit approval of the exact proposal revision, configuration
   revision, concrete local effects, and every authority relaxation. A skipped
   interview or unanswered decision is not approval.
5. After approval, use only documented installed commands. In the current
   runtime, `faktori provision proposal`, `faktori provision approve`, and
   `faktori provision apply` support local scaffolding; remote provisioning and
   `localProductSources` are not assumed unless the installed runtime advertises
   them.
6. Reconcile an interrupted apply from
   `.faktori/provisioning/operations.jsonl` before retrying. Preserve existing
   Git repositories and user changes; stop for drift, an unresolved intended
   operation, a changed proposal, or a path outside the approved root.

## Scale, output, and handoff

- Select compact packaging for a solo, low-risk local factory; select normal
  packaging for multiple products or material operating choices; select
  high-risk packaging when authority, isolation, credentials, or recovery is
  material.
- Emit: discovery record; proposal; approval record; resolved profile and
  locked versions; local-operation identities and observed results; explicit
  pending/unsupported effects; and a small delivery-loop demonstration plan.
- Record evidence as `proposal@<revision>`, `config@<revision>`, approver,
  operation ID, exact root, observed filesystem/Git result, and remaining gate.
  For example: `local scaffold observed at <root>; remote GitHub repository:
  pending/unsupported; owner approval: approval@<revision>.`
- Hand the accepted factory profile and its documented kit-root paths to the
  **product-creation skill**. Escalate instead of widening authority for missing
  approval, budget uncertainty, credential requests, unsupported effects, or
  unreconciled recovery.
