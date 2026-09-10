---
name: faktori-update
description: This skill should be used when an owner requests /faktori-update, upgrades an existing Faktori installation, or connects existing Manager Loop records to an updated Console without restarting product work.
---

# Update an existing Faktori factory

Update the installed kit, not the product being built. Preserve owner material
and execution continuity. Treat invocation as an update request, not permission
to migrate incompatible state, interrupt workers, widen authority, or buy services.

## Discover the target

Accept an optional factory path and target revision. Default to merged `main` of
`https://github.com/PARAD111GM/faktori` unless the owner selected a release channel
or pinned revision. Never replace a customized fork or its remote without approval.
For managed installations, compare package versions before planning cutover.
Changed content at the same version (including two `0.0.0` main revisions) is
not a supported managed update. Stop and request a versioned release; never
invent a version, bypass identity checks, or silently switch installation modes.

1. Locate the source checkout, installed runtime, Console launch command, owner
   configuration, operational records, and relevant Manager Loop configs. Ask one
   concise question if multiple factories leave the target ambiguous. Do not scan
   unrelated home directories or credential stores.
2. Read `AGENTS.md`, `INSTALL.md`, and `docs/manager-loop.md` from that kit. Consult
   `docs/maintenance/README.md` and its compatibility guide for managed updates or
   state-format changes. Resolve named paths from the identified kit root, never
   from a guessed parent of this copied skill.
3. Record current revision, Git status, installed toolchain, runtime path, running
   coordinator/workers, unresolved operations, and saved-but-unapplied settings.
   Never infer worker death from a stale dashboard or expired heartbeat.

## Update safely

1. Present the exact target revision, affected paths, restart implications and
   recovery boundary. Proceed within the requested scope; ask before incompatible
   migrations, new costs, destructive replacement or worker interruption.
2. Preserve local edits, configuration, credentials, records and extensions.
   Fetch and inspect upstream changes. Use a clean separate checkout if local
   modifications prevent a safe fast-forward. Never reset, auto-stash, force-push,
   discard changes or merge product branches as part of an installation update.
3. Before cutover, create/review a backup appropriate to the factory and present
   the exact update preview/diff to the owner. Do not infer approval from a
   selected revision or successful build.
4. Build and validate the selected revision with its documented Node/npm versions,
   lockfile and bounded tests. Follow `INSTALL.md`; do not run source-only scripts
   inside an installed tarball or assume an npm registry release exists.
5. Update the runtime actually serving the Console, not merely a source clone.
   Use documented update preview/apply with the exact preview digest and approval
   for managed installations. For source/packed installs, stage the replacement
   before cutover and preserve a recoverable prior runtime. Never overwrite loaded
   runtime modules while agents or the coordinator are using them. Keep provider
   credentials out of replacement runtimes and backups.
6. When loop visibility is requested, reconcile `managerLoops` in the existing
   owner-controlled Console configuration. Set `id` to the exact loop `loopId` and
   `artifactsDirectory` to its existing absolute records path. Use optional existing
   product/pod identifiers only when known; a pod requires its product. Preserve
   other entries and settings. Treat the same ID with a different directory as a
   conflict requiring resolution, not permission to overwrite it.
7. Establish a safe restart window from current process and work observations.
   Restart only the affected Console. If shutdown waits on browser event streams,
   disconnect those Console pages without discarding unsaved forms. Confirm the old
   coordinator exited before starting its replacement. Never delete locks, clear
   records, kill agents or relaunch the Manager Loop to unblock the update.

## Verify and report

- Confirm the served runtime/assets correspond to the selected revision, factory
  and configuration. Reopen the Console and verify its connection.
- Match registered loops on Overview and Work to existing records: scope filters,
  phase acceptance, reviews, verification, repairs and unavailable/stale status.
  Do not expose private prompts or sessions. Recorded running is not proven
  liveness; provider completion is not review acceptance.
- Observe a real state change if ongoing work supplies one. Otherwise report live
  refresh as not exercised. Never launch paid work or fabricate progress to prove
  an update. Do not rerun completed phases.
- Check that owner settings and records remain intact except for approved changes.
  Do not copy credentials or alter provider authentication, configured spending,
  billing routes, or worker state as part of the update.
- Regenerate and review the setup-readiness inventory using the current local
  Console configuration. It must account for every provider route, Jira mapping,
  and GM scheduler as enabled-and-verified, pending auth/observation, or an
  explicit owner deferral. An offline readiness report detects omissions; it
  cannot upgrade any route to verified. Preserve Jira's one authorization source
  per site and reuse it only for the owner's explicitly mapped projects; products
  without a mapping retain local Faktori tickets.
  Report previous/installed revision, runtime/config paths, Console URL, registered
  loops, checks actually performed, remaining gaps and the safe next action. Keep
  private paths out of public commits and shared reports.

Stop on ambiguous targets, unknown surviving workers, unresolved mutations,
conflicting registrations, unsupported compatibility, failed checks or missing
authority. Preserve the working installation and failure evidence. Never silently
roll back data formats, lower acceptance criteria, change authentication, purchase
services, or push/merge/deploy product work. Route unrelated development elsewhere.
