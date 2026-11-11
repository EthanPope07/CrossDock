import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { LineSplitter, parseMacEvent } from '../src/events';
import { findTool, parseDeviceList, parseInstallLine } from '../src/ideviceinstaller';
import { parseCli } from '../src/cli';
import { buildScriptArgs, remoteBuildCommand, shQuote } from '../src/shell';
import { scale, WINDOWS } from '../src/telemetry';

const mac = createRequire(__filename)(path.resolve(__dirname, '..', '..', 'mac', 'build-ipa.js'));

// ---------------------------------------------------------------- shell quoting
/**
 * A real POSIX shell, or null. On Windows only Git for Windows / MSYS2 count: `bash.exe` on PATH is usually the
 * WSL launcher, which re-parses the command line in an extra shell layer (and CrossDock is a no-WSL project).
 */
function findPosixShell(): string | null {
  if (process.platform === 'win32') {
    const candidates = [process.env.CROSSDOCK_SH, 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe', 'C:\\msys64\\usr\\bin\\sh.exe'];
    return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
  }
  for (const c of ['sh', 'bash']) { try { execFileSync(c, ['-c', 'true']); return c; } catch { /* try next */ } }
  return null;
}

test('shQuote: value stays a single literal word in a real POSIX shell (injection attempts)', (t) => {
  const sh = findPosixShell();
  if (!sh) return t.skip('no POSIX shell available (Git for Windows / MSYS2 / sh)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossdock-sh-'));
  try {
    const marker = path.join(dir, 'pwned').replace(/\\/g, '/');
    const nasty = ['plain', "it's", 'a b', `$(touch ${marker})`, `\`touch ${marker}\``, `x; touch ${marker}`, '"quoted"', '$HOME', "'; rm -rf / #", 'new\nline'];
    for (const s of nasty) {
      const out: string = execFileSync(sh, ['-c', `printf %s ${shQuote(s)}`], { encoding: 'utf8' });
      assert.equal(out, s, `round-trip failed for ${JSON.stringify(s)}`);
    }
    assert.equal(fs.existsSync(path.join(dir, 'pwned')), false, 'an injected command actually ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remoteBuildCommand: quotes every user value, leaves $HOME for the Mac shell', () => {
  const cmd = remoteBuildCommand({
    shell: '/bin/zsh -lc', node: 'node', remoteRoot: "/Users/me/My App", scriptPath: '.crossdock/bin/build-ipa.js',
    build: { workspace: 'App.xcworkspace', scheme: "Evil'; reboot; '", configuration: 'Debug', allowProvisioningUpdates: true },
  });
  assert.ok(cmd.startsWith("/bin/zsh -lc '"));
  assert.ok(cmd.includes('$HOME/.crossdock/bin/build-ipa.js'));
  assert.ok(!cmd.includes("Evil'; reboot"), 'raw injection text must not survive unquoted');
  assert.match(cmd, /My App/);
});

test('buildScriptArgs: optional flags appear only when set', () => {
  assert.deepEqual(buildScriptArgs({ project: 'A.xcodeproj', scheme: 'A', configuration: 'Release', team: 'ABCDE12345', allowProvisioningUpdates: false }),
    ['--project', 'A.xcodeproj', '--scheme', 'A', '--configuration', 'Release', '--team', 'ABCDE12345', '--no-provisioning-updates']);
  assert.deepEqual(buildScriptArgs({ workspace: 'A.xcworkspace', scheme: 'A', configuration: 'Debug', allowProvisioningUpdates: true }),
    ['--workspace', 'A.xcworkspace', '--scheme', 'A', '--configuration', 'Debug']);
});

// ---------------------------------------------------------------- events
test('parseMacEvent / LineSplitter: ignore noise, survive split chunks', () => {
  assert.equal(parseMacEvent('Last login: Tue Nov 10'), null);
  assert.equal(parseMacEvent('{not json'), null);
  assert.equal(parseMacEvent('{"no":"type"}'), null);
  assert.deepEqual(parseMacEvent('{"type":"progress","percent":42}'), { type: 'progress', percent: 42 });
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"type":"lo'), []);
  assert.deepEqual(s.push('g","line":"x"}\r\n{"type":"stage"'), ['{"type":"log","line":"x"}']);
  assert.deepEqual(s.push(',"stage":"a","message":"b"}\n'), ['{"type":"stage","stage":"a","message":"b"}']);
  assert.deepEqual(s.flush(), []);
});

test('telemetry scale: build/fetch/install windows tile 0..100 without overlap', () => {
  assert.equal(scale(WINDOWS.build, 0), 0);
  assert.equal(scale(WINDOWS.build, 100), 60);
  assert.equal(scale(WINDOWS.fetch, 50), 70);
  assert.equal(scale(WINDOWS.install, 100), 100);
  assert.equal(scale(WINDOWS.install, 250), 100, 'clamped');
});

// ---------------------------------------------------------------- ideviceinstaller
test('ideviceinstaller: output parsing', () => {
  assert.deepEqual(parseDeviceList('00008110-001A2B3C4D5E601E\n\n'), ['00008110-001A2B3C4D5E601E']);
  assert.deepEqual(parseDeviceList('ERROR: No device found!'), []);
  assert.deepEqual(parseInstallLine('Install: CreatingStagingDirectory (5%)'), { percent: 5 });
  assert.deepEqual(parseInstallLine('Install: Complete'), { percent: 100, complete: true });
  assert.ok(parseInstallLine('ERROR: Could not connect to lockdownd. Exiting.').error);
  assert.deepEqual(parseInstallLine('Copying app.ipa to device'), {});
});

test('findTool: explicit dir beats env beats .crossdock/tools beats PATH', () => {
  const exe = process.platform === 'win32' ? 'ideviceinstaller.exe' : 'ideviceinstaller';
  const present = new Set<string>();
  const exists = (p: string) => present.has(p);
  const sep = path.delimiter;
  const env = { CROSSDOCK_IDEVICE_DIR: path.join('E', 'env'), PATH: `${path.join('P', 'one')}${sep}${path.join('P', 'two')}` };
  const opts = { dir: path.join('D', 'explicit'), cwd: 'W', env, exists };
  assert.equal(findTool('ideviceinstaller', opts), null);
  present.add(path.join('P', 'two', exe));
  assert.equal(findTool('ideviceinstaller', opts), path.join('P', 'two', exe));
  present.add(path.join('W', '.crossdock', 'tools', exe));
  assert.equal(findTool('ideviceinstaller', opts), path.join('W', '.crossdock', 'tools', exe));
  present.add(path.join('E', 'env', exe));
  assert.equal(findTool('ideviceinstaller', opts), path.join('E', 'env', exe));
  present.add(path.join('D', 'explicit', exe));
  assert.equal(findTool('ideviceinstaller', opts), path.join('D', 'explicit', exe));
});

// ---------------------------------------------------------------- CLI
test('cli: parses flags, rejects unknown ones and missing values', () => {
  assert.deepEqual(parseCli(['--host', 'mac', '--no-install', '--remote-root', '/x', '--pin-host-key', 'SHA256:a']),
    { host: 'mac', noInstall: true, remoteRoot: '/x', pinHostKey: 'SHA256:a' });
  assert.throws(() => parseCli(['--bogus']), /unknown option/);
  assert.throws(() => parseCli(['--host']), /missing value/);
  assert.throws(() => parseCli(['stray']), /unexpected argument/);
});

// ---------------------------------------------------------------- Mac-side script (pure parts)
test('mac script: argument validation and xcodebuild command line', () => {
  assert.throws(() => mac.parseArgs([]), /--scheme is required/);
  assert.throws(() => mac.parseArgs(['--scheme', 'A']), /--workspace or --project/);
  assert.throws(() => mac.parseArgs(['--scheme', 'A', '--workspace', 'a', '--project', 'b']), /either/);
  assert.throws(() => mac.parseArgs(['--scheme', 'A', '--nope']), /unknown argument/);
  const o = mac.parseArgs(['--workspace', 'App.xcworkspace', '--scheme', 'App', '--team', 'TEAM123456']);
  assert.deepEqual(mac.buildArgs(o, '/dd'), [
    '-workspace', 'App.xcworkspace', '-scheme', 'App', '-configuration', 'Debug', '-sdk', 'iphoneos',
    '-destination', 'generic/platform=iOS', '-derivedDataPath', '/dd', '-allowProvisioningUpdates', 'build', 'DEVELOPMENT_TEAM=TEAM123456',
  ]);
});

test('mac script: progress is monotonic, bounded, and completes on BUILD SUCCEEDED', () => {
  const t = new mac.ProgressTracker();
  let last = 0;
  for (let i = 0; i < 200; i++) {
    const p = t.feed('CompileSwift normal arm64 /x/File.swift');
    if (p !== null) { assert.ok(p > last && p < 90, `p=${p}`); last = p; }
  }
  assert.equal(t.feed('Ld /x/App.app/App normal'), 88);
  assert.equal(t.feed('CodeSign /x/App.app'), 94);
  assert.equal(t.feed('random noise'), null);
  assert.equal(t.feed('** BUILD SUCCEEDED **'), 100);
});

test('mac script: picks the .app from -showBuildSettings JSON', () => {
  const json = JSON.stringify([
    { target: 'Lib', buildSettings: { WRAPPER_EXTENSION: 'framework', TARGET_BUILD_DIR: '/b', FULL_PRODUCT_NAME: 'Lib.framework' } },
    { target: 'App', buildSettings: { WRAPPER_EXTENSION: 'app', TARGET_BUILD_DIR: '/b/Debug-iphoneos', FULL_PRODUCT_NAME: 'App.app' } },
  ]);
  assert.equal(mac.pickApp(json), path.join('/b/Debug-iphoneos', 'App.app'));
  assert.equal(mac.pickApp('[]'), null);
  assert.throws(() => mac.pickApp('not json'));
});
