# Lean loop templates

Copy `implementation.json` for approved new work or `validation-only.json` for
an existing frozen candidate. Replace every `/absolute/...` path, exact revision,
approval identity/revision, requirement, criterion, verifier, and route with
owner-controlled values. Do not run an example unchanged.

The route arrays are owner cost/availability order; they are not price claims.
Use `availability: "unknown"` when availability is not known. Keep
`knownQuota: "unknown"` unless an owner-controlled source already knows the
answer. See `docs/lean-execution.md` for the full contract.

