# Maintenance kit

This kit is for an owner operating a local Faktori installation. It does not
export provider credentials, rebuild the disposable SQLite projection into a
backup, or decide whether an uncertain side effect happened. Stop admission and
resolve those decisions explicitly before a restored factory is allowed to run.

## Quickstart

Use Node.js 24 LTS and npm 12 on macOS or Linux. WSL2 is unverified. From the
repository or an installed package:

```sh
npm ci --ignore-scripts
npm run build
npm run pack:verify
```

The complete source check also verifies two local host prerequisites: a POSIX
`ps` command for fail-closed Console coordinator identity, and the GitHub CLI
(`gh`) for the configured GitHub integration probe. The probe only observes the
installed binary; it does not authenticate or contact GitHub. If `ps` is not
available, Console startup refuses coordinator ownership rather than guessing.
Managed-release installation stays offline. Before update, provision an
approved npm cache containing the candidate's exact public dependencies;
installation scripts stay disabled and a missing cache entry stops before
release activation.

The packed check installs the tarball into a clean temporary consumer and runs
the installed CLI and public exports. For a source checkout, the CLI examples
are invoked with `npm run faktori -- ...`.

### Backup, restore, reconcile

Create a request whose `sourceRoot` is the normalized absolute factory root.
All paths inside the request are portable relative paths. Include the committed
operational journal, owner configuration JSON, product artifacts, and required
run records; do not include provider credential stores. Set `credentialPaths`
explicitly to any credential-store paths to exclude. Configuration JSON also
strips only keys matched by the documented sensitive-key pattern; this is not a
claim that arbitrary secrets can be detected.

```sh
npm run faktori -- backup create examples/maintenance/backup-request.json /absolute/path/backups/factory-2026-01-01
npm run faktori -- backup restore /absolute/path/backups/factory-2026-01-01 examples/maintenance/restore-request.json
npm run faktori -- backup reconcile /absolute/path/restored-factory/reconcile-request.json
```

`backup create` takes an offline coordinator lock and refuses an unterminated
journal. `backup restore` takes the backup directory and a
`faktori.restore-request/v1` JSON file containing `destinationRoot`,
`expectedFactoryId`, `expectedSourceRoot`, and
`rebindConfigurationPaths: true`. It requires a new destination, explicitly
rebinds owner-configuration absolute paths from the recorded source root to the
destination, and leaves historical journal evidence unchanged (apart from
appending recovery events). Inspect recovery blocks and use `backup reconcile`
with evidence for every recovery ID. A `blocked` disposition keeps that
affected run visibly blocked; once every recovery has an explicit disposition,
unrelated runs are not globally frozen.

### Initialize and update

Register a candidate public kit once, then preview it before applying it:

```sh
npm run faktori -- update initialize /absolute/path/initialize-request.json
npm run faktori -- update preview /absolute/path/update-request.json
npm run faktori -- update apply /absolute/path/approved-update-request.json
```

The approval file must contain the exact `previewDigest` returned by preview and
an owner identity/timestamp. Supported state migrations are explicit. Older
versions, unsupported state formats, same-version content changes, and silent
rollbacks are refused. Files outside `.faktori/` release control remain owner
material and are not overwritten. Installation keeps lifecycle scripts disabled,
then builds only the exact pinned `better-sqlite3` dependency and requires a real
SQLite projection rebuild through the selected installed CLI before activation.

Before updating an existing installation, create an ordinary backup and inspect
the update preview/diff with the owner. Preserve the active runtime until the
owner accepts the exact preview. An update neither restarts workers nor changes
provider authentication, credentials, configured spending, or billing routes.
Those are separate owner decisions. After a safe cutover window, inspect the
offline setup-readiness inventory in [the agent update guide](../agent-update-guide.md);
it identifies omitted routes and integrations but does not prove a live service.

See [the local customization example](../../examples/maintenance/README.md),
[troubleshooting](troubleshooting.md), and [compatibility](compatibility.md).
