# Phase 7 trusted fixture-harness evidence — 2026-09-06

This evidence preserves the frozen Phase 0 fixture bytes, checksums and child
timeouts. It records observed execution separately from product acceptance.

## Initial diagnostic sequence

- The first standalone due-dates base run used Playwright's default Chrome
  channel, reached the unchanged 20,000 ms test timeout, and then required a
  bounded interruption when teardown did not exit.
- A diagnostic rerun with Playwright logging, the same default Chrome channel
  and unchanged test completed every action, including delete after restart,
  in 12.75 seconds.
- The unchanged aggregate verifier then completed in 28.89 seconds. It
  reproduced task-board RED, due-dates base GREEN, due-dates feature RED and
  Python boundary RED exactly as specified.

The earlier delete-after-restart failure is therefore not consistently
reproducible in the trusted harness. This does not retroactively validate the
scope-invalid cold-start product or permit deleting its failed evidence.

## Reproducible envelope

Commit `7797200` adds `scripts/run-phase7-fixture-harness.mjs` and its focused
tests. The envelope:

- requires the supported Node 24 runtime;
- pins `PLAYWRIGHT_CHANNEL=chromium` and prewarms the resolved Chromium binary;
- invokes the unchanged `fixtures/verify-fixtures.mjs` verifier;
- retains the frozen 20-second browser-test and 25-second child-process bounds;
- adds only a 120-second outer process-tree bound; and
- writes a machine-readable result without publishing host paths.

A root run and a separate Build Manager run both passed. The manager observed
Node 24.20.0, the Chromium channel, a 14.336-second verifier duration, empty
stderr, all checksum checks, and the expected task RED / due base GREEN / due
feature RED / Python RED outcomes.

No frozen fixture, expected outcome, checksum or timeout changed. This closes
trusted local harness preparation only. It does not complete F7-01, supply a
Linux browser matrix, create an incumbent Triforge resource or establish a
paired comparison.
