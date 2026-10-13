# Discovery session to full product-definition draft

The deterministic draft bridge imports a complete model-generated
`faktori.product-definition/v1` proposal against one immutable discovery session.
It does not launch a provider, append interview history, fabricate owner
decisions, or authorize execution or release. Web, native iOS/Android and live
increments use the same bridge. Platform targets describe the product being
produced. A proposed first slice does not replace the owner's full product goal.

Use `renderProductDefinitionDraftPrompt(session)` for the model context and
`productDefinitionDraftOutputSchema(session)` for its complete output shape.
The schema is specialized for the session's new-product/live-increment mode.
The model returns exactly `{ "sessionDigest": "<digest>", "definition": {...} }`.
The definition contains all ordinary definition sections but **omits**
`ownerDecisions`, `definitionDecisionId`, per-record `decisionId`, and native
`exceptionDecisionId`. All records have `status: "proposed"`. The importer
injects an empty owner-decisions array only after rejecting model authority.

```ts
import {
  importProductDefinitionDraft, productDefinitionDraftOutputSchema,
  renderProductDefinitionDraftPrompt, productDiscoverySessionDigest,
  inspectProductDefinition,
} from 'faktori/production';

const expectedSessionDigest = productDiscoverySessionDigest(session);
const prompt = renderProductDefinitionDraftPrompt(session);
const outputSchema = productDefinitionDraftOutputSchema(session);
// The operator obtains the response separately and preserves its exact bytes.
const draft = importProductDefinitionDraft(session, {
  expectedSessionDigest,
  sourceReference: 'file:/absolute/private/model-definition-response.json',
  responseBytes,
});
// Existing inspection reports proposed records and missing owner acceptance.
const inspection = inspectProductDefinition(draft.definition);
```

The response is limited to one megabyte and must be valid UTF-8 JSON. Its exact
bytes are copied before parsing and hashed as `draft.source.revision`; whitespace
or key-order changes produce a different byte receipt. The validated definition
has a separate semantic `definitionDigest`. The operator digest and model's
echoed digest must both equal the supplied session's digest. The caller owns
canonical/private file checks and storage of the original response; this pure
API accepts bytes and cannot establish that a reference points to a real file.
The importer never normalizes a source file and then calls the normalized bytes
the original response. The frozen envelope retains the full session and has no
clock-dependent fields, making imports deterministic for the same inputs.

`productDefinitionDraftOwnerSources(session)` exposes the permitted exact source
entries. `owner.intent` identifies the original idea source. Answer source IDs
are `owner.answer.<SHA256 of answer id>` and identify only the latest **answered**
answer for each question, with that answer's original source reference/revision.
Corrected older answers and latest unknown/deferred answers cannot be cited as
current owner requirements. The envelope's bindings retain answer IDs and the
digest of each actual answer. Live context sources identify the original
baseline, optional deployed artifact, and owner baseline notes as declarations.
They never become `observed_constraint` evidence; all such model sources are
rejected. When the owner supplied a deployed artifact, its draft record must
cite `owner.live.deployed-artifact`. The original live context remains intact in
the envelope even while the model proposes its interpretation.

Other sources must be explicitly `proposed_assumption`, use
`session:<session-id>/assumption:<source-id>` at `sha256:<session-digest>`, and
have a corresponding proposed assumptions record. A source link proves which
declaration was cited; it does not verify semantic entailment or establish that
the owner approved the model's interpretation. Every derived statement remains
proposed. The envelope is labelled `model_interpretation_not_verified`, preserves
unresolved interview question IDs, and leaves missing content for the existing
definition inspection and owner review. Structural import success is not proof
of requirements completeness.

The importer also rejects changes to product identity, raw idea, intent source,
selected platforms, shared-native policy, new/live mode or the live baseline.
Native UI remains mandatory. A future owner-approved separate-native exception
belongs to the independent owner-decision path, not model output. Owner review
must resolve scope, assumptions, live continuity, and positive/failure/recovery
acceptance before design or delivery gates can pass.
