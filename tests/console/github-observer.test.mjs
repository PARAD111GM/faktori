import { describe, expect, it, vi } from 'vitest';

import { GitHubWorkObserver } from '../../src/console/github-observer.ts';

const link = { ticketId: 'CWM-012', repository: 'example/faktori', number: 12 };

describe('linked GitHub work observation', () => {
  it('observes only the configured PR and never turns a merged PR into product acceptance', async () => {
    const calls = [];
    const observer = new GitHubWorkObserver({ links: [link], command: async (argv) => {
      calls.push(argv);
      return { exitCode: 0, stdout: JSON.stringify({ url: 'https://github.com/example/faktori/pull/12', state: 'MERGED', mergedAt: '2026-09-10T12:00:00Z', reviewDecision: 'APPROVED' }), stderr: '' };
    } });
    await observer.refresh();
    expect(calls).toEqual([['pr', 'view', '12', '--repo', 'example/faktori', '--json', 'url,state,mergedAt,reviewDecision']]);
    expect(observer.snapshot()).toEqual([expect.objectContaining({ ticketId: 'CWM-012', status: 'available', merged: 'yes', review: 'unknown', url: 'https://github.com/example/faktori/pull/12' })]);
    expect(JSON.stringify(observer.snapshot())).not.toMatch(/productAccepted|deployed|local/);
  });

  it('retains only last-good bounded metadata as stale after a failed refresh', async () => {
    let calls = 0; let now = new Date('2026-09-10T12:00:00.000Z').getTime();
    const observer = new GitHubWorkObserver({ links: [link], now: () => new Date(now), command: async () => {
      calls += 1;
      return calls === 1
        ? { exitCode: 0, stdout: JSON.stringify({ url: 'https://github.com/example/faktori/pull/12', state: 'OPEN', mergedAt: null, reviewDecision: null }), stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'private token must not escape' };
    } });
    await observer.refresh();
    now += 60_000;
    await observer.refresh();
    expect(observer.snapshot()).toEqual([expect.objectContaining({ status: 'stale', merged: 'no', review: 'unknown', error: 'observation_refresh_failed', url: 'https://github.com/example/faktori/pull/12' })]);
    expect(JSON.stringify(observer.snapshot())).not.toContain('private token');
  });

  it('fails closed for a malformed canonical URL', async () => {
    const observer = new GitHubWorkObserver({ links: [link], command: async () => ({ exitCode: 0, stdout: JSON.stringify({ url: 'https://attacker.example/example/faktori/pull/12', state: 'MERGED', mergedAt: '2026-09-10T12:00:00Z', reviewDecision: 'APPROVED' }), stderr: '' }) });
    await observer.refresh();
    expect(observer.snapshot()).toEqual([expect.objectContaining({ status: 'unavailable', merged: 'unknown', review: 'unknown' })]);
  });

  it('bounds a thousand explicit links to four concurrent gh observations', async () => {
    let active = 0; let peak = 0;
    const links = Array.from({ length: 1000 }, (_, index) => ({ ticketId: `CWM-${index + 1000}`, repository: 'example/faktori', number: index + 1 }));
    const observer = new GitHubWorkObserver({ links, command: async (argv) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const number = Number(argv[2]);
      return { exitCode: 0, stdout: JSON.stringify({ url: `https://github.com/example/faktori/pull/${number}`, state: 'OPEN', mergedAt: null, reviewDecision: null }), stderr: '' };
    } });
    await observer.refresh();
    expect(peak).toBeLessThanOrEqual(4);
    expect(observer.snapshot()).toHaveLength(1000);
  });

  it('times out an injected hung observation, backs off, and never starts another copy', async () => {
    vi.useFakeTimers();
    let now = new Date('2026-09-10T12:00:00.000Z').getTime();
    let calls = 0;
    const observer = new GitHubWorkObserver({ links: [link], now: () => new Date(now), command: async () => {
      calls += 1;
      return await new Promise(() => {});
    } });
    const first = observer.refresh();
    await vi.advanceTimersByTimeAsync(15_000);
    await first;
    expect(observer.snapshot()).toEqual([expect.objectContaining({ error: 'observation_timed_out' })]);
    now += 60_000;
    await observer.refresh();
    expect(calls).toBe(1);
    vi.useRealTimers();
  });

  it('does not reset failure backoff when the service reapplies an identical allowlist', async () => {
    let now = new Date('2026-09-10T12:00:00.000Z').getTime(); let calls = 0;
    const observer = new GitHubWorkObserver({ links: [link], now: () => new Date(now), command: async () => {
      calls += 1; return { exitCode: 1, stdout: '', stderr: 'unavailable' };
    } });
    await observer.refresh();
    observer.setLinks([{ ...link }]);
    await observer.refresh();
    expect(calls).toBe(1);
    now += 60_000;
    await observer.refresh();
    expect(calls).toBe(2);
  });

  it('does not leak a removed allowlist link when its in-flight observation resolves', async () => {
    let release = () => {};
    const observer = new GitHubWorkObserver({ links: [link], command: async () => await new Promise((resolve) => { release = () => resolve({ exitCode: 0, stdout: JSON.stringify({ url: 'https://github.com/example/faktori/pull/12', state: 'MERGED', mergedAt: '2026-09-10T12:00:00Z', reviewDecision: 'APPROVED' }), stderr: '' }); }) });
    const refresh = observer.refresh();
    await Promise.resolve();
    observer.setLinks([]);
    release();
    await refresh;
    expect(observer.snapshot()).toEqual([]);
  });

  it('projects the current ticket scope when one PR is reassigned during an in-flight refresh', async () => {
    let calls = 0; let release = () => {};
    const a = { ...link, ticketId: 'CWM-A' };
    const b = { ...link, ticketId: 'CWM-B' };
    const c = { ...link, ticketId: 'CWM-C' };
    const result = { exitCode: 0, stdout: JSON.stringify({ url: 'https://github.com/example/faktori/pull/12', state: 'OPEN', mergedAt: null, reviewDecision: null }), stderr: '' };
    const observer = new GitHubWorkObserver({ links: [a], command: async () => {
      calls += 1;
      return calls === 1 ? result : await new Promise((resolve) => { release = () => resolve(result); });
    } });
    await observer.refresh();
    observer.setLinks([b]);
    const first = observer.refresh();
    const second = observer.refresh();
    await Promise.resolve();
    observer.setLinks([c]);
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(observer.snapshot()).toEqual([expect.objectContaining({ ticketId: 'CWM-C', repository: 'example/faktori', number: 12, status: 'available' })]);
    expect(JSON.stringify(observer.snapshot())).not.toContain('CWM-A');
    expect(JSON.stringify(observer.snapshot())).not.toContain('CWM-B');
  });
});
