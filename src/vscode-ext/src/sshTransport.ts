import * as fs from 'fs';
import * as os from 'os';
import { Client, ClientChannel, utils } from 'ssh2';
import { checkHostKey } from './knownHosts';
import { Logger } from './logger';

export interface SshSettings {
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  /** ssh-agent socket / Windows named pipe. Used when no private key is configured. */
  agent?: string;
  pinnedHostKey?: string;
  knownHostsPath: string;
  keepaliveMs?: number;
  readyTimeoutMs?: number;
  askPassphrase?: () => Promise<string | undefined>;
}

/** Problems that retrying cannot fix; the user has to act. */
export class SshConfigError extends Error {}
export class SshAuthError extends Error {}
export class HostKeyError extends Error {}

export interface SshHandle { client: Client; channel: ClientChannel; close(): void }
interface Credentials { privateKey?: Buffer; passphrase?: string; agent?: string }

const expandHome = (p: string) => (p.startsWith('~') ? os.homedir() + p.slice(1) : p);

export async function resolveCredentials(s: SshSettings): Promise<Credentials> {
  if (s.privateKeyPath) {
    const keyPath = expandHome(s.privateKeyPath);
    let buf: Buffer;
    try { buf = await fs.promises.readFile(keyPath); }
    catch (e) { throw new SshConfigError(`Cannot read private key "${keyPath}": ${(e as Error).message}`); }
    let parsed = utils.parseKey(buf);
    if (parsed instanceof Error && /passphrase/i.test(parsed.message)) {
      const pp = await s.askPassphrase?.();
      if (!pp) throw new SshConfigError('This private key is encrypted and no passphrase was provided.');
      parsed = utils.parseKey(buf, pp);
      if (parsed instanceof Error) throw new SshConfigError(`Cannot decrypt private key: ${parsed.message}`);
      return { privateKey: buf, passphrase: pp };
    }
    if (parsed instanceof Error) throw new SshConfigError(`Cannot parse private key "${keyPath}": ${parsed.message}`);
    return { privateKey: buf };
  }
  const agent = s.agent || process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
  if (!agent) throw new SshConfigError('No private key is configured and no ssh-agent was found. Set "crossdock.ssh.privateKeyPath".');
  return { agent };
}

function connectOnce(s: SshSettings, cred: Credentials, command: string, log: Logger): Promise<SshHandle> {
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
    client.on('ready', () => {
      log.info(`ssh: connected to ${s.host}:${s.port} as ${s.username}; starting "${command}"`);
      client.exec(command, (err, channel) => {
        if (err) return fail(err);
        settled = true;
        resolve({ client, channel, close: () => client.end() });
      });
    });
    client.on('error', (e: Error & { level?: string }) => {
      fail(e.level === 'client-authentication' ? new SshAuthError(`Authentication failed for ${s.username}@${s.host}: ${e.message}`) : e);
    });
    client.on('close', () => fail(new Error('connection closed before the language server started')));
    client.connect({
      host: s.host,
      port: s.port,
      username: s.username,
      privateKey: cred.privateKey,
      passphrase: cred.passphrase,
      agent: cred.agent,
      keepaliveInterval: s.keepaliveMs ?? 10_000,
      keepaliveCountMax: 3,
      readyTimeout: s.readyTimeoutMs ?? 15_000,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        const r = checkHostKey(s.knownHostsPath, s.host, s.port, key, s.pinnedHostKey);
        if (!r.ok) { hostKeyError = new HostKeyError(r.reason ?? 'host key rejected'); log.error(hostKeyError.message); }
        else if (r.firstUse) log.warn(`ssh: first connection to ${s.host}:${s.port}; trusting and saving host key ${r.fingerprint}`);
        verify(r.ok);
      },
    } as Parameters<Client['connect']>[0]);
  });
}

export interface RetryControl {
  shouldStop(): boolean;
  onRetry?(attempt: number, error: Error, delayMs: number): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Connects and runs `command`, retrying network failures with exponential backoff (0.5 s .. 10 s).
 * Configuration, authentication and host-key problems are thrown immediately.
 */
export async function connectWithRetry(s: SshSettings, command: string, log: Logger, ctl: RetryControl): Promise<SshHandle> {
  const cred = await resolveCredentials(s);
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    if (ctl.shouldStop()) throw new Error('connection attempt cancelled');
    try {
      return await connectOnce(s, cred, command, log);
    } catch (e) {
      const err = e as Error;
      if (err instanceof HostKeyError || err instanceof SshAuthError || err instanceof SshConfigError) throw err;
      log.warn(`ssh: attempt ${attempt} failed: ${err.message}; retrying in ${delay} ms`);
      ctl.onRetry?.(attempt, err, delay);
      await sleep(delay);
      delay = Math.min(delay * 2, 10_000);
    }
  }
}
