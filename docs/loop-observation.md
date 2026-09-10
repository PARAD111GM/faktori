# Observe loops without restarting the Console

Loop observation is deterministic and read-only. It does not launch, steer, approve, publish or restart a worker. Configure the following optional block in the owner-controlled local Console configuration once:

```json
{
  "managerLoopRegistry": {
    "path": "/absolute/controller-directory/loop-registrations.json",
    "allowedArtifactRoots": ["/absolute/approved-loop-records"]
  }
}
```

The controller directory and artifact roots must already exist. Keep controller storage separate from worker workspaces. Choose narrow artifact roots, not a home directory. Activating this configuration requires the ordinary Console configuration reload/restart; adding subsequent loops does **not**.

Submit each source to `POST /api/console/manager-loops/register` using the existing local owner command token and approved browser origin:

```json
{
  "id": "task-list-proof",
  "artifactsDirectory": "/absolute/approved-loop-records/task-list-proof",
  "productId": "task-board",
  "references": { "ticket": "WI-42", "feature": "task-completion" }
}
```

The directory must exist and `id` must match the actual loop ID. Where a factory catalog exists, product/pod mappings must exist in that catalog. The server checks resolved paths, rejects escapes and conflicting registrations, persists the source, and updates its existing observer. Repeated identical registration returns `created: false`. Registration grants no execution or publication authority.

Automate this request in the existing orchestration process; do not wake a model or send another agent a message just to register or poll a source. For a local integration, the following reads the token from its owner-controlled file without putting the token in command arguments or output:

```sh
node --input-type=module - /absolute/local-console.json /absolute/loop-source.json <<'NODE'
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const source = JSON.parse(await readFile(process.argv[3], 'utf8'));
if (!config.commandToken) throw new Error('An explicit owner command token is required');
const origin = `http://127.0.0.1:${config.port}`;
const response = await fetch(`${origin}/api/console/manager-loops/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin,
    'x-faktori-console-token': config.commandToken },
  body: JSON.stringify(source),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error ?? `Registration failed: ${response.status}`);
console.log(JSON.stringify({ registration: result.registration, created: result.created }));
NODE
```

## Usage and delivery evidence

New stage receipts retain available provider usage, including failed attempts. Older receipts remain unknown. The observer shares accounting code with the construction usage utility; cached input and reasoning are subsets, not additional tokens. Outcome references connect expenditure to work; validated existing delivery receipts establish merge and deployment/staging-acceptance states. Labels alone do not establish a shipped outcome.

An owner may explicitly configure `usageExportPath` for a normalized external-session JSONL export. Register only the intended participating sessions; never scan unrelated conversation history. Use the normalization contract in [usage monitoring](build/usage-monitoring.md), retaining response identity, cumulative/incremental semantics and parent inclusion. A registered export does not establish provider billing or product acceptance. Hot-registered exports must also stay inside the approved roots.

The observer maintains bounded polling/backoff and retains registrations across restarts. A recorded running stage is not a verified heartbeat; unavailable liveness remains unavailable. Current stages with no terminal usage receipt contribute an unknown measurement rather than implying complete coverage. Missing or replaced sources become unavailable or cause a visible recovery error; do not delete registry history to make the warning disappear.
