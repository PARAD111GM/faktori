# ADR-002: Publication authority belongs to the coordinator

Status: accepted

Workers can edit an approved workspace and run product checks. They cannot
publish using controller credentials. Before an external mutation the
coordinator records operation identity, target repository, branch/base,
resulting commit expectation, and current authorization; afterward it records
the observed result. Merge and production release remain human-authorized by
default.
