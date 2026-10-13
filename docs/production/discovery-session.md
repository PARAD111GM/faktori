# Attended requirements interview

`prepareProductDiscoverySession` starts with an owner's raw idea and produces a resumable interview. It supports a new web/native mobile product or the next complete increment of an existing live product. It does not require a completed product definition before asking the first useful question.

The initial interview covers users, measurable outcomes, current workflow, one complete journey, scope exclusions, errors and permissions, data, integrations, constraints, budget and review time, and release/recovery criteria. Mobile questions cover native UI, device and OS support, offline behavior, native capabilities and store ownership. Shared native mobile code is the default. A later product-definition owner decision must explicitly authorize any separate-codebase exception.

The model helps interpret the idea, expose assumptions and ask high-information follow-ups. Its output is always a proposal. Owner answers are recorded through a separate API, with the owner identity and a source reference. An answer is a declaration, not independently observed evidence or approval of a product definition. `unknown` and `deferred` responses preserve the question as unresolved. A corrected answer appends another response; the prompt uses the latest response for unresolved-question selection and retains earlier responses as context.

## Start, answer and resume

From an installed Faktori package under the supported Node runtime:

```js
import { readFile } from 'node:fs/promises';
import {
  prepareProductDiscoverySession, renderProductDiscoveryPrompt,
  recordProductDiscoveryAnswer, recordProductDiscoveryProposal, saveProductDiscoverySession,
  loadProductDiscoverySession,
} from 'faktori/production';

// Resolve the packaged example path, or use your own owner brief.
const seed = JSON.parse(await readFile('/absolute/path/discovery-session.json', 'utf8'));
let session = prepareProductDiscoverySession(seed);
const log = '/absolute/existing/private-directory/discovery.jsonl';
await saveProductDiscoverySession(log, session);
console.log(renderProductDiscoveryPrompt(session));

session = recordProductDiscoveryAnswer(session, {
  id: 'answer.users.1',
  questionId: 'interview.users',
  ownerId: seed.ownerId,
  text: 'The first users are dispatchers at repair teams with 3–10 technicians. The team owner pays. Dispatchers need to recover the schedule when visits overrun.',
  disposition: 'answered',
  source: { reference: 'owner-interview:field-service/users', revision: '1' },
});
await saveProductDiscoverySession(log, session);
session = await loadProductDiscoverySession(log);
console.log(renderProductDiscoveryPrompt(session));
```

The example answer illustrates the recording shape; replace it with the owner's actual response. The API requires explicit platforms and owner identity. An omitted `ideaSource` receives a local `session:<sessionId>/owner-intent` reference to the supplied statement. This identifier does not claim external evidence. Source references should point to a portable owner brief, interview record or revision-bound artifact. Never store credentials in interview text or sources.

The log path must be canonical and absolute. Its parent directories must already exist and have no symlink aliases; resolve the real parent path before supplying it. Hardlinked logs are rejected. New logs are created with mode `0600`. Keep interview data in private local operational storage, outside the public repository. This file format is portable and contains no provider credentials.

## Use the existing coding provider

Render the prompt and send it through the owner's existing coding-provider session. Use an owner-selected frontier model and reasoning setting suited to complex requirements discovery. Provider model availability and account authentication remain provider-owned. This module launches no provider or scheduler and makes no model-selection or account-readiness claim.

For a structured attended Codex turn, write `productDiscoveryProposalOutputSchema` to a local JSON file and the rendered prompt to another file. The existing unmodified CLI can consume them:

```sh
codex exec --model "$OWNER_SELECTED_MODEL" --sandbox read-only \
  --output-schema /absolute/path/proposal-schema.json \
  --output-last-message /absolute/path/model-response.json \
  - < /absolute/path/discovery-prompt.txt
```

Choose the model explicitly from the owner's currently available provider capabilities. The command is an operator handoff, not an executed or validated live-provider receipt. The read-only sandbox constrains workspace changes; owner attendance and provider policy still govern tool access. No execution, publication, deployment or release authority is created by an interview.

Record the returned data with `recordProductDiscoveryProposal`, adding an operator-owned proposal ID and the exact output reference:

```js
const output = JSON.parse(await readFile('/absolute/path/model-response.json', 'utf8'));
session = recordProductDiscoveryProposal(session, {
  ...output,
  id: 'proposal.model.1',
  source: { reference: 'file:/absolute/path/model-response.json', revision: 'response-content-digest' },
});
await saveProductDiscoverySession(log, session);
```

`status` must be `proposed`. The model may return `text` and new questions with `id`, `topic` and `text`; unknown fields, duplicate IDs and attempted acceptance fields are rejected. Every model question retains its proposal ID. Operator records should preserve the full model response separately. This API is a local provenance discipline, not an authentication service: the trusted attended operator must record actual owner answers through the answer path and model output through the proposal path.

## Existing live products and definition handoff

A seed can include `existingProduct`:

```json
{
  "baseline": { "reference": "git:product-repo", "revision": "exact-source-commit" },
  "deployedArtifact": { "reference": "deployment:production", "revision": "exact-artifact-revision" },
  "notes": [
    {
      "text": "An old mobile client remains supported; contract compatibility needs investigation.",
      "source": { "reference": "owner-brief:client-support", "revision": "1" }
    }
  ]
}
```

That selects `live_increment` and adds a baseline question before the general interview. Declared source/deployment refs are context, not live verification. Supported clients, API/data contracts, schema constraints, migrations, incidents, telemetry, concurrent work and rollback remain explicit discovery subjects. Omit `deployedArtifact` when unknown; the prompt asks for the missing evidence.

Use the session's sourced answers and separately recorded proposals to draft `faktori.product-definition/v1`. That contract requires its full section arrays and explicit source mapping. Model assumptions and proposals stay proposed; owner decisions and acceptance are separate records. Interview completion never automatically marks a definition accepted, design-ready, execution-ready or production-ready. Use the product-definition inspector and later delivery gates for those decisions.

## Revision and recovery guarantees

Pure transition APIs return deeply frozen new snapshots. Each answer or model proposal advances the revision and records a SHA-256 digest of its parent. Saving serializes writers through the existing ownership lock, checks the entire history and appends a complete newline-terminated JSON snapshot followed by file synchronization. Retrying the exact latest snapshot is an idempotent no-op. Earlier answers, questions, proposals, owner intent and baseline cannot be rewritten through the persistence API. A stale writer must reload and reapply its new response with a distinct response ID.

The log is bounded to 400 revisions and eight megabytes; individual snapshots and entries are also bounded. These limits fail explicitly instead of silently dropping context. This is an attended interview log, not an unbounded model transcript store.

Interrupted writes, incomplete final lines, inconsistent parent digests, changed log paths and unresolved ownership guards fail closed. Preserve the file and investigate; do not automatically delete the guard, truncate the log or overwrite the last revision. Recover from a backed-up validated log under owner control. Hash links detect accidental rewriting and stale transitions; a person with filesystem write access can rewrite an entire log, so this is not a tamper-proof audit system.
