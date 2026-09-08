# Operational clarity

Phase 8 adds three read-only explanation surfaces to the existing journal,
coordinator, API, CLI, and Console. They add no scheduler, authority, repair
engine, provider launch, login flow, or persistent store.

## Structured blockers

Delegation admission keeps its existing accepted and reason behavior and may
add a faktori.blocker/v1 value. The blocker has a deterministic identity, fixed
reason code and remediation, the decision-owning coordinator role, observed
parent, child, and workstream identities, and sorted ownership overlaps.

Repository-relative paths pass the same overlap predicate used by admission.
Absolute paths, traversal, URLs, control-storage paths, secret-looking values,
and unsafe identities are omitted with counts. A rejected admission records the
safe blocker as an observation on the authoritative journal. The Console
derives unresolved blockers from those events and removes a blocker when the
same parent and delegation are later durably admitted or the named conflicting
child has a durable terminal provider receipt. Displaying a blocker never
resumes, serializes, approves, or changes work.

## Redacted run manifest

    faktori run manifest <journal.jsonl> <run-id>

The command reads committed JSONL without creating, repairing, truncating, or
rewriting the source. It emits faktori.run-manifest/v1 to stdout. The report
contains only allowlisted, value-validated observations already present for the
run: safe target and work identities and revisions, context and input digests,
provider, model, profile, resource settings, outcome, and per-category usage.

The exporter excludes authority, credentials (including common credential
signatures that otherwise look like valid identifiers), sessions, prompts, messages,
summaries, verification prose, raw events, private paths, URLs and remotes, and
arbitrary nested values. Each absent or rejected category is marked
not_observed or unsafe_or_invalid. Unavailable usage remains unavailable;
cached input and reasoning stay separate and are not added to another total.
contentDigest is SHA-256 over the canonical public report excluding only the
digest field itself, so identical safe observations produce identical output.
There is no export timestamp.

## Unified preflight

    faktori preflight <request.json>

The diagnostic request contract is faktori.preflight/v1; a public projection-only example is
[preflight-projection.json](../examples/diagnostics/preflight-projection.json).
It contains the canonical factory configuration, selected target and profile,
and explicit, untrusted observation assertions for:

- Console projection prerequisites;
- execution prerequisites;
- resource and budget compatibility;
- configured provider capabilities;
- requested integration prerequisites; and
- optional target-scoped live-evidence assertions bound to the request's
  `expectedRevision`.

The evaluator reuses the normal configuration resolver and returns
faktori.preflight-result/v1. Every check has a stable ID, section, status,
observation basis, freshness, scope, and fixed non-executing remediation.
Configuration-derived checks can pass, while caller-supplied success assertions
remain `not_tested` with unknown freshness. Negative observations remain
fail-closed, conflicting provider observations are fail-dominant, and every
caller-controlled diagnostic ID uses the same credential-safe validator.

For an installed check, wrap that request in
`faktori.preflight-installation/v1` with `installation.factoryId` and an
absolute `installation.projectionPath`. The CLI opens the existing SQLite file
with `readonly` and `fileMustExist`, verifies the Faktori `run_events` table
shape, and never emits the path. The Console supplies those same facts from its
already validated owner-controlled local configuration. A valid projection with
at least one matching durable admission can set `projectionReady: true`. A
valid empty projection remains `not_tested` because it has no durable factory
binding yet; that does not prevent the Console from running in its empty state.
A missing projection or one containing a foreign/invalid admission fails with a
specific rebuild remediation. Neither caller JSON status nor freshness can make
execution or live evidence verified. Preflight is an observation report, never
an admission lease; the coordinator must revalidate current scope, capacity,
budget, and authority at admission time.

The core evaluator is data-only. It does not import filesystem, process, transport,
provider adapter, coordinator, approval, provisioning, script, or network
execution surfaces. The small local inspector imports only the existing SQLite
projection reader and path validator; it cannot write, launch, install,
authenticate, repair, or reach the network. The Factory Console renders the
same sanitized result when its owner-controlled local configuration supplies
preflightRequest.
