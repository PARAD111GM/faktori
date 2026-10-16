import type { RunIntent } from '../runtime/contracts.ts';
import type { ProviderCurrentContext, ProviderSessionBinding, ProviderTurnAdapter, ProviderTurnLifecycle } from './contracts.ts';
import type { TaskSupervisor } from '../execution/task-supervisor.ts';

/** Explicit opt-in profile. The existing bounded exec adapter remains unchanged. */
export class CodexAppServerAdapter implements ProviderTurnAdapter {
  readonly supervisor: TaskSupervisor;
  constructor(options: { supervisor: TaskSupervisor }) { this.supervisor = options.supervisor; }
  async start(intent: RunIntent, context: ProviderCurrentContext, lifecycle?: ProviderTurnLifecycle) { await this.supervisor.prepare(intent, context); return this.supervisor.execute(intent, context, 'start', undefined, lifecycle); }
  async resume(intent: RunIntent, session: ProviderSessionBinding, context: ProviderCurrentContext, lifecycle?: ProviderTurnLifecycle) { await this.supervisor.prepare(intent, context, session); return this.supervisor.execute(intent, context, 'resume', session, lifecycle); }
  cancel(intent: RunIntent, lifecycle?: ProviderTurnLifecycle) { return this.supervisor.cancel(intent, lifecycle); }
}
