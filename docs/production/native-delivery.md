# Native local delivery and continued development

The `native_local` profile connects a qualified native candidate to the existing
`product observe`, `product adopt` and `product next-discovery` lifecycle. It
supports iOS Simulator app directories and Android Emulator APKs. Its receipt
always retains local qualification scope and does not qualify physical devices,
production signing, store distribution or factory publication.

Start with requirements discovery and separately accepted definition/design.
The definition selects the native platforms; the design includes the shared API
contract. Retain their exact canonical bytes and owner approval alongside the
candidate source and independent verification configuration/evaluator bindings.
The native backend identity includes origin, artifact digest, schema revision
and contract revision; it must match the accepted shared API design and declared
client compatibility.

Seal each actual artifact read-only:

```sh
faktori product native-artifact-seal native-artifact-request.json
```

The request has exactly `path` and `kind`; `path` is a canonical absolute local
path and `kind` is `ios_app_directory` or `android_apk_file`. The returned seal
binds sorted tree entries, modes, sizes and file hashes. Its digest is a tree
manifest digest, including for an APK, rather than the standalone APK file hash.
Symlinks, hard-linked files, path aliases, changing files and oversized artifacts
are rejected. Reads stream in bounded chunks; sealing does not install, sign,
launch or publish an app.

Prepare a `faktori.native-local-delivery/v1` owner-approved configuration and a
`faktori.product-baseline-observation/v1` request with `profile: native_local`,
`environment: local_qualification`, the exact source/artifact-set identities,
native targets, backend identity and verification receipt. The targets are
distinct and sorted by platform. Bind the observer executable/scripts and its
read-only scope before running identity → complete journey → identity. The
observer must establish native UI, lifecycle, artifact/signing identity and
backend compatibility, plus the existing authentication, persistence, recovery
and outcome checks. An observer JSON declaration alone is not actual device
proof; qualification requires the approved observer's retained execution.

Run `product observe`, then adopt the passed observation using the existing
journal parent digest and owner authority. Artifact, source, configuration,
verification and observer bindings are reread before observation, replay,
adoption and the next discovery session. A changed binding requires fresh
qualification; an unfinished observation retains an incomplete intent rather
than launching a duplicate. The next discovery session inherits the qualified
local baseline, platform/client contracts and its distribution limitations.
Ongoing features still require their own accepted scope and release authority.

The source and installed complete-feature acceptance use synthetic observer and
native payload fixtures. Their successful lifecycle does not turn those
fixtures into real binaries or device evidence. Actual iOS/Android runtime
receipts remain separately recorded in the attended public qualification.
