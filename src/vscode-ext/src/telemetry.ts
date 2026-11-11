import * as fs from 'fs';
import * as path from 'path';

export type SshState = 'unconfigured' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped';

/** Writes this module's telemetry fragment atomically; the dashboard merges fragments. Never throws. */
export function writeLspTelemetry(file: string, state: SshState, host: string, lastError = ''): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = {
      module: 'vscode-ext',
      updated: new Date().toISOString(),
      connection: { ssh: state === 'connected' ? 'up' : 'down', state, host, lastError },
    };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* telemetry is best-effort */ }
}
