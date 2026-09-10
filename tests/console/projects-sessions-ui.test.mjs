import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let server;

const project = {
  productId: 'faktori',
  title: 'Faktori Console',
  goal: 'Make catalog work easy to inspect.',
  artifacts: [],
  plans: [{ id: 'console-plan', order: 1, title: 'Console repairs', goal: 'Keep navigation legible.', phases: [] }],
  progress: {
    status: 'available',
    tickets: { total: 2, done: 1, inProgress: 0, remaining: 1, blocked: 0, unknown: 0 },
    evidence: { local: 'owner_published', reviewed: 'owner_published', merged: 'unknown', deployed: 'unknown', productAccepted: 'unknown' },
    pullRequests: { status: 'unavailable', populationBasis: 'explicit_catalog_linked_pull_requests', denominator: 0, merged: 0, unknown: 0, independentReviewStatus: 'unavailable', independentReviewPassed: 0, independentReviewUnknown: 0 },
  },
  dailySummaries: [],
  pullRequests: [],
};

const workManagement = { status: 'available', projects: [project], sessions: [], requests: [], decisions: [] };
const navigation = { openRun() {}, openLoop() {}, openRequest() {} };

function findElement(element, predicate) {
  if (Array.isArray(element)) return element.map((child) => findElement(child, predicate)).find(Boolean);
  if (!element || typeof element !== 'object') return undefined;
  if (predicate(element)) return element;
  return findElement(element.props?.children, predicate);
}

beforeAll(async () => {
  server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true } });
});

afterAll(async () => {
  await server?.close();
});

describe('Console project list and session heading repairs', () => {
  it('starts project navigation as a compact list and renders the selected project as a detail page', async () => {
    const { Projects } = await server.ssrLoadModule('/console/src/projects.tsx');
    const list = renderToStaticMarkup(createElement(Projects, { workManagement, navigation, onSelectProject() {} }));
    const detail = renderToStaticMarkup(createElement(Projects, { workManagement, navigation, selectedProjectId: 'faktori', onSelectProject() {}, onBackToProjects() {} }));

    expect(list).toContain('Open project');
    expect(list).not.toContain('Plan 1');
    expect(detail).toContain('Back to projects');
    expect(detail).toContain('Plan 1');
    expect(detail).not.toContain('Open project');
  });

  it('routes list selection and detail back controls through supplied navigation callbacks', async () => {
    const { Project, ProjectList } = await server.ssrLoadModule('/console/src/projects.tsx');
    let selected;
    let returned = false;

    findElement(ProjectList({ projects: [project], onSelectProject: (productId) => { selected = productId; } }), (element) => element.type === 'button' && element.props.className === 'project-list-item').props.onClick();
    findElement(Project({ project, requests: [], sessions: [], navigation, onBackToProjects: () => { returned = true; } }), (element) => element.type === 'button' && element.props.children === 'Back to projects').props.onClick();

    expect(selected).toBe('faktori');
    expect(returned).toBe(true);
  });

  it('uses a scoped light heading treatment for sessions on the dark workspace', async () => {
    const styles = await readFile(join(root, 'console/src/styles.css'), 'utf8');

    expect(styles).toContain('.sessions-list > .panel-heading { grid-column: 1 / -1; margin: 16px 0 0; padding: 14px 16px; background: #202322; color: #f3f3f0; }');
    expect(styles).toContain('.sessions-list > .panel-heading h3, .sessions-list > .panel-heading > strong { color: #f3f3f0; }');
    expect(styles).toContain('.sessions-list > .panel-heading p { color: #c5c8c6; }');
  });
});
