import { HelpHeading, HelpSummary } from './section-help.tsx';
import { summarizeUsage } from '../../src/runtime/usage-accounting.mjs';

export type TokenUsage = {
  input?: number | null;
  cached?: number | null;
  uncachedInput?: number | null;
  output?: number | null;
  reasoning?: number | null;
  total?: number | null;
  excludedChildCount?: number;
  unknownMeasurements?: number;
};

export type TokenTrackerStage = {
  phaseId: string;
  kind: 'manager_brief' | 'implement' | 'repair' | 'review' | 'manager_accept' | 'deterministic_accept' | string;
  round: number;
  outcome: string;
  completedAt: string;
  usage?: { availability?: 'reported' | 'partially_reported' | 'unavailable'; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number };
  model?: string;
};

export type TokenTrackerLoop = {
  id: string;
  productId?: string;
  podId?: string;
  status: string;
  usage?: TokenUsage;
  stages: TokenTrackerStage[];
};

export type TokenTrackerEfficiency = {
  usage: TokenUsage;
  coverage: { registeredObservations: number; usableObservations: number; ratio: number | null };
};

export type TokenRole = 'build' | 'coordination' | 'review' | 'repair';
export type TokenRoleSummary = { role: TokenRole; receiptCount: number; usage: TokenUsage };

const ROLES: TokenRole[] = ['build', 'coordination', 'review', 'repair'];

export function roleForStage(kind: TokenTrackerStage['kind']): TokenRole | undefined {
  if (kind === 'implement') return 'build';
  if (kind === 'repair') return 'repair';
  if (kind === 'review') return 'review';
  if (kind === 'manager_brief' || kind === 'manager_accept') return 'coordination';
  return undefined;
}

function stageRecords(loops: TokenTrackerLoop[], role?: TokenRole): Record<string, unknown>[] {
  return loops.flatMap((loop) => loop.stages.flatMap((stage) => {
    const stageRole = roleForStage(stage.kind);
    if (stageRole === undefined || (role !== undefined && stageRole !== role)) return [];
    const telemetry = stage.usage;
    const hasCounters = telemetry?.availability === 'reported' || telemetry?.availability === 'partially_reported';
    return [{
      source: `loop:${loop.id}`,
      agentId: `${loop.id}:${stage.phaseId}:${stage.kind}:${stage.round}`,
      sessionId: `${stage.phaseId}:${stage.kind}:${stage.round}`,
      registeredSessionId: `${loop.id}:${stage.phaseId}:${stage.kind}:${stage.round}`,
      responseId: `${stage.phaseId}:${stage.kind}:${stage.round}`,
      at: stage.completedAt,
      cumulative: true,
      coverageScope: 'exclusive',
      ...(hasCounters ? { counters: {
        ...(telemetry?.inputTokens === undefined ? {} : { input: telemetry.inputTokens }),
        ...(telemetry?.cachedInputTokens === undefined ? {} : { cached: telemetry.cachedInputTokens }),
        ...(telemetry?.outputTokens === undefined ? {} : { output: telemetry.outputTokens }),
        ...(telemetry?.reasoningTokens === undefined ? {} : { reasoning: telemetry.reasoningTokens }),
        ...(telemetry?.inputTokens === undefined || telemetry?.outputTokens === undefined ? {} : { total: telemetry.inputTokens + telemetry.outputTokens }),
      } } : { telemetry: 'unknown' }),
    }];
  }));
}

function trackedUsage(records: Record<string, unknown>[]): TokenUsage {
  const summary = summarizeUsage(records, 0);
  return { ...summary.actual, unknownMeasurements: summary.unknown.length };
}

function acceptedReceiptCount(records: Record<string, unknown>[]): number {
  return summarizeUsage(records, 0).records.accepted;
}

export function summarizeTokenTrackerRoles(loops: TokenTrackerLoop[]): TokenRoleSummary[] {
  return ROLES.map((role) => {
    const records = stageRecords(loops, role);
    return { role, receiptCount: acceptedReceiptCount(records), usage: trackedUsage(records) };
  });
}

export function summarizeTokenTrackerRun(loop: TokenTrackerLoop): TokenUsage {
  // The loop observer owns the all-source normalized total. It may include a
  // separately registered usage export whose stage role is intentionally not
  // guessed here.
  if (loop.usage !== undefined) return loop.usage;
  return trackedUsage(stageRecords([loop]));
}

export function trackerRoleCoverage(loops: TokenTrackerLoop[]): { receiptUsage: TokenUsage; coverage: { registeredObservations: number; usableObservations: number; ratio: number | null } } {
  const records = stageRecords(loops);
  const usage = trackedUsage(records);
  const usableObservations = records.filter((record) => record.telemetry !== 'unknown' && typeof record.counters === 'object' && record.counters !== null && Number.isFinite((record.counters as { total?: number }).total)).length;
  return { receiptUsage: usage, coverage: { registeredObservations: records.length, usableObservations, ratio: records.length === 0 ? null : usableObservations / records.length } };
}

function count(value?: number | null): string { return value === undefined || value === null ? 'Unavailable' : new Intl.NumberFormat().format(value); }
function percent(value: number | null): string { return value === null ? 'Unavailable' : `${(value * 100).toFixed(1)}%`; }
function label(value: string): string { return value.replaceAll('_', ' '); }

function TokenFacts({ usage }: { usage: TokenUsage }) {
  return <dl className="token-facts">
    <dt>Input</dt><dd>{count(usage.input)}</dd>
    <dt>Cached input</dt><dd>{count(usage.cached)}</dd>
    <dt>Uncached input</dt><dd>{count(usage.uncachedInput)}</dd>
    <dt>Output</dt><dd>{count(usage.output)}</dd>
    <dt>Measured total</dt><dd>{count(usage.total)}</dd>
  </dl>;
}

export function TokenTrackerOverview({ efficiency }: { efficiency?: TokenTrackerEfficiency }) {
  if (efficiency === undefined) return <section className="panel token-tracker-overview"><div className="panel-heading"><div><HelpHeading level={2} scope="token-tracker">Token tracker</HelpHeading><p>No registered Manager Loop observations are currently projected.</p></div><a className="overview-link" href="#factory">Open Factory</a></div></section>;
  return <section className="panel token-tracker-overview"><div className="panel-heading"><div><HelpHeading level={2} scope="token-tracker">Token tracker</HelpHeading><p>Measured registered observations only; cached input remains a subset of input.</p></div><a className="overview-link" href="#factory">Open Factory</a></div><div className="metric-row"><div className="metric"><span>Measured total</span><strong>{count(efficiency.usage.total)}</strong></div><div className="metric"><span>Observation coverage</span><strong>{efficiency.coverage.usableObservations}/{efficiency.coverage.registeredObservations}</strong></div><div className="metric"><span>Unknown</span><strong>{count(efficiency.usage.unknownMeasurements)}</strong></div></div></section>;
}

export function TokenTracker({ loops, efficiency }: { loops: TokenTrackerLoop[]; efficiency?: TokenTrackerEfficiency }) {
  const roles = summarizeTokenTrackerRoles(loops);
  const roleCoverage = trackerRoleCoverage(loops);
  const total = efficiency?.usage ?? roleCoverage.receiptUsage;
  const coverage = efficiency?.coverage ?? roleCoverage.coverage;
  const roleTotal = roleCoverage.receiptUsage.total;
  const allTotal = total.total;
  const omittedRoleTelemetry = allTotal !== null && allTotal !== undefined && roleTotal !== null && roleTotal !== undefined && allTotal !== roleTotal;
  return <section className="panel panel-muted token-tracker" aria-label="Token tracker">
    <div className="panel-heading"><div><HelpHeading level={2} scope="token-tracker">Token tracker</HelpHeading><p>Normalized lower-bound provider telemetry from registered Manager Loop observations. Observations include stage receipts and any explicitly registered usage export. It updates when usage receipts arrive; running stages may be unmeasured.</p></div><strong>{loops.length} loops</strong></div>
    <div className="token-summary"><div><HelpHeading level={3} scope="token-tracker">Measured usage</HelpHeading><TokenFacts usage={total} /></div><div><HelpHeading level={3} scope="token-tracker">Measurement coverage</HelpHeading><dl className="token-facts"><dt>Usable observations</dt><dd>{coverage.usableObservations}/{coverage.registeredObservations}</dd><dt>Coverage</dt><dd>{percent(coverage.ratio)}</dd><dt>Unknown measurements</dt><dd>{count(total.unknownMeasurements)}</dd><dt>Excluded overlap</dt><dd>{count(total.excludedChildCount)}</dd></dl><p className="quiet">Uncached input appears only when every contributing input receipt also reports its cached portion.</p></div></div>
    <section className="token-role-section"><HelpHeading level={3} scope="token-tracker">Receipt roles</HelpHeading><p className="quiet">Build, coordination, review, and repair are stage roles—not a claim about a person or provider identity.</p><div className="token-role-grid">{roles.map((item) => <article key={item.role} className="token-role-card"><h4>{item.role}</h4><span>{item.receiptCount} receipt{item.receiptCount === 1 ? '' : 's'}</span><strong>{count(item.usage.total)}</strong><small>Input {count(item.usage.input)} · cached {count(item.usage.cached)} · uncached {count(item.usage.uncachedInput)} · output {count(item.usage.output)}</small>{item.usage.unknownMeasurements ? <em>{item.usage.unknownMeasurements} unknown</em> : null}</article>)}</div>{omittedRoleTelemetry && <p className="notice">Role totals cover only receipt stages. The overall total also includes registered usage that has no safe stage-role label.</p>}</section>
    <section className="token-runs"><HelpHeading level={3} scope="token-tracker">Per-run receipt breakdown</HelpHeading>{loops.length === 0 ? <p className="quiet">No registered Manager Loop records are available.</p> : <div className="token-run-list">{loops.map((loop) => {
      const usage = summarizeTokenTrackerRun(loop);
      const models = [...new Set(loop.stages.map((stage) => stage.model).filter((model): model is string => Boolean(model)))];
      return <details key={loop.id} className="token-run"><HelpSummary scope="token-tracker"><span><strong>{loop.id}</strong><small>Project: {loop.productId ?? 'not recorded'} · Scope: {loop.podId ?? 'not recorded'} · Model: {models.length ? models.join(', ') : 'not recorded'}</small></span><b>{count(usage.total)} measured</b></HelpSummary><div className="token-run-body"><TokenFacts usage={usage} /><p className="quiet">Status: {label(loop.status)}. Model labels are shown only when a registered receipt records one.</p><ol>{loop.stages.map((stage, index) => <li key={`${stage.phaseId}:${stage.kind}:${stage.round}:${index}`}><strong>{stage.phaseId} / {label(stage.kind)}</strong><span>{label(stage.outcome)} · round {stage.round} · {stage.usage?.availability ?? 'unavailable'} telemetry</span><small>Input {count(stage.usage?.inputTokens)} · cached {count(stage.usage?.cachedInputTokens)} · output {count(stage.usage?.outputTokens)}</small></li>)}</ol></div></details>;
    })}</div>}</section>
    <p className="notice">Cached input is already part of input and is never added again. Coverage is only for registered Manager Loop observations, not the whole factory: controlling Codex task and Foreman overhead remain excluded unless an explicit registered export supplies them. Outcome metrics stay separate: this tracker reports telemetry, not invoices, savings, or product acceptance.</p>
  </section>;
}
