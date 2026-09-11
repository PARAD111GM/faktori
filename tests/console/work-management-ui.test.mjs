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
    progress: { status: 'available', observedAt: '2026-09-10T12:00:00.000Z', populationBasis: 'catalog_tickets_explicit_status', tickets: { total: 2, done: 1, inProgress: 0, remaining: 1, blocked: 1, unknown: 0 }, evidence: { local: 'owner_published', reviewed: 'owner_published', merged: 'owner_published', deployed: 'unknown', productAccepted: 'unknown' }, pullRequests: { status: 'available', observedAt: '2026-09-10T12:00:00.000Z', populationBasis: 'explicit_catalog_linked_pull_requests', denominator: 1, merged: 1, unknown: 0, independentReviewStatus: 'unavailable', independentReviewPassed: 0, independentReviewUnknown: 1 } },
    dailySummaries: [{ date: '2026-09-10', timezone: 'America/Chicago', observedAt: '2026-09-10T12:00:00.000Z', populationBasis: 'retained_same_day_events', done: 1, inProgress: 0, remaining: 1, blocked: 1, activity: { managerReports: 0, decisionTransitions: 0, blockers: 0, ticketTransitions: 1, ticketDoneTransitions: 1, loopPhaseEvents: 2, pullRequestChanges: 0, pullRequestChangeCoverage: 'unavailable' } }],
    pullRequests: [{ ticketId: 'CWM-001', repository: 'PARADIIIGM/faktori', number: 8, status: 'available', observedAt: '2026-09-10T12:00:00.000Z', review: 'unknown', merged: 'yes', url: 'https://github.com/PARADIIIGM/faktori/pull/8' }],
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
  it('offers labelled help without opening a dialog or treating title text as markup', async () => {
    const { HelpHeading } = await server.ssrLoadModule('/console/src/section-help.tsx');
    const html = renderToStaticMarkup(createElement(HelpHeading, { level: 2, scope: 'projects' }, '<script>Project</script>'));
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="About &lt;script&gt;Project&lt;/script&gt;"');
    expect(html).not.toContain('<dialog');
    expect(html).not.toContain('<script>');
    const { sectionHelp } = await server.ssrLoadModule('/console/src/section-help-content.ts');
    const help = sectionHelp('Connect your project plans', 'projects');
    expect([help.summary, help.source, help.next].join(' ')).toContain('workCatalog.path');
  });
  it('renders goals, ordered plans and bounded artifacts with IDs kept secondary', async () => {
    const { Projects } = await server.ssrLoadModule('/console/src/projects.tsx');
    const html = renderToStaticMarkup(createElement(Projects, { workManagement, selectedProjectId: 'faktori', onBackToProjects() {}, navigation: { openRun() {}, openLoop() {}, openRequest() {} } }));

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
    expect(html).toContain('Qualified progress');
    expect(html).toContain('1/2');
    expect(html).toContain('Catalog tickets with explicit status');
    expect(html).toContain('Daily summary');
    expect(html).toContain('Retained events for this local day');
    expect(html).toContain('America/Chicago');
    expect(html).toContain('1 ticket transitions (1 to done)');
    expect(html).toContain('2 loop phase events');
    expect(html).toContain('PR change history unavailable for today');
    expect(html).toContain('Owner-published evidence annotations, not verified delivery');
    expect(html).toContain('1/1 merged observations');
    expect(html).toContain('Unavailable — no retained exact-head independent review gate evidence.');
    expect(html).toContain('PARADIIIGM/faktori #8');
    expect(html).toContain('A merge does not accept a ticket or ship a product; GitHub review state is not an independent Faktori review gate.');
    expect(html).toContain('Independent review gate: unknown');
  });

  it('keeps unavailable catalog state honest and legacy-safe', async () => {
    const { Projects } = await server.ssrLoadModule('/console/src/projects.tsx');
    const html = renderToStaticMarkup(createElement(Projects, { workManagement: { status: 'unavailable', error: 'Configured catalog could not be read.', projects: [], sessions: [], requests: [] }, navigation: { openRun() {}, openLoop() {}, openRequest() {} } }));

    expect(html).toContain('Project plans could not be loaded');
    expect(html).toContain('Configured catalog could not be read.');
    expect(html).toContain('Your source files are not changed by this error.');
    expect(html).toContain('Technical details for your agent');
    expect(html).toContain('workCatalog file path');
    expect(html).not.toContain('0%');
  });

  it('does not turn unavailable PR history into a quiet day', async () => {
    const { Projects } = await server.ssrLoadModule('/console/src/projects.tsx');
    const quiet = structuredClone(workManagement);
    quiet.projects[0].dailySummaries[0].activity = { managerReports: 0, decisionTransitions: 0, blockers: 0, ticketTransitions: 0, ticketDoneTransitions: 0, loopPhaseEvents: 0, pullRequestChanges: 0, pullRequestChangeCoverage: 'unavailable' };
    const html = renderToStaticMarkup(createElement(Projects, { workManagement: quiet, selectedProjectId: 'faktori', onBackToProjects() {}, navigation: { openRun() {}, openLoop() {}, openRequest() {} } }));

    expect(html).toContain('No recorded non-PR changes today; PR change history unavailable.');
    expect(html).not.toContain('No recorded changes today.');
  });

  it('shows session title, role, scope, and unknown capability instead of liveness', async () => {
    const { Sessions } = await server.ssrLoadModule('/console/src/sessions.tsx');
    const html = renderToStaticMarkup(createElement(Sessions, { workManagement, manager: { threadId: 'manager-private-id', title: 'Build manager' }, lastHeartbeatAt: '2026-09-09T16:35:00.000Z' }));

    expect(html).toContain('Phase 1 implementer');
    expect(html).toContain('implementer');
    expect(html).toContain('faktori / console-batch-1 / phase-one / CWM-001');
    expect(html).toContain('Provider</dt><dd>Not observed');
    expect(html).toContain('Current activity</dt><dd>Unknown — no liveness observation');
    expect(html).toContain('Last recorded contact');
    expect(html).not.toContain('<h2>Sessions</h2>'); // Page title belongs to the shared app header.
    expect(html).not.toContain('private-thread-id');
  });

  it('routes activity only to retained run, loop, request, or decision details', async () => {
    const { ActivityFeed } = await server.ssrLoadModule('/console/src/work-visibility.tsx');
    const html = renderToStaticMarkup(createElement(ActivityFeed, {
      filter: { productId: '', podId: '' }, selectRun() {}, selectLoop() {}, selectRequest() {}, selectDecision() {},
      items: [
        { id: 'activity-run', at: '2026-09-09T17:00:00.000Z', source: 'run', summary: 'Run recorded', runId: 'run-1' },
        { id: 'activity-loop', at: '2026-09-09T16:00:00.000Z', source: 'loop', summary: 'Loop recorded', loopId: 'loop-1' },
        { id: 'activity-request', at: '2026-09-09T15:00:00.000Z', source: 'request', summary: 'Request recorded', requestId: 'request-1' },
        { id: 'activity-decision', at: '2026-09-09T14:00:00.000Z', source: 'decision', summary: 'Decision recorded', decisionId: 'decision-1' },
      ],
    }));

    expect(html).toContain('Open run');
    expect(html).toContain('Open loop');
    expect(html).toContain('Open request');
    expect(html).toContain('Open decision');
    expect(html).not.toContain('Open Codex');
    expect(html).toContain('not a live agent transcript');
  });

  it('switches retained Work detail links to the catalog project and clears stale pod scope', async () => {
    const presentation = await server.ssrLoadModule('/console/src/main.tsx');
    expect(presentation.projectScope('project-b')).toEqual({ productId: 'project-b', podId: '' });
  });
});
