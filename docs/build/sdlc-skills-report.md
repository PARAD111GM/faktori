# Complete SDLC skill kit

## Scope

Expand the eleven first-party playbooks and add interview, research, independent
review, and portable handoff: fifteen bundled skills covering factory setup,
Plan, Design, Build, Test, Deploy, Maintain, and bounded factory operation.
See [the routing guide](../skills.md) and [evaluation scenarios](../skills-evaluation.md).

The kit follows the requested skill-creator conventions: explicit triggers,
imperative procedures, proportional scope, progressive disclosure, initialized
new packages, locally bundled resources, and validated archives. Superpowers
informs root-cause debugging, fresh verification, and evidence-based handling of
review feedback; it is not an installation dependency. Attribution is recorded
in [third-party notices](../third-party-notices.md).

## Implementation and review

Three Terra high specialists owned non-overlapping intake, delivery, and
operations packages. The manager integrated routing, packaging, validation,
examples, and documentation. A Sol medium read-only reviewer found no material
issues. There were no model escalations. Per-agent token telemetry was not
collected for this change; token consumption and dollar cost remain unknown.

Instruction-level probes A, C, D, E, and F covered ambiguous intent, a clear
Python bug, stale review evidence, failed post-deployment smoke checks, and an
interrupted provider handoff. They preserved configured authority, proportional
interviewing, current-revision evidence, and reconciliation before retry.
These were dry-run instruction evaluations, not live provider or factory proof.

## Observed verification

Under the pinned Node 24.20.0 / npm 12.0.2 toolchain:

- TypeScript checks and the application build passed.
- All 301 tests in 39 files passed with `npm test -- --maxWorkers=4`.
- The clean installed npm package passed `npm run pack:verify`, including
  validation of its shipped skill catalog and resources.
- All fifteen skill archives passed the requested skill-creator packager.
- Skill structure, provider-entrymap drift, and diff whitespace checks passed.

Initial restricted tests could not bind loopback. With local loopback access,
the default highly parallel run hit one existing five-second CLI timeout;
limiting test workers resolved it without changing assertions or timeouts.
The check script now builds before tests because installation/update tests
require emitted runtime files in a fresh checkout.

## Limits and follow-up

Structural validation and archives prove distribution integrity, not reliable
agent behavior. Native skill auto-discovery across providers and live execution
of the full scenario set have not been demonstrated by this change. Direct
loading from the bundled routing guide remains the supported baseline.
This work neither changes Phase 7 acceptance nor resumes the deferred Twinzy
comparison. No runtime scheduling or authority policy was expanded.
