# F7-02 Linux Node and Python product evidence — 2026-09-07

Status: candidate evidence complete; exact-head Build Manager acceptance of the
Faktori repair remains required.

## Admitted boundary

The owner explicitly approved Codex with bridge networking and the dedicated
credential profile against only two disposable F7-02 workspaces: Node due dates
and the Python date-boundary regression. The run did not authorize or perform a
push, merge, deployment, issue-tracker mutation, active product operation,
credential export, paid-route change, or usage reset.

The admitted product execution used the controller's non-root numeric UID and
GID only because the selected dedicated credential directory was
controller-owned and private (`0700`). That run mounted the dedicated profile
read-only and linked `auth.json` into a tmpfs-backed `CODEX_HOME`; provider
session writes were ephemeral. A final security review then narrowed the
candidate further: the directory itself is no longer mounted when an ephemeral
home is selected. Only `auth.json` is mounted read-only at a seed path, so
sibling profile files are not visible. The hardened plan records the directory
and file type, device, inode, owner, and mode and revalidates them immediately
before Docker launch. Every Docker Codex launch requires an unchanged
builder-issued plan. Arbitrary numeric users, root, permissive profiles, unsafe
filenames, and a writable profile combined with an ephemeral home are rejected.

Retained failed preflights identified and closed these boundary defects before
the successful run:

- the fixed `65532:65532` worker could not traverse the private profile;
- making that profile writable exceeded the approved credential boundary;
- mounting the entire profile read-only prevented the vendor app server from
  writing its own session state;
- disallowed ambient environment keys were rejected; and
- the deliberately narrow environment omitted the Docker client directory.

## Product results

Both unmodified Codex provider executions completed and committed only inside
their disposable product repositories.

| Case | Product commit | Changed product files | Provider-reported usage |
| --- | --- | --- | --- |
| Node due dates | `a80e05362fac9aa63a89c73e944cacc0c96d6421` | `src/app.js`, `src/due-dates.mjs`, `src/index.html`, `src/working-board.mjs` | 601,110 input; 12,217 output; 548,480 cached input tokens |
| Python date boundary | `56f78304f995838cc3fdbc96441afcfba435526c` | `src/date_rules.py` | 141,591 input; 1,806 output; 110,976 cached input tokens |

The provider-reported aggregate is 742,701 input tokens, 14,023 output tokens,
and 659,456 cached input tokens. These counters are recorded observations, not
an overlap-adjusted construction total.

## Independent Linux verification

The controller then verified the committed products without provider
credentials and with networking disabled:

- Python ran the frozen `test/test_date_rules.py` contract with pinned pytest
  9.0.2: 3 passed in 0.01 seconds.
- Node ran the unchanged base task-board browser contract and the due-date
  feature contract using the pinned Playwright envelope: 1 passed in about 2.9
  seconds and 1 passed in about 3.0 seconds.
- Both product repositories were clean at their recorded commits.
- All 20 entries in `fixtures/SHA256SUMS` passed after the run. No frozen README,
  starter, test, or source input changed.
- A separate network-disabled Docker probe with dummy sibling files confirmed
  that the selected seed file was readable while neither the parent profile
  path nor the unselected sibling existed in the container.

The first provider-side Node `npm test` could not resolve the frozen base
contract because that sibling fixture was not mounted. The independent run
supplied the unchanged frozen task-board fixture and pinned test packages as
test-only inputs; it did not alter the candidate or frozen fixture bytes. The
provider-side Python container lacked pytest, so the same independent run
installed the pinned verifier into the disposable workspace before executing
the frozen contract.

WSL2 remains explicitly unverified because no real WSL2 host is available. Its
absence is not represented as observed support.

## Faktori candidate verification

The pinned Node 24.20.0/npm 12.0.2 `npm run check` gate passed strict
typechecking, production builds, 40 test files / 327 tests, and packed-CLI
verification. One full-kit maintenance test passed in isolation but twice
crossed its 30-second per-test limit under full-suite I/O contention. Its
bounded ceiling was raised to 60 seconds; the successful full run completed in
about 43 seconds overall. No maintenance behavior or fixture contract changed.
