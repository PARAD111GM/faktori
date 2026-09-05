#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
  approveProvisioningProposal,
  assembleContextPacket,
  createDiscoveryRecord,
  createProvisioningProposal,
  previewNewProduct,
  provisionApprovedProposal,
  renderProvisioningProposal,
  resolveFactoryConfig,
} from './index.ts';

const HELP = `Usage:
  faktori config resolve <configuration.json>
  faktori context assemble <hierarchy.json> <node-id>
  faktori provision proposal <request.json>
  faktori provision approve <request.json>
  faktori provision apply <bundle.json> <absolute-root>
  faktori product preview <request.json>

Commands read explicit JSON files and write JSON to stdout. Only provision apply
changes local state, and it requires an approved bundle plus an absolute root.`;

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

  throw new Error(`unknown command: ${argv.join(' ')}\n\n${HELP}`);
}

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
