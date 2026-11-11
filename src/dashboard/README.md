# CrossDock dashboard

Live status page for the CrossDock toolchain (Next.js App Router + Tailwind). It shows TCP and SSH connection
status, the last 10 synced files with latency, and a live deployment progress bar. See
[docs/phase4-dashboard.md](../../docs/phase4-dashboard.md) for how it works.

```powershell
npm install
npm run dev     # http://127.0.0.1:3000 (bound to localhost only)
npm test        # merge-logic unit tests
npm run build   # production build
```

It reads the telemetry fragments the other modules write to `<repo>/.crossdock/`
(override with `CROSSDOCK_TELEMETRY_DIR`). Run it from this folder.
