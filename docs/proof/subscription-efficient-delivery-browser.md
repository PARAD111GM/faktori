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

The preview suite passed 8/8 and typecheck/build passed. The first browser run
reported two missing-favicon requests. The Console now declares the packaged
brand SVG as its favicon. The complete browser drill was rerun against a fresh
isolated Console on 2026-09-22: both viewports, two persisted feedback items,
revision verification and final-review readiness passed with **no browser
console errors or application exceptions**. The proof server and its owned
preview were stopped afterward. Following the Linux cleanup-race repair, the
complete drill passed again, including the Console's Stop operation reaching
observed `stopped` state, with no console errors. The focused preview lifecycle
and Console facade checks passed 10/10; runtime and Console typechecks passed.

The two applied operations exercise feedback bookkeeping, not actual product
code edits or human acceptance. Browser context declarations are capability
contracts, not evidence that a real human reviewed the candidate. Live provider,
deployment and acceptance gates remain separate.
