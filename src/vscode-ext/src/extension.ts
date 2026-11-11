import * as path from 'path';
import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  StreamInfo,
} from 'vscode-languageclient/node';
import { crossdockHome, Logger } from './logger';
import { PathMapper } from './pathMap';
import { createSession, Session } from './session';
import { connectWithRetry, SshSettings } from './sshTransport';
import { SshState, writeLspTelemetry } from './telemetry';

const FAST_FAIL_MS = 5_000;
const MAX_FAST_FAILS = 3;

let client: LanguageClient | undefined;
let statusItem: vscode.StatusBarItem;
let log: Logger;
let output: vscode.LogOutputChannel;
let generation = 0;
let state: SshState = 'unconfigured';
let lastError = '';
let currentHost = '';
let telemetryFile = '';

function setState(s: SshState, detail = ''): void {
  state = s;
  lastError = s === 'connected' ? '' : detail || lastError;
  const label: Record<SshState, string> = {
    unconfigured: '$(gear) CrossDock: not configured',
    connecting: '$(sync~spin) CrossDock: connecting',
    reconnecting: '$(sync~spin) CrossDock: reconnecting',
    connected: '$(check) CrossDock: connected',
    error: '$(error) CrossDock: error',
  };
  statusItem.text = label[s];
  statusItem.tooltip = detail ? `${s}: ${detail}` : `Mac build server: ${currentHost || '(unset)'}  ·  click for actions`;
  if (telemetryFile) writeLspTelemetry(telemetryFile, s, currentHost, lastError);
}

interface Resolved { ssh: SshSettings; remoteRoot: string; localRoot: string; command: string }

function readSettings(): Resolved | string {
  const cfg = vscode.workspace.getConfiguration('crossdock');
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return 'Open a folder first: CrossDock maps the workspace to the Mac mirror.';
  const host = cfg.get<string>('ssh.host', '').trim();
  const username = cfg.get<string>('ssh.username', '').trim();
  const remoteRoot = cfg.get<string>('remoteRoot', '').trim();
  const missing = [!host && 'crossdock.ssh.host', !username && 'crossdock.ssh.username', !remoteRoot && 'crossdock.remoteRoot'].filter(Boolean);
  if (missing.length) return `Missing settings: ${missing.join(', ')}`;
  currentHost = host;
  const custom = cfg.get<string>('telemetryFile', '').trim();
  telemetryFile = custom || path.join(folder.uri.fsPath, '.crossdock', 'crossdock-telemetry.lsp.json');
  return {
    localRoot: folder.uri.fsPath,
    remoteRoot,
    command: cfg.get<string>('lsp.command', 'xcrun sourcekit-lsp').trim(),
    ssh: {
      host,
      username,
      port: cfg.get<number>('ssh.port', 22),
      privateKeyPath: cfg.get<string>('ssh.privateKeyPath', '').trim() || undefined,
      pinnedHostKey: cfg.get<string>('ssh.hostKeyFingerprint', '').trim() || undefined,
      keepaliveMs: cfg.get<number>('ssh.keepaliveSeconds', 10) * 1000,
      knownHostsPath: path.join(crossdockHome(), 'known_hosts.json'),
      askPassphrase: () =>
        Promise.resolve(vscode.window.showInputBox({ prompt: 'Passphrase for your SSH private key (kept in memory only)', password: true, ignoreFocusOut: true })),
    },
  };
}

async function startClient(): Promise<void> {
  const myGen = ++generation;
  const settings = readSettings();
  if (typeof settings === 'string') {
    setState('unconfigured', settings);
    statusItem.tooltip = settings;
    const choice = await vscode.window.showWarningMessage(`CrossDock: ${settings}`, 'Open Settings');
    if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'crossdock');
    return;
  }
  let mapper: PathMapper;
  try { mapper = new PathMapper(settings.localRoot, settings.remoteRoot); }
  catch (e) { setState('error', (e as Error).message); void vscode.window.showErrorMessage(`CrossDock: ${(e as Error).message}`); return; }

  let session: Session | undefined;
  let fastFails = 0;
  let everConnected = false;
  setState('connecting');

  const serverOptions: ServerOptions = async (): Promise<StreamInfo> => {
    setState(everConnected ? 'reconnecting' : 'connecting');
    const handle = await connectWithRetry(settings.ssh, settings.command, log, {
      shouldStop: () => myGen !== generation,
      onRetry: (n, err) => setState(everConnected ? 'reconnecting' : 'connecting', `attempt ${n}: ${err.message}`),
    });
    session = createSession(handle.channel, mapper, log);
    handle.channel.on('close', () => {
      log.warn('ssh: language-server channel closed');
      handle.close();
    });
    everConnected = true;
    setState('connected');
    return { reader: session.reader, writer: session.writer };
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'swift' },
      { scheme: 'file', language: 'objective-c' },
      { scheme: 'file', pattern: '**/*.{swift,m,mm}' },
    ],
    outputChannel: output,
    errorHandler: {
      error: () => ({ action: ErrorAction.Continue }),
      closed: () => {
        const lived = session ? Date.now() - session.startedAt : 0;
        fastFails = lived < FAST_FAIL_MS ? fastFails + 1 : 0;
        if (myGen !== generation) return { action: CloseAction.DoNotRestart, handled: true };
        if (fastFails >= MAX_FAST_FAILS) {
          const tail = session?.stderrTail().trim() || 'no output';
          const msg = `"${settings.command}" keeps exiting immediately on the Mac (${tail}). Check crossdock.lsp.command and that Xcode command line tools are installed.`;
          setState('error', msg);
          void vscode.window.showErrorMessage(`CrossDock: ${msg}`);
          return { action: CloseAction.DoNotRestart, handled: true };
        }
        setState('reconnecting', 'connection to the Mac was lost');
        return { action: CloseAction.Restart, handled: true };
      },
    },
  };

  const next = new LanguageClient('crossdock', 'CrossDock (sourcekit-lsp on Mac)', serverOptions, clientOptions);
  client = next;
  try {
    await next.start();
  } catch (e) {
    if (myGen !== generation) return;
    const msg = (e as Error).message;
    log.error(`start failed: ${msg}`);
    setState('error', msg);
    void vscode.window.showErrorMessage(`CrossDock: ${msg}`, 'Show Log').then((c) => c && output.show());
  }
}

async function stopClient(): Promise<void> {
  generation++;
  const c = client;
  client = undefined;
  try { await c?.stop(2000); } catch { /* already stopped */ }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log = new Logger();
  output = vscode.window.createOutputChannel('CrossDock', { log: true });
  log.addSink((line) => output.appendLine(line));
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusItem.command = 'crossdock.showActions';
  statusItem.show();
  log.info(`CrossDock extension activated (VS Code ${vscode.version})`);

  const restart = async () => { await stopClient(); await startClient(); };
  context.subscriptions.push(
    statusItem,
    output,
    { dispose: () => log.dispose() },
    vscode.commands.registerCommand('crossdock.reconnect', restart),
    vscode.commands.registerCommand('crossdock.showLogs', () => output.show()),
    vscode.commands.registerCommand('crossdock.showActions', async () => {
      const pick = await vscode.window.showQuickPick(['Reconnect to Mac', 'Show log', 'Open settings'], { placeHolder: `CrossDock: ${state}${lastError ? ` (${lastError})` : ''}` });
      if (pick === 'Reconnect to Mac') await restart();
      else if (pick === 'Show log') output.show();
      else if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'crossdock');
    }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('crossdock')) { log.info('settings changed; reconnecting'); void restart(); } }),
  );
  await startClient();
}

export async function deactivate(): Promise<void> {
  await stopClient();
}
