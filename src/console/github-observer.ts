import { GitHubRepositoryObserver, type GitHubCommand, type GitHubPullRequestObservation } from '../integrations/github.ts';
import type { WorkManagementPullRequestLink, WorkManagementPullRequestProjection } from './work-management.ts';

const MAX_LINKS = 1_000;
const MAX_CONCURRENT_OBSERVATIONS = 4;
const OBSERVATION_TIMEOUT_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 5 * 60_000;

export interface GitHubWorkObserverOptions {
  /** Explicit catalog-derived owner/repository/number allowlist only. */
  links: readonly WorkManagementPullRequestLink[];
  command: GitHubCommand;
  now?: () => Date;
  staleAfterMs?: number;
}

type ObservationResult =
  | { kind: 'observed'; value: GitHubPullRequestObservation }
  | { kind: 'failed' | 'timed_out' | 'pending' };

/**
 * Bounded read-only PR observation. At most four configured PRs are observed
 * at once. The shipped gh command receives a terminating deadline; a custom
 * test command that never settles stays tracked and is never launched again.
 */
export class GitHubWorkObserver {
  #links: WorkManagementPullRequestLink[];
  #snapshot = new Map<string, WorkManagementPullRequestProjection>();
  #refreshing?: Promise<void>;
  #pending = new Map<string, Promise<GitHubPullRequestObservation>>();
  #listeners = new Set<() => void>();
  #failureOrUnchangedStreak = 0;
  #nextRefreshAt = 0;
  readonly #observer: GitHubRepositoryObserver;
  readonly #now: () => Date;
  readonly #staleAfterMs: number;

  constructor(options: GitHubWorkObserverOptions) {
    validateLinks(options.links, 'linked_pull_request_allowlist');
    this.#links = options.links.map((item) => ({ ...item }));
    this.#observer = new GitHubRepositoryObserver(options.command);
    this.#now = options.now ?? (() => new Date());
    this.#staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
    if (!Number.isInteger(this.#staleAfterMs) || this.#staleAfterMs < 1_000) throw new Error('linked_pull_request_stale_after_must_be_at_least_one_second');
  }

  onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  links(): WorkManagementPullRequestLink[] { return this.#links.map((item) => ({ ...item })); }

  /** Catalog reload seam: only server-validated owner catalog links may replace the allowlist. */
  setLinks(links: readonly WorkManagementPullRequestLink[]): void {
    validateLinks(links, 'linked_pull_request_allowlist');
    const before = JSON.stringify(this.#links);
    // The service reconciles catalog links frequently. An identical allowlist
    // must not turn a bounded failed/unchanged poll into a hot loop.
    if (JSON.stringify(links) === before) return;
    this.#links = links.map((item) => ({ ...item }));
    const allowed = new Set(this.#links.map(key));
    this.#snapshot = new Map([...this.#snapshot].filter(([entry]) => allowed.has(entry)));
    // A catalog change is eligible immediately; stale in-flight reads cannot
    // write later because refresh checks the current allowlist.
    this.#nextRefreshAt = 0;
    this.#failureOrUnchangedStreak = 0;
    for (const listener of this.#listeners) listener();
  }

  snapshot(): WorkManagementPullRequestProjection[] {
    const now = this.#now().getTime();
    return this.#links.map((link) => {
      const current = this.#snapshot.get(key(link));
      if (current === undefined) return { ...link, status: 'unavailable', merged: 'unknown', review: 'unknown', error: this.#pending.has(key(link)) ? 'observation_pending' : 'not_observed' };
      const stale = current.observedAt === undefined || now - Date.parse(current.observedAt) > this.#staleAfterMs;
      // The same external PR can be deliberately reassigned to another ticket
      // by a catalog reload. Keep observation metadata, but always project the
      // current catalog scope rather than the historical ticket id.
      return { ...current, ...link, ...(stale && current.status === 'available' ? { status: 'stale' as const, error: 'observation_stale' } : {}) };
    });
  }

  async refresh(): Promise<void> {
    if (this.#refreshing !== undefined) return this.#refreshing;
    const operation = async (): Promise<void> => {
      const startedAt = this.#now().getTime();
      if (startedAt < this.#nextRefreshAt) return;
      const before = JSON.stringify(this.snapshot());
      const beforeFacts = facts(this.#snapshot);
      const links = this.#links.map((item) => ({ ...item }));
      const outcomes = await pooled(links, MAX_CONCURRENT_OBSERVATIONS, async (link) => ({ link, result: await this.observe(link) }));
      const next = new Map(this.#snapshot);
      let failed = false;
      for (const { link, result } of outcomes) {
        // A catalog reload can remove/reassign a link while this poll is in
        // flight. Never repopulate a dropped item with delayed remote output.
        if (!this.isCurrent(link)) continue;
        const prior = next.get(key(link));
        if (result.kind === 'observed') {
          // GitHub's reviewDecision is not Faktori's independent exact-head
          // review gate. Do not upgrade this field without retained gate proof.
          next.set(key(link), { ...link, status: 'available', observedAt: this.#now().toISOString(), merged: result.value.merged ? 'yes' : 'no', review: 'unknown', url: result.value.url });
        } else {
          failed = true;
          next.set(key(link), prior === undefined
            ? { ...link, status: 'unavailable', merged: 'unknown', review: 'unknown', error: result.kind === 'timed_out' ? 'observation_timed_out' : result.kind === 'pending' ? 'observation_pending' : 'observation_unavailable' }
            : { ...prior, status: 'stale', error: result.kind === 'timed_out' ? 'observation_timed_out' : result.kind === 'pending' ? 'observation_pending' : 'observation_refresh_failed' });
        }
      }
      this.#snapshot = next;
      const unchanged = beforeFacts === facts(next);
      this.#failureOrUnchangedStreak = failed || unchanged ? Math.min(this.#failureOrUnchangedStreak + 1, 16) : 0;
      this.#nextRefreshAt = this.#now().getTime() + backoff(this.#failureOrUnchangedStreak);
      if (JSON.stringify(this.snapshot()) !== before) for (const listener of this.#listeners) listener();
    };
    const refresh = operation();
    this.#refreshing = refresh;
    void refresh.finally(() => { if (this.#refreshing === refresh) this.#refreshing = undefined; }).catch(() => undefined);
    return refresh;
  }

  private isCurrent(link: WorkManagementPullRequestLink): boolean {
    return this.#links.some((candidate) => candidate.ticketId === link.ticketId && candidate.repository === link.repository && candidate.number === link.number);
  }

  private async observe(link: WorkManagementPullRequestLink): Promise<ObservationResult> {
    const entry = key(link);
    if (this.#pending.has(entry)) return { kind: 'pending' };
    const operation = this.#observer.observePullRequest(link.repository, link.number, { timeoutMs: OBSERVATION_TIMEOUT_MS });
    this.#pending.set(entry, operation);
    void operation.finally(() => { if (this.#pending.get(entry) === operation) this.#pending.delete(entry); }).catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.then((value) => ({ kind: 'observed' as const, value }), () => ({ kind: 'failed' as const })),
        new Promise<ObservationResult>((resolve) => { timeout = setTimeout(() => resolve({ kind: 'timed_out' }), OBSERVATION_TIMEOUT_MS); timeout.unref(); }),
      ]);
    } finally { if (timeout !== undefined) clearTimeout(timeout); }
  }
}

function key(link: WorkManagementPullRequestLink): string { return `${link.repository}#${link.number}`; }

function validateLinks(links: readonly WorkManagementPullRequestLink[], error: string): void {
  if (links.length > MAX_LINKS || new Set(links.map(key)).size !== links.length) throw new Error(`${error}_invalid`);
}

function backoff(streak: number): number {
  return Math.min(MIN_POLL_INTERVAL_MS * (2 ** streak), MAX_POLL_INTERVAL_MS);
}

function facts(snapshot: ReadonlyMap<string, WorkManagementPullRequestProjection>): string {
  return JSON.stringify([...snapshot.values()].map(({ observedAt: _observedAt, status: _status, error: _error, ...item }) => item).sort((a, b) => key(a).localeCompare(key(b))));
}

async function pooled<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next; next += 1;
      if (index >= items.length) return;
      results[index] = await map(items[index]!);
    }
  }));
  return results;
}
