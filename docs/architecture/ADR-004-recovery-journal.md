# ADR-004: Reconcile uncertain operations after restart

Status: accepted

The coordinator owns an append-only journal for runs, reservations, messages,
pending operations, and receipts. A crash between intent and result creates an
unresolved operation. Startup must reconcile it before retrying; an expired
heartbeat alone never proves that a worker stopped. Cancellation revokes
publication permission before worker termination, and late results are retained
without side effects.
