import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let server;

const workManagement = {
  status: 'available',
  revision: 'catalog-r3',
  observedAt: '2026-09-09T17:00:00.000Z',
  projects: [{
    productId: 'faktori',
    title: 'Faktori Console',
    goal: 'Make work understandable without pretending that reports are acceptance.',
    artifacts: [{ id: 'plan', title: 'Console delivery plan', role: 'plan', path: 'docs/plans/console.md', status: 'available', content: '# Console work', contentBasis: 'owner_snapshot', sourceRevision: 'faktori-plan-r2', snapshotAt: '2026-09-09T16:45:00.000Z' }],
    plans: [{ id: 'console-batch-1', order: 1, title: 'Understand work', goal: 'Publish the first catalog-backed surfaces.', phases: [{ id: 'phase-one', order: 1, title: 'Projects and sessions', goal: 'Make assignment visible.', acceptance: 'Human titles and ordered tickets are readable.', tickets: [{ id: 'CWM-001', order: 1, title: 'Work catalog', goal: 'Validate the catalog graph.', dependencies: ['CWM-000'], runIds: ['run-1'], loopIds: ['loop-1'] }] }] }],
  }],
  sessions: [{ id: 'phase-one', threadId: 'private-thread-id', title: 'Phase 1 implementer', role: 'implementer', productId: 'faktori', planId: 'console-batch-1', phaseId: 'phase-one', ticketId: 'CWM-001' }],
  requests: [{ id: 'request-1', sessionId: 'phase-one', title: 'Implement the catalog UI', status: 'completed', assignment: { id: 'phase-one', threadId: 'private-thread-id', title: 'Phase 1 implementer', role: 'implementer', productId: 'faktori', planId: 'console-batch-1', phaseId: 'phase-one', ticketId: 'CWM-001' }, callbackManager: { threadId: 'manager-private-id', title: 'Build manager' }, createdAt: '2026-09-09T16:00:00.000Z', instructionAvailable: true, report: { sourceThreadId: 'private-thread-id', observedByManagerThreadId: 'manager-private-id', summary: 'Rendered the Project view.', observedAt: '2026-09-09T16:30:00.000Z', delivery: 'reported', productAcceptance: 'not_evaluated' } }],
};

beforeAll(async () => {
  server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true } });
});

afterAll(async () => {
  await server?.close();
});

describe('Console work-management UI', () => {
  it('renders goals, ordered plans and bounded artifacts with IDs kept secondary', async () => {
    const { Projects } = await server.ssrLoadModule('/console/src/projects.tsx');
    const html = renderToStaticMarkup(createElement(Projects, { workManagement, navigation: { openRun() {}, openLoop() {}, openRequest() {} } }));

    expect(html).toContain('Faktori Console');
    expect(html).toContain('Make work understandable without pretending that reports are acceptance.');
    expect(html).toContain('Plan 1');
    expect(html).toContain('Projects and sessions');
    expect(html).toContain('Work catalog');
    expect(html).toContain('Depends on: CWM-000');
    expect(html).toContain('Open run');
    expect(html).toContain('Open loop');
    expect(html).toContain('Open request');
    expect(html).toContain('Owner-published snapshot — not live file content.');
    expect(html).toContain('Recorded revision: faktori-plan-r2');
    expect(html).toContain('Snapshot recorded:');
    expect(html).toContain('<pre># Console work</pre>');
    expect(html).toContain('Ticket ID: CWM-001');
    expect(html.indexOf('Work catalog')).toBeLessThan(html.indexOf('Ticket ID: CWM-001'));
    expect(html).not.toContain('artifactHome');
  });

  it('keeps unavailable catalog state honest and legacy-safe', async () => {
    const { Projects } = await server.ssrLoadModule('/console/src/projects.tsx');
    const html = renderToStaticMarkup(createElement(Projects, { workManagement: { status: 'unavailable', error: 'Configured catalog could not be read.', projects: [], sessions: [], requests: [] }, navigation: { openRun() {}, openLoop() {}, openRequest() {} } }));

    expect(html).toContain('Work catalog unavailable');
    expect(html).toContain('Configured catalog could not be read.');
    expect(html).toContain('Legacy Console configuration remains usable.');
    expect(html).not.toContain('0%');
  });

  it('shows session title, role, scope, and unknown capability instead of liveness', async () => {
    const { Sessions } = await server.ssrLoadModule('/console/src/sessions.tsx');
    const html = renderToStaticMarkup(createElement(Sessions, { workManagement, manager: { threadId: 'manager-private-id', title: 'Build manager' }, lastHeartbeatAt: '2026-09-09T16:35:00.000Z' }));

    expect(html).toContain('Phase 1 implementer');
    expect(html).toContain('implementer');
    expect(html).toContain('faktori / console-batch-1 / phase-one / CWM-001');
    expect(html).toContain('Provider</dt><dd>Not observed');
    expect(html).toContain('Current activity</dt><dd>Unknown');
    expect(html).toContain('not evidence that a task is currently active');
    expect(html).not.toContain('private-thread-id');
  });

  it('routes activity only to retained run, loop, or request details', async () => {
    const { ActivityFeed } = await server.ssrLoadModule('/console/src/work-visibility.tsx');
    const html = renderToStaticMarkup(createElement(ActivityFeed, {
      filter: { productId: '', podId: '' }, selectRun() {}, selectLoop() {}, selectRequest() {},
      items: [
        { id: 'activity-run', at: '2026-09-09T17:00:00.000Z', source: 'run', summary: 'Run recorded', runId: 'run-1' },
        { id: 'activity-loop', at: '2026-09-09T16:00:00.000Z', source: 'loop', summary: 'Loop recorded', loopId: 'loop-1' },
        { id: 'activity-request', at: '2026-09-09T15:00:00.000Z', source: 'request', summary: 'Request recorded', requestId: 'request-1' },
      ],
    }));

    expect(html).toContain('Open run');
    expect(html).toContain('Open loop');
    expect(html).toContain('Open request');
    expect(html).not.toContain('Open Codex');
    expect(html).toContain('not a live agent transcript');
  });

  it('switches retained Work detail links to the catalog project and clears stale pod scope', async () => {
    const presentation = await server.ssrLoadModule('/console/src/main.tsx');
    expect(presentation.projectScope('project-b')).toEqual({ productId: 'project-b', podId: '' });
  });
});
