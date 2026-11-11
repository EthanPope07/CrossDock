import * as fs from 'fs';
import * as path from 'path';

export type DeployState = 'idle' | 'connecting' | 'building' | 'fetching' | 'installing' | 'done' | 'failed';

export interface DeployTelemetry {
  state: DeployState;
  /** Overall progress 0..100 across build, fetch and install. */
  progress: number;
  stage: string;
  message: string;
  ipa?: string;
  error?: string;
}

/** Overall-progress windows: build 0-60, fetch 60-80, install 80-100. */
export const WINDOWS = { build: [0, 60], fetch: [60, 80], install: [80, 100] } as const;
export const scale = (w: readonly [number, number], pct: number): number =>
  Math.round(w[0] + ((w[1] - w[0]) * Math.max(0, Math.min(100, pct))) / 100);

/** Atomically writes this module's telemetry fragment (the dashboard merges fragments). Never throws. */
export function writeDeployTelemetry(file: string, ssh: 'up' | 'down', host: string, t: DeployTelemetry): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { module: 'deploy', updated: new Date().toISOString(), connection: { ssh, host }, deployment: t };
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* telemetry is best-effort */ }
}
