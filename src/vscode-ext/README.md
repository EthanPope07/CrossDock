# CrossDock for VS Code

Swift and Objective-C language features on **Windows**, powered by Apple's `sourcekit-lsp` running on your **Mac**
over SSH. Part of [CrossDock](https://github.com/EthanPope07/CrossDock).

## Setup

1. Keep your project mirrored on the Mac with CrossDock's file sync (`win-sender` / `mac-listener`).
2. Make sure `ssh <user>@<mac> xcrun sourcekit-lsp --help` works from Windows using a key (no password prompts).
3. Set these in your VS Code settings (or the project's `.vscode/settings.json`):

```json
{
  "crossdock.ssh.host": "my-mac.local",
  "crossdock.ssh.username": "me",
  "crossdock.ssh.privateKeyPath": "~/.ssh/id_ed25519",
  "crossdock.remoteRoot": "/Users/me/proj"
}
```

Open a `.swift` file. The status bar shows **CrossDock: connected** and compiler errors appear as squiggles.

## Commands

- **CrossDock: Reconnect to Mac**
- **CrossDock: Show Log** (also `~/.crossdock/logs/vscode-ext.log`)

## Security

SSH keys or ssh-agent only; passwords are not supported. The Mac's host key is trusted on first use and refused if it
ever changes (optionally pin it with `crossdock.ssh.hostKeyFingerprint`).

Full documentation: [docs/phase2-lsp-bridge.md](https://github.com/EthanPope07/CrossDock/blob/main/docs/phase2-lsp-bridge.md).
