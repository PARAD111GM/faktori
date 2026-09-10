import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let server;

const decision = {
  id: 'decision-console-batch-2',
  scope: { productId: 'faktori', planId: 'console-work-management', phaseId: 'batch-2', ticketId: 'CWM-007' },
  problem: 'The owner must choose how the decision inbox proceeds.',
  cause: { basis: 'observed', summary: 'The active Manager published an explicit phase gate.' },
  evidence: [{ label: 'Manager record', summary: 'The decision was raised from the retained phase state.' }],
  accountableOwner: 'Factory owner',
  recommendedNextAction: 'Choose the bounded owner response for Manager observation.',
  impact: 'Phase 3 remains blocked until the response is observed separately.',
  capability: 'supported',
  action: { kind: 'record_owner_response', label: 'Record owner response' },
  options: [{ id: 'continue', label: 'Continue to Batch 3 after evidence review' }, { id: 'hold', label: 'Hold pending more evidence' }],
  state: 'open',
  revision: 3,
  observedAt: '2026-09-09T19:00:00.000Z',
};

beforeAll(async () => {
  server = await createServer({ root, configFile: false, logLevel: 'silent', server: { middlewareMode: true } });
});

afterAll(async () => {
  await server?.close();
});

describe('Console Decision Inbox', () => {
  it('renders the full plain-language decision and one bounded owner response control', async () => {
    const { DecisionInbox } = await server.ssrLoadModule('/console/src/decisions.tsx');
    const html = renderToStaticMarkup(createElement(DecisionInbox, { decisions: [decision], token: 'local-token' }));

    expect(html).toContain('The owner must choose how the decision inbox proceeds.');
    expect(html).toContain('Basis: observed');
    expect(html).toContain('Phase 3 remains blocked until the response is observed separately.');
    expect(html).toContain('Factory owner');
    expect(html).toContain('Manager record');
    expect(html).toContain('Continue to Batch 3 after evidence review');
    expect(html).toContain('Record response for Manager observation');
    expect(html).toContain('does not wake or message the Manager');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('Allow');
  });

  it('keeps an unavailable provider-like action honest and disabled', async () => {
    const { DecisionInbox } = await server.ssrLoadModule('/console/src/decisions.tsx');
    const unavailable = { ...decision, id: 'decision-provider', capability: 'unavailable', action: { kind: 'answer_provider_request', label: 'Answer pending provider request' }, options: [], state: 'open' };
    const html = renderToStaticMarkup(createElement(DecisionInbox, { decisions: [unavailable], token: 'local-token' }));

    expect(html).toContain('This action is unavailable in the current observed state.');
    expect(html).toContain('Answer pending provider request');
    expect(html).toContain('does not create a provider, merge, deployment, or native approval');
    expect(html).not.toContain('<select');
  });

  it('only navigates a supported observed target without claiming to execute it', async () => {
    const { DecisionInbox } = await server.ssrLoadModule('/console/src/decisions.tsx');
    const html = renderToStaticMarkup(createElement(DecisionInbox, { decisions: [{
      ...decision,
      id: 'decision-observed-run',
      action: { kind: 'answer_provider_request', label: 'Open run to answer', target: { runId: 'run-42', requestId: 'request-42' } },
      options: [],
    }], token: 'local-token', navigation: { openRun() {}, openSession() {} } }));

    expect(html).toContain('Open run to answer');
    expect(html).toContain('Opens the retained run detail and its existing provider response control. No provider answer has been sent.');
    expect(html).not.toContain('Send response');
  });

  it('keeps recorded, pending Manager acknowledgement and resolved states distinct', async () => {
    const { DecisionInbox } = await server.ssrLoadModule('/console/src/decisions.tsx');
    const html = renderToStaticMarkup(createElement(DecisionInbox, { decisions: [
      { ...decision, id: 'response-recorded', state: 'response_recorded', ownerResponse: { optionId: 'continue', label: 'Continue to Batch 3 after evidence review', recordedAt: '2026-09-09T19:03:00.000Z' } },
      { ...decision, id: 'pending-ack', state: 'pending_manager_ack' },
      { ...decision, id: 'acknowledged', state: 'manager_acknowledged' },
      { ...decision, id: 'resolved', state: 'resolved' },
    ], token: 'local-token' }));

    expect(html).toContain('Response recorded');
    expect(html).toContain('Pending Manager acknowledgement');
    expect(html).toContain('Manager acknowledged');
    expect(html).toContain('Resolved');
    expect(html).toContain('Recorded owner response:');
    expect(html).toContain('No browser acknowledgement control exists.');
  });

  it('keeps an uncertain recorded response reconciliation-only', async () => {
    const { DecisionInbox } = await server.ssrLoadModule('/console/src/decisions.tsx');
    const html = renderToStaticMarkup(createElement(DecisionInbox, { decisions: [{
      ...decision,
      id: 'uncertain-recorded-response',
      state: 'uncertain',
      ownerResponse: { optionId: 'continue', label: 'Continue to Batch 3 after evidence review', recordedAt: '2026-09-09T19:03:00.000Z' },
    }], token: 'local-token' }));

    expect(html).toContain('Recorded owner response:');
    expect(html).toContain('needs Manager reconciliation');
    expect(html).toContain('No new browser response or acknowledgement control exists.');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Record response for Manager observation');
  });

  it('shows only a compact actionable subset on Overview', async () => {
    const { DecisionInbox } = await server.ssrLoadModule('/console/src/decisions.tsx');
    const html = renderToStaticMarkup(createElement(DecisionInbox, { decisions: [decision, { ...decision, id: 'resolved', state: 'resolved' }], compact: true, openDecisions() {} }));

    expect(html).toContain('Decision Inbox');
    expect(html).toContain('Open all decisions');
    expect(html).not.toContain('Owner response</label>');
    expect(html).not.toContain('Decision resolved');
  });
});
