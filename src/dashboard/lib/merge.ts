// Pure merge of the telemetry fragments written by the CrossDock modules:
//   win-sender  -> crossdock-telemetry.sync.json    (TCP link + last syncs, refreshed every 5 s heartbeat)
//   vscode-ext  -> crossdock-telemetry.lsp.json     (SSH link to the Mac, refreshed every 5 s while VS Code runs)
//   deploy      -> crossdock-telemetry.deploy.json  (build / fetch / install progress, per run)
// No file-system access here so it can be unit-tested; see read.ts for the I/O.

export type Link = 'up' | 'down' | 'unknown';
export type DeployState = 'idle' | 'connecting' | 'building' | 'fetching' | 'installing' | 'done' | 'failed';

export interface SyncEvent { path: string; latencyMs: number; bytes: number; at: string }
export interface Source { present: boolean; updated: string | null; ageSec: number | null }
export interface LinkStatus { state: Link; detail: string; host?: string; ageSec: number | null; extra?: string }
export interface DeploymentStatus {
  state: DeployState; progress: number; stage: string; message: string; ipa?: string; error?: string;
  active: boolean; ageSec: number | null; stalled: boolean;
}
export interface Merged {
  generatedAt: string;
  tcp: LinkStatus;
  ssh: LinkStatus;
  syncs: SyncEvent[];
  syncStats: { count: number; medianMs: number; maxMs: number } | null;
  deployment: DeploymentStatus | null;
  sources: { sync: Source; lsp: Source; deploy: Source };
}
export interface RawInputs { sync?: unknown; lsp?: unknown; deploy?: unknown; now: number }

/** win-sender pings every 5 s and refreshes its file; 4 missed beats = considered stopped. */
export const HEARTBEAT_STALE_SEC = 20;
/** A running deployment that has not reported for this long is flagged as stalled (not failed). */
export const DEPLOY_STALLED_SEC = 120;
const ACTIVE: DeployState[] = ['connecting', 'building', 'fetching', 'installing'];
const DEPLOY_STATES: DeployState[] = ['idle', 'connecting', 'building', 'fetching', 'installing', 'done', 'failed'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function source(raw: unknown, now: number): Source {
  if (!isObj(raw)) return { present: false, updated: null, ageSec: null };
  const updated = typeof raw.updated === 'string' ? raw.updated : null;
  const t = updated ? Date.parse(updated) : NaN;
  return { present: true, updated, ageSec: Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null };
}

function cleanSyncs(raw: unknown): SyncEvent[] {
  if (!isObj(raw) || !Array.isArray(raw.syncs)) return [];
  const out: SyncEvent[] = [];
  for (const s of raw.syncs) {
    if (!isObj(s) || typeof s.path !== 'string') continue;
    out.push({ path: s.path, latencyMs: Math.max(0, num(s.latencyMs)), bytes: Math.max(0, num(s.bytes)), at: str(s.at) });
    if (out.length === 10) break;
  }
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mergeTelemetry({ sync, lsp, deploy, now }: RawInputs): Merged {
  const sources = { sync: source(sync, now), lsp: source(lsp, now), deploy: source(deploy, now) };

  // ---- TCP (win-sender): alive only while its heartbeat keeps the file fresh.
  let tcp: LinkStatus;
  const syncConn = isObj(sync) && isObj(sync.connection) ? sync.connection : {};
  const host = isObj(sync) && isObj(syncConn) ? `${str(syncConn.host)}${syncConn.port ? `:${num(syncConn.port)}` : ''}` : '';
  if (!sources.sync.present) {
    tcp = { state: 'unknown', detail: 'win-sender has not reported yet', ageSec: null };
  } else if (sources.sync.ageSec === null || sources.sync.ageSec > HEARTBEAT_STALE_SEC) {
    tcp = { state: 'down', detail: `no heartbeat for ${sources.sync.ageSec ?? '?'} s: win-sender is probably not running`, host, ageSec: sources.sync.ageSec };
  } else if (syncConn.tcp === 'up') {
    tcp = { state: 'up', detail: 'connected to the Mac receiver', host, ageSec: sources.sync.ageSec, extra: num(syncConn.connects) > 1 ? `${num(syncConn.connects)} connects (reconnected)` : undefined };
  } else {
    tcp = { state: 'down', detail: str(syncConn.lastError) || 'disconnected, retrying', host, ageSec: sources.sync.ageSec };
  }

  // ---- SSH: the editor's LSP tunnel, or the deploy run's session while one is active.
  const lspConn = isObj(lsp) && isObj(lsp.connection) ? lsp.connection : {};
  const depConn = isObj(deploy) && isObj(deploy.connection) ? deploy.connection : {};
  const dep = isObj(deploy) && isObj(deploy.deployment) ? deploy.deployment : null;
  const depState = dep && DEPLOY_STATES.includes(dep.state as DeployState) ? (dep.state as DeployState) : null;
  const deployActive = !!depState && ACTIVE.includes(depState) && sources.deploy.ageSec !== null && sources.deploy.ageSec <= DEPLOY_STALLED_SEC;
  const lspFresh = sources.lsp.present && sources.lsp.ageSec !== null && sources.lsp.ageSec <= HEARTBEAT_STALE_SEC;
  let ssh: LinkStatus;
  if (deployActive && depConn.ssh === 'up') {
    ssh = { state: 'up', detail: 'deploy session to the Mac is open', host: str(depConn.host), ageSec: sources.deploy.ageSec };
  } else if (lspFresh && lspConn.ssh === 'up') {
    ssh = { state: 'up', detail: 'editor language-server tunnel is open', host: str(lspConn.host), ageSec: sources.lsp.ageSec };
  } else if (lspFresh && lspConn.state === 'unconfigured') {
    ssh = { state: 'unknown', detail: 'CrossDock extension is not configured', ageSec: sources.lsp.ageSec };
  } else if (lspFresh) {
    ssh = { state: 'down', detail: str(lspConn.lastError) || `editor tunnel is ${str(lspConn.state, 'down')}`, host: str(lspConn.host), ageSec: sources.lsp.ageSec };
  } else if (sources.lsp.present) {
    ssh = { state: 'unknown', detail: 'VS Code extension is not running (no heartbeat)', host: str(lspConn.host), ageSec: sources.lsp.ageSec };
  } else {
    ssh = { state: 'unknown', detail: 'no editor or deploy session reported yet', ageSec: null };
  }

  // ---- Deployment.
  let deployment: DeploymentStatus | null = null;
  if (dep && depState) {
    const ageSec = sources.deploy.ageSec;
    deployment = {
      state: depState,
      progress: Math.max(0, Math.min(100, Math.round(num(dep.progress)))),
      stage: str(dep.stage), message: str(dep.message),
      ipa: typeof dep.ipa === 'string' ? dep.ipa : undefined,
      error: typeof dep.error === 'string' ? dep.error : undefined,
      active: ACTIVE.includes(depState),
      ageSec,
      stalled: ACTIVE.includes(depState) && (ageSec === null || ageSec > DEPLOY_STALLED_SEC),
    };
  }

  const syncs = cleanSyncs(sync);
  const lat = syncs.map((s) => s.latencyMs);
  return {
    generatedAt: new Date(now).toISOString(),
    tcp, ssh, syncs,
    syncStats: lat.length ? { count: lat.length, medianMs: median(lat), maxMs: Math.max(...lat) } : null,
    deployment, sources,
  };
}
