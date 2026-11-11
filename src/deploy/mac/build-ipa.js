#!/usr/bin/env node
'use strict';
// CrossDock Mac build trigger. Uploaded and run over SSH by the Windows orchestrator
// (src/deploy), from inside the mirrored project directory. Zero dependencies, Node >= 18.
//
// Runs `xcodebuild ... -sdk iphoneos build`, packages the resulting .app into an .ipa
// (Payload/<App>.app, zipped) and reports everything as NDJSON events on stdout:
//   {type:'stage',    stage, message}
//   {type:'progress', percent, step}          percent is 0..100 for the Mac-side work
//   {type:'log',      line}
//   {type:'result',   ok:true, ipa, bytes, sha256, appName, bundleId}
//   {type:'error',    message, errors:[...]}
// The full xcodebuild log is kept in .crossdock/build.log on the Mac.

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');

function parseArgs(argv) {
  const o = { configuration: 'Debug', allowProvisioningUpdates: true };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`missing value for ${flag}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace') o.workspace = need(i++, a);
    else if (a === '--project') o.project = need(i++, a);
    else if (a === '--scheme') o.scheme = need(i++, a);
    else if (a === '--configuration') o.configuration = need(i++, a);
    else if (a === '--team') o.team = need(i++, a);
    else if (a === '--no-provisioning-updates') o.allowProvisioningUpdates = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.scheme) throw new Error('--scheme is required');
  if (o.workspace && o.project) throw new Error('pass either --workspace or --project, not both');
  if (!o.workspace && !o.project) throw new Error('one of --workspace or --project is required');
  return o;
}

/** Arguments shared by the build and -showBuildSettings invocations. */
function baseArgs(o, derivedData) {
  return [
    ...(o.workspace ? ['-workspace', o.workspace] : ['-project', o.project]),
    '-scheme', o.scheme,
    '-configuration', o.configuration,
    '-sdk', 'iphoneos',
    '-destination', 'generic/platform=iOS',
    '-derivedDataPath', derivedData,
  ];
}

function buildArgs(o, derivedData) {
  return [
    ...baseArgs(o, derivedData),
    ...(o.allowProvisioningUpdates ? ['-allowProvisioningUpdates'] : []),
    'build',
    ...(o.team ? [`DEVELOPMENT_TEAM=${o.team}`] : []),
  ];
}

/** xcodebuild does not know its total step count, so progress is estimated from step markers. */
class ProgressTracker {
  constructor() { this.steps = 0; this.percent = 0; }
  /** Returns a new (monotonic) percent when the line moves progress, else null. */
  feed(line) {
    let next = this.percent;
    if (/^(CompileSwift|SwiftCompile|CompileC|CompileAssetCatalog|CompileStoryboard|CompileXIB|ProcessInfoPlistFile|CopyPNGFile|PhaseScriptExecution|SwiftEmitModule|SwiftDriver)\b/.test(line)) {
      this.steps++;
      next = Math.max(next, Math.round(5 + 80 * (1 - Math.exp(-this.steps / 40))));
    } else if (/^Ld\b|^Libtool\b/.test(line)) next = Math.max(next, 88);
    else if (/^CodeSign\b/.test(line)) next = Math.max(next, 94);
    else if (/\*\* BUILD SUCCEEDED \*\*/.test(line)) next = 100;
    if (next > this.percent) { this.percent = next; return next; }
    return null;
  }
}

/** Picks the built .app from `xcodebuild -showBuildSettings -json` output. */
function pickApp(json) {
  const list = JSON.parse(json);
  for (const entry of Array.isArray(list) ? list : []) {
    const s = entry.buildSettings || {};
    if (s.WRAPPER_EXTENSION === 'app' && s.TARGET_BUILD_DIR && s.FULL_PRODUCT_NAME) {
      return path.join(s.TARGET_BUILD_DIR, s.FULL_PRODUCT_NAME);
    }
  }
  return null;
}

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('build-ipa.js must run on macOS (xcodebuild is required)');
  const o = parseArgs(process.argv.slice(2));
  const work = path.resolve('.crossdock');
  const derivedData = path.join(work, 'DerivedData');
  const outDir = path.join(work, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(work, 'build.log'));

  emit({ type: 'stage', stage: 'build', message: `xcodebuild ${o.scheme} (${o.configuration}, iphoneos)` });
  const args = buildArgs(o, derivedData);
  emit({ type: 'log', line: `$ xcodebuild ${args.join(' ')}` });

  const tracker = new ProgressTracker();
  const errors = [];
  const tail = [];
  const code = await new Promise((resolve, reject) => {
    const child = spawn('xcodebuild', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', (e) => reject(new Error(`cannot start xcodebuild: ${e.message}. Are the Xcode command line tools installed?`)));
    let buf = '';
    const onData = (chunk) => {
      logStream.write(chunk);
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        if (/: error:|^error:|\*\* BUILD FAILED \*\*|Signing for .* requires|No profiles for|No signing certificate/.test(line) && errors.length < 50) errors.push(line);
        const p = tracker.feed(line);
        if (p !== null) emit({ type: 'progress', percent: Math.min(p, 97), step: line.split(' ')[0] });
        else if (/^(Ld|CodeSign|\*\*)/.test(line)) emit({ type: 'log', line });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', resolve);
  });
  logStream.end();
  if (code !== 0) {
    emit({ type: 'error', message: `xcodebuild failed with exit code ${code} (full log: ${path.join(work, 'build.log')} on the Mac)`, errors: errors.length ? errors : tail.slice(-20) });
    process.exit(2);
  }

  emit({ type: 'stage', stage: 'package', message: 'locating the built .app and packaging an .ipa' });
  let appPath = null;
  try {
    const { stdout } = await run('xcodebuild', [...baseArgs(o, derivedData), '-showBuildSettings', '-json']);
    appPath = pickApp(stdout);
  } catch (e) {
    emit({ type: 'log', line: `showBuildSettings failed (${e.message}); falling back to a directory scan` });
  }
  if (!appPath || !fs.existsSync(appPath)) {
    const products = path.join(derivedData, 'Build', 'Products', `${o.configuration}-iphoneos`);
    const apps = fs.existsSync(products) ? fs.readdirSync(products).filter((n) => n.endsWith('.app')) : [];
    if (apps.length === 1) appPath = path.join(products, apps[0]);
    else throw new Error(`could not determine the built .app (found ${apps.length} candidates in ${products})`);
  }
  const appName = path.basename(appPath, '.app');
  const tmp = fs.mkdtempSync(path.join(outDir, 'pkg-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Payload'));
    await run('cp', ['-R', appPath, path.join(tmp, 'Payload')]);
    const ipa = path.join(outDir, `${appName}.ipa`);
    fs.rmSync(ipa, { force: true });
    await run('zip', ['-qry', ipa, 'Payload'], { cwd: tmp });
    let bundleId = '';
    try { bundleId = (await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Info.plist')])).stdout.trim(); } catch { /* optional */ }
    const { size } = fs.statSync(ipa);
    emit({ type: 'progress', percent: 100, step: 'package' });
    emit({ type: 'result', ok: true, ipa, bytes: size, sha256: await sha256File(ipa), appName, bundleId });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { parseArgs, baseArgs, buildArgs, ProgressTracker, pickApp };

if (require.main === module) {
  main().catch((e) => {
    emit({ type: 'error', message: e.message, errors: [] });
    process.exit(1);
  });
}
