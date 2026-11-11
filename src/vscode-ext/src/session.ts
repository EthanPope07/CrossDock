import { PassThrough, Writable } from 'stream';
import { FrameDecoder, encodeFrame } from './jsonrpc';
import { Logger } from './logger';
import { PathMapper } from './pathMap';

/** The slice of an ssh2 ClientChannel the bridge needs. */
export interface RemoteChannel {
  on(event: 'data', cb: (b: Buffer) => void): unknown;
  on(event: 'close' | 'end', cb: () => void): unknown;
  write(b: Buffer | string): boolean;
  end(): void;
  stderr?: { on(event: 'data', cb: (b: Buffer) => void): unknown };
}

export interface Session {
  /** Feed this to vscode-languageclient as the server's stdout. */
  reader: PassThrough;
  /** Feed this to vscode-languageclient as the server's stdin. */
  writer: Writable;
  startedAt: number;
  stderrTail(): string;
  close(): void;
}

const LANGUAGE_BY_EXT: Record<string, string> = { swift: 'swift', m: 'objective-c', mm: 'objective-cpp' };

type Json = Record<string, any>;

/** Client -> Mac: make the message valid on the Mac side. */
export function rewriteOutgoing(msg: Json, mapper: PathMapper): Json {
  const m: Json = structuredClone(msg);
  // The Mac cannot see our PID; servers that watch it would exit immediately.
  if (m.method === 'initialize' && m.params) m.params.processId = null;
  // VS Code reports unknown file types as plaintext; sourcekit-lsp needs the real language id.
  if (m.method === 'textDocument/didOpen' && m.params?.textDocument) {
    const td = m.params.textDocument;
    const ext = typeof td.uri === 'string' ? /\.([A-Za-z]+)$/.exec(td.uri)?.[1]?.toLowerCase() : undefined;
    if (ext && LANGUAGE_BY_EXT[ext]) td.languageId = LANGUAGE_BY_EXT[ext];
  }
  return mapper.toRemote(m);
}

/** Mac -> client: translate Mac paths back into the Windows workspace. */
export function rewriteIncoming(msg: Json, mapper: PathMapper): Json {
  return mapper.toLocal(msg);
}

export function createSession(channel: RemoteChannel, mapper: PathMapper, log: Logger): Session {
  const reader = new PassThrough();
  const fromClient = new FrameDecoder();
  const fromServer = new FrameDecoder();
  let stderr = '';
  let closed = false;

  const forward = (body: Buffer, rewrite: (m: Json) => Json, send: (b: Buffer) => void, dir: string) => {
    let out: Buffer;
    try {
      const msg = JSON.parse(body.toString('utf8')) as Json;
      if (log) log.debug(`${dir} ${msg.method ?? (msg.error ? 'error-response' : 'response')}${msg.id !== undefined ? ` #${msg.id}` : ''}`);
      out = encodeFrame(JSON.stringify(rewrite(msg)));
    } catch (e) {
      log.warn(`${dir}: could not parse/rewrite a message (${(e as Error).message}); forwarding unchanged`);
      out = encodeFrame(body);
    }
    send(out);
  };

  const writer = new Writable({
    write(chunk: Buffer, _enc, cb) {
      try {
        for (const body of fromClient.push(chunk)) {
          forward(body, (m) => rewriteOutgoing(m, mapper), (b) => { if (!closed) channel.write(b); }, '->mac');
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    final(cb) { channel.end(); cb(); },
  });

  channel.on('data', (chunk: Buffer) => {
    try {
      for (const body of fromServer.push(chunk)) {
        forward(body, (m) => rewriteIncoming(m, mapper), (b) => reader.write(b), '<-mac');
      }
    } catch (e) {
      log.error(`protocol error from the Mac: ${(e as Error).message}`);
      reader.end();
    }
  });
  channel.stderr?.on('data', (b: Buffer) => {
    const s = b.toString('utf8');
    stderr = (stderr + s).slice(-4000);
    log.warn(`sourcekit-lsp stderr: ${s.trimEnd()}`);
  });
  const onEnd = () => { if (!closed) { closed = true; reader.end(); } };
  channel.on('close', onEnd);
  channel.on('end', onEnd);

  return {
    reader,
    writer,
    startedAt: Date.now(),
    stderrTail: () => stderr,
    close: () => { closed = true; try { channel.end(); } catch { /* ignore */ } reader.end(); },
  };
}
