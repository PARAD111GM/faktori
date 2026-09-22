# Subscription-efficient delivery browser drill

Date: 2026-09-22. Scope: a fresh, provider-free local Console with one owner-registered loopback preview. This was a local drill, not a deployment, provider check, or human acceptance.

Observed in a visible browser:

- The Work view rendered the routing, workflow, preview, feedback, and durable command-receipt surfaces at desktop and 390×844 without page horizontal overflow.
- The preview started through its configured operation, reported its exact runtime revision through the identity probe, and remained `running` with `current` evidence.
- Separate declared agent and human browser contexts were shown as contract data only; no browser evidence was fabricated.
- Two distinct bounded feedback items persisted across reload, were applied only through matching owner-configured operations, then confirmed at the same candidate revision. The final-review gate became ready; automatic push remained absent.

Artifacts: `faktori-delivery-desktop.png`, `faktori-delivery-feedback.png`, and `faktori-delivery-mobile.png` were captured in the temporary proof output.

Commands run with Node 24:

```text
node node_modules/vitest/vitest.mjs run tests/preview --reporter verbose
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/vite/bin/vite.js build --config console/vite.config.ts
node run.js playwright-test-faktori-delivery.js
```

The preview suite passed 8/8 and typecheck/build passed. Browser instrumentation found no application JavaScript error, but did record two explicit `404` requests for the Console's missing `/favicon.ico` (one per browser context). This is not hidden as a clean browser run; the Console static asset owner must supply the existing favicon asset or route before the no-console-error gate is clear.
