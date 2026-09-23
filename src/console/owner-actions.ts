import type { RunIntent } from '../runtime/contracts.ts';
import type { AdmissionResult, DurableCoordinator } from '../runtime/coordinator.ts';
import type { ConsoleOwnerActions } from './service.ts';

export interface ConsoleOwnerActionPorts {
  /** Trusted planning/control layer supplies exactly one prevalidated intent per eligible work item. */
  intentForWorkItem(workItemId: string): Promise<RunIntent | undefined>;
  /** Provider-specific execution remains controller-owned and is invoked only after admission. */
  startAdmittedRun?(runId: string): Promise<{ detail?: string }>;
  admissionRejected?(runId: string): Promise<void>;
  answerRequest?(runId: string, requestId: string, answer: string): Promise<{ detail?: string }>;
  cancelRun?(runId: string, reason: string): Promise<{ detail?: string }>;
  resumeRun?(runId: string): Promise<{ detail?: string }>;
  authoritativeRecord?(runId: string): Promise<{ url: string }>;
}

function admitted(result: AdmissionResult): { runId: string; detail?: string } {
  if (!result.accepted || result.snapshot === undefined) throw new Error(result.reason ?? 'work_admission_rejected');
  return { runId: result.snapshot.intent.runId };
}

export function consoleAdmissionPaused(coordinator: DurableCoordinator): boolean {
  for (const event of [...coordinator.journal.events()].reverse()) {
    if (event.kind !== 'console.command') continue;
    const receipt = event.data.command as { status?: string; command?: { type?: string; paused?: boolean } } | undefined;
    if (receipt?.status === 'completed' && receipt.command?.type === 'pause_admission') return receipt.command.paused === true;
  }
  return false;
}

/**
 * The Console receives only a work-item identifier. It never constructs
 * authority, workspace, reservation, or provider parameters from browser data.
 */
export function createConsoleOwnerActions(coordinator: DurableCoordinator, ports: ConsoleOwnerActionPorts): ConsoleOwnerActions {
  return {
    async startWork(workItemId: string): Promise<{ runId: string; detail?: string }> {
      if (consoleAdmissionPaused(coordinator)) throw new Error('admission_paused');
      const intent = await ports.intentForWorkItem(workItemId);
      if (intent === undefined) throw new Error('work_item_not_eligible');
      const admission = await coordinator.admit(intent);
      if (!admission.accepted) await ports.admissionRejected?.(intent.runId);
      const acceptedRun = admitted(admission);
      if (ports.startAdmittedRun === undefined) return acceptedRun;
      // Admission is the durable command boundary. Provider delivery continues
      // independently so cancel and next-turn messages are never queued behind
      // an entire model turn.
      const started = ports.startAdmittedRun(acceptedRun.runId);
      void started.catch(() => undefined);
      return { ...acceptedRun, detail: 'provider_delivery_started' };
    },
    answer: ports.answerRequest === undefined ? undefined : (runId, requestId, answer) => ports.answerRequest!(runId, requestId, answer),
    cancel: ports.cancelRun === undefined ? undefined : (runId, reason) => ports.cancelRun!(runId, reason),
    resume: ports.resumeRun === undefined ? undefined : (runId) => ports.resumeRun!(runId),
    openRecord: ports.authoritativeRecord === undefined ? undefined : (runId) => ports.authoritativeRecord!(runId),
  };
}
