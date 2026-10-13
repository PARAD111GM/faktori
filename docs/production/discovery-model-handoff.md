# Discovery model handoff

This handoff uses the owner's existing Codex CLI session to obtain a structured requirements proposal. Faktori does not launch a provider, select a model, or treat the response as owner approval.

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
