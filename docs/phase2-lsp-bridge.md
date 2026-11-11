# Phase 2: IDE LSP bridge

A VS Code extension (`src/vscode-ext`) that gives Swift / Objective-C files on Windows real compiler
feedback by running Apple's `sourcekit-lsp` **on the Mac** and tunnelling the Language Server Protocol over SSH.

```
VS Code ─ vscode-languageclient ─► session (rewrite) ─► ssh2 exec channel ─► xcrun sourcekit-lsp (Mac)
        ◄────────── diagnostics ◄── session (rewrite) ◄──────────────────────┘
```

## Setup

1. Run Phase 1 so the workspace is mirrored on the Mac (`mac-listener --root /Users/me/proj`).
2. Make sure `ssh <user>@<mac> xcrun sourcekit-lsp --help` works from Windows with a key (no password prompts).
3. Build and launch the extension in a dev window:

```powershell
cd src/vscode-ext; npm install; npm run build
code --extensionDevelopmentPath "<repo>\src\vscode-ext" <your-swift-project-folder>
```

4. In that window's settings (or the project's `.vscode/settings.json`):

```json
{
  "crossdock.ssh.host": "my-mac.local",
  "crossdock.ssh.username": "me",
  "crossdock.ssh.privateKeyPath": "~/.ssh/id_ed25519",
  "crossdock.remoteRoot": "/Users/me/proj"
}
```

Open a `.swift` file. The status bar shows `CrossDock: connected`; type `let x: Int = "oops"` and the compiler's
error should appear as a red squiggle. Logs: **CrossDock** output channel and `~/.crossdock/logs/vscode-ext.log`.
Commands: *CrossDock: Reconnect to Mac*, *CrossDock: Show Log*.

## How it works

- **Transport** (`sshTransport.ts`): `ssh2` client, key or ssh-agent auth, keepalives (dead link detected after
  3 missed). Network failures retry with backoff 0.5 s → 10 s. Config, auth and host-key errors are *not* retried.
- **Host keys** (`knownHosts.ts`): trust on first use into `~/.crossdock/known_hosts.json`; a changed key is refused
  with a loud error. Optional pinning via `crossdock.ssh.hostKeyFingerprint`. Passwords are intentionally unsupported;
  an encrypted key prompts for its passphrase and keeps it in memory only.
- **Framing** (`jsonrpc.ts`): `Content-Length` frames, correct across split chunks and multi-byte UTF-8.
- **Bridge** (`session.ts`): every client→Mac message is parsed, rewritten and re-framed, and the same in reverse.
  Rewrites: Windows paths/URIs ⇄ Mac paths/URIs (`pathMap.ts`, including object keys such as `WorkspaceEdit.changes`
  and either drive-letter case); `initialize.processId` → `null` (the Mac cannot see the Windows PID and servers
  that watch it would exit); `didOpen.languageId` forced from the file extension (VS Code says `plaintext` for
  unknown types, which sourcekit-lsp ignores).
- **Resilience** (`extension.ts`): a dropped connection restarts the client, which reconnects and re-opens documents.
  If the remote command exits within 5 s three times in a row (typically a wrong `crossdock.lsp.command` or missing
  Xcode tools) it stops and shows the Mac's stderr instead of looping.
- **Telemetry:** writes `.crossdock/crossdock-telemetry.lsp.json` (SSH state) for the Phase 4 dashboard.

## Verification status

| Check | Result |
|---|---|
| `tsc` strict typecheck + esbuild bundle | pass |
| Unit tests (`npm test`): framing, path mapping, message rewriting, host-key trust | 11/11 pass |
| Extension loads and activates in real VS Code 1.145.1 | pass (isolated profile, log confirmed) |
| SSH connection, `sourcekit-lsp` on the Mac, red squiggles in the editor | **not yet verified: needs a real Mac** |

The end-to-end path was deliberately not tested against mocks; it should be checked on real hardware using the
setup steps above. Known gaps: `.swift` syntax *colouring* relies on semantic tokens from sourcekit-lsp (no
TextMate grammar is bundled yet), and the path mapper does not rewrite Mac paths embedded in the middle of
free-text messages unless they end at a path boundary.
