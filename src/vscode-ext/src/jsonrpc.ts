// LSP base-protocol framing: "Content-Length: N\r\n\r\n" + N bytes of UTF-8 JSON.

const MAX_FRAME = 256 * 1024 * 1024;
const MAX_HEADER = 8 * 1024;

/** Incrementally splits a byte stream into message bodies (handles split headers/bodies and many frames per chunk). */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private len = 0;
  private need = -1;

  push(chunk: Buffer): Buffer[] {
    this.chunks.push(chunk);
    this.len += chunk.length;
    const out: Buffer[] = [];
    for (;;) {
      if (this.need < 0) {
        const all = this.flatten();
        const idx = all.indexOf('\r\n\r\n');
        if (idx < 0) {
          if (all.length > MAX_HEADER) throw new Error('LSP header too large or malformed');
          break;
        }
        const header = all.subarray(0, idx).toString('ascii');
        const m = /^content-length:\s*(\d+)\s*$/im.exec(header);
        if (!m) throw new Error(`LSP frame without Content-Length: ${JSON.stringify(header.slice(0, 80))}`);
        const n = Number(m[1]);
        if (n > MAX_FRAME) throw new Error(`LSP frame too large (${n} bytes)`);
        this.need = n;
        this.setBuffer(all.subarray(idx + 4));
      }
      if (this.len < this.need) break;
      const all = this.flatten();
      out.push(all.subarray(0, this.need));
      this.setBuffer(all.subarray(this.need));
      this.need = -1;
    }
    return out;
  }

  private flatten(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.len)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  private setBuffer(b: Buffer): void {
    this.chunks = b.length ? [b] : [];
    this.len = b.length;
  }
}

export function encodeFrame(body: string | Buffer): Buffer {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'), payload]);
}
