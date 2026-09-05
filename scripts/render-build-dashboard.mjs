#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { args, escapeHtml, fail, json } from './lib/build-records.mjs';

const options = args(process.argv.slice(2));

function historySeries(history) {
  let completed = 0;
  return [...history].sort((left, right) => String(left.at).localeCompare(String(right.at))).map((event, index) => {
    if (event.from === 'complete' && event.to !== 'complete') completed = Math.max(0, completed - 1);
    if (event.from !== 'complete' && event.to === 'complete') completed += 1;
    return { index: index + 1, completed, at: event.at, ticketId: event.ticketId, to: event.to };
  });
}

function chart(series, total) {
  if (series.length === 0) return '<p>No completion events recorded yet.</p>';
  const width = 720;
  const height = 160;
  const timestamps = series.map((point) => Date.parse(point.at));
  const validTimeline = timestamps.every(Number.isFinite);
  const first = validTimeline ? Math.min(...timestamps) : 0;
  const last = validTimeline ? Math.max(...timestamps) : 0;
  const denominator = Math.max(1, series.length - 1);
  const xPositions = series.length === 1
    ? [width / 2]
    : timestamps.map((timestamp, index) => validTimeline && last > first
      ? ((timestamp - first) / (last - first)) * width
      : (index / denominator) * width);
  const points = series.map((point, index) => `${xPositions[index]},${height - ((point.completed / Math.max(1, total)) * height)}`).join(' ');
  const labels = series.map((point) => `<li>${escapeHtml(point.at)} — ${escapeHtml(point.ticketId)} → ${escapeHtml(point.to)} (${point.completed} complete)</li>`).join('');
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Completion-history chart"><polyline points="${points}" fill="none" stroke="#156c4b" stroke-width="4"/><line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="#9ba8b3"/></svg><ol class="events">${labels}</ol>`;
}

function page(checklist, summary) {
  const tickets = checklist.tickets ?? [];
  const history = checklist.history ?? [];
  const complete = tickets.filter((ticket) => ticket.status === 'complete').length;
  const progress = tickets.length === 0 ? 0 : Math.round((complete / tickets.length) * 100);
  const phase = checklist.project?.currentPhase ?? summary?.phase ?? 'unknown';
  const budget = summary?.budget?.estimate ?? checklist.project?.phaseBudgets?.[String(phase)] ?? null;
  const usage = summary ?? { actual: { total: null }, estimated: { total: null }, unknown: [], budget: { estimate: budget, percentUsed: null }, notices: [], models: [] };
  const usagePercent = usage.budget?.percentUsed ?? null;
  const chartWidth = Math.max(0, Math.min(100, Number(usagePercent) || 0));
  const blockers = tickets.filter((ticket) => ticket.status === 'blocked');
  const rows = tickets.map((ticket) => `<tr><td>${escapeHtml(ticket.id)}</td><td>${escapeHtml(ticket.title)}</td><td><span class="status ${escapeHtml(ticket.status)}">${escapeHtml(ticket.status)}</span></td><td>${escapeHtml((ticket.dependencies ?? []).join(', ') || '—')}</td><td>${escapeHtml(ticket.owner?.role ?? 'unassigned')}<br><small>${escapeHtml(ticket.owner?.agentId ?? '—')}</small></td><td>${escapeHtml(ticket.owner?.model ?? 'unknown')}/${escapeHtml(ticket.owner?.reasoning ?? 'unknown')}</td></tr>`).join('');
  const blockerItems = blockers.length === 0 ? '<li>None</li>' : blockers.map((ticket) => `<li>${escapeHtml(ticket.id)} — ${escapeHtml(ticket.title)}</li>`).join('');
  const missingItems = usage.unknown?.length ? usage.unknown.map((item) => `<li>${escapeHtml(item.ticket)} — ${escapeHtml(item.reason)}</li>`).join('') : '<li>None</li>';
  const modelRecords = usage.models?.length ? usage.models.map((model) => `${model.model}/${model.reasoning}`).join(', ') : 'unknown';
  const metric = (label, value) => `${label}: ${value === null || value === undefined ? 'unknown' : `${escapeHtml(value)} tokens`}`;
  const actualLabel = usage.actual?.kind === 'overlap-safe-lower-bound'
    ? 'Overlap-safe lower bound (incomplete coverage)'
    : 'Measured actual';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Faktori construction dashboard</title><style>body{font:16px system-ui;margin:2rem;max-width:1100px;color:#17212b}h1{margin-bottom:.2rem}section{margin:2rem 0;padding:1.25rem;border:1px solid #d5dce2;border-radius:.6rem}table{border-collapse:collapse;width:100%}th,td{padding:.6rem;border-bottom:1px solid #d5dce2;text-align:left;vertical-align:top}.bar{height:1rem;background:#e8edf1;border-radius:999px}.bar i{display:block;height:100%;background:#156c4b;border-radius:inherit}.usage i{background:#315c9b}.status{font-weight:600}.blocked{color:#a43b00}.complete{color:#156c4b}svg{width:100%;height:auto;background:#f7f9fa}.events{max-height:10rem;overflow:auto}small{color:#526170}</style></head><body><main><h1>Faktori construction</h1><p>Current phase: ${escapeHtml(phase)}. ${complete} of ${tickets.length} complete (${progress}%).</p><div class="bar" aria-label="Checklist progress"><i style="width:${progress}%"></i></div><section><h2>Completion history</h2>${chart(historySeries(history), tickets.length)}</section><section><h2>Phase usage</h2><p>${actualLabel}: ${escapeHtml(usage.actual?.total ?? 'unknown')} tokens. Estimated work: ${escapeHtml(usage.estimated?.total ?? 'unknown')} tokens. Phase budget: ${escapeHtml(budget ?? 'unknown')} tokens. ${metric('Remaining allowance', usage.budget?.remaining)}. Budget used: ${escapeHtml(usagePercent ?? 'unknown')}%.</p><p>${metric('Input', usage.actual?.input)}. ${metric('Output', usage.actual?.output)}. ${metric('Cached', usage.actual?.cached)}. ${metric('Reasoning', usage.actual?.reasoning)}.</p><div class="bar usage" aria-label="Token budget consumption"><i style="width:${chartWidth}%"></i></div><p>Notices: ${escapeHtml((usage.notices ?? []).map((notice) => `${notice.threshold}%`).join(', ') || 'none')}. Model/reasoning records: ${escapeHtml(modelRecords)}.</p><h3>Missing usage telemetry</h3><ul>${missingItems}</ul></section><section><h2>Blockers</h2><ul>${blockerItems}</ul></section><section><h2>Full checklist</h2><table><thead><tr><th>ID</th><th>Ticket</th><th>Status</th><th>Dependencies</th><th>Owner</th><th>Model/reasoning</th></tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`;
}

async function render() {
  if (!options.checklist || !options.output) throw new Error('Usage: render-build-dashboard.mjs --checklist path --summary path --output dashboard.html');
  const checklist = await json(options.checklist);
  const summary = options.summary ? await json(options.summary) : null;
  await writeFile(options.output, `${page(checklist, summary)}\n`, 'utf8');
  process.stdout.write(`Rendered ${options.output}\n`);
}

render().catch((error) => fail(error.message));
