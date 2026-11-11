# Phase 1: High-speed file sync daemon

Windows -> macOS, one-way, over a raw TCP socket. Native Win32 on the Windows side (no WSL).

| Part | Path | Language |
|---|---|---|
| Sender | `src/daemon/win-sender` | C++17, MSYS2 UCRT64, `ReadDirectoryChangesW`, Winsock |
| Receiver | `src/daemon/mac-listener/listener.js` | Node >= 18, zero dependencies |
| Test harness | `tests/phase1/run.js` | Node |

## Build and run

```powershell
./scripts/build-win-sender.ps1                       # -> src/daemon/win-sender/build/win-sender.exe (static, no DLLs)
node src/daemon/mac-listener/listener.js --root ~/proj --port 9477      # on the Mac
src/daemon/win-sender/build/win-sender.exe --dir C:\proj --host <mac-ip> --port 9477   # on Windows
node tests/phase1/run.js                              # end-to-end tests (loopback)
```

Sender flags: `--dir` (required), `--host`, `--port`, `--telemetry <file>`, `--debounce-ms` (default 1), `--verbose`.
Receiver flags: `--root` (required), `--port`, `--host`, `--keep a,b`, `--no-prune`, `--dry-run`, `--verbose`.

## Wire protocol (big-endian)

```
u8 action | u16 pathLen | path (UTF-8, relative, '/') | u64 size | payload
```

| Action | Meaning | Payload |
|---|---|---|
| 1 WRITE | create/overwrite file | file bytes |
| 2 DELETE | remove file or directory tree | none |
| 3 MKDIR | create directory | none |
| 4 PRUNE | delete everything on receiver not in manifest | `\n`-joined relative paths |
| 5 PING | heartbeat (every 5 s idle) | none |

The receiver replies to every frame with one byte: `0x06` ACK or `0x15` NAK. The sender keeps
at most 256 frames un-acked, and measures latency as *event detected -> ACK received*.
Renames are sent as DELETE(old) + WRITE/MKDIR(new, with subtree).

## Behaviour

- **Debounce:** events are merged for 1 ms (a save produces 2+ events), forced out after 25 ms.
- **Reconnect:** any socket failure -> exponential backoff 250 ms .. 5 s, then a **full resync**
  (every file re-sent, then PRUNE), so changes made while disconnected are never lost.
  Change-buffer overflow also triggers a full resync.
- **Receiver safety:** rejects absolute paths, `..`, empty components; writes via temp file + atomic
  rename; payload cap 256 MiB; PRUNE never deletes `.git .build DerivedData build .crossdock .DS_Store node_modules`
  (Mac-side build products). Sender never sends `.git node_modules .build DerivedData .crossdock .vs .idea`,
  `*.tmp *.swp *.swx *~ .#* .DS_Store`. The two lists must be kept in sync by hand.
- **Skipped PRUNE:** if the sender's scan was incomplete (unreadable file), PRUNE is skipped so the Mac copy is not damaged.
- **Logs:** `~/.crossdock/logs/win-sender.log` and `mac-listener.log` (always DEBUG-level in the file;
  `--verbose` adds DEBUG to the console). Override the folder with `CROSSDOCK_LOG_DIR`.
- **Telemetry:** the sender writes its own fragment, default `.crossdock/crossdock-telemetry.sync.json`
  (`connection.tcp`, last 10 syncs with `latencyMs`). Phase 3 will write a separate fragment and the Phase 4
  dashboard API will merge fragments, because C++ and Node cannot safely read-modify-write one shared JSON file.

## Verification results (loopback, Windows 11, Defender real-time protection ON)

`node tests/phase1/run.js` -> 19/19 passed on 8 consecutive runs. Covers: initial mirror, unicode names,
empty dirs, prune, keep-list, exclusions, nested create, modify, 5 MiB binary integrity, file/dir rename,
file/dir delete, temp-file ignore, path-traversal rejection, receiver crash + automatic reconnect + catch-up,
telemetry JSON, log files.

Latency, `.swift` save -> content visible on the receiver (50 samples/run):

| Measure | Typical result |
|---|---|
| End-to-end, receiver writing to disk on the same PC | p50 ~19 ms, p90 23-43 ms, 0-3 of 50 samples over 50 ms |
| Sender path + TCP only (receiver dry-run) | p50 ~11 ms, p95 ~15 ms |

**Caveat:** about 1-3% of saves stall 45-50 ms inside Windows' `CreateFileW` when opening a file that was
written milliseconds earlier (reproduced outside CrossDock with a bare C++ probe; Defender real-time scanning).
Latency is `debounce + ~10 ms` fixed OS cost, so a longer debounce only hurts. End-to-end numbers on a single
PC also swing between runs (median ~20 to ~40 ms) with browser/OneDrive/Defender load, so the harness asserts:
sender path + TCP (receiver dry-run), the part the code controls, p50 < 30 ms and p90 < 50 ms; end to end, median < 50 ms
and p90 < 100 ms. All numbers, including the worst sample, are printed. A Defender exclusion for the watched folder
should remove the stalls, but that is a security setting and is left to the user.

**Housekeeping:** the sender refreshes its telemetry file on every 5 s heartbeat (so a dashboard can tell an idle
sender from a dead one) and ignores `desktop.ini` / `Thumbs.db`, which OneDrive and Explorer create in synced folders.

**Not yet verified:** real Windows -> Mac latency over a network (no Mac available during development).
Expect network RTT on top of the numbers above; on the Mac side there is no Defender scan.
