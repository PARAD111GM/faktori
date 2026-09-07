# Phase 8 stacked PR descriptions

No remote is configured in this worktree. These descriptions are prepared for owner-approved publication after Build Manager acceptance and any required Phase 7 base update.

## F8-01 — Structured blocker details

**Title:** `feat: add structured blocker diagnostics`

**Commit/base:** `735478b` on `af958a28f8366e91683f3f67615cc2ec5ea0ee88`

Adds `faktori.blocker/v1` details to existing delegation refusals without changing `accepted: false` or the prior reason string. Safe blocker observations are journaled best-effort, projected into the Console, and removed after matching admission or after each named conflicting child reaches a durable terminal provider receipt. Paths and identities are value-validated, credential signatures and private control paths are omitted with counts, and stable IDs are computed from the safe projection.

Verification: blocker unit negatives, delegation admission/recovery tests, Console state tests, TypeScript, full repository gate, and independent security review.

## F8-02 — Redacted exportable run manifest

**Title:** `feat: export redacted run manifests`

**Commit/base:** `8147bab` on F8-01 `735478b` (stacked)

Adds `faktori.run-manifest/v1` plus `faktori run manifest <journal.jsonl> <run-id>`. The command reads committed JSONL without opening the journal repair path or mutating the source. Output is an exact-schema, field-and-value-allowlisted observation report with credential-signature rejection, explicit omission reasons, separated usage categories, and a deterministic canonical SHA-256 digest. Prompts, messages, sessions, authority, summaries, private paths, URLs, remotes, and raw events are never exported.

Verification: manifest determinism/redaction/parser negatives, CLI source-preservation tests, public export checks, installed packed CLI proof, TypeScript, full repository gate, and independent security review.

## F8-03 — Unified read-only preflight and remediation

**Title:** `feat: add fail-closed operational preflight`

**Commit/base:** `84c3fbb` on F8-02 `8147bab` (stacked)

Adds `faktori.preflight-result/v1`, `faktori preflight <request.json>`, and the same sanitized projection in the Factory Console. Checks cover configuration, Console, execution, resources, provider capabilities, integrations, and live evidence with stable credential-safe IDs, scope, basis, freshness, and fixed remediation. Public JSON success assertions remain explicitly unverified. A small shared local inspector opens an existing SQLite projection strictly read-only, validates its Faktori table shape, and can establish projection readiness while execution and live verification remain unknown; missing/invalid projections get specific nonexecuting remediation. Failures dominate contradictory provider observations. No provider, authentication, installation, repair, or network surface is invoked.

Verification: deterministic and malformed-input tests, self-certification and revision-binding negatives, Console preparation/service tests, CLI tests, installed packed CLI proof, TypeScript, full repository gate, and independent security review.

## Publication and acceptance notes

- Do not publish until the owner authorizes remote use and the Build Manager accepts the exact candidate head.
- If accepted Phase 7 lands at a different head, update the stack base and rerun the pinned full gate before publication.
- These PRs add diagnostic/read-only surfaces only; no provider execution, credential handling, deployment, merge, or product-infrastructure authority is included.
