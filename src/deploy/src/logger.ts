import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const crossdockHome = (): string => process.env.CROSSDOCK_HOME || path.join(os.homedir(), '.crossdock');

/** Verbose file logger (~/.crossdock/logs/deploy.log) that also prints to the console. */
export class Logger {
  private stream?: fs.WriteStream;
  constructor(private readonly verbose = false, fileName = 'deploy.log') {
    const dir = process.env.CROSSDOCK_LOG_DIR || path.join(crossdockHome(), 'logs');
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.stream = fs.createWriteStream(path.join(dir, fileName), { flags: 'a' });
      this.stream.on('error', () => { this.stream = undefined; });
    } catch { /* logging must never break a deploy */ }
  }
  private write(level: string, msg: string, toConsole: boolean): void {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const line = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} [${level}] ${msg}`;
    this.stream?.write(line + '\n');
    if (toConsole) console.log(line);
  }
  debug(m: string): void { this.write('DEBUG', m, this.verbose); }
  info(m: string): void { this.write('INFO', m, true); }
  warn(m: string): void { this.write('WARN', m, true); }
  error(m: string): void { this.write('ERROR', m, true); }
  close(): Promise<void> { return new Promise((r) => (this.stream ? this.stream.end(r) : r())); }
}
