# Phase 4: Telemetry dashboard

A local Next.js (App Router, Tailwind) page that shows what the other three modules are doing, live.

| Panel | Shows | Source |
|---|---|---|
| Connection status: **TCP** | win-sender ↔ Mac receiver link | `.crossdock/crossdock-telemetry.sync.json` |
| Connection status: **SSH** | editor language-server tunnel, or the deploy run's session | `...lsp.json`, `...deploy.json` |
| **Last 10 synced files** | path, latency (change detected → Mac acknowledged), size, age; median and slowest | `...sync.json` |
| **Deployment** | state, live progress bar, build/fetch/install steps, message, `.ipa`, errors | `...deploy.json` |

```powershell
cd src/dashboard; npm install; npm run dev     # http://127.0.0.1:3000
```

## How it works

- Each module writes its **own** fragment atomically (write temp file, rename). Windows C++ and Node cannot safely
  read-modify-write one shared JSON file, so there is no shared writer and no lock.
- `GET /api/telemetry` (`app/api/telemetry/route.ts`) reads the three fixed file names, merges them with the pure
  function in `lib/merge.ts`, and returns JSON with `Cache-Control: no-store`. No part of a request ever reaches a
  file path. Because the project uses Cache Components, the handler calls `connection()` so it runs per request instead of
  being prerendered at build time.
- The page (`components/Dashboard.tsx`) polls once a second (every 5 s while the tab is hidden), shows an explicit
  "lost contact" banner if the API stops answering, and works in light and dark mode and at phone width.
  Status is always text plus a shape (● ▲ ○), never colour alone; the progress bar is a real `progressbar`.
- The dev server binds to `127.0.0.1` only. Telemetry contains file paths and hostnames, so don't expose it.

## "Alive" means a fresh heartbeat

An idle sender and a crashed sender must not look alike, so both long-running modules refresh their file every 5 s:
win-sender on its TCP ping, the VS Code extension on a timer (and it writes `stopped` on shutdown).

| Situation | Dashboard |
|---|---|
| Sender file fresh and `tcp: up` | TCP **Connected** |
| Sender file older than 20 s (process killed/crashed) | TCP **Down**: "no heartbeat for N s" |
| Sender fresh but disconnected | TCP **Down** with the sender's own error (it keeps retrying) |
| VS Code closed (extension file stale) | SSH **No signal**, never a stale "connected" |
| Deploy run active | SSH **Connected** (deploy session) |
| Active deploy silent for 2 min | "No update for…" warning (stalled, not failed) |
| Missing, malformed or hostile files | treated as "no report"; never crashes the API |

## Verification status

| Check | Result |
|---|---|
| `next build` (route `/api/telemetry` is dynamic), `eslint`, `tsc --noEmit` | pass |
| Merge logic unit tests (`npm test`): liveness rules, caps, clamping, malformed input | 9/9 pass |
| In a real browser against **real module output** (real `win-sender.exe` + listener producing syncs; the real extension and deploy telemetry writers) | pass: API returned live data, cards, table and progress bar rendered |
| Killed the real sender while watching the page | TCP flipped to **Down** by itself after ~30 s, no reload |
| Light mode, 375 px width, no horizontal overflow, progressbar ARIA values | pass |
| Deployment panel with a *real* in-flight build/fetch/install | **not yet verified**: needs a Mac and iPhone (the panel was driven by the real deploy telemetry writer with a fetch-state value) |
