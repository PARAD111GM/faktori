---
name: faktori-deploy
description: Release an accepted artifact through approved authority and record observable deployment evidence.
---

# Deploy

Inputs are tested artifact revision, release authority, target environment, workflow/command, and rollback plan. Output a release record and post-release health evidence; small releases can use the compact record, normal releases require release evidence, and high-risk releases require explicit approval and recovery. Never treat a PR or receipt as product acceptance by itself. Escalate missing approval/credentials, drifted revisions, failed health checks, or rollback ambiguity; leave the result pending rather than simulating success.
