# Owner shopping-list quantities and units increment

Status as of October 14, 2026: owner-accepted attended feature; public web release,
restart persistence and actual public-backup local recovery passed. iOS Simulator
and Android Emulator app journeys also passed against the public HTTPS backend.

## Accepted feature

The owner chose the shopping-list app as the product, requested quantities/units,
and accepted the concrete reviewed candidate and temporary public test update.
The accepted feature supports positive quantities up to 999999 with at most
three decimal places, and optional trimmed units up to 24 Unicode code points.
ASCII control characters and unpaired UTF-16 surrogates are rejected. Existing
items default to quantity 1 and an empty unit. Automatic conversions, prices and
inventory are outside this increment.

The additive schema-2-to-3 migration preserves existing users, sessions, item
identities and completion state. Integer milliunits avoid floating-point storage
drift. Immutable retry identities bind the item name, quantity and normalized
unit. Native drafts and pending operations preserve the complete payload across
process restarts and account changes. Capability checks prevent an older backend
from silently dropping nondefault quantities.

## Observed delivery and recovery

The repaired source passed independent review and its 20-gate complete local
feature journey. The AMD64 container and repaired iOS Simulator/Android Emulator
artifacts passed their applicable complete feature slices. Installed native bytes
were verified against the retained artifacts. Local native offline operations
reconciled their original request identities exactly once.

The accepted exact image was published and deployed to the existing temporary
test Machine and volume. Runtime source hashes matched the reviewed files. The
public strict-HTTPS browser/API journey passed form entry, quantity/unit display,
reload, shared completion, Unicode persistence and retry, validation and household
isolation. Existing sessions and baseline data survived both migration and a
same-image Machine restart.

A fresh pre-migration schema-2 backup was retained off-volume. A fresh actual
schema-3 public backup subsequently passed a stopped local restore using the exact
image: all 9 users and 27 items, quantity/unit values, item identities and completion
ledger were preserved; restored browser and native sessions were revoked. Fresh
authentication, isolation, new quantity/unit operations and restart persistence
passed against the recovered local copy. The public database was not restored or
replaced during this proof.

The new public-HTTPS native profile preserves the compiled native payloads and
original release network policy while replacing the source-bound Hermes bundles.
The actual iOS Simulator and Android Emulator apps created and completed shared
quantity/unit items, observed each other's data and retained signed-in state on
relaunch. Household isolation passed. Native offline/retry evidence remains the
separate exact-source local journey; a new public-native outage was not run or
claimed. A final off-volume backup includes the resulting 29 synthetic items.

An initial vendor update request duplicated an image digest and was rejected
before any Machine change. The retained follow-up records the unchanged baseline,
corrected unique-tag resolution to the accepted manifest and verified successful
deployment. No speculative rollback was attempted.

## Boundaries and next gate

The original synthetic-only data limit, monitored operating ceiling and October
20 cleanup remain in force. This acceptance does not authorize permanent hosting,
real customer data, paid developer enrollment, physical-device distribution or
store release. Returning to the schema-2-only application requires a compatible
stopped backup restore and a separate data-loss decision; an old-binary-only
rollback is incompatible with schema 3.

These receipts establish an attended feature delivery. They do not retroactively
establish an installed FAKTORI discovery-to-implementation lifecycle: construction
preceded this concrete feature acceptance. Whole-product definition acceptance,
formal installed observation/adoption, a prospective owner-requested next cycle,
human holdout calibration and sustained outcomes remain distinct gates. Preserve
the original proposed whole-product definition instead of marking it accepted to
clear those gates.

Private operational records retain exact artifacts, source/runtime bindings,
approval timing, independent review, backup custody, failed attempts and cleanup.
They contain no public claim of full FAKTORI production readiness.
