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
   `faktori provision apply` support local scaffolding. When the request names
   an existing local product, bind its absolute directory through
   `localProductSources`; the approved apply imports the source snapshot rather
   than silently creating an empty scaffold or relying on a later manual copy.
   Remote provisioning remains pending or unsupported unless the installed
   runtime advertises it.
6. Reconcile an interrupted apply from
   `.faktori/provisioning/operations.jsonl` before retrying. Preserve existing
   Git repositories and user changes; stop for drift, an unresolved intended
   operation, a changed proposal, or a path outside the approved root.
7. Prepare the loopback Console with `faktori console prepare` from the approved
   installed projection. Run `faktori preflight` against the selected factory
   and configuration before admitting work. Treat public readiness assertions
   as untrusted: only the installed read-only projection check can establish
   projection readiness, while execution and live evidence require their own
   independent provenance.
8. Produce a required integration inventory from the selected configuration:
   every provider route, Jira project mapping, and GM scheduler is either
   enabled and verified by a separately observed bounded exercise, pending
   authentication/observation, or deliberately deferred by an owner decision.
   A cataloged provider is not a configured/authenticated route; configured
   `runtime.gm` is not observed scheduler health. Use `faktori readiness report
   <absolute-local-console.json>` to detect configuration omissions, but do not
   call its offline result verification of a live integration.

## Scale, output, and handoff

- Select compact packaging for a solo, low-risk local factory; select normal
  packaging for multiple products or material operating choices; select
  high-risk packaging when authority, isolation, credentials, or recovery is
  material.
- Emit: discovery record; proposal; approval record; resolved profile and
  locked versions; local-operation identities and observed results; explicit
  pending/unsupported effects; prepared Console configuration; preflight result;
  and a small delivery-loop demonstration plan. Include the integration
  inventory with owner decisions and separate evidence references for every
  enabled-and-verified item.
- Record evidence as `proposal@<revision>`, `config@<revision>`, approver,
  operation ID, exact root, source-snapshot digest when applicable, observed
  filesystem/Git result, and remaining gate.
  For example: `local scaffold observed at <root>; remote GitHub repository:
  pending/unsupported; owner approval: approval@<revision>.`
- Hand the accepted factory profile and its documented kit-root paths to the
  **product-creation skill**. A later product inherits factory defaults, reports
  incremental cost and workload, and creates no pod automatically; apply its
  approved bundle with `faktori product new`. Escalate instead of widening
  authority for missing approval, changed source snapshots, budget uncertainty,
  credential requests, unsupported effects, or unreconciled recovery.
