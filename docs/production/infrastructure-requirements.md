# Infrastructure prerequisites for a disposable web qualification

The deployment provider and account are not selected yet. This sheet records the decisions and access needed before a real hosted exercise. It does not recommend a vendor or authorize account creation, billing, or deployment.

## Start locally without an account

The work can begin with a local development server and a local or disposable database. Keep synthetic data in that environment, use local-only credentials, and verify the product's essential journey and recovery behavior there. This path needs no hosting account, paid service, domain purchase, or production data. It is useful for discovery and implementation, but it does not prove a hosted deployment, public HTTPS behavior, production database durability, or live-user readiness.

An existing CLI login only proves that a command-line tool can authenticate to some provider account. It does not identify an approved project, prove permission to create or change hosting resources, grant spending authority, or authorize a production release. Confirm those separately with the account owner.

## Decisions before a disposable hosted web exercise

Record a named owner and a reference for each selected resource. If a decision remains open, record it as open and keep the corresponding gate blocked.

| Area | Decide or provide | Minimum evidence before the hosted exercise |
| --- | --- | --- |
| Hosting and runtime | Provider/project, deployment region, runtime/build method, preview versus production separation, and resource owner | Owner-approved project/resource reference and documented deployment target |
| Persistent database | Database service/project, region, disposable dataset, access boundary, schema migration path, and deletion/retention plan | Disposable database resource reference; prove application writes survive a process restart |
| Authentication | Whether the product needs user sign-in; if yes, identity provider, roles/authorization model, account owner, and test identities | Document the decision; for enabled auth, verify positive, denied, and cross-user access behavior with test accounts |
| Public address and TLS | Use the provider's assigned hostname or a custom domain; identify DNS/TLS owner and renewal responsibility | HTTPS route on the selected hostname and a successful certificate check. A custom domain is optional; HTTPS for any public hosted route is required |
| Secrets | Which runtime secrets are needed, who owns them, where they are stored, and how rotation/revocation works | Secret names and custody reference only. Never put secret values in the repo, plan, logs, or evidence packet |
| Logs and operations | Application/platform logs, error visibility, retention, alert route, incident owner and coverage | A test failure appears in the selected log view and can be tied to the candidate revision without exposing sensitive data |
| Backups and restore | Database backup/PITR approach, retention, recovery objectives, restore owner, and disposable restore destination | Restore into an isolated disposable target and inspect the recovered data; a configured backup alone is not restore evidence |
| Rollback or forward fix | Which prior artifact is compatible with current data, who may initiate rollback, and when a forward fix is required | Owner-approved authority and a rehearsed recovery path for the exercise. Data migrations may make code rollback unsafe |
| Cost and authority | Monthly/runtime estimate, maximum approved spend, billing owner, and who can approve changes | Explicit owner decision and bounded ceiling before enabling billable resources |
| Data and test scope | Data classes, permitted model inputs, synthetic/sanitized fixtures, retention and deletion | Written data policy for the exercise; do not seed real personal or production data by default |

For a disposable exercise, prefer an isolated project and database that can be deleted after evidence is collected. Reuse an already approved resource when its owner confirms the scope, access, and spending boundary. Do not enable a billing plan, create a paid resource, accept provider terms, or publish a public application without the account owner's authority.

## Release evidence remains separate

The deployment plan should bind the product revision, candidate revision, and exact source revision. A successful provider command or a visible URL is only one observation. Acceptance also needs the intended artifact and environment identity, an authenticated journey when the product requires authentication, expected persistence, authorization-denied behavior, logs, recovery evidence, and an independently reviewed result. Keep preview/seed-data evidence distinct from production-data claims.

The `targets.web.domainTls` field can reference an assigned provider HTTPS hostname and its TLS route. It does not require purchasing a custom domain. The operations inspector treats the value as a declaration; it cannot test DNS, certificates, access, logs, database behavior, backups, or rollback.
