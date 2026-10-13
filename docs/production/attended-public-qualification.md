# Attended public qualification — October 13, 2026

The shopping-list qualification app is deployed at
https://faktori-qual-20261013-c7a9.fly.dev. This is a synthetic attended delivery
exercise, not a production-readiness declaration for FAKTORI.

The owner authorized one 512 MB Machine, one encrypted 1 GB volume, a $10 total
monitored operating ceiling and cleanup after seven days. The ceiling is not a
provider-enforced billing cap. An active cleanup automation targets October 20,
2026 at 1:33 PM America/Chicago, checks retained resource identities and removes
only this exercise's resources. Later owner instructions take precedence.

The deployed image was reused without rebuilding. Its registry manifest is
`sha256:b17178c0b818076ec76d72d0031cfca446f7c194bf14a14850a600a2347b20e6`;
its image configuration ID is
`sha256:125fdb0628c23d6ba4d96695f3364c11491ff72bf8295aef413ca8d51002db52`.
These identify different objects. Nine deployed application/runtime file hashes
match the frozen source. Provider health and strict public TLS checks pass.

An eight-gate whole browser/API journey passed with fresh synthetic accounts:
shared household data, separate-household isolation, authenticated reload,
input/origin boundaries, immutable retry, recovery from a confirmed save with
failed refresh, delivered late-result isolation and explicit replay rejection
of a revoked session. Independent source review verified the revised evaluator
and its candidate/report bindings. The evaluator remains human-uncalibrated.

The actual Machine stopped and restarted on the same image and volume. A
subsequent real browser and API journey recovered the surviving session and six
saved shared items while retaining separate-household isolation. A consistent
live SQLite backup was downloaded into private off-volume custody and its
checksum matches the manifest. Independent stopped local restore passed using
the exact deployed image in network-isolated containers. All user, item,
idempotency and login-limit rows match; backed-up sessions are removed; the
specific saved session was valid in the source backup and is denied after
restore. Fresh local API sign-in recovers the six exact saved items. Temporary
containers and their owned anonymous volumes were removed. This is local API
restore recovery, not a public browser restoration or cloud database replacement.

The first synthetic fixture passwords were accidentally printed in tool output.
Fresh fixtures replaced those accounts; obsolete password hashes were replaced
with unknown random values and obsolete sessions were revoked. Their saved data
was preserved. No Fly credentials were exposed or exported into project records.

The next gates are human evaluator calibration, the valid public release/adoption
chain and observed automatic operation.
The separately reviewed shared-backend native increment still requires actual
new iOS/Android binaries and real secure-store/network recovery qualification.
Its exact SecureStore dependency lock and full-UI typechecking are complete;
fresh native builds are deferred because available local disk space is below
the observed build requirements plus reserve.
Requirements discovery and accepted design must remain the beginning of each
new-product or explicitly requested live-product feature cycle.
