import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEPLOY_STALLED_SEC, HEARTBEAT_STALE_SEC, mergeTelemetry } from './merge.ts';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString();

const sync = (over: Record<string, unknown> = {}, updatedSecAgo = 1) => ({
  module: 'win-sender', updated: ago(updatedSecAgo),
  connection: { tcp: 'up', host: '10.0.0.5', port: 9477, connects: 1, lastError: '' },
  syncs: [{ path: 'Sources/App.swift', latencyMs: 12.5, bytes: 120, at: ago(2) }],
  ...over,
});

test('nothing reported: everything unknown, no crash', () => {
  const m = mergeTelemetry({ now: NOW });
  assert.equal(m.tcp.state, 'unknown');
  assert.equal(m.ssh.state, 'unknown');
  assert.deepEqual(m.syncs, []);
  assert.equal(m.syncStats, null);
  assert.equal(m.deployment, null);
  assert.equal(m.sources.sync.present, false);
});

test('tcp: fresh + up is up; idle-but-heartbeating stays up', () => {
  const m = mergeTelemetry({ now: NOW, sync: sync({}, HEARTBEAT_STALE_SEC - 1) });
  assert.equal(m.tcp.state, 'up');
  assert.equal(m.tcp.host, '10.0.0.5:9477');
});

test('tcp: a file older than the heartbeat window means the sender stopped, even if it last said "up"', () => {
  const m = mergeTelemetry({ now: NOW, sync: sync({}, HEARTBEAT_STALE_SEC + 1) });
  assert.equal(m.tcp.state, 'down');
  assert.match(m.tcp.detail, /heartbeat/);
});

test('tcp: fresh but disconnected reports the sender\'s own error; reconnects are surfaced', () => {
  const down = mergeTelemetry({ now: NOW, sync: sync({ connection: { tcp: 'down', lastError: 'connect failed (WSA 10061)' } }) });
  assert.equal(down.tcp.state, 'down');
  assert.match(down.tcp.detail, /10061/);
  const re = mergeTelemetry({ now: NOW, sync: sync({ connection: { tcp: 'up', connects: 3, host: 'h', port: 1 } }) });
  assert.match(re.tcp.extra ?? '', /3 connects/);
});

test('syncs: capped at 10, newest first as given, bad entries dropped, stats computed', () => {
  const syncs = Array.from({ length: 14 }, (_, i) => ({ path: `f${i}.swift`, latencyMs: i + 1, bytes: 1, at: ago(i) }));
  const m = mergeTelemetry({ now: NOW, sync: sync({ syncs: [{ nope: true }, 'junk', ...syncs] }) });
  assert.equal(m.syncs.length, 10);
  assert.equal(m.syncs[0].path, 'f0.swift');
  assert.deepEqual(m.syncStats, { count: 10, medianMs: 5.5, maxMs: 10 });
  const neg = mergeTelemetry({ now: NOW, sync: sync({ syncs: [{ path: 'a', latencyMs: -5, bytes: 'x', at: 1 }] }) });
  assert.deepEqual(neg.syncs[0], { path: 'a', latencyMs: 0, bytes: 0, at: '' });
});

test('ssh: fresh editor tunnel up; closed VS Code (stale file) is unknown, not "up"', () => {
  const lsp = (state: string, ssh: string, sec: number) => ({ module: 'vscode-ext', updated: ago(sec), connection: { ssh, state, host: 'mac.local', lastError: '' } });
  assert.equal(mergeTelemetry({ now: NOW, lsp: lsp('connected', 'up', 3) }).ssh.state, 'up');
  const stale = mergeTelemetry({ now: NOW, lsp: lsp('connected', 'up', 600) });
  assert.equal(stale.ssh.state, 'unknown');
  assert.match(stale.ssh.detail, /not running/);
  assert.equal(mergeTelemetry({ now: NOW, lsp: lsp('reconnecting', 'down', 2) }).ssh.state, 'down');
  assert.equal(mergeTelemetry({ now: NOW, lsp: lsp('stopped', 'down', 2) }).ssh.state, 'down');
  assert.equal(mergeTelemetry({ now: NOW, lsp: lsp('unconfigured', 'down', 2) }).ssh.state, 'unknown');
});

test('ssh: an active deploy run counts as an open SSH session', () => {
  const deploy = { updated: ago(2), connection: { ssh: 'up', host: 'mac.local' }, deployment: { state: 'building', progress: 30, stage: 'build', message: 'x' } };
  assert.equal(mergeTelemetry({ now: NOW, deploy }).ssh.state, 'up');
});

test('deployment: progress clamped, active flag, stalled only when active and silent too long', () => {
  const dep = (state: string, progress: number, sec: number) => ({ updated: ago(sec), connection: { ssh: 'up', host: 'h' }, deployment: { state, progress, stage: 's', message: 'm' } });
  const run = mergeTelemetry({ now: NOW, deploy: dep('building', 142, 5) }).deployment!;
  assert.equal(run.progress, 100);
  assert.ok(run.active && !run.stalled);
  assert.ok(mergeTelemetry({ now: NOW, deploy: dep('building', 10, DEPLOY_STALLED_SEC + 5) }).deployment!.stalled);
  const done = mergeTelemetry({ now: NOW, deploy: dep('done', 100, 9999) }).deployment!;
  assert.ok(!done.active && !done.stalled, 'a finished run is never "stalled"');
  const failed = mergeTelemetry({ now: NOW, deploy: { updated: ago(1), deployment: { state: 'failed', progress: 12, error: 'No iPhone found' } } }).deployment!;
  assert.equal(failed.error, 'No iPhone found');
  assert.equal(mergeTelemetry({ now: NOW, deploy: { updated: ago(1), deployment: { state: 'exploded' } } }).deployment, null, 'unknown state rejected');
});

test('hostile or malformed inputs never throw', () => {
  for (const bad of [null, 7, 'str', [], { connection: 5, syncs: 'x', deployment: [] }, { updated: 'not a date', connection: { tcp: 'up' } }]) {
    assert.doesNotThrow(() => mergeTelemetry({ now: NOW, sync: bad, lsp: bad, deploy: bad }));
  }
  const m = mergeTelemetry({ now: NOW, sync: { updated: 'not a date', connection: { tcp: 'up' } } });
  assert.equal(m.tcp.state, 'down', 'an unparseable timestamp cannot prove liveness');
});
