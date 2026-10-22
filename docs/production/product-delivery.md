# Product definition to existing execution

The delivery compiler binds an accepted product definition to the existing Lean
implementation loop. It performs no commands, provider calls, publication or
deployment. It uses the discovery inspector and existing hierarchy/context and
Lean configuration validators; it introduces no coordinator or scheduler.

`compileProductDelivery(definition, request)` returns `needs_bindings` with
actionable `requiredBindings`, or `ready_for_loop` with `leanConfiguration`.
`serializeProductDeliveryLoop(result)` rejects pending results and returns the
strict JSON input accepted by the existing `faktori loop run` command.
Readiness means the configuration compiled, while runtime capabilities,
independent acceptance, external review, release and live behavior remain
unobserved. The compiler makes no production-readiness claim.

## Owner bindings

The request uses `faktori.product-delivery-request/v1` and pins the inspected
semantic `definitionDigest`. The CLI binds the original definition and request
files as absolute paths with SHA-256 file-byte digests. These become existing
candidate file dependencies. Both handoff files must be inside the approved
worker workspace because existing worker authority forbids outside reads.
Preserve their bytes unchanged; the loop checks dependency bytes during
preflight. The pure compiler checks declared path containment, while filesystem
ownership, symlink resolution and file-byte verification remain runtime checks.

The execution owner supplies `execution.loopId`, `workspace`,
`artifactsDirectory`, `approval`, `candidate`, `provider`, `roleRoutes`,
`review`, `toolchain`, `limits` and one `acceptanceCommand: {command, args}`.
These fields use the existing Lean contract. In particular:

- Native access and implementation approval must be explicit. Approval and
  optional repair approval must name this exact definition revision.
- The candidate needs an exact base revision, explicit dependency/environment
  arrays and complete inputs. Git dependencies retain exact revisions; files
  retain exact byte digests. The compiler reserves `product-definition` and
  `product-delivery-request` dependency IDs.
- The provider and implementer/reviewer routes are owner-selected. Exhausted
  quota is a capability blocker. Unknown access, tools, quota and platform
  qualification remain unknown until existing preflight/verification observes
  them. The compiler does not purchase or activate another route.
- Runtime, token and repair limits are explicit execution settings. Discovery
  effort estimates never populate them. No limit or repair approval is created
  on the owner's behalf.
- One feature-sized acceptance command covers the accepted linked scenarios.
  Toolchain probes establish execution prerequisites; they do not replace
  behavior acceptance. The existing loop retains independent review and its
  bounded repair policy.

Missing authority or configuration is reported as a `decision`. An actually
unavailable declared provider is a `capability`. Invalid or stale inputs fail
validation rather than producing a plausible runnable plan.

Only accepted `scope.includedRequirementIds` and their accepted scenarios enter
execution. A scenario linking included and excluded requirements needs an owner
scope decision; the compiler neither drops links nor expands scope. Unresolved
discovery returns pending bindings without constructing an executable context.

## Platform and existing-product release contract

`releasePlan.targets` has one entry per platform selected in discovery and no
extra platforms. Each entry supplies `platform`, `environment`, exact
`resourceRevision` (Git revision or SHA-256 configuration digest),
`releaseOwner`, `artifactContract`, `distributionContract`,
`postDeployAcceptance` and `rollbackPlan`. These are pending contracts, not
observed release receipts or deployment authority.

For web, name the owner's selected runtime/hosting environment, artifact and
staged acceptance. For iOS/Android, retain the discovery native-UI requirement,
shared native codebase default, device/OS envelope, capability contracts and
distribution/signing ownership. Any separate-codebase exception belongs in
accepted discovery. A WebView wrapper does not satisfy native acceptance.
The compiler imposes no hosting vendor or framework and provides no synthetic
build/sign/distribution command.

Existing-product delivery also requires `releasePlan.compatibility` with the
same accepted `baselineRevision`, `supportedClientContract`, `migrationPlan`,
`regressionAcceptance` and `concurrentWorkBoundary`. These preserve deployed
baseline, client/API/schema compatibility and concurrent ownership in the
handoff. New-product requests cannot invent an existing baseline.
The deployed baseline must be an exact Git revision or artifact digest.

The scoped executable context inherits accepted product constraints and carries
the accepted requirement/scenario IDs, command, caller approval, file bindings
and evidence requirements. Model proposals remain outside the acceptance
criteria. The original definition and request retain the complete discovery
and release contracts; downstream evidence must retain their revisions/digests.
The actual Lean implementation brief includes explicit artifact paths/digests,
complete inherited constraints, accepted roles/data/integrations/resources,
platform and existing-product contracts, and the pending release plan. The
compiler chunks that complete handoff into the existing bounded brief rather
than discarding constraints. An oversized handoff returns a missing scope
decision. Returning the rich context alone does not deliver it to a worker.

## Command flow

Inspect discovery and obtain owner decisions first. Then compile the same
definition with an owner-authored request. Both commands emit JSON on stdout;
explicit redirection saves the compilation and, only when ready, loop input:

```sh
faktori product compile ./product-definition.json ./delivery-request.json > ./compilation.json
faktori product loop-config ./product-definition.json ./delivery-request.json > ./loop-input.json
faktori loop run ./loop-input.json
```

Keep the definition/request files inside the approved workspace, and inspect
`requiredBindings` before requesting a loop input. Keep the existing independent review,
candidate evidence, publication and release gates. Recompile after any accepted
definition or resource-contract amendment; a changed dependency fails existing
preflight rather than silently updating an active run.

The [delivery request example](../../examples/production/delivery-request.json)
is deliberately pending: it provides no implementation or native-access grant,
provider selection, workspace or spending cap. Its digest matches the shipped
product-definition example. For another definition, replace it with the
inspected accepted definition digest, select the real resource
revision, and supply explicit execution settings before compiling. A pending
example is not a fake working application or an installed delivery receipt.
