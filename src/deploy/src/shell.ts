/** POSIX single-quote a value so it is one literal word for the remote shell (no injection from config values). */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface BuildOptions {
  workspace?: string;
  project?: string;
  scheme: string;
  configuration: string;
  team?: string;
  allowProvisioningUpdates: boolean;
}

/** Arguments for the Mac-side build-ipa.js. */
export function buildScriptArgs(b: BuildOptions): string[] {
  return [
    ...(b.workspace ? ['--workspace', b.workspace] : []),
    ...(b.project ? ['--project', b.project] : []),
    '--scheme', b.scheme,
    '--configuration', b.configuration,
    ...(b.team ? ['--team', b.team] : []),
    ...(b.allowProvisioningUpdates ? [] : ['--no-provisioning-updates']),
  ];
}

/**
 * Remote command: a login shell (so Homebrew's PATH is loaded for `node`), in the mirrored project
 * directory, running the uploaded script. `$HOME` is deliberately left for the remote shell to expand.
 */
export function remoteBuildCommand(opts: { shell: string; node: string; remoteRoot: string; scriptPath: string; build: BuildOptions }): string {
  const inner = `cd ${shQuote(opts.remoteRoot)} && ${opts.node} "$HOME/${opts.scriptPath}" ${buildScriptArgs(opts.build).map(shQuote).join(' ')}`;
  return `${opts.shell} ${shQuote(inner)}`;
}
