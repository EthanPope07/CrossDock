#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { crossdockHome, Logger } from './logger';
import { installExisting, PipelineOptions, runPipeline } from './pipeline';

const USAGE = `crossdock-deploy: build on the Mac, fetch the .ipa, install it on the USB-connected iPhone

Usage: node out/src/cli.js [options]
  --config <file>        JSON file with any of the options below (camelCase keys); flags override it
  --host <host>          Mac build server                      --port <n>            SSH port (22)
  --user <name>          SSH user                              --key <path>          private key (else ssh-agent)
  --pin-host-key <fp>    pin the Mac's host key (SHA256:...)   (key passphrase: CROSSDOCK_SSH_PASSPHRASE)
  --remote-root <path>   mirrored project dir on the Mac       --scheme <name>       Xcode scheme (required)
  --workspace <file>     .xcworkspace (relative to remote root)  --project <file>    .xcodeproj
  --configuration <c>    Debug (default)                       --team <id>           DEVELOPMENT_TEAM
  --no-provisioning-updates                                    --out <dir>           .crossdock/build
  --no-install           build and fetch only                  --device <udid>       target iPhone
  --idevice-dir <dir>    folder with ideviceinstaller.exe      --ipa <file>          install this .ipa only (no SSH/build)
  --remote-shell <cmd>   default "/bin/zsh -lc"                --remote-node <cmd>   default "node"
  --telemetry <file>     default .crossdock/crossdock-telemetry.deploy.json
  --verbose              debug output on the console
`;

type Raw = Record<string, string | boolean>;
const FLAGS_WITH_VALUE = ['config', 'host', 'port', 'user', 'key', 'pin-host-key', 'remote-root', 'scheme', 'workspace', 'project', 'configuration', 'team', 'out', 'device', 'idevice-dir', 'ipa', 'remote-shell', 'remote-node', 'telemetry'];
const BOOLEAN_FLAGS = ['no-install', 'no-provisioning-updates', 'verbose', 'help'];
const camel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

export function parseCli(argv: string[]): Raw {
  const raw: Raw = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) raw[camel(name)] = true;
    else if (FLAGS_WITH_VALUE.includes(name)) {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      raw[camel(name)] = argv[++i];
    } else throw new Error(`unknown option: ${a}`);
  }
  return raw;
}

async function main(): Promise<number> {
  let flags: Raw;
  try { flags = parseCli(process.argv.slice(2)); } catch (e) { console.error(`${(e as Error).message}\n\n${USAGE}`); return 2; }
  if (flags.help) { console.log(USAGE); return 0; }
  let cfg: Raw = {};
  if (typeof flags.config === 'string') {
    try { cfg = JSON.parse(fs.readFileSync(flags.config, 'utf8')); } catch (e) { console.error(`cannot read --config: ${(e as Error).message}`); return 2; }
  }
  const o = { ...cfg, ...flags } as Record<string, any>;
  const cwd = process.cwd();
  const log = new Logger(!!o.verbose);
  const telemetryFile = path.resolve(o.telemetry ?? path.join(cwd, '.crossdock', 'crossdock-telemetry.deploy.json'));
  const outDir = path.resolve(o.out ?? path.join(cwd, '.crossdock', 'build'));

  const base: PipelineOptions = {
    ssh: {
      host: o.host ?? '', port: Number(o.port ?? 22), username: o.user ?? '', privateKeyPath: o.key, pinnedHostKey: o.pinHostKey,
      knownHostsPath: path.join(crossdockHome(), 'known_hosts.json'), passphrase: process.env.CROSSDOCK_SSH_PASSPHRASE,
    },
    remoteRoot: o.remoteRoot ?? '',
    build: { workspace: o.workspace, project: o.project, scheme: o.scheme ?? '', configuration: o.configuration ?? 'Debug', team: o.team, allowProvisioningUpdates: !o.noProvisioningUpdates },
    remoteShell: o.remoteShell ?? '/bin/zsh -lc',
    remoteNode: o.remoteNode ?? 'node',
    outDir, install: !o.noInstall, udid: o.device, toolDir: o.ideviceDir, telemetryFile, cwd,
  };

  try {
    if (typeof o.ipa === 'string') {
      const ipa = path.resolve(o.ipa);
      log.info(`install-only mode: ${ipa}`);
      await installExisting(ipa, base, log);
      log.info('DONE: installation succeeded');
      return 0;
    }
    const missing = [!base.ssh.host && '--host', !base.ssh.username && '--user', !base.remoteRoot && '--remote-root', !base.build.scheme && '--scheme',
      !base.build.workspace && !base.build.project && '--workspace or --project'].filter(Boolean);
    if (missing.length) { console.error(`missing required option(s): ${missing.join(', ')}\n\n${USAGE}`); return 2; }
    const r = await runPipeline(base, log);
    log.info(`DONE: ${r.localIpa}${r.installed ? ' installed on the iPhone' : ' (not installed)'}`);
    return 0;
  } catch (e) {
    log.error(`FAILED: ${(e as Error).message}`);
    return 1;
  } finally {
    await log.close();
  }
}

if (require.main === module) main().then((c) => process.exit(c));
