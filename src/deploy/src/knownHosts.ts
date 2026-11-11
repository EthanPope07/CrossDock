import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** OpenSSH-style fingerprint: "SHA256:" + unpadded base64 of SHA-256 over the raw host key blob. */
export function fingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export interface HostKeyResult { ok: boolean; firstUse?: boolean; reason?: string; fingerprint: string }

const normalise = (fp: string) => (fp.startsWith('SHA256:') ? fp : `SHA256:${fp}`).replace(/=+$/, '');

/**
 * Trust-on-first-use host key check. A configured `pinned` fingerprint always wins.
 * Otherwise the first key seen for host:port is stored in `file` and any later change is refused.
 */
export function checkHostKey(file: string, host: string, port: number, key: Buffer, pinned?: string): HostKeyResult {
  const fp = fingerprint(key);
  if (pinned) {
    return normalise(pinned) === fp
      ? { ok: true, fingerprint: fp }
      : { ok: false, fingerprint: fp, reason: `Host key for ${host} does not match the pinned fingerprint (got ${fp}, expected ${normalise(pinned)}).` };
  }
  const id = `${host}:${port}`;
  let db: Record<string, string> = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or unreadable: treated as empty */ }
  const known = db[id];
  if (known) {
    return known === fp
      ? { ok: true, fingerprint: fp }
      : { ok: false, fingerprint: fp, reason: `HOST KEY CHANGED for ${id}: expected ${known}, got ${fp}. Refusing to connect (possible man-in-the-middle). If the Mac was legitimately rebuilt, remove "${id}" from ${file}.` };
  }
  db[id] = fp;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
  return { ok: true, firstUse: true, fingerprint: fp };
}
