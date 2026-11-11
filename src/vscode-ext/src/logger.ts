import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const crossdockHome = (): string => process.env.CROSSDOCK_HOME || path.join(os.homedir(), '.crossdock');

type Sink = (line: string) => void;

/** Verbose file logger (~/.crossdock/logs/vscode-ext.log) with optional extra sinks (e.g. a VS Code OutputChannel). */
export class Logger {
  private stream?: fs.WriteStream;
  private sinks: Sink[] = [];

  constructor(fileName = 'vscode-ext.log') {
    const dir = process.env.CROSSDOCK_LOG_DIR || path.join(crossdockHome(), 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(dir, fileName), { flags: 'a' });
      this.stream.on('error', () => { this.stream = undefined; });
    } catch { /* logging must never break the extension */ }
  }

  addSink(s: Sink): void { this.sinks.push(s); }

  private write(level: string, msg: string): void {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    const line = `${ts} [${level}] ${msg}`;
    this.stream?.write(line + '\n');
    for (const s of this.sinks) { try { s(line); } catch { /* ignore */ } }
  }

  debug(m: string): void { this.write('DEBUG', m); }
  info(m: string): void { this.write('INFO', m); }
  warn(m: string): void { this.write('WARN', m); }
  error(m: string): void { this.write('ERROR', m); }
  dispose(): void { this.stream?.end(); }
}
