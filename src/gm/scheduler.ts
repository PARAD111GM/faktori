import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseLocalConsoleConfiguration } from '../console/startup.ts';

type Trigger = { type: 'scheduled' } | { type: 'owner_requested'; requestId: string };

function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function systemd(value: string): string { return value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"'); }

export async function callConsoleGMReview(configurationPath: string, trigger: Trigger): Promise<unknown> {
  const configuration = parseLocalConsoleConfiguration(JSON.parse(await readFile(configurationPath, 'utf8')) as unknown);
  if (!configuration.commandToken || configuration.port === 0) throw new Error('nightly GM CLI requires a fixed Console port and configured commandToken');
  const origin = `http://127.0.0.1:${configuration.port}`;
  if (!configuration.allowedOrigins.includes(origin)) throw new Error('nightly GM CLI origin is not allowlisted by the Console configuration');
  const route = trigger.type === 'scheduled' ? 'scheduled' : 'review';
  const response = await fetch(`${origin}/api/console/gm/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Faktori-Console-Token': configuration.commandToken }, body: JSON.stringify(trigger.type === 'scheduled' ? {} : { requestId: trigger.requestId }) });
  if (response.status === 204) return { status: 'not_due' };
  const body = await response.json() as unknown;
  if (!response.ok) throw new Error(`Console GM review failed (${response.status})`);
  return body;
}

export async function renderLocalGMScheduler(configurationPath: string, platform: 'launchd' | 'systemd', executable = process.execPath, cliPath = process.argv[1] ?? ''): Promise<Record<string, unknown>> {
  if (!isAbsolute(configurationPath)) throw new Error('scheduler configuration path must be absolute');
  const configuration = parseLocalConsoleConfiguration(JSON.parse(await readFile(configurationPath, 'utf8')) as unknown);
  const gm = configuration.runtime?.gm;
  if (gm?.mode !== 'nightly' || !gm.schedule?.enabled) throw new Error('scheduler rendering requires enabled runtime.gm nightly configuration');
  if (!configuration.commandToken || configuration.port === 0) throw new Error('scheduler rendering requires a fixed Console port and commandToken');
  const label = `dev.faktori.gm.${configuration.factoryId.replaceAll(/[^a-zA-Z0-9.-]/g, '-')}`;
  const args = [executable, cliPath, 'gm', 'review', configurationPath, '--scheduled'];
  if (platform === 'launchd') return {
    platform, timezone: gm.schedule.timezone, localTime: gm.schedule.localTime, installed: false, pollingIntervalSeconds: 900,
    definition: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>StartInterval</key><integer>900</integer><key>RunAtLoad</key><true/></dict></plist>\n`,
    note: 'launchd polls locally; the Console applies the configured IANA timezone and one-attempt-per-day gate.',
  };
  const command = args.map((arg) => `"${systemd(arg)}"`).join(' ');
  return {
    platform, timezone: gm.schedule.timezone, localTime: gm.schedule.localTime, installed: false, pollingIntervalSeconds: 900,
    service: `[Unit]\nDescription=Faktori consolidated nightly GM review\n[Service]\nType=oneshot\nExecStart=${command}\n`,
    timer: `[Unit]\nDescription=Poll Faktori nightly GM due gate\n[Timer]\nOnBootSec=2m\nOnUnitActiveSec=15m\nPersistent=true\nUnit=${label}.service\n[Install]\nWantedBy=timers.target\n`,
    note: 'systemd definition is generated but not exercised on macOS; the Console applies the configured IANA timezone and daily dedupe.',
  };
}
