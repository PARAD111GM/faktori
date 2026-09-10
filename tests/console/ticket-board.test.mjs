import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { beforeAll, afterAll, it, expect } from 'vitest';
let server, TicketBoard;
beforeAll(async () => { server = await createServer({ configFile: false, logLevel: 'silent', server: { middlewareMode: true } }); ({ TicketBoard } = await server.ssrLoadModule('/console/src/ticket-board.tsx')); });
afterAll(async () => server?.close());
const workManagement = { status: 'available', projects: [{ productId: 'app', title: 'App', plans: [{ id: 'p', title: 'Release', phases: [{ id: 'f', title: 'Core', tickets: [{ id: 'A-1', title: 'Save a task', goal: 'Persist it', dependencies: [], status: 'remaining', issueKey: 'TWZ-1' }, { id: 'A-2', title: 'Show saved tasks', dependencies: [] }] }] }] }] };
const render = (boards = []) => renderToStaticMarkup(createElement(TicketBoard, { workManagement, boards, runs: [], filter: { productId: '', podId: '' }, selectRun: () => {} }));
it('shows every local ticket without needing an execution run or Jira', () => {
  const html = render(); expect(html).toContain('Save a task'); expect(html).toContain('Show saved tasks'); expect(html).toContain('Status not recorded'); expect(html).toContain('aria-label="Work board"');
});
it('keeps unmatched local tickets while showing a matched Jira issue only from its authoritative source', () => {
  const html = render([{ id: 'jira', projectKey: 'TWZ', productId: 'app', status: 'connected', issues: [{ key: 'TWZ-1', summary: 'Jira task title', status: 'To Do', statusCategory: 'new', updatedAt: '2026-09-10T00:00:00Z', url: 'https://example.atlassian.net/browse/TWZ-1' }] }]);
  expect(html).toContain('Jira task title'); expect(html).not.toContain('Save a task'); expect(html).toContain('Show saved tasks');
});
it('does not hide local tickets when configured Jira is unavailable', () => {
  const html = render([{ id: 'jira', projectKey: 'TWZ', productId: 'app', status: 'unavailable', issues: [] }]);
  expect(html).toContain('Save a task'); expect(html).toContain('could not be refreshed');
});
it('has one project scope control including catalog-only projects and recognizes detail deep links', async () => {
  const { Work, viewFromHash } = await server.ssrLoadModule('/console/src/main.tsx');
  const html = renderToStaticMarkup(createElement(Work, { state: { workManagement }, runs: [], selectRun: () => {}, openLoop: () => {}, openRequest: () => {}, submit: () => {}, submitManagerConnected: async () => {} }));
  expect((html.match(/<label>Project</g) ?? []).length).toBe(1);
  expect(html).toContain('<option value="app">App</option>');
  expect((html.match(/aria-label="Work board"/g) ?? []).length).toBe(1);
  expect(html).not.toContain('Execution runs');
  expect(html).not.toContain('Local tickets');
  expect(html).not.toContain('Launching');
  expect(viewFromHash('#projects?project=app')).toBe('projects');
});
