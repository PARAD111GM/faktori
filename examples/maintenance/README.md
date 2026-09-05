# Local customization example

Keep owner material beside (not inside) the public package. This example uses a
factory-owned configuration and an operational journal under one local root;
replace `/absolute/path/my-factory` with your own normalized absolute path.

`backup-request.json` demonstrates the portable request shape. The source root
is intentionally a placeholder so this example cannot accidentally read or
publish a developer's machine. Create the listed files in your own factory,
set `credentialPaths` to every provider credential-store path, then run:

```sh
npm run faktori -- backup create examples/maintenance/backup-request.json /absolute/path/backups/first
```

Configuration JSON is sanitized for sensitive-looking keys. Product artifacts
and operational records are copied with their digests and modes. Provider
credential paths are not included.

To restore, edit `restore-request.json` with the backup manifest's exact factory
identity and source root, choose a separate empty destination, and keep
`rebindConfigurationPaths` set to `true`. Configuration absolute paths are
rebound to the new destination; historical journal evidence is not rewritten.
Inspect the resulting recovery requirements and reconcile each one with
observed evidence. A blocked disposition affects that run, not unrelated
admission.
