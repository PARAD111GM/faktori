# Discovery model handoff

This handoff uses the owner's existing Codex CLI session to obtain a structured
requirements proposal. The attended native command launches only the explicitly
selected route; model output never becomes owner approval.

## Attended native proposal

Create and save a raw-idea discovery session first. Prepare an existing product
workspace and a private artifact directory with mode `0700`. Supply their
canonical absolute paths, the saved history, an operator-chosen proposal ID and
the exact qualified CLI executable in a private configuration:

```json
{
  "historyPath": "/absolute/private/discovery.jsonl",
  "proposalId": "proposal.model.1",
  "workspacePath": "/absolute/private/product",
  "artifactsDirectory": "/absolute/private/discovery-artifacts",
  "provider": {
    "kind": "codex",
    "executable": "/absolute/path/to/codex",
    "model": "OWNER_SELECTED_MODEL",
    "reasoning": "high",
    "contextIsolation": "bounded",
    "nativeAccessApproved": true
  },
  "limits": {
    "maxRuntimeMinutes": 5,
    "maxRetries": 0,
    "maxOutputBytes": 2000000,
    "maxResponseBytes": 250000
  }
}
```

Set `nativeAccessApproved` only for the operator-approved native route, workspace
and data scope. Do not copy the example as authority. The model must be available
through the selected executable/account; Faktori never substitutes a separately
billed provider. Then run:

```sh
faktori discovery propose /absolute/private/operator-config.json
```

The command renders the current interview, writes its structured output schema,
executes one read-only native proposal turn and retains private lifecycle,
bounded raw capture and complete normalized artifacts. Only a completed native
turn with a valid exact response may append a proposal. The immutable interview
history rejects stale or concurrent writers. Failed, malformed or overflowing
turns retain their artifacts and cannot append; the CLI exits nonzero for a
provider failure or rejected response. Read-only/bounded context does not prove
OS filesystem isolation, and this route remains attended.

Runtime bounds apply per attempt; maximum provider time is that bound multiplied
by `maxRetries + 1`. Retrying is bounded to at most two additional attempts and
never retries authentication, quota, denial or uncertain interruption. No token
or financial cap is inferred from runtime/output bounds; reported usage remains
separate. Exact replay of the same recorded proposal/configuration checks retained
response bytes and launches no provider. Conflicting reused IDs fail. A later
interview revision uses a new proposal ID.

Review the result with `discovery resume`, record real owner answers with
`discovery answer`, then request the next proposal against that same history.
Consequential owner decisions and definition acceptance remain separate steps.

## Manual provider handoff

The explicit prompt/schema/file-import path remains available for operators who
already ran the vendor CLI themselves. These commands do not launch a provider.

## Prepare and run

Create a discovery session and private history file using the discovery-session instructions. Then render the current prompt and save the output schema to private files. For example, using the installed `faktori` command and an already-created history file:

```sh
faktori discovery prompt /absolute/private/path/discovery.jsonl > /absolute/private/path/discovery-prompt.txt
```

Write the printed `outputSchema` value as JSON to `/absolute/private/path/proposal-schema.json`. Choose the model and reasoning setting from the owner's available Codex capabilities, then run an attended, read-only CLI turn:

```sh
codex exec --model OWNER_SELECTED_MODEL --sandbox read-only \
  --output-schema /absolute/private/path/proposal-schema.json \
  --output-last-message /absolute/private/path/model-response.json \
  - < /absolute/private/path/discovery-prompt.txt
```

Use actual absolute paths in a private local directory that already exists. Keep the prompt, response, schema and history out of public repositories. Do not put credentials in discovery data. The CLI command is the provider handoff; it does not establish a provider receipt or grant execution, publication, deployment or release authority.

## Import the response

After reviewing that the exact output file is the intended model response, import it with an operator-chosen proposal ID:

```sh
faktori discovery import-proposal \
  /absolute/private/path/discovery.jsonl \
  /absolute/private/path/model-response.json \
  proposal.model.1
```

The importer accepts exactly `status`, `text` and `questions` from the model JSON. It rejects extra fields such as `id`, `source` or `recordedAt`, then attaches the supplied proposal ID and a source reference containing the canonical response-file path and SHA-256 digest of its exact bytes. Input must be a regular, unaliased file no larger than one megabyte. The proposal remains `proposed`; it cannot represent an owner answer or acceptance.

The importer validates and appends a new immutable session revision. Repeating an import with the same ID, file content and source is an idempotent no-op when that proposal is already in the latest session. Reusing an ID for different content or a different source fails. To import a changed model response, use a new proposal ID. Preserve the original response file with the session history for review.

Review the resulting session with `faktori discovery resume /absolute/private/path/discovery.jsonl` and render a fresh prompt if further questions are needed. Record actual owner responses through the separate `discovery answer` path. Model proposals and owner decisions remain distinct throughout definition drafting and acceptance.
