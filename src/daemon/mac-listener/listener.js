#!/usr/bin/env node
'use strict';
// CrossDock mac-listener
// TCP daemon that applies the win-sender wire protocol to a local directory,
// mirroring the sender's file system state. Zero dependencies (Node >= 18).
// Runs unchanged on macOS, Linux and Windows (the test harness uses Windows).
//
// Frame (big-endian): u8 action | u16 pathLen | path (utf8) | u64 size | payload
//   1 WRITE  2 DELETE  3 MKDIR  4 PRUNE (payload = '\n'-joined manifest)  5 PING
// Every frame is answered with one byte: 0x06 ACK or 0x15 NAK.

const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const ACT = { WRITE: 1, DELETE: 2, MKDIR: 3, PRUNE: 4, PING: 5 };
const ACK = Buffer.from([0x06]);
const NAK = Buffer.from([0x15]);
const MAX_PAYLOAD = 256 * 1024 * 1024;
// Names PRUNE never deletes (build products created on the Mac, plus names the
// sender excludes). Keep in sync with isExcluded() in win-sender/src/main.cpp.
const DEFAULT_KEEP = ['.git', '.build', 'DerivedData', 'build', '.crossdock', '.DS_Store', 'node_modules'];

// ------------------------------------------------------------------ options
function parseArgs(argv) {
  const o = { port: 9477, host: '0.0.0.0', root: null, prune: true, keep: [...DEFAULT_KEEP], verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--root') o.root = next();
    else if (a === '--no-prune') o.prune = false;
    else if (a === '--dry-run') o.dryRun = true;  // ACK frames without touching disk (latency benchmarking)
    else if (a === '--keep') o.keep.push(...next().split(',').filter(Boolean));
    else if (a === '--verbose') o.verbose = true;
    else { usage(); process.exit(a === '--help' ? 0 : 2); }
  }
  if (!o.root || !Number.isInteger(o.port)) { usage(); process.exit(2); }
  o.root = path.resolve(o.root);
  return o;
}
function usage() {
  console.log('listener.js --root <dir> [--port 9477] [--host 0.0.0.0] [--keep a,b] [--no-prune] [--verbose]');
}

// ------------------------------------------------------------------ logging
let logStream = null;
let VERBOSE = false;
function initLog() {
  const dir = process.env.CROSSDOCK_LOG_DIR || path.join(os.homedir(), '.crossdock', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logStream = fs.createWriteStream(path.join(dir, 'mac-listener.log'), { flags: 'a' });
}
function log(level, msg) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  const line = `${ts} [${level}] ${msg}\n`;
  if (level !== 'DEBUG' || VERBOSE) process.stdout.write(line);
  if (logStream) logStream.write(line);
}

// ------------------------------------------------------------- frame parser
class FrameParser {
  constructor(onFrame, onError) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.chunks = [];
    this.len = 0;
    this.state = 0;
    this.dead = false;
  }
  push(chunk) {
    if (this.dead) return;
    this.chunks.push(chunk);
    this.len += chunk.length;
    this.drain();
  }
  take(n) {
    if (n === 0) return Buffer.alloc(0);
    const first = this.chunks[0];
    let out;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
    } else {
      const all = Buffer.concat(this.chunks, this.len);
      out = all.subarray(0, n);
      const rest = all.subarray(n);
      this.chunks = rest.length ? [rest] : [];
    }
    this.len -= n;
    return out;
  }
  drain() {
    for (;;) {
      if (this.state === 0) {
        if (this.len < 3) return;
        const h = this.take(3);
        this.act = h[0];
        this.plen = h.readUInt16BE(1);
        this.state = 1;
      }
      if (this.state === 1) {
        if (this.len < this.plen + 8) return;
        const b = this.take(this.plen + 8);
        this.path = b.toString('utf8', 0, this.plen);
        this.size = b.readUInt32BE(this.plen) * 2 ** 32 + b.readUInt32BE(this.plen + 4);
        if (this.size > MAX_PAYLOAD) {
          this.dead = true;
          this.onError(new Error(`payload too large (${this.size})`));
          return;
        }
        this.state = 2;
      }
      if (this.state === 2) {
        if (this.len < this.size) return;
        const payload = this.take(this.size);
        this.state = 0;
        this.onFrame({ act: this.act, path: this.path, payload });
      }
    }
  }
}

// -------------------------------------------------------------- fs applying
class Mirror {
  constructor(opts) {
    this.root = opts.root;
    this.prune = opts.prune;
    this.dryRun = !!opts.dryRun;
    this.keep = new Set(opts.keep);
    this.tmpSeq = 0;
  }

  // Maps a protocol path to an absolute path inside root, or throws.
  resolve(rel) {
    if (rel === '' || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new Error(`bad path: ${JSON.stringify(rel)}`);
    const parts = rel.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`bad path: ${JSON.stringify(rel)}`);
    const full = path.join(this.root, ...parts);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`path escapes root: ${JSON.stringify(rel)}`);
    return full;
  }

  async mkdirp(dir) {
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      if (e.code !== 'ENOTDIR' && e.code !== 'EEXIST') throw e;
      // A file is in the way of a directory: the sender's state wins.
      let cur = dir;
      while (cur.length > this.root.length) {
        const st = await fsp.lstat(cur).catch(() => null);
        if (st && !st.isDirectory()) await fsp.rm(cur, { force: true });
        cur = path.dirname(cur);
      }
      await fsp.mkdir(dir, { recursive: true });
    }
  }

  async write(rel, payload) {
    const full = this.resolve(rel);
    await this.mkdirp(path.dirname(full));
    const tmp = `${full}.crossdock-tmp-${process.pid}-${this.tmpSeq++}`;
    // Small files (the common editor-save case) use sync calls: no thread-pool
    // hops, ~2x faster. Large files stay async so they never stall the loop.
    const small = payload.length <= 1024 * 1024;
    if (small) fs.writeFileSync(tmp, payload);
    else await fsp.writeFile(tmp, payload);
    try {
      if (small) fs.renameSync(tmp, full);
      else await fsp.rename(tmp, full);
    } catch (e) {
      if (e.code === 'EISDIR' || e.code === 'ENOTEMPTY' || e.code === 'EPERM' || e.code === 'EEXIST') {
        await fsp.rm(full, { recursive: true, force: true });
        await fsp.rename(tmp, full);
      } else {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    }
  }

  async del(rel) {
    await fsp.rm(this.resolve(rel), { recursive: true, force: true });
  }

  async mkdir(rel) {
    const full = this.resolve(rel);
    const st = await fsp.lstat(full).catch(() => null);
    if (st && !st.isDirectory()) await fsp.rm(full, { force: true });
    await this.mkdirp(full);
  }

  // Deletes everything under root that is not in the manifest (and not kept).
  async pruneTo(manifestText) {
    if (!this.prune) return 0;
    const keepSet = new Set();
    for (const rel of manifestText.split('\n')) {
      if (!rel) continue;
      const parts = rel.split('/');
      for (let i = 1; i <= parts.length; i++) keepSet.add(parts.slice(0, i).join('/'));
    }
    let removed = 0;
    const walk = async (dir, relDir) => {
      for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (this.keep.has(ent.name) || ent.name.includes('.crossdock-tmp-')) continue;
        const full = path.join(dir, ent.name);
        if (!keepSet.has(rel)) {
          await fsp.rm(full, { recursive: true, force: true });
          removed++;
          log('DEBUG', `pruned ${rel}`);
        } else if (ent.isDirectory()) {
          await walk(full, rel);
        }
      }
    };
    await walk(this.root, '');
    return removed;
  }

  async apply({ act, path: rel, payload }) {
    if (this.dryRun) { if (act !== ACT.PING && act !== ACT.PRUNE) this.resolve(rel); return; }
    switch (act) {
      case ACT.WRITE: return this.write(rel, payload);
      case ACT.DELETE: return this.del(rel);
      case ACT.MKDIR: return this.mkdir(rel);
      case ACT.PRUNE: {
        const n = await this.pruneTo(payload.toString('utf8'));
        if (n) log('INFO', `prune removed ${n} stale entr${n === 1 ? 'y' : 'ies'}`);
        return;
      }
      case ACT.PING: return;
      default: throw new Error(`unknown action ${act}`);
    }
  }
}

// ------------------------------------------------------------------- server
function main() {
  const opts = parseArgs(process.argv.slice(2));
  VERBOSE = opts.verbose;
  initLog();
  fs.mkdirSync(opts.root, { recursive: true });
  opts.root = fs.realpathSync(opts.root);
  const mirror = new Mirror(opts);
  let connId = 0;

  const server = net.createServer((socket) => {
    const id = ++connId;
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    log('INFO', `[#${id}] sender connected from ${peer}`);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    let queue = Promise.resolve();
    let frames = 0;

    const parser = new FrameParser(
      (frame) => {
        queue = queue.then(async () => {
          if (socket.destroyed) return;
          const t0 = process.hrtime.bigint();
          try {
            await mirror.apply(frame);
            frames++;
            if (!socket.destroyed) socket.write(ACK);
            log('DEBUG', `[#${id}] act=${frame.act} path=${frame.path} bytes=${frame.payload.length} took=${Number(process.hrtime.bigint() - t0) / 1e6}ms`);
          } catch (e) {
            log('WARN', `[#${id}] rejected act=${frame.act} path=${JSON.stringify(frame.path)}: ${e.message}`);
            if (!socket.destroyed) socket.write(NAK);
          }
        });
      },
      (e) => {
        log('ERROR', `[#${id}] protocol error: ${e.message}; closing`);
        socket.destroy();
      },
    );

    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('error', (e) => log('WARN', `[#${id}] socket error: ${e.code || e.message}`));
    socket.on('close', () => log('INFO', `[#${id}] sender disconnected after ${frames} frame(s)`));
  });

  server.on('error', (e) => {
    log('ERROR', `server error: ${e.code || e.message}`);
    process.exit(1);
  });
  server.listen(opts.port, opts.host, () => {
    log('INFO', `mac-listener listening on ${opts.host}:${server.address().port}, mirroring into ${opts.root} (prune ${opts.prune ? 'on' : 'off'})`);
  });

  const shutdown = () => {
    log('INFO', 'shutting down');
    server.close();
    setTimeout(() => process.exit(0), 100);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();
module.exports = { FrameParser, Mirror, ACT };
