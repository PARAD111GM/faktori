import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  BoundedCommandRunner, NativeCodexProcessRunner, NativeIdentityProbe, persistPrivateProviderArtifact,
} from '../execution/transports.ts';
import { CodexAdapter } from '../providers/codex.ts';
import { providerContextPayloadDigest, type ProviderCurrentContext } from '../providers/contracts.ts';
import type { ProviderFinalResult, RunIntent } from '../runtime/contracts.ts';
import {
  loadProductDiscoverySession, productDiscoveryProposalOutputSchema, productDiscoverySessionDigest,
  recordProductDiscoveryProposal, renderProductDiscoveryPrompt, saveProductDiscoverySession,
  type DiscoverySessionProposal, type ProductDiscoverySession,
} from './discovery-session.ts';

/** Operator configuration, never read from model output or interview answers. */
export interface DiscoveryProviderConfiguration {
  historyPath: string;
  proposalId: string;
  workspacePath: string;
  artifactsDirectory: string;
  provider: {
    kind: 'codex'; executable: string; model: string; reasoning: 'low' | 'medium' | 'high';
    contextIsolation: 'bounded'; nativeAccessApproved: true;
  };
  limits: {
    /** Per-attempt wall time. Total provider time is bounded by (maxRetries + 1) times this value. */
    maxRuntimeMinutes: number;
    maxRetries: number;
    maxOutputBytes: number;
    maxResponseBytes: number;
  };
}

export interface DiscoveryProviderResult {
  format: 'faktori.discovery-provider-result/v1';
  status: 'proposed' | 'already_recorded' | 'provider_failed' | 'rejected';
  proposalId: string;
  revision: number;
  sessionDigest: string;
  attempts: number;
  artifactsDirectory?: string;
  normalizedArtifacts: string[];
  final?: ProviderFinalResult;
  proposal?: DiscoverySessionProposal;
  reason?: string;
}

const ENVIRONMENT_KEYS = ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NO_COLOR'] as const;
const POLICY = Object.freeze({
  requireIntentApproval: true, requireSpecificationApproval: true, requireIndependentReview: true,
  mergeAuthority: 'human' as const, productionReleaseAuthority: 'human' as const,
  allowPreviewDeployment: false, allowLocalDeployment: false, allowSeparateBilling: false,
});
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!keys.includes(key) || !('value' in descriptor)) throw new Error(`${label} contains unsupported fields or accessors`);
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label} must be a bounded nonempty string without NUL`);
  return value;
}
function absolute(value: unknown, label: string): string {
  const path = string(value, label);
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be a canonical absolute path`);
  return path;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer from ${min} through ${max}`);
  return value as number;
}

export function parseDiscoveryProviderConfiguration(value: unknown): DiscoveryProviderConfiguration {
  const input = object(value, ['historyPath', 'proposalId', 'workspacePath', 'artifactsDirectory', 'provider', 'limits'], 'discovery provider configuration');
  const provider = object(input.provider, ['kind', 'executable', 'model', 'reasoning', 'contextIsolation', 'nativeAccessApproved'], 'provider');
  if (provider.kind !== 'codex' || provider.nativeAccessApproved !== true || provider.contextIsolation !== 'bounded') throw new Error('discovery requires explicitly approved native Codex access with bounded context isolation');
  if (!['low', 'medium', 'high'].includes(provider.reasoning as string)) throw new Error('provider.reasoning must be low, medium or high');
  const model = string(provider.model, 'provider.model', 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new Error('provider.model must be a model identifier');
  const proposalId = string(input.proposalId, 'proposalId', 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(proposalId)) throw new Error('proposalId must be an identifier');
  const limits = object(input.limits, ['maxRuntimeMinutes', 'maxRetries', 'maxOutputBytes', 'maxResponseBytes'], 'limits');
  return {
    historyPath: absolute(input.historyPath, 'historyPath'), proposalId,
    workspacePath: absolute(input.workspacePath, 'workspacePath'), artifactsDirectory: absolute(input.artifactsDirectory, 'artifactsDirectory'),
    provider: { kind: 'codex', executable: absolute(provider.executable, 'provider.executable'), model, reasoning: provider.reasoning as 'low' | 'medium' | 'high', contextIsolation: 'bounded', nativeAccessApproved: true },
    limits: {
      maxRuntimeMinutes: integer(limits.maxRuntimeMinutes, 'maxRuntimeMinutes', 1, 30), maxRetries: integer(limits.maxRetries, 'maxRetries', 0, 2),
      maxOutputBytes: integer(limits.maxOutputBytes, 'maxOutputBytes', 4096, 8_000_000), maxResponseBytes: integer(limits.maxResponseBytes, 'maxResponseBytes', 1024, 1_000_000),
    },
  };
}

async function canonicalDirectory(path: string, privateDirectory: boolean): Promise<void> {
  if (await realpath(path) !== path) throw new Error('discovery directories must have no symlink aliases');
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (privateDirectory && (info.mode & 0o077) !== 0)) throw new Error('discovery artifacts require an existing private directory (0700)');
}
async function writeExclusive(path: string, contents: string): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
}
async function readPrivateBytes(path: string, maxBytes: number): Promise<Buffer> {
  if (await realpath(path) !== path) throw new Error('model response has a symlink alias');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes || (before.mode & 0o077) !== 0) throw new Error('model response must be a private unaliased regular file within the configured response bound');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await file.stat();
    if (!held.isFile() || held.nlink !== 1 || held.size !== before.size || held.dev !== before.dev || held.ino !== before.ino) throw new Error('model response changed during open');
    const bytes = Buffer.alloc(held.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await file.read(bytes, position, bytes.length - position, position);
      if (!read.bytesRead) throw new Error('model response changed during read');
      position += read.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (after.size !== held.size || after.mtimeMs !== held.mtimeMs || current.dev !== held.dev || current.ino !== held.ino || current.nlink !== 1) throw new Error('model response changed during read');
    return bytes;
  } finally { await file.close(); }
}

function intentFor(config: DiscoveryProviderConfiguration, session: ProductDiscoverySession, context: ProviderCurrentContext, runId: string, attempt: number): RunIntent {
  const sessionDigest = productDiscoverySessionDigest(session);
  return {
    format: 'faktori.run-intent/v1', runId, admissionKey: runId,
    workItem: { id: config.proposalId, revision: sessionDigest, role: 'requirements_interviewer' },
    target: { factoryId: 'attended-discovery', productId: session.productId, repository: `local:${config.workspacePath}`, branch: 'discovery-only', baseRevision: sessionDigest, expectedRevision: sessionDigest },
    context: { packetRevision: context.packetRevision, digest: context.digest },
    execution: { profile: 'native', workspaceId: hash(config.workspacePath), workspacePath: config.workspacePath, providerId: 'codex', model: config.provider.model, reasoning: config.provider.reasoning, approvedInputDigests: [providerContextPayloadDigest(context)] },
    // The estimate is unknown (zero), not a promised token limit. Native usage is retained separately.
    budget: { reservationId: runId, maxRuntimeMinutes: config.limits.maxRuntimeMinutes, estimatedTokens: 0, status: 'held' },
    authority: { authorityRevision: 'attended-discovery-proposal-only/v1', epoch: 1, scopeDigest: hash(JSON.stringify(POLICY)), policy: POLICY }, attempt, createdAt: new Date().toISOString(),
  };
}

/** Obtain and append one proposed interview response through the owner's unchanged native CLI. */
export async function runProductDiscoveryProposal(input: unknown): Promise<DiscoveryProviderResult> {
  const config = parseDiscoveryProviderConfiguration(input);
  await canonicalDirectory(config.workspacePath, false);
  await canonicalDirectory(config.artifactsDirectory, true);
  await access(config.provider.executable, constants.X_OK);
  const session = await loadProductDiscoverySession(config.historyPath);
  const base = { format: 'faktori.discovery-provider-result/v1' as const, proposalId: config.proposalId, revision: session.revision, sessionDigest: productDiscoverySessionDigest(session) };
  const previous = session.modelProposals.find((item) => item.id === config.proposalId);
  if (previous) {
    if (!previous.source.reference.startsWith('file:')) throw new Error('proposal ID is already used by a different source');
    const responsePath = absolute(previous.source.reference.slice(5), 'recorded response path');
    const recordedConfig = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateBytes(join(dirname(dirname(responsePath)), 'provider-config.json'), 16000)));
    if (JSON.stringify(parseDiscoveryProviderConfiguration(recordedConfig)) !== JSON.stringify(config)) throw new Error('proposal ID is already recorded with different operator configuration');
    const bytes = await readPrivateBytes(responsePath, config.limits.maxResponseBytes);
    if (previous.source.revision !== `sha256:${hash(bytes)}`) throw new Error('recorded proposal source bytes have changed');
    return { ...base, status: 'already_recorded', attempts: 0, normalizedArtifacts: [], proposal: previous };
  }
  const environment = Object.freeze(Object.fromEntries(ENVIRONMENT_KEYS.flatMap((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.length > 0 && !value.includes('\0') ? [[key, value]] : [];
  })));
  if (!environment.PATH || !environment.HOME) throw new Error('discovery requires an allowlisted PATH and HOME for the existing vendor CLI authentication');
  const artifactsDirectory = await mkdtemp(join(config.artifactsDirectory, 'discovery-'));
  const prompt = renderProductDiscoveryPrompt(session);
  const context: ProviderCurrentContext = { packetRevision: `${session.sessionId}@${session.revision}`, digest: `sha256:${hash(prompt)}`, prompt, nativeSandbox: 'read-only' };
  const normalizedArtifacts: string[] = [];
  await writeExclusive(join(artifactsDirectory, 'prompt.txt'), prompt);
  await writeExclusive(join(artifactsDirectory, 'provider-config.json'), `${JSON.stringify(config)}\n`);
  const schemaPath = join(artifactsDirectory, 'proposal-schema.json');
  await writeExclusive(schemaPath, `${JSON.stringify(productDiscoveryProposalOutputSchema)}\n`);
  await persistPrivateProviderArtifact(artifactsDirectory, ['request'], { format: 'faktori.discovery-provider-request/v1', config, sessionDigest: base.sessionDigest, context, environmentKeys: Object.keys(environment) });
  for (let attempt = 1; attempt <= config.limits.maxRetries + 1; attempt++) {
    const attemptDirectory = join(artifactsDirectory, `attempt-${attempt}`);
    await mkdir(attemptDirectory, { mode: 0o700 });
    const responsePath = join(attemptDirectory, 'model-response.json');
    // Precreate a private empty response file: the vendor CLI truncates it rather than choosing a permissive mode.
    await writeExclusive(responsePath, '');
    const runId = `discovery-${randomUUID()}`;
    const intent = intentFor(config, session, context, runId, attempt);
    const commands = new BoundedCommandRunner();
    const native = new NativeCodexProcessRunner({ executable: config.provider.executable, artifactsDirectory: attemptDirectory, commands, identityProbe: new NativeIdentityProbe({ commands, cwd: config.workspacePath, env: environment }), runNonce: randomUUID(), stdoutMaxBytes: config.limits.maxOutputBytes, stderrMaxBytes: config.limits.maxOutputBytes });
    const adapter = new CodexAdapter({
      runner: { async run(request) {
        const args = [...request.args.slice(0, -1), '--output-schema', schemaPath, '--output-last-message', responsePath, request.args.at(-1)!];
        const lifecycle = request.lifecycle;
        if (!lifecycle?.onTerminationRequired) throw new Error('discovery requires durable worker lifecycle hooks');
        return native.run({ ...request, args, lifecycle: { onStarted: lifecycle.onStarted, onTerminationRequired: lifecycle.onTerminationRequired } });
      } }, environment, compatibleModels: [config.provider.model], contextIsolation: 'bounded',
      limits: { maxRuntimeMinutes: config.limits.maxRuntimeMinutes, maxRetries: config.limits.maxRetries, maxTokens: 0 },
    });
    const result = await adapter.start(intent, context, {
      async onStarted(worker) { await persistPrivateProviderArtifact(attemptDirectory, ['started'], { event: 'worker.started', intent, worker }); },
      async onTerminationRequired(worker, reason) { await persistPrivateProviderArtifact(attemptDirectory, ['termination'], { event: 'worker.termination_required', worker, reason }); },
    });
    normalizedArtifacts.push(await persistPrivateProviderArtifact(attemptDirectory, ['normalized'], { format: 'faktori.discovery-provider-attempt/v1', attempt, intent, result, responsePath }));
    let responseBytes: Buffer | undefined;
    let responseError: unknown;
    try {
      responseBytes = await readPrivateBytes(responsePath, config.limits.maxResponseBytes);
      await persistPrivateProviderArtifact(attemptDirectory, ['source'], { event: 'proposal.source_captured', source: { reference: `file:${responsePath}`, revision: `sha256:${hash(responseBytes)}` }, byteLength: responseBytes.length });
    } catch (error) {
      responseError = error;
      await persistPrivateProviderArtifact(attemptDirectory, ['source-rejected'], { event: 'proposal.source_rejected', responsePath, error: error instanceof Error ? error.message : 'unknown response capture failure' });
    }
    if (result.final.outcome !== 'completed') {
      // Never retry ambiguous termination, malformed streams, authentication, quota or denial.
      if (attempt <= config.limits.maxRetries && result.malformedEventCount === 0 && ['failed', 'unavailable'].includes(result.final.outcome)) continue;
      return { ...base, status: 'provider_failed', attempts: attempt, artifactsDirectory, normalizedArtifacts, final: result.final, reason: 'native provider did not complete a valid turn; history is unchanged' };
    }
    try {
      if (responseError !== undefined || responseBytes === undefined) throw responseError ?? new Error('response bytes were not captured');
      const bytes = responseBytes;
      const source = { reference: `file:${responsePath}`, revision: `sha256:${hash(bytes)}` };
      const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['status', 'text', 'questions'], 'model response');
      if (Object.keys(value).sort().join(',') !== 'questions,status,text' || !Array.isArray(value.questions) || value.questions.length > 20) throw new Error('model response must match the exact proposal output schema');
      const next = recordProductDiscoveryProposal(session, { ...value, id: config.proposalId, source });
      await persistPrivateProviderArtifact(attemptDirectory, ['validated'], { event: 'proposal.validated', source, byteLength: bytes.length, parentDigest: base.sessionDigest });
      // Existing history locking and parent-digest validation reject a concurrent or stale writer.
      await saveProductDiscoverySession(config.historyPath, next);
      return { ...base, status: 'proposed', revision: next.revision, sessionDigest: productDiscoverySessionDigest(next), attempts: attempt, artifactsDirectory, normalizedArtifacts, final: result.final, proposal: next.modelProposals.at(-1)! };
    } catch (error) {
      await persistPrivateProviderArtifact(attemptDirectory, ['rejected'], { event: 'proposal.rejected', responsePath, error: error instanceof Error ? error.message : 'unknown validation or append failure' });
      return { ...base, status: 'rejected', attempts: attempt, artifactsDirectory, normalizedArtifacts, final: result.final, reason: 'response validation or immutable history append failed; preserve private artifacts and reload the history before recovery' };
    }
  }
  throw new Error('discovery exhausted its bounded attempt loop');
}
