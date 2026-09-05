# Adapter contract

An adapter receives a scoped context packet, approved execution profile, and
bounded budget. It returns normalized events plus a final result and usage
telemetry when the provider exposes it. A session identifier is opaque and is
only resumed explicitly in the same recorded workspace.

The coordinator owns admission, reservations, cancellation authority, and all
publication. An adapter may report a provider denial or missing capability,
but may not reinterpret either as approval. Redacted evidence records command
shape, version, event kind, and outcome; never credentials or raw private
transcripts.
