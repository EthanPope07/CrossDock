import * as fs from 'fs';
import * as os from 'os';
import { Client, SFTPWrapper, utils } from 'ssh2';
import { LineSplitter } from './events';
import { checkHostKey } from './knownHosts';
import { Logger } from './logger';

export interface SshSettings {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  agent?: string;
  pinnedHostKey?: string;
  knownHostsPath: string;
  keepaliveMs?: number;
  readyTimeoutMs?: number;
  /** Passphrase for an encrypted key. Read from CROSSDOCK_SSH_PASSPHRASE by the CLI; never stored. */
  passphrase?: string;
}

/** Problems retrying cannot fix. */
export class SshConfigError extends Error {}
export class SshAuthError extends Error {}
export class HostKeyError extends Error {}

const expandHome = (p: string) => (p.startsWith('~') ? os.homedir() + p.slice(1) : p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function credentials(s: SshSettings): { privateKey?: Buffer; passphrase?: string; agent?: string } {
  if (s.privateKeyPath) {
    const keyPath = expandHome(s.privateKeyPath);
    let buf: Buffer;
    try { buf = fs.readFileSync(keyPath); } catch (e) { throw new SshConfigError(`Cannot read private key "${keyPath}": ${(e as Error).message}`); }
    const parsed = utils.parseKey(buf, s.passphrase);
    if (parsed instanceof Error) {
      throw new SshConfigError(/passphrase/i.test(parsed.message)
        ? 'The private key is encrypted. Set the CROSSDOCK_SSH_PASSPHRASE environment variable (or use ssh-agent).'
        : `Cannot parse private key "${keyPath}": ${parsed.message}`);
    }
    return { privateKey: buf, passphrase: s.passphrase };
  }
  const agent = s.agent || process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
  if (!agent) throw new SshConfigError('No private key given and no ssh-agent found. Pass --key <path>.');
  return { agent };
}

function connectOnce(s: SshSettings, log: Logger): Promise<Client> {
  const cred = credentials(s);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let hostKeyError: HostKeyError | undefined;
    const fail = (e: Error) => {
      if (settled) { log.warn(`ssh: ${e.message}`); return; }
      settled = true;
      try { client.end(); } catch { /* ignore */ }
      reject(hostKeyError ?? e);
    };
    client.on('ready', () => { settled = true; resolve(client); });
    client.on('error', (e: Error & { level?: string }) =>
      fail(e.level === 'client-authentication' ? new SshAuthError(`Authentication failed for ${s.username}@${s.host}: ${e.message}`) : e));
    client.on('close', () => fail(new Error('connection closed during handshake')));
    client.connect({
      host: s.host, port: s.port, username: s.username,
      privateKey: cred.privateKey, passphrase: cred.passphrase, agent: cred.agent,
      keepaliveInterval: s.keepaliveMs ?? 10_000, keepaliveCountMax: 3, readyTimeout: s.readyTimeoutMs ?? 15_000,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const r = checkHostKey(s.knownHostsPath, s.host, s.port, key, s.pinnedHostKey);
        if (!r.ok) { hostKeyError = new HostKeyError(r.reason ?? 'host key rejected'); log.error(hostKeyError.message); }
        else if (r.firstUse) log.warn(`ssh: first connection to ${s.host}:${s.port}; trusting and saving host key ${r.fingerprint}`);
        verify(r.ok);
      },
    } as Parameters<Client['connect']>[0]);
  });
}

/** Connects with exponential backoff on network errors; config/auth/host-key errors fail immediately. */
export async function connectWithRetry(s: SshSettings, log: Logger, maxAttempts = 6): Promise<Client> {
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      const c = await connectOnce(s, log);
      log.info(`ssh: connected to ${s.username}@${s.host}:${s.port}`);
      return c;
    } catch (e) {
      const err = e as Error;
      if (err instanceof HostKeyError || err instanceof SshAuthError || err instanceof SshConfigError || attempt >= maxAttempts) throw err;
      log.warn(`ssh: attempt ${attempt}/${maxAttempts} failed: ${err.message}; retrying in ${delay} ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 8_000);
    }
  }
}

export interface ExecResult { code: number | null; signal?: string }

/** Runs a remote command, streaming stdout/stderr lines to the callbacks. */
export function exec(client: Client, command: string, onStdout: (line: string) => void, onStderr: (line: string) => void): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, channel) => {
      if (err) return reject(err);
      const out = new LineSplitter();
      const errS = new LineSplitter();
      channel.on('data', (d: Buffer) => out.push(d).forEach(onStdout));
      channel.stderr.on('data', (d: Buffer) => errS.push(d).forEach(onStderr));
      channel.on('close', (code: number | null, signal?: string) => {
        out.flush().forEach(onStdout);
        errS.flush().forEach(onStderr);
        resolve({ code, signal });
      });
      channel.on('error', reject);
    });
  });
}

export const openSftp = (client: Client): Promise<SFTPWrapper> =>
  new Promise((resolve, reject) => client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));

export const uploadFile = (sftp: SFTPWrapper, local: string, remote: string): Promise<void> =>
  new Promise((resolve, reject) => sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve())));

export const downloadFile = (sftp: SFTPWrapper, remote: string, local: string, onProgress: (done: number, total: number) => void): Promise<void> =>
  new Promise((resolve, reject) =>
    sftp.fastGet(remote, local, { concurrency: 16, chunkSize: 64 * 1024, step: (done: number, _chunk: number, total: number) => onProgress(done, total) },
      (err) => (err ? reject(err) : resolve())));
