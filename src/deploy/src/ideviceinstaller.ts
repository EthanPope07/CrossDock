import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LineSplitter } from './events';
import { Logger } from './logger';

export class ToolMissingError extends Error {}
export class NoDeviceError extends Error {}

const EXE = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export const INSTALL_HELP =
  'ideviceinstaller.exe was not found. Install a Windows build of libimobiledevice (it ships ideviceinstaller.exe and idevice_id.exe) ' +
  'and either add its folder to PATH, put it in .crossdock/tools/, or pass --idevice-dir <folder> / set CROSSDOCK_IDEVICE_DIR.';

/** Looks for a libimobiledevice tool: explicit dir, env var, .crossdock/tools, then PATH. */
export function findTool(name: string, opts: { dir?: string; cwd?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {}): string | null {
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const env = opts.env ?? process.env;
  const file = EXE(name);
  const dirs = [
    opts.dir,
    env.CROSSDOCK_IDEVICE_DIR,
    path.join(opts.cwd ?? process.cwd(), '.crossdock', 'tools'),
    ...(env.PATH ?? env.Path ?? '').split(path.delimiter),
  ].filter((d): d is string => !!d);
  for (const d of dirs) {
    const candidate = path.join(d, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** `idevice_id -l` prints one UDID per line. */
export function parseDeviceList(output: string): string[] {
  return output.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[0-9A-Fa-f-]{20,}$/.test(l));
}

/** ideviceinstaller prints e.g. "Install: CreatingStagingDirectory (5%)" and "Install: Complete". */
export function parseInstallLine(line: string): { percent?: number; complete?: boolean; error?: string } {
  const out: { percent?: number; complete?: boolean; error?: string } = {};
  const pct = /\((\d{1,3})%\)/.exec(line);
  if (pct) out.percent = Math.min(100, Number(pct[1]));
  if (/Install:\s*Complete/i.test(line) || /^Install complete/i.test(line)) { out.complete = true; out.percent = 100; }
  if (/^ERROR:|\bFailed\b|\berror\b.*\(-?\d+\)/i.test(line) && !out.complete) out.error = line;
  return out;
}

function runCapture(file: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr })));
}

export async function listDevices(idevicId: string): Promise<string[]> {
  const r = await runCapture(idevicId, ['-l']);
  return parseDeviceList(r.stdout);
}

export interface InstallResult { ok: boolean; udid: string; lines: string[]; sawComplete: boolean }

/** Installs an .ipa on the USB-connected iPhone via `ideviceinstaller -i`. */
export async function installIpa(
  ipa: string,
  opts: { toolDir?: string; udid?: string; cwd?: string },
  log: Logger,
  onProgress: (percent: number, line: string) => void,
): Promise<InstallResult> {
  if (!fs.existsSync(ipa)) throw new Error(`ipa not found: ${ipa}`);
  const installer = findTool('ideviceinstaller', { dir: opts.toolDir, cwd: opts.cwd });
  if (!installer) throw new ToolMissingError(INSTALL_HELP);
  const idevicId = findTool('idevice_id', { dir: opts.toolDir ?? path.dirname(installer), cwd: opts.cwd });

  let udid = opts.udid;
  if (idevicId) {
    const devices = await listDevices(idevicId);
    log.info(`usb: ${devices.length} device(s) connected${devices.length ? `: ${devices.join(', ')}` : ''}`);
    if (!devices.length) throw new NoDeviceError('No iPhone found over USB. Plug it in, unlock it, tap "Trust This Computer", and make sure Apple Mobile Device Support (iTunes / Apple Devices) is installed.');
    if (udid && !devices.includes(udid)) throw new NoDeviceError(`Device ${udid} is not connected (connected: ${devices.join(', ')}).`);
    if (!udid && devices.length > 1) throw new NoDeviceError(`Several devices are connected (${devices.join(', ')}); choose one with --device <udid>.`);
    udid = udid ?? devices[0];
  } else {
    log.warn('idevice_id was not found next to ideviceinstaller; skipping the device pre-check');
  }

  const args = [...(udid ? ['-u', udid] : []), '-i', ipa];
  log.info(`usb: ${installer} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(installer, args, { windowsHide: true });
    const lines: string[] = [];
    let sawComplete = false;
    const handle = (line: string) => {
      if (!line.trim()) return;
      lines.push(line);
      log.info(`ideviceinstaller: ${line}`);
      const p = parseInstallLine(line);
      if (p.complete) sawComplete = true;
      if (p.percent !== undefined) onProgress(p.percent, line);
    };
    const out = new LineSplitter();
    const err = new LineSplitter();
    child.stdout.on('data', (d) => out.push(d).forEach(handle));
    child.stderr.on('data', (d) => err.push(d).forEach(handle));
    child.on('error', (e) => reject(new ToolMissingError(`Cannot start ${installer}: ${e.message}`)));
    child.on('close', (code) => {
      out.flush().forEach(handle);
      err.flush().forEach(handle);
      if (code === 0 && !sawComplete) log.warn('ideviceinstaller exited 0 but never printed "Install: Complete"; treating the exit code as authoritative');
      resolve({ ok: code === 0, udid: udid ?? '', lines, sawComplete });
    });
  });
}
