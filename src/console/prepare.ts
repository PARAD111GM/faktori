import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { resolveFactoryConfig, type FactoryConfiguration } from '../config/index.ts';
import { providerContextPayloadDigest, type ProviderCurrentContext } from '../providers/contracts.ts';
import type { RunIntent } from '../runtime/contracts.ts';

type Input = Record<string, unknown>;

function object(value: unknown, label: string): Input {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Input;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${label} must be an integer greater than or equal to ${minimum}`);
  return Number(value);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as Input;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(workspace: string, args: string[], label: string): string {
  const result = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${label}: ${result.stderr.trim() || 'git command failed'}`);
  return result.stdout.trim();
}

/**
 * Converts an approved local factory and one explicit work item into the exact
 * owner-controlled Console configuration needed for a real native Codex turn.
 */
export function prepareLocalCodexConsole(value: unknown): Record<string, unknown> {
  const input = object(value, 'Console preparation request');
  const factoryRoot = text(input.factoryRoot, 'factoryRoot');
  if (!isAbsolute(factoryRoot) || !existsSync(factoryRoot)) throw new Error('factoryRoot must be an existing absolute directory');
  const configuration = object(input.configuration, 'configuration') as unknown as FactoryConfiguration;
  const resolved = resolveFactoryConfig(configuration);
  const profilePath = join(factoryRoot, 'config', 'factory-profile.json');
  if (!existsSync(profilePath)) throw new Error('approved factory profile is missing; run provision apply first');
  const profile = object(JSON.parse(readFileSync(profilePath, 'utf8')), 'approved factory profile');
  if (object(profile.factory, 'approved factory profile.factory').id !== resolved.factory.id
    || profile.configurationRevision !== sha(stable(resolved))) {
    throw new Error('approved factory profile does not match the supplied configuration');
  }

  const productId = text(input.productId, 'productId');
  const product = resolved.products.find((candidate) => candidate.id === productId);
  if (product === undefined) throw new Error(`unknown configured product: ${productId}`);
  const provider = resolved.providers.find((candidate) => candidate.id === product.providerId);
  if (provider?.kind !== 'codex' || product.executionProfile !== 'native') {
    throw new Error('local Codex preparation requires a product resolved to a native Codex provider');
  }
  if (product.budget.strictSpending) {
    throw new Error('strict spending was selected but this route has no observed hard token-cap capability');
  }

  const workspace = realpathSync(join(factoryRoot, 'products', productId));
  if (realpathSync(git(workspace, ['rev-parse', '--show-toplevel'], 'product repository unavailable')) !== workspace) {
    throw new Error('product workspace must be the exact Git repository root');
  }
  if (git(workspace, ['status', '--porcelain'], 'product status unavailable') !== '') {
    throw new Error('product workspace must be clean before its approved base is recorded');
  }
  const baseRevision = git(workspace, ['rev-parse', '--verify', 'HEAD'], 'product base revision unavailable');
  const branch = git(workspace, ['branch', '--show-current'], 'product branch unavailable');
  if (branch === '') throw new Error('product workspace must be on a named branch');

  const work = object(input.workItem, 'workItem');
  const workItemId = text(work.id, 'workItem.id');
  const workRevision = text(work.revision, 'workItem.revision');
  const objective = text(work.objective, 'workItem.objective');
  if (!Array.isArray(work.acceptanceCriteria) || work.acceptanceCriteria.length === 0) throw new Error('workItem.acceptanceCriteria must be a non-empty array');
  const criteria = work.acceptanceCriteria.map((criterion, index) => text(criterion, `workItem.acceptanceCriteria[${index}]`));
  if (!Array.isArray(work.constraints)) throw new Error('workItem.constraints must be an array');
  const constraints = work.constraints.map((constraint, index) => text(constraint, `workItem.constraints[${index}]`));
  const model = text(input.model, 'model');
  const environment = object(input.environment, 'environment');
  if (!Object.values(environment).every((entry) => typeof entry === 'string')) throw new Error('environment values must all be strings');
  const createdAt = text(input.createdAt, 'createdAt');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('createdAt must be an ISO timestamp');
  const estimatedTokens = integer(input.estimatedTokens, 'estimatedTokens', 0);
  if (estimatedTokens > product.budget.maxTokens && product.budget.maxTokens > 0) throw new Error('estimatedTokens exceeds the approved product budget');
  const prompt = [
    `Work item ${workItemId} (${workRevision}).`,
    `Objective: ${objective}`,
    'Acceptance criteria:',
    ...criteria.map((criterion) => `- ${criterion}`),
    'Inherited constraints:',
    ...(constraints.length === 0 ? ['- None recorded.'] : constraints.map((constraint) => `- ${constraint}`)),
    'Treat provider authentication as the only permitted ambient state. Do not inspect memory, user configuration, parent/sibling directories, or paths outside this repository.',
    'Do not create symlinks, hard links, or dependency references to paths outside this repository. If acceptance tooling is missing and an approved offline package cache is available, record the exact dependency in the product package manifest and lockfile and install it product-locally.',
    'Work only in this repository. Preserve the accepted scope and starting behavior. Do not use remotes, publish, merge, deploy, access credentials, or add paid/network services. Implement the smallest correct change, run the repository acceptance tests, and finish with a concise summary of changed files and observed commands.',
  ].join('\n');
  const context: ProviderCurrentContext = {
    packetRevision: text(input.contextRevision, 'contextRevision'),
    digest: `sha256:${sha(JSON.stringify({ objective, criteria, constraints, baseRevision }))}`,
    prompt,
  };
  const scopeDigest = `sha256:${sha(JSON.stringify({ factoryId: resolved.factory.id, productId, workItemId, workRevision, baseRevision, branch, authority: product.authority }))}`;
  const suffix = sha(`${scopeDigest}:${context.digest}`).slice(0, 20);
  const intent: RunIntent = {
    format: 'faktori.run-intent/v1',
    runId: `run-${suffix}`,
    admissionKey: `admission-${suffix}`,
    workItem: { id: workItemId, revision: workRevision },
    target: { factoryId: resolved.factory.id, productId, repository: `local:${productId}`, branch, baseRevision, expectedRevision: baseRevision },
    context: { packetRevision: context.packetRevision, digest: context.digest },
    execution: { profile: 'native', workspaceId: `product:${productId}`, workspacePath: workspace, providerId: 'codex', model, approvedInputDigests: [providerContextPayloadDigest(context)] },
    budget: { reservationId: `reservation-${suffix}`, maxRuntimeMinutes: product.budget.maxRuntimeMinutes, estimatedTokens, status: 'held' },
    authority: { authorityRevision: text(input.authorityRevision, 'authorityRevision'), epoch: 1, scopeDigest, policy: product.authority },
    attempt: 1,
    createdAt,
  };
  const port = input.port === undefined ? 4173 : integer(input.port, 'port', 0);
  if (port > 65_535) throw new Error('port must be at most 65535');
  return {
    factoryId: resolved.factory.id,
    journalPath: join(factoryRoot, '.faktori', 'runtime', 'operations.jsonl'),
    projectionPath: join(factoryRoot, '.faktori', 'runtime', 'projection.sqlite'),
    port,
    allowedOrigins: [`http://127.0.0.1:${port}`],
    limits: { ...product.budget, strictSpendingSupported: false },
    factoryConfiguration: configuration,
    runtime: {
      providers: [{ id: 'codex', profile: 'native', environment, compatibleModels: [model], runNonce: `codex-${suffix}`, contextIsolation: 'bounded' }],
      workItems: [{ workItemId, intent, context, dependsOnWorkItemIds: [] }],
      resumePlans: [],
    },
  };
}
