import { URI } from 'vscode-uri';

// Translates between the Windows workspace and the Mac mirror that mac-listener
// keeps in sync (e.g. C:\proj  <->  /Users/me/proj). Applied to every string
// (and object key, e.g. WorkspaceEdit.changes) in every JSON-RPC message.

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const trimSep = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
const BOUNDARY = String.raw`(?=$|[\\/:\s"'\`)\]>,;])`;
const NOT_AFTER = String.raw`(?<![\w./~%-])`;

/** Windows drive letters appear in either case ("c:" / "C:", "file:///c%3A" / "file:///C%3A"); match both. */
function flipDrive(p: string): string[] {
  const m = /^((?:file:\/\/\/)?)([A-Za-z])((?::|%3A).*)$/i.exec(p);
  return m ? [p, m[1] + m[2].toLowerCase() + m[3], m[1] + m[2].toUpperCase() + m[3]] : [p];
}

export class PathMapper {
  private readonly localUri: string;
  private readonly localPath: string;
  private readonly remoteUri: string;
  private readonly remotePath: string;
  private readonly toRemoteUriRe: RegExp;
  private readonly toRemotePathRe: RegExp;
  private readonly toLocalUriRe: RegExp;
  private readonly toLocalPathRe: RegExp;

  constructor(localRoot: string, remoteRoot: string) {
    if (!localRoot || !remoteRoot) throw new Error('PathMapper needs both a local and a remote root');
    this.remotePath = trimSep(remoteRoot.replace(/\\/g, '/'));
    if (!this.remotePath.startsWith('/')) throw new Error(`remote root must be an absolute POSIX path, got "${remoteRoot}"`);
    const lroot = trimSep(localRoot);
    this.localUri = URI.file(lroot).toString();
    this.localPath = lroot.replace(/\\/g, '/');
    this.remoteUri = URI.file(this.remotePath).toString();

    const unencodedColon = (u: string) => u.replace(/%3A/i, ':');
    const lUriVariants = [...new Set([this.localUri, unencodedColon(this.localUri)].flatMap(flipDrive))];
    const lPathVariants = [...new Set([trimSep(localRoot), this.localPath].flatMap(flipDrive))];
    const rUriVariants = [...new Set([this.remoteUri, `file://${this.remotePath}`])];

    const alt = (xs: string[]) => xs.sort((a, b) => b.length - a.length).map(esc).join('|');
    // local -> remote: path tails may use backslashes, normalise them to '/'.
    this.toRemoteUriRe = new RegExp(`${NOT_AFTER}(?:${alt(lUriVariants)})${BOUNDARY}`, 'g');
    this.toRemotePathRe = new RegExp(`${NOT_AFTER}(?:${alt(lPathVariants)})((?:[\\\\/][^\\s"'<>|*?]*)?)`, 'g');
    // remote -> local
    this.toLocalUriRe = new RegExp(`${NOT_AFTER}(?:${alt(rUriVariants)})${BOUNDARY}`, 'g');
    this.toLocalPathRe = new RegExp(`${NOT_AFTER}${esc(this.remotePath)}${BOUNDARY}`, 'g');
  }

  toRemoteString(s: string): string {
    return s
      .replace(this.toRemoteUriRe, () => this.remoteUri)
      .replace(this.toRemotePathRe, (_m, tail: string) => this.remotePath + tail.replace(/\\/g, '/'));
  }

  toLocalString(s: string): string {
    return s
      .replace(this.toLocalUriRe, () => this.localUri)
      .replace(this.toLocalPathRe, () => this.localPath);
  }

  toRemote<T>(value: T): T { return this.walk(value, (s) => this.toRemoteString(s)) as T; }
  toLocal<T>(value: T): T { return this.walk(value, (s) => this.toLocalString(s)) as T; }

  private walk(v: unknown, f: (s: string) => string): unknown {
    if (typeof v === 'string') return f(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x, f));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[f(k)] = this.walk(x, f);
      return out;
    }
    return v;
  }
}
