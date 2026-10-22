# Product operations contract

`inspectProductOperations` (`src/production/operations.ts`) validates a bounded declaration for one exact product candidate. The request binds the product and candidate revisions to a source revision, names the intended web or native platforms, and records release resources and operational decisions. Its output is a planning aid for the next independent acceptance step.

The inspector does not connect to hosting providers, stores, databases, build systems, or security tools. Every reference in the request remains a declaration, including references to scans, restore drills, and evaluators. The result always has `evidenceState: declared_not_observed`, `executionReady: false`, and `productionReady: false`. A complete plan receives `declared_for_independent_review`; this is not a release verdict.

Missing or unresolved information appears in `blockers` as an actionable item. Missing hosting, account, database, domain/TLS, build, signing, store, and integration resources remain blockers. A reference such as `store account: configured` is not proof that an account exists or is authorized. Use stable artifact, ticket, repository, or resource references. Do not include secrets, tokens, environment values, or credential contents.

For web products, declare hosting/runtime/database, domain and TLS routing, account ownership, and credential custody. Also record integrations, a monthly runtime estimate, spending authority, data classes and permitted model use, retention and provider/region restrictions, and owner-approved iteration, concurrency, spend, attention, response, and escalation limits.

For native products, declare build, signing, distribution, store account, and account owner for each selected platform. The default is one shared cross-platform codebase that produces native iOS and Android experiences; separate native codebases require a product-specific exception rationale. This contract names no framework and implies no integration with Expo, a store, a build service, or an account provider.

All targets require a product-data backup policy, recovery objectives, a disposable restore target, and a restore evidence reference. Live schema or API changes declare an expand/contract strategy where applicable, supported client versions, and compatibility evidence. Destructive changes include a recovery plan. Authorization, dependency/license, secrets-scan, independent evaluator, and privacy/terms evidence references are required. Incident ownership includes primary and backup owners, notification route, coverage, response objectives, and explicit rollback or forward-fix authority; native binaries may need a forward fix.

The output includes a permanent acceptance blocker. A separate authorized process must observe the target resources, exact candidate and deployed artifact, security controls, data behavior, restore result, and client compatibility before release. This declaration contract does not execute deployment, assign runtime authority, or duplicate the coordinator's execution and evidence controls.

Input objects reject unknown fields, bound text and array sizes, and reject obvious credential-shaped values. The request digest binds the supplied declaration; it does not attest to the truth of any statement or evidence reference.
