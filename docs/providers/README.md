# Provider-neutral guidance

Adapters wrap unmodified vendor CLIs and explicit session identities. Each
adapter probes version and capabilities, starts a bounded run, resumes an
explicit session, streams normalized events, handles supported native requests,
and cancels with a reported resulting state.

Capabilities must make approval replies, questions, resume, cancellation,
usage, and sandboxing visible. Unsupported capabilities never silently widen
permissions. Results distinguish completed, unchanged-but-verified, blocked,
authentication-required, quota-exhausted, failed, cancelled, and interrupted
with uncertain outcome.

Provider authentication stays in the provider’s own login and credential
store. Public docs must never contain a token, session export, or machine-local
credential path. See [adapter contract](adapter-contract.md).
