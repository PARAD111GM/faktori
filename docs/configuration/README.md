# Factory configuration

`resolveFactoryConfig()` validates the version-controlled factory configuration
before it is used by later onboarding and execution work. It deliberately has no
credential, provider-login, provisioning, scheduling, or remote side effects.

## Model

The configuration has one factory, a registry of providers and environments,
then products and optional pods. A pod belongs to one product. Products inherit
the factory defaults; pods inherit their product's resolved settings. Creating a
product therefore does not create a pod automatically.

Provider capabilities are declared, rather than inferred from a provider name.
An `isolated` execution profile requires an `isolated` capability, `native`
requires `native`, and a strict budget requires `token-limit`.

See [solo.json](../../examples/config/solo.json) for the smallest usable
configuration and [multi-product.json](../../examples/config/multi-product.json)
for two products sharing factory defaults while only one has a pod.

## Sparse overrides and safe authority

Only an absent property inherits. `false`, `0`, an empty string, and an empty
array are all explicit values and are validated as such. For example,
`maxRetries: 0` means no retries; `environmentId: ""` is an error, not a request
to inherit the default.

The resolver starts from conservative authority: intent, specification and
independent review are required; merge and production release remain human;
separate billing is disallowed. An override that relaxes one of those controls
must include a non-empty acknowledgement keyed to that exact control:

```json
{
  "authority": {
    "requireIndependentReview": false,
    "riskAcknowledgements": {
      "requireIndependentReview": "The owner accepts merge without an independent review."
    }
  }
}
```

The acknowledgement records an explicit decision in the configuration but does
not substitute for the revision-bound approval required by provisioning.

## Errors

`ConfigValidationError` exposes an `issues` array and formats each error as a
path plus a correction. Typical messages are
`products[0].overrides.providerId: unknown provider "missing-provider"` and
`pods[0].overrides.executionProfile: provider "cursor" does not support
capability "isolated"`. Callers should display all issues and refuse to proceed
when any exist.
