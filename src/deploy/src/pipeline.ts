import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'ssh2';
import { MacEvent, parseMacEvent } from './events';
import { installIpa } from './ideviceinstaller';
import { Logger } from './logger';
import { BuildOptions, remoteBuildCommand } from './shell';
import { connectWithRetry, downloadFile, exec, openSftp, SshSettings, uploadFile } from './ssh';
import { DeployState, scale, WINDOWS, writeDeployTelemetry } from './telemetry';

export interface PipelineOptions {
  ssh: SshSettings;
  remoteRoot: string;
  build: BuildOptions;
  remoteShell: string;
  remoteNode: string;
  /** Local folder for fetched .ipa files (default .crossdock/build). */
  outDir: string;
  install: boolean;
  udid?: string;
  toolDir?: string;
  telemetryFile: string;
  cwd: string;
}

export interface PipelineResult { localIpa: string; sha256: string; bundleId: string; installed: boolean; installLog: string[] }

const REMOTE_SCRIPT = '.crossdock/bin/build-ipa.js'; // relative to the Mac user's home
const FETCH_ATTEMPTS = 3;

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

type Resolved = Extract<MacEvent, { type: 'result' }>;

export async function runPipeline(o: PipelineOptions, log: Logger): Promise<PipelineResult> {
  let ssh: 'up' | 'down' = 'down';
  let progress = 0;
  const tele = (state: DeployState, stage: string, message: string, pct?: number, extra: { ipa?: string; error?: string } = {}) => {
    if (pct !== undefined) progress = Math.max(progress, pct);
    writeDeployTelemetry(o.telemetryFile, ssh, o.ssh.host, { state, progress, stage, message, ...extra });
  };

  let client: Client | undefined;
  const reconnect = async () => {
    try { client?.end(); } catch { /* ignore */ }
    ssh = 'down';
    client = await connectWithRetry(o.ssh, log);
    ssh = 'up';
    client.on('close', () => { ssh = 'down'; });
    return client;
  };

  try {
    tele('connecting', 'connect', `connecting to ${o.ssh.host}`, 0);
    await reconnect();

    // 1. Push the build script (always the current version; nothing to install on the Mac by hand).
    const local = path.resolve(__dirname, '..', '..', 'mac', 'build-ipa.js');
    await exec(client!, 'mkdir -p "$HOME/.crossdock/bin"', () => undefined, (l) => log.debug(`mac: ${l}`));
    await uploadFile(await openSftp(client!), local, REMOTE_SCRIPT);
    log.info(`uploaded build script to ~/${REMOTE_SCRIPT}`);

    // 2. Build on the Mac, streaming NDJSON events.
    tele('building', 'build', `building ${o.build.scheme} on the Mac`, 0);
    let result: Resolved | undefined;
    let failure: Extract<MacEvent, { type: 'error' }> | undefined;
    const cmd = remoteBuildCommand({ shell: o.remoteShell, node: o.remoteNode, remoteRoot: o.remoteRoot, scriptPath: REMOTE_SCRIPT, build: o.build });
    log.debug(`remote command: ${cmd}`);
    const run = await exec(
      client!,
      cmd,
      (line) => {
        const ev = parseMacEvent(line);
        if (!ev) { log.debug(`mac: ${line}`); return; }
        if (ev.type === 'progress') tele('building', 'build', ev.step ?? 'compiling', scale(WINDOWS.build, ev.percent));
        else if (ev.type === 'stage') { log.info(`mac: [${ev.stage}] ${ev.message}`); tele('building', ev.stage, ev.message); }
        else if (ev.type === 'log') log.info(`mac: ${ev.line}`);
        else if (ev.type === 'result') result = ev;
        else if (ev.type === 'error') failure = ev;
      },
      (line) => log.warn(`mac stderr: ${line}`),
    );
    if (!result) {
      const detail = failure ? `${failure.message}\n${failure.errors.slice(0, 15).join('\n')}` : `build script exited with code ${run.code} without a result`;
      throw new Error(`Remote build failed: ${detail}`);
    }
    const built: Resolved = result;
    log.info(`built ${built.appName} (${built.bundleId || 'unknown bundle id'}): ${built.bytes} bytes, sha256 ${built.sha256}`);
    tele('building', 'build', 'build complete', WINDOWS.build[1]);

    // 3. Fetch the .ipa over SFTP, verify size + checksum, retrying (with reconnect) on failure.
    fs.mkdirSync(o.outDir, { recursive: true });
    const finalPath = path.join(o.outDir, path.basename(built.ipa));
    const partial = `${finalPath}.partial`;
    for (let attempt = 1; ; attempt++) {
      try {
        tele('fetching', 'fetch', `downloading ${path.basename(built.ipa)}`, WINDOWS.fetch[0]);
        const sftp = await openSftp(client!);
        let last = 0;
        await downloadFile(sftp, built.ipa, partial, (done, total) => {
          const pct = total ? (done / total) * 100 : 0;
          if (pct - last >= 2) { last = pct; tele('fetching', 'fetch', `${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB`, scale(WINDOWS.fetch, pct)); }
        });
        const size = fs.statSync(partial).size;
        const sum = await sha256File(partial);
        if (size !== built.bytes || sum !== built.sha256) throw new Error(`downloaded file failed verification (size ${size}/${built.bytes}, sha256 ${sum.slice(0, 12)}…)`);
        fs.rmSync(finalPath, { force: true });
        fs.renameSync(partial, finalPath);
        break;
      } catch (e) {
        fs.rmSync(partial, { force: true });
        if (attempt >= FETCH_ATTEMPTS) throw new Error(`Could not fetch the .ipa after ${FETCH_ATTEMPTS} attempts: ${(e as Error).message}`);
        log.warn(`fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed: ${(e as Error).message}; reconnecting`);
        await reconnect();
      }
    }
    log.info(`fetched and verified ${finalPath}`);
    tele('fetching', 'fetch', 'download verified', WINDOWS.fetch[1], { ipa: finalPath });

    // 4. Flash it to the USB-connected iPhone.
    if (!o.install) {
      tele('done', 'done', `built and fetched ${finalPath} (install skipped)`, 100, { ipa: finalPath });
      return { localIpa: finalPath, sha256: built.sha256, bundleId: built.bundleId, installed: false, installLog: [] };
    }
    const inst = await installOnly(finalPath, o, log, tele);
    return { localIpa: finalPath, sha256: built.sha256, bundleId: built.bundleId, installed: true, installLog: inst };
  } catch (e) {
    tele('failed', 'failed', (e as Error).message, undefined, { error: (e as Error).message });
    throw e;
  } finally {
    try { client?.end(); } catch { /* ignore */ }
    ssh = 'down';
  }
}

type Tele = (state: DeployState, stage: string, message: string, pct?: number, extra?: { ipa?: string; error?: string }) => void;

async function installOnly(ipa: string, o: PipelineOptions, log: Logger, tele: Tele): Promise<string[]> {
  tele('installing', 'install', 'installing on the iPhone over USB', WINDOWS.install[0], { ipa });
  const r = await installIpa(ipa, { toolDir: o.toolDir, udid: o.udid, cwd: o.cwd }, log, (pct, line) =>
    tele('installing', 'install', line, scale(WINDOWS.install, pct), { ipa }));
  if (!r.ok) throw new Error(`ideviceinstaller did not report success. Last output:\n${r.lines.slice(-8).join('\n')}`);
  log.info(`installed on device ${r.udid || '(default)'}`);
  tele('done', 'done', `installed ${path.basename(ipa)} on ${r.udid || 'the iPhone'}`, 100, { ipa });
  return r.lines;
}

/** Install an existing .ipa (no SSH, no build). Used by `--ipa`. */
export async function installExisting(ipa: string, o: PipelineOptions, log: Logger): Promise<string[]> {
  const tele: Tele = (state, stage, message, pct, extra = {}) =>
    writeDeployTelemetry(o.telemetryFile, 'down', o.ssh.host, { state, progress: pct ?? 0, stage, message, ...extra });
  try {
    return await installOnly(ipa, o, log, tele);
  } catch (e) {
    tele('failed', 'failed', (e as Error).message, undefined, { error: (e as Error).message });
    throw e;
  }
}
