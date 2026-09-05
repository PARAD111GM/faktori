# Troubleshooting maintenance

## `coordinator is active` or `ownership is unresolved`

Backup and reconciliation require the coordinator to be stopped and its
admission quiesced. Do not delete a lock just to make the command pass. Confirm
the owning process is gone, then retry; an unresolved worker or side effect
still requires reconciliation evidence.

## `unterminated journal tail`

The journal was written while a record was incomplete. Stop the coordinator and
recover the authoritative journal before taking a backup. The backup command
does not silently discard the tail.

## `restore destination already exists`

Restore is intentionally non-destructive. Choose a new empty destination; it
will never overwrite an existing owner directory or restore into the backup.

## `decisions must cover every pending recovery exactly once`

Read `.faktori/restoration.json` and the restored journal. Submit one decision
for each recovery ID, with evidence, and use the backup's exact `sourceBackupId`.
`blocked` is a valid outcome for the affected run. Once every recovery has one
explicit disposition, reconciliation does not globally freeze unrelated
admission; the affected run remains visibly blocked until its own authority and
effect state is resolved.

## Update preview refuses the candidate

Check the candidate package's version, `faktoriStateFormatVersion`, and declared
public files. A candidate older than the active version, with an unsupported
state format, or with changed same-version content must be published as an
explicit supported release instead of being forced through.

## Credentials or private paths appear in a request

Provider credentials stay in the provider's credential store and must be listed
under `credentialPaths` so they are explicitly excluded from backups. JSON
configuration additionally strips keys matching Faktori's sensitive-key
pattern, but that pattern cannot find arbitrary secrets hidden under unrelated
keys or in non-JSON files. Use paths relative to the factory root in backup
requests; never commit machine-specific absolute paths, tokens, cookies, or
private identifiers.
