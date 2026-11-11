# CrossDock

**Write iOS code on Windows. Build it on a Mac you never touch. Land the app on your iPhone over USB.**

CrossDock is a remote distributed build engine: it syncs your source from a Windows PC to a headless
macOS build server, compiles it there with Xcode, and installs the resulting `.ipa` on an iPhone plugged
into the Windows machine, with editor support and a live dashboard along the way. Everything on the Windows
side is native Win32. No WSL, no network drives.

```
 Windows PC                                   macOS build server
 ┌──────────────────────┐   raw TCP / SSH    ┌────────────────────────┐
 │ VS Code + extension  │ ◄────────────────► │ sourcekit-lsp          │
 │ win-sender (C++)     │ ─── file deltas ─► │ mac-listener           │
 │ deploy (Node)        │ ◄──── .ipa ─────── │ xcodebuild             │
 │ dashboard (Next.js)  │                    └────────────────────────┘
 └─────────┬────────────┘
           │ USB (ideviceinstaller)
        iPhone
```

## Status

| Phase | Module | State |
|---|---|---|
| 1 | **File sync daemon**: `src/daemon` (C++ sender, Node receiver) | ✅ Built and tested, see [docs/phase1-file-sync.md](docs/phase1-file-sync.md) |
| 2 | **IDE LSP bridge**: `src/vscode-ext` (TypeScript) | 🟡 Built, unit-tested, loads in VS Code; needs a real Mac to verify end to end, see [docs/phase2-lsp-bridge.md](docs/phase2-lsp-bridge.md) |
| 3 | **Remote build + USB deploy**: `src/deploy` (Node) | 🟡 Built and unit-tested; needs a Mac, an iPhone and `ideviceinstaller.exe` to verify end to end, see [docs/phase3-build-deploy.md](docs/phase3-build-deploy.md) |
| 4 | **Telemetry dashboard**: `src/dashboard` (Next.js + Tailwind) | 🔜 Scaffolded only |

Each module runs and tests independently and talks to the others over stdin/stdout, TCP, or local JSON files.
Network drops are expected: the daemons reconnect automatically and resync. Verbose logs go to `~/.crossdock/logs/`.

## Try Phase 1

Requirements: Windows 10/11, [MSYS2](https://www.msys2.org/) UCRT64 (`g++`, `cmake`, `ninja`), Node 18+.

```powershell
./scripts/build-win-sender.ps1        # builds src/daemon/win-sender/build/win-sender.exe
node tests/phase1/run.js              # end-to-end test suite over loopback
```

Watch it work live (one command per terminal tab, then edit files in `demo/windows-side`):

```powershell
./scripts/demo-phase1.ps1 receiver
./scripts/demo-phase1.ps1 sender
./scripts/demo-phase1.ps1 view
```

Measured on loopback with Windows Defender on: a saved `.swift` file is visible on the receiver in a median of
~19 ms. About 1-3% of saves hit a 45-50 ms Windows file-open stall that is outside CrossDock's control (details in the
Phase 1 doc). Real Windows → Mac latency over a network is not yet measured.

## Design notes

- **Wire protocol:** `[action, path, size, payload]` frames, one ACK byte per frame; renames are DELETE + WRITE.
- **Correctness first:** receiver writes atomically, rejects path traversal, and never prunes Mac-side build output.
- **No shared-file races:** each module writes its own telemetry fragment; the dashboard merges them.

## License

[MIT](LICENSE) © 2026 Ethan Pope
