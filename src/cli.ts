#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  AppendOnlyJournal,
  approveProvisioningProposal,
  assembleContextPacket,
  createDiscoveryRecord,
  createFactoryBackup,
  createProvisioningProposal,
  createRunManifest,
  evaluateInstalledPreflightDocument,
  initializeRuntimeInstallation,
  runManagerLoop,
  recordLoopDeliveryEvidence,
  prepareLoopPublicationHandoff,
  publishLoopPublication,
  applyRuntimeUpdate,
  previewRuntimeUpdate,
  previewNewProduct,
  parseRunManifestJournal,
  prepareLocalCodexConsole,
  provisionApprovedProposal,
  provisionApprovedNewProduct,
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
  faktori product new <approved-bundle.json> <absolute-root>
  faktori runtime rebuild <journal.jsonl> <projection.sqlite>
  faktori run manifest <journal.jsonl> <run-id>
  faktori loop run <config.json>
  faktori loop delivery record <request.json>
  faktori loop publication prepare <request.json>
  faktori loop publication publish <request.json>
  faktori preflight <request.json>
  faktori backup create <request.json> <backup-directory>
  faktori backup restore <backup-directory> <restore-request.json>
  faktori backup reconcile <request.json>
  faktori update initialize <request.json>
  faktori update preview <request.json>
  faktori update apply <approved-request.json>
  faktori console serve <local-console.json>
  faktori console prepare <request.json>

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
    const changeInput = isRecord(request.change) ? request.change : undefined;
    const previousResolvedConfig = changeInput?.kind === 'add-product'
      ? changeInput.previousResolvedConfig ?? resolveFactoryConfig(changeInput.previousConfiguration)
      : undefined;
    const change = changeInput === undefined ? undefined : { ...changeInput, previousResolvedConfig };
    const discovery = isRecord(request.discovery) && request.discovery.format === 'faktori.discovery/v1'
      ? request.discovery
      : createDiscoveryRecord(request.discovery);
    const proposal = createProvisioningProposal({ ...request, discovery, resolvedConfig, ...(change === undefined ? {} : { change }) });
    print({ resolvedConfig, ...(previousResolvedConfig === undefined ? {} : { previousResolvedConfig }), discovery, proposal, renderedProposal: renderProvisioningProposal(proposal) });
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

  if (group === 'product' && action === 'new') {
    if (!extra) throw new Error('an existing absolute factory root is required');
    const bundle = record(await json(source, 'approved new-product bundle'), 'approved new-product bundle');
    print(provisionApprovedNewProduct({ ...bundle, root: extra }));
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

  if (group === 'run' && action === 'manifest') {
    if (argv.length !== 4 || !source || !extra) throw new Error('run manifest requires exactly one operational journal path and one run ID');
    let contents: string;
    try {
      contents = await readFile(source, 'utf8');
    } catch (error) {
      throw new Error(`operational journal could not be read from ${source}: ${errorMessage(error)}`);
    }
    print(createRunManifest(parseRunManifestJournal(contents), extra));
    return;
  }

  if (group === 'loop' && action === 'publication' && (source === 'prepare' || source === 'publish')) {
    if (argv.length !== 4 || !extra) throw new Error('loop publication requires one request JSON path');
    const request = await json(extra, 'publication request');
    print(await (source === 'prepare' ? prepareLoopPublicationHandoff(request) : publishLoopPublication(request)));
    return;
  }

  if (group === 'loop' && action === 'delivery' && source === 'record') {
    if (argv.length !== 4 || !extra) throw new Error('loop delivery record requires one request JSON path');
    print(await recordLoopDeliveryEvidence(await json(extra, 'delivery evidence request')));
    return;
  }

  if (group === 'loop' && action === 'run') {
    if (argv.length !== 3 || !source) throw new Error('loop run requires exactly one manager loop configuration path');
    print(await runManagerLoop(await json(source, 'manager loop configuration')));
    return;
  }

  if (group === 'preflight') {
    if (argv.length !== 2 || !action) throw new Error('preflight requires exactly one request JSON path');
    print(evaluateInstalledPreflightDocument(await json(action, 'preflight request')));
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

  if (group === 'console' && action === 'prepare') {
    print(prepareLocalCodexConsole(await json(source, 'Console preparation request')));
    return;
  }

  throw new Error(`unknown command: ${argv.join(' ')}\n\n${HELP}`);
}

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
