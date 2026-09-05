#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  AppendOnlyJournal,
  approveProvisioningProposal,
  assembleContextPacket,
  createDiscoveryRecord,
  createFactoryBackup,
  createProvisioningProposal,
  initializeRuntimeInstallation,
  applyRuntimeUpdate,
  previewRuntimeUpdate,
  previewNewProduct,
  provisionApprovedProposal,
  reconcileRestoredFactory,
  renderProvisioningProposal,
  resolveFactoryConfig,
  restoreFactoryBackup,
  SqliteProjection,
  startLocalConsoleFromFile,
} from './index.ts';

const HELP = `Usage:
  faktori config resolve <configuration.json>
  faktori context assemble <hierarchy.json> <node-id>
  faktori provision proposal <request.json>
  faktori provision approve <request.json>
  faktori provision apply <bundle.json> <absolute-root>
  faktori product preview <request.json>
  faktori runtime rebuild <journal.jsonl> <projection.sqlite>
  faktori backup create <request.json> <backup-directory>
  faktori backup restore <backup-directory> <restore-request.json>
  faktori backup reconcile <request.json>
  faktori update initialize <request.json>
  faktori update preview <request.json>
  faktori update apply <approved-request.json>
  faktori console serve <local-console.json>

Commands read explicit files and write JSON to stdout. Provision apply changes
approved local factory state. Runtime rebuild replaces only the specified
disposable SQLite projection from its authoritative journal.`;

type InputRecord = Record<string, unknown>;

function isRecord(value: unknown): value is InputRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, label: string): InputRecord {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function json(path: string | undefined, label: string): Promise<unknown> {
  if (!path) throw new Error(`${label} path is required`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read as JSON from ${path}: ${errorMessage(error)}`);
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(argv: string[]): Promise<void> {
  const [group, action, source, extra] = argv;
  if (group === '--help' || group === '-h' || group === 'help' || !group) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (group === 'config' && action === 'resolve') {
    print(resolveFactoryConfig(await json(source, 'configuration')));
    return;
  }

  if (group === 'context' && action === 'assemble') {
    if (!extra) throw new Error('context node ID is required');
    print(assembleContextPacket(await json(source, 'hierarchy'), extra));
    return;
  }

  if (group === 'provision' && action === 'proposal') {
    const request = record(await json(source, 'proposal request'), 'proposal request');
    const resolvedConfig = request.resolvedConfig ?? resolveFactoryConfig(request.configuration);
    const discovery = isRecord(request.discovery) && request.discovery.format === 'faktori.discovery/v1'
      ? request.discovery
      : createDiscoveryRecord(request.discovery);
    const proposal = createProvisioningProposal({ ...request, discovery, resolvedConfig });
    print({ resolvedConfig, discovery, proposal, renderedProposal: renderProvisioningProposal(proposal) });
    return;
  }

  if (group === 'provision' && action === 'approve') {
    print(approveProvisioningProposal(await json(source, 'approval request')));
    return;
  }

  if (group === 'provision' && action === 'apply') {
    if (!extra) throw new Error('an absolute provisioning root is required');
    const bundle = record(await json(source, 'approved provisioning bundle'), 'approved provisioning bundle');
    print(provisionApprovedProposal({ ...bundle, root: extra }));
    return;
  }

  if (group === 'product' && action === 'preview') {
    const request = record(await json(source, 'product request'), 'product request');
    const resolvedConfig = request.resolvedConfig ?? resolveFactoryConfig(request.configuration);
    print(previewNewProduct({ ...request, resolvedConfig }));
    return;
  }

  if (group === 'runtime' && action === 'rebuild') {
    if (!source) throw new Error('an operational journal path is required');
    if (!extra) throw new Error('a disposable SQLite projection path is required');
    const journal = await AppendOnlyJournal.open(source);
    const projection = new SqliteProjection(extra);
    try {
      projection.rebuild(journal.events());
      print({ eventCount: journal.events().length, snapshots: projection.snapshots() });
    } finally {
      projection.close();
    }
    return;
  }

  if (group === 'backup' && action === 'create') {
    if (!extra) throw new Error('a new backup directory is required');
    print(await createFactoryBackup(await json(source, 'backup request'), extra));
    return;
  }

  if (group === 'backup' && action === 'restore') {
    if (!source) throw new Error('a backup directory is required');
    if (!extra) throw new Error('a restore request with separate destination and path-rebinding confirmation is required');
    print(await restoreFactoryBackup(source, await json(extra, 'restore request')));
    return;
  }

  if (group === 'backup' && action === 'reconcile') {
    print(await reconcileRestoredFactory(await json(source, 'restore reconciliation request')));
    return;
  }

  if (group === 'update' && action === 'initialize') {
    print(await initializeRuntimeInstallation(await json(source, 'update initialization request')));
    return;
  }

  if (group === 'update' && action === 'preview') {
    print(await previewRuntimeUpdate(await json(source, 'update request')));
    return;
  }

  if (group === 'update' && action === 'apply') {
    print(await applyRuntimeUpdate(await json(source, 'approved update request')));
    return;
  }

  if (group === 'console' && action === 'serve') {
    const started = await startLocalConsoleFromFile(source ?? '');
    process.stdout.write(`${JSON.stringify({ url: started.url })}\n`);
    const close = async (): Promise<void> => { await started.close(); process.exit(0); };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    await new Promise<void>(() => {});
  }

  throw new Error(`unknown command: ${argv.join(' ')}\n\n${HELP}`);
}

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
