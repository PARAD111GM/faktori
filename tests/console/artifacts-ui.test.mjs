import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let server;
const artifact = { id: 'intent', title: 'Canonical INTENT', role: 'intent', path: 'INTENT.md', status: 'available', content: 'Approved objective', contentBasis: 'owner_snapshot', sourceRevision: 'intent-r7', snapshotAt: '2026-09-11T12:00:00Z' };
const project = { productId: 'faktori', title: 'Faktori', goal: 'Ship truthfully.', artifacts: [artifact], plans: [], progress: { status: 'available', tickets: { total: 0, done: 0, inProgress: 0, remaining: 0, blocked: 0, unknown: 0 }, evidence: {}, pullRequests: {} }, dailySummaries: [], pullRequests: [] };
beforeAll(async () => { server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true } }); });
afterAll(async () => { await server?.close(); });

describe('Console Artifacts UI', () => {
  it('renders available snapshot artifacts as safe React text with their revision and basis', async () => {
    const { Artifacts } = await server.ssrLoadModule('/console/src/artifacts.tsx');
    const html = renderToStaticMarkup(createElement(Artifacts, { workManagement: { status: 'available', projects: [project], sessions: [], requests: [], decisions: [] } }));
    expect(html).toContain('Owner-published snapshot — not live file content.');
    expect(html).toContain('Recorded revision: intent-r7');
    expect(html).toContain('Approved objective');
    expect(html).not.toContain('artifactHome');
    expect(html).not.toContain('>Artifacts<');
  });
  it('keeps missing INTENT and stale file observations explicit without inventing approval', async () => {
    const { Artifacts } = await server.ssrLoadModule('/console/src/artifacts.tsx');
    const stale = { ...project, artifacts: [{ ...artifact, id: 'plan', role: 'plan', status: 'stale', contentBasis: 'observed_file', content: undefined, error: 'Last safe observation is stale.' }] };
    const html = renderToStaticMarkup(createElement(Artifacts, { workManagement: { status: 'available', projects: [stale], sessions: [], requests: [], decisions: [] } }));
    expect(html).toContain('INTENT is not recorded');
    expect(html).toContain('No approval or intent is inferred.');
    expect(html).toContain('Last safe observation is stale.');
    expect(html).not.toContain('Approved objective');
  });
  it('treats an unavailable registered INTENT and an absent catalog as no approval evidence', async () => {
    const { Artifacts } = await server.ssrLoadModule('/console/src/artifacts.tsx');
    const unavailableIntent = { ...project, artifacts: [{ ...artifact, status: 'unavailable', content: undefined, error: 'Safe read unavailable.' }] };
    const unavailable = renderToStaticMarkup(createElement(Artifacts, { workManagement: { status: 'available', projects: [unavailableIntent], sessions: [], requests: [], decisions: [] } }));
    const absent = renderToStaticMarkup(createElement(Artifacts, {}));
    expect(unavailable).toContain('INTENT is unavailable or stale');
    expect(unavailable).toContain('No approval or intent is inferred.');
    expect(unavailable).toContain('Safe read unavailable.');
    expect(absent).toContain('Artifact catalog unavailable');
    expect(absent).not.toContain('No matching project artifacts');
  });
  it('routes the Artifacts hash and preserves its project filter', async () => {
    const { viewFromHash } = await server.ssrLoadModule('/console/src/main.tsx');
    expect(viewFromHash('#artifacts?project=faktori')).toBe('artifacts');
  });
  it('renders sprint readiness as read-only evidence and treats a missing report as no-go', async () => {
    const { SprintReadinessCard } = await server.ssrLoadModule('/console/src/main.tsx');
    const ready = renderToStaticMarkup(createElement(SprintReadinessCard, { report: { ready: true, mode: 'attended', blockers: [] } }));
    const unknown = renderToStaticMarkup(createElement(SprintReadinessCard, { error: 'Sprint readiness request failed (404)' }));
    expect(ready).toContain('attended ready');
    expect(ready).toContain('cannot approve, launch, or repair a sprint');
    expect(unknown).toContain('unknown / no-go');
    expect(unknown).not.toContain('<input');
    expect(unknown).not.toContain('Approve');
  });
});
