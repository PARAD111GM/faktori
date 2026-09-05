#!/usr/bin/env node
import { args, canonicalTickets, fail, json, writeJson } from './lib/build-records.mjs';

const options = args(process.argv.slice(2));
const statuses = new Set(['not_started', 'in_progress', 'blocked', 'complete', 'split', 'cancelled']);

function commaValues(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} requires at least one value`);
  const values = value.split(',').map((entry) => entry.trim());
  if (values.some((entry) => entry === '')) throw new Error(`${label} contains an empty value`);
  if (new Set(values).size !== values.length) throw new Error(`${label} contains a duplicate value`);
  return values;
}

function derivedTickets(parent, ids, titles) {
  const parentId = parent.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${parentId}[a-z][a-z0-9-]*$`);
  return ids.map((id, index) => {
    if (!pattern.test(id)) throw new Error(`Derived ticket ID must extend ${parent.id}: ${id}`);
    return {
      id,
      phase: parent.phase,
      title: titles?.[index] ?? `${parent.title} — ${id}`,
      status: 'not_started',
      dependencies: [...(parent.dependencies ?? [])],
      splitFrom: parent.id,
      owner: { role: 'unassigned' },
      notes: [],
      evidence: [],
    };
  });
}

async function update() {
  if (!options.checklist || !options.ticket || !options.status) throw new Error('Usage: update-build-status.mjs --checklist path --ticket F0-02 --status status [--reason text] [--split-into IDs]');
  if (!statuses.has(options.status)) throw new Error(`Unsupported status: ${options.status}`);
  const checklist = await json(options.checklist);
  if (checklist.schemaVersion !== 1 || !Array.isArray(checklist.tickets) || !Array.isArray(checklist.history)) throw new Error('Checklist must use schemaVersion 1 with tickets and history arrays');
  const ticket = checklist.tickets.find((candidate) => candidate.id === options.ticket);
  if (!ticket) throw new Error(`Unknown ticket: ${options.ticket}`);
  if (!canonicalTickets().includes(options.ticket) && !ticket.splitFrom) throw new Error(`Ticket is not part of the canonical 32-ticket model: ${options.ticket}`);
  const splitInto = options.status === 'split' ? commaValues(options['split-into'], 'A split status') : [];
  const titles = options['split-titles'] === undefined ? undefined : commaValues(options['split-titles'], '--split-titles');
  if (titles && titles.length !== splitInto.length) throw new Error('--split-titles must provide one title for each derived ticket');
  const children = options.status === 'split' ? derivedTickets(ticket, splitInto, titles) : [];
  const existingIds = new Set(checklist.tickets.map((candidate) => candidate.id));
  for (const child of children) {
    if (canonicalTickets().includes(child.id)) throw new Error(`Derived ticket collides with canonical ticket: ${child.id}`);
    if (existingIds.has(child.id)) throw new Error(`Derived ticket already exists: ${child.id}`);
  }
  const from = ticket.status;
  ticket.status = options.status;
  if (splitInto.length) ticket.splitInto = splitInto;
  checklist.history.push({
    eventId: `status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(), ticketId: ticket.id, from, to: options.status,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(splitInto.length ? { splitInto } : {}),
  });
  for (const child of children) {
    checklist.tickets.push(child);
    checklist.history.push({
      eventId: `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(), ticketId: child.id, type: 'created', to: 'not_started', splitFrom: ticket.id,
    });
  }
  await writeJson(options.checklist, checklist);
  process.stdout.write(`${ticket.id}: ${from} -> ${ticket.status}\n`);
}

update().catch((error) => fail(error.message));
