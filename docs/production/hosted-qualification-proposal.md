# Proposed first hosted qualification

This is a prepared target proposal, not an approved deployment. Finish local
application acceptance and public-runtime security before provisioning it.

## Recommended disposable target

For the initial SQLite qualification app, use one new Fly.io app in an isolated
owner-selected organization, one `shared-cpu-1x` Machine with 512 MB RAM, and one
1 GB persistent volume mounted at `/data`. Use the assigned `fly.dev` HTTPS
hostname, a single region and synthetic data. Avoid a dedicated IPv4 address,
custom domain purchase, managed database and additional Machines in this bounded
exercise. Bind the exact image/source revision and database path to the release
record. The application must listen on the configured internal port and write its
database to the mounted volume.

This is a disposable persistence/recovery exercise. A single Machine and volume
have a host failure and deployment downtime boundary; volumes have no automatic
replication. A multi-instance production application needs an explicit database
replication or managed database design, appropriate availability objectives and
independent restore evidence. Provider snapshots are additional recovery support;
they do not replace a tested application backup.
[Fly volume documentation](https://docs.fly.io/volumes/overview)

Current published pricing lists the 512 MB Machine at $3.69 per 30 days in the
lowest-priced regions and a volume at $0.15 per provisioned GB/month. The nominal
always-on subtotal is therefore $3.84/month before snapshots, transfer and other
charges. Refresh the regional quote at provisioning. Proposed owner authorization
is a $10 total disposable-exercise ceiling, with resource inventory, usage checks,
an expiry and cleanup; it is not granted yet and does not imply a provider-enforced
hard billing cap. Stop if the operator cannot enforce the approved boundary.
[Fly pricing](https://docs.fly.io/about/pricing)

## What the owner will need to approve

The operator presents the exact app name, organization, region, resource sizes,
image digest, synthetic account provisioning, spending/expiry boundary, restore
destination and cleanup commands in one release packet. The owner supplies or
signs into the selected account through the vendor's normal login flow, approves
the concrete resource proposal and names the release/incident owner. No secret
values belong in that packet. Existing production projects are outside scope.

Before that approval step, prepare and verify HTTPS-aware secure sessions,
bounded session lifetime and login abuse protection, absence of public fixture
routes, intentional synthetic account provisioning, runtime health/log behavior,
database backup/restore and a compatible rollback or forward-fix route. Public
fixture passwords and local test modes cannot establish public release readiness.

After deployment, independently exercise sign-in, denied/cross-household access,
save failure and uncertain-save recovery, reload, runtime restart persistence,
logs and isolated restore. Retain exact artifact/environment identities and all
interventions. Only those observations can close the hosted qualification gate.
