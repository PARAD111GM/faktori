# Manager Loop publication handoff

A successful Manager Loop is local acceptance, not publication. Publication is
an explicit, owner-approved two-step handoff that freezes the accepted content,
binds it to one immutable commit, and creates or reconciles one draft pull
request. It never commits, merges, deploys, or marks external review complete.

## 1. Freeze the accepted content

Run this immediately after the loop succeeds, while the accepted workspace
still has the exact content reviewed by the loop. The workspace can be dirty;
that is the normal Manager Loop result. Put the request in an owner-controlled
file:

```json
{
  "format": "faktori.loop-publication-prepare/v1",
  "approved": true,
  "workspace": "/absolute/path/to/the/loop-workspace",
  "loopArtifactsDirectory": "/absolute/path/to/the/loop-records",
  "bundleDirectory": "/absolute/path/to/a/private-publication-bundle"
}
```

```sh
faktori loop publication prepare /absolute/path/to/prepare.json
```

The command verifies the succeeded report, the final manager acceptance, its
referenced passing independent review, and the configured verification
receipts. It then verifies the live workspace digest against that exact
acceptance before and after capture. The private bundle contains:

- `handoff.json`: the loop, review, acceptance, report, and reviewed-tree
  bindings;
- `files/`: regular payload files for the complete versionable tree. Symlink
  targets are stored as inert file content and are never followed;
- later, `publication.json`: durable publication intent and observation.

The bundle and loop-artifact directories must be real, owner-controlled
directories with owner-only permissions. Payload and record files must be
owner-owned regular files with owner-only permissions. Preparation is bounded
to 20,000 files and 512 MiB and refuses an unstable workspace. It does not run
project hooks, project scripts, or provider commands.

If the workspace has changed since acceptance, rerun the Manager Loop review
and manager acceptance. Do not edit a digest or handoff to make it fit.

## 2. Commit the frozen tree, then publish it

The owner or an owner-controlled tool creates a commit from the frozen content.
Faktori does not create that commit implicitly. Prepare a second explicit
request naming the controller-owned checkout and exact publication scope:

```json
{
  "format": "faktori.loop-publication-request/v1",
  "approved": true,
  "bundleDirectory": "/absolute/path/to/a/private-publication-bundle",
  "publication": {
    "repository": "owner/product",
    "branch": "faktori/accepted-work",
    "baseRefName": "main",
    "baseRevision": "0123456789abcdef0123456789abcdef01234567",
    "expectedRevision": "89abcdef0123456789abcdef0123456789abcdef",
    "publisherRemote": "origin",
    "publisherWorktree": "/absolute/path/to/controller-owned-checkout"
  }
}
```

```sh
faktori loop publication publish /absolute/path/to/publish.json
```

Before any external write, Faktori checks that:

- approval and every scope field are present, with no extra authority fields;
- the publication branch differs from the base branch, so this path cannot push
  the reviewed commit directly onto the named base;
- the bundle, records, and controller checkout pass ownership and permission
  preflight;
- the selected commit exists and its complete tree exactly matches the frozen
  reviewed-tree manifest;
- the named base commit is an ancestor of that commit;
- the configured GitHub repository identity is exact and the current account
  has write, maintain, or admin permission.

Faktori records `intended` atomically in both the bundle and
`<loopArtifactsDirectory>/publication.json` before pushing. The controller Git
boundary disables project hooks, global Git configuration, credential helpers,
and interactive prompting, then pushes the exact commit object rather than the
checkout's current `HEAD`. The GitHub boundary creates a draft pull request and
re-reads its head, base, and immutable head commit before recording success.
The controller's `gh` and Git transports must already be authenticated for
non-interactive use. Faktori does not copy credentials, enable a credential
helper, inherit a project token, or automate login. A GitHub CLI login by
itself may not authenticate the deliberately sanitized Git push boundary; the
owner must configure that controller boundary explicitly. Authentication or
permission failure stays visible as a publication failure.

## Recovery and receipts

The operation ID is derived from the accepted evidence, reviewed tree,
repository, branch, base, and expected commit. Retrying the same request reuses
an already observed pull request. If a process stopped after the remote effect
but before the local receipt, retry searches for the same operation marker and
accepts only one draft pull request with the exact repository, head branch,
base branch, and commit. A mismatch fails closed. A surviving final receipt
repairs an `intended` mirror only after the same pull request is freshly
observed as open. A missing, closed, merged, ambiguous, or mismatched prior pull
request becomes `uncertain`; retries keep observing it and never create a
replacement implicitly.

The observable receipt shape is:

```json
{
  "format": "faktori.loop-publication-receipt/v1",
  "status": "published",
  "operationId": "loop-publication-...",
  "loop": {
    "loopId": "...",
    "acceptedEvidenceDigest": "sha256:...",
    "reviewStageId": "...",
    "managerAcceptanceStageId": "..."
  },
  "binding": {
    "repository": "owner/product",
    "branch": "faktori/accepted-work",
    "baseRefName": "main",
    "baseRevision": "...",
    "expectedRevision": "...",
    "reviewedTreeDigest": "sha256:..."
  },
  "pr": {
    "number": 12,
    "url": "https://github.com/owner/product/pull/12",
    "headRefName": "faktori/accepted-work",
    "headRefOid": "...",
    "baseRefName": "main",
    "isDraft": true
  },
  "observedAt": "..."
}
```

Only `published` or `reconciled` with an exact binding and observed pull-request
URL proves the publication gate. `intended`, `blocked`, `failed`, and
`uncertain` require owner attention. Even a published receipt proves only that
the reviewed commit is attached to that draft pull request. External review,
merge, deployment, and staging verification remain separate owner-observed
delivery gates.
