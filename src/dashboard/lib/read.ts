import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mergeTelemetry, type Merged } from './merge';

const MAX_BYTES = 1024 * 1024;

/** Where the modules write telemetry: $CROSSDOCK_TELEMETRY_DIR, else <repo>/.crossdock (dashboard runs from src/dashboard). */
export function telemetryDir(): string {
  return process.env.CROSSDOCK_TELEMETRY_DIR
    ? path.resolve(process.env.CROSSDOCK_TELEMETRY_DIR)
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), '..', '..', '.crossdock');
}

// Fixed file names only: nothing from the request ever reaches a path.
const FILES = {
  sync: 'crossdock-telemetry.sync.json',
  lsp: 'crossdock-telemetry.lsp.json',
  deploy: 'crossdock-telemetry.deploy.json',
} as const;

async function readJson(file: string): Promise<unknown> {
  try {
    const st = await fs.stat(file);
    if (st.size > MAX_BYTES) return undefined;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined; // missing, mid-write or malformed: treated as "no report"
  }
}

export async function readTelemetry(dir = telemetryDir()): Promise<Merged> {
  // The directory is deliberately runtime-configured and outside the app, so tell Turbopack not to trace it.
  const [sync, lsp, deploy] = await Promise.all([
    readJson(path.join(/*turbopackIgnore: true*/ dir, FILES.sync)),
    readJson(path.join(/*turbopackIgnore: true*/ dir, FILES.lsp)),
    readJson(path.join(/*turbopackIgnore: true*/ dir, FILES.deploy)),
  ]);
  return mergeTelemetry({ sync, lsp, deploy, now: Date.now() });
}
