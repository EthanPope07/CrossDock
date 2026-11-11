# Phase 3: Remote build and USB deployment

One command builds on the Mac, brings the `.ipa` back, and installs it on a USB-connected iPhone:

```
Windows (src/deploy)                              Mac
  1. upload mac/build-ipa.js  ──── SSH/SFTP ───►  ~/.crossdock/bin/build-ipa.js
  2. run it in the mirrored project ───────────►  xcodebuild -sdk iphoneos build → Payload/App.app → App.ipa
     ◄──────────── NDJSON progress events ───────  (progress, errors, sha256, bundle id)
  3. SFTP download + size/SHA-256 verify ◄─────── .crossdock/out/App.ipa
  4. ideviceinstaller.exe -i App.ipa ──USB──► iPhone
```

## Prerequisites

- **Phase 1 running**, so the project is mirrored on the Mac (e.g. `/Users/me/proj`). Wait for the sender to go idle before building.
- **Mac:** Xcode + command line tools, Node 18+ (`node` must be on the login-shell PATH; Homebrew is fine), SSH enabled, your key in `~/.ssh/authorized_keys`. The project must be signable for a device (team set in the project or via `--team`; `-allowProvisioningUpdates` is on by default and needs your Apple ID signed into Xcode).
- **Windows:** Node 18+, Apple Mobile Device Support (installed with iTunes or the Apple Devices app; the service was already running here), and a Windows build of **libimobiledevice** providing `ideviceinstaller.exe` and `idevice_id.exe`. CrossDock does not bundle or download it. Put it in `.crossdock/tools/`, on `PATH`, or pass `--idevice-dir`.
- iPhone: plugged in, unlocked, "Trust This Computer" accepted, Developer Mode on (iOS 16+).

## Use

```powershell
cd src/deploy; npm install; npm run build
node out/src/cli.js --host my-mac.local --user me --key ~/.ssh/id_ed25519 `
  --remote-root /Users/me/proj --workspace App.xcworkspace --scheme App --team ABCDE12345
```

Useful variants: `--no-install` (build and fetch only), `--ipa path\App.ipa` (install an existing file, no SSH),
`--device <udid>` when several phones are connected, `--config crossdock.deploy.json` (same options, camelCase keys).
Encrypted keys: set `CROSSDOCK_SSH_PASSPHRASE` (or use ssh-agent). Passwords are not supported.

## Behaviour

- **Progress:** xcodebuild does not report a total, so Mac-side progress is estimated from step markers (compile → link → codesign → done).
  Overall progress is build 0-60 %, fetch 60-80 %, install 80-100 %, written to `.crossdock/crossdock-telemetry.deploy.json`
  (`state`: connecting / building / fetching / installing / done / failed) for the Phase 4 dashboard.
- **Reliability:** SSH connect retries with backoff (0.5 s → 8 s, 6 attempts); a failed or corrupt download reconnects and retries 3 times
  (the `.ipa` stays on the Mac). Auth, host-key and config errors fail immediately. If the SSH link drops *during* the Mac build,
  the run fails with a clear error and can simply be re-run.
- **Security:** same trust-on-first-use host-key file as the extension (`~/.crossdock/known_hosts.json`), refused if changed, pinning
  via `--pin-host-key`. Every config value is single-quote escaped before it reaches the Mac shell (tested against injection strings).
- **Errors you will see:** xcodebuild error lines (and the Mac-side log path `.crossdock/build.log`), no iPhone found / several found, tool missing with the exact fix.
- **Logs:** `~/.crossdock/logs/deploy.log` (verbose always; `--verbose` also prints debug to the console).

## Verification status

| Check | Result |
|---|---|
| `tsc` strict build | pass |
| Unit tests (`npm test`): shell quoting verified in a real POSIX shell with injection strings, command/arg construction, event parsing, progress tracking, build-settings parsing, tool lookup order, installer output parsing, CLI parsing | 11/11 pass |
| Mac script refuses to run off macOS; CLI usage errors (exit 2); missing-`ideviceinstaller` error + failed-state telemetry; SSH retry/backoff then clean failure | pass (exercised for real) |
| `xcodebuild` build, `.ipa` packaging, SFTP fetch, `ideviceinstaller -i` install on an iPhone | **not yet verified: needs a Mac, a signable Xcode project, an iPhone and `ideviceinstaller.exe`** |

Known gaps: the sender's "mirror is up to date" state is not checked automatically before building; `-allowProvisioningUpdates` signing depends
on your Xcode account setup; the Mac-side script is uploaded fresh each run (no version pinning).
