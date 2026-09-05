# ADR-001: Keep the artifact chain portable

Status: accepted

Intent, specifications, plans, policies, evidence references, and approved
configuration use ordinary version-controlled documents and stable identifiers.
Generated configuration lives outside this source repository. A product may
span repositories, but one artifact home is named explicitly.

This keeps handoffs independent of a vendor conversation, makes review and
recovery inspectable, and prevents private runtime state from becoming public
source. Provider-native links remain references, not replacements for the
accepted scope or evidence.
