/** Events emitted as NDJSON by mac/build-ipa.js. */
export type MacEvent =
  | { type: 'stage'; stage: string; message: string }
  | { type: 'progress'; percent: number; step?: string }
  | { type: 'log'; line: string }
  | { type: 'result'; ok: true; ipa: string; bytes: number; sha256: string; appName: string; bundleId: string }
  | { type: 'error'; message: string; errors: string[] };

/** Returns null for lines that are not a recognised event (stray shell/profile output on the Mac). */
export function parseMacEvent(line: string): MacEvent | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const ev = JSON.parse(t);
    return ev && typeof ev.type === 'string' ? (ev as MacEvent) : null;
  } catch {
    return null;
  }
}

/** Splits a byte stream into complete lines; keeps the trailing partial line for the next push. */
export class LineSplitter {
  private rest = '';
  push(chunk: Buffer | string): string[] {
    this.rest += chunk.toString();
    const lines = this.rest.split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    return lines;
  }
  flush(): string[] {
    const r = this.rest;
    this.rest = '';
    return r ? [r] : [];
  }
}
