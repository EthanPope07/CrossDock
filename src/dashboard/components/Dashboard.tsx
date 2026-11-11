"use client";

import { useEffect, useState } from "react";
import type { DeploymentStatus, LinkStatus, Merged, SyncEvent } from "@/lib/merge";

const POLL_MS = 1000;
const POLL_HIDDEN_MS = 5000;

// ------------------------------------------------------------------ data
function useTelemetry() {
  const [data, setData] = useState<Merged | null>(null);
  const [failures, setFailures] = useState(0);
  // Set in the effect, never during render: Cache Components prerenders this shell and must not freeze the time.
  const [now, setNow] = useState(0);

  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const res = await fetch("/api/telemetry", { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as Merged;
        if (!stop) { setData(json); setFailures(0); }
      } catch {
        if (!stop) setFailures((n) => n + 1);
      }
      if (!stop) timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
    };
    void tick();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop = true; ctrl.abort(); clearTimeout(first); clearTimeout(timer); clearInterval(clock); };
  }, []);

  return { data, failures, now };
}

// ------------------------------------------------------------------ format
const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);

function ago(sec: number | null): string {
  if (sec === null) return "never";
  if (sec < 2) return "just now";
  if (sec < 90) return `${sec} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
}

const sinceIso = (iso: string, now: number): number | null => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null;
};

// ------------------------------------------------------------------ pieces
const PILL = {
  up: { glyph: "●", label: "Connected", cls: "bg-good-bg text-good" },
  down: { glyph: "▲", label: "Down", cls: "bg-bad-bg text-bad" },
  unknown: { glyph: "○", label: "No signal", cls: "bg-track text-muted" },
} as const;

function Pill({ state }: { state: LinkStatus["state"] }) {
  const p = PILL[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-semibold ${p.cls}`}>
      <span aria-hidden="true">{p.glyph}</span>
      {p.label}
    </span>
  );
}

function Card({ title, hint, children, className = "" }: { title: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-card p-5 shadow-sm ${className}`}>
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

function Link({ title, sub, link }: { title: string; sub: string; link: LinkStatus }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="text-xs text-muted">{sub}</div>
        <p className="mt-1.5 text-sm text-muted">{link.detail}</p>
        <p className="mt-0.5 text-xs text-muted">
          {link.host ? <span className="font-mono">{link.host}</span> : null}
          {link.host && link.ageSec !== null ? " · " : null}
          {link.ageSec !== null ? `updated ${ago(link.ageSec)}` : null}
          {link.extra ? ` · ${link.extra}` : null}
        </p>
      </div>
      <Pill state={link.state} />
    </div>
  );
}

function latencyTone(ms: number) {
  if (ms < 50) return { bar: "bg-good", text: "text-good", label: "fast" };
  if (ms < 100) return { bar: "bg-warn", text: "text-warn", label: "ok" };
  return { bar: "bg-bad", text: "text-bad", label: "slow" };
}

function SyncTable({ syncs, stats, now }: { syncs: SyncEvent[]; stats: Merged["syncStats"]; now: number }) {
  if (!syncs.length) {
    return <p className="rounded-lg bg-track px-4 py-6 text-center text-sm text-muted">No files synced yet. Start <code className="font-mono">win-sender.exe</code> and save a file in the watched folder.</p>;
  }
  return (
    <>
      {stats && (
        <p className="mb-3 text-sm text-muted">
          Last {stats.count}: median <strong className="text-ink">{stats.medianMs.toFixed(1)} ms</strong>, slowest <strong className="text-ink">{stats.maxMs.toFixed(1)} ms</strong>
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
          <caption className="sr-only">Most recently synced files with end-to-end latency</caption>
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">File</th>
              <th scope="col" className="py-2 pr-3 font-medium">Latency</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Size</th>
              <th scope="col" className="py-2 text-right font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {syncs.map((s, i) => {
              const tone = latencyTone(s.latencyMs);
              return (
                <tr key={`${s.at}-${s.path}-${i}`} className="border-b border-line/60 last:border-0">
                  <td className="max-w-[18rem] truncate py-2 pr-3 font-mono text-[0.8125rem]" title={s.path}>{s.path}</td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-3">
                      <span className={`w-20 shrink-0 font-mono tabular-nums ${tone.text}`}>{s.latencyMs.toFixed(1)} ms</span>
                      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-track" aria-hidden="true">
                        <span className={`block h-full rounded-full ${tone.bar}`} style={{ width: `${Math.min(100, s.latencyMs)}%` }} />
                      </span>
                      <span className="sr-only">{tone.label}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums text-muted">{s.bytes ? formatBytes(s.bytes) : "–"}</td>
                  <td className="whitespace-nowrap py-2 text-right text-muted">{ago(sinceIso(s.at, now))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

const STEPS = [
  { key: "build", label: "Build on Mac", from: 0, to: 60 },
  { key: "fetch", label: "Fetch .ipa", from: 60, to: 80 },
  { key: "install", label: "Install on iPhone", from: 80, to: 100 },
] as const;

const STATE_STYLE: Record<DeploymentStatus["state"], { label: string; cls: string }> = {
  idle: { label: "Idle", cls: "bg-track text-muted" },
  connecting: { label: "Connecting", cls: "bg-warn-bg text-warn" },
  building: { label: "Building", cls: "bg-warn-bg text-warn" },
  fetching: { label: "Fetching", cls: "bg-warn-bg text-warn" },
  installing: { label: "Installing", cls: "bg-warn-bg text-warn" },
  done: { label: "Done", cls: "bg-good-bg text-good" },
  failed: { label: "Failed", cls: "bg-bad-bg text-bad" },
};

function Deployment({ d }: { d: DeploymentStatus | null }) {
  if (!d) {
    return <p className="rounded-lg bg-track px-4 py-6 text-center text-sm text-muted">No deployment yet. Run <code className="font-mono">crossdock-deploy</code> to build and install.</p>;
  }
  const st = STATE_STYLE[d.state];
  const barTone = d.state === "failed" ? "bg-bad" : d.state === "done" ? "bg-good" : "bg-accent";
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={`rounded-full px-2.5 py-1 text-sm font-semibold ${st.cls}`}>{st.label}</span>
        <span className="font-mono text-2xl font-semibold tabular-nums">{d.progress}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="Deployment progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={d.progress}
        aria-valuetext={`${d.progress} percent, ${st.label}`}
        className="h-3 w-full overflow-hidden rounded-full bg-track"
      >
        <div className={`bar-fill h-full rounded-full ${barTone}`} style={{ width: `${d.progress}%` }} />
      </div>
      <ol className="mt-3 grid grid-cols-3 gap-2 text-xs" aria-label="Deployment steps">
        {STEPS.map((s) => {
          const complete = d.progress >= s.to || d.state === "done";
          const current = !complete && d.progress >= s.from && d.active;
          return (
            <li key={s.key} aria-current={current ? "step" : undefined} className={`rounded-md border px-2 py-1.5 ${current ? "border-accent text-ink" : "border-line text-muted"}`}>
              <span aria-hidden="true">{complete ? "✓ " : current ? "▸ " : "· "}</span>
              {s.label}
              <span className="sr-only">{complete ? " (complete)" : current ? " (in progress)" : " (pending)"}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-sm" aria-live="polite">{d.message || d.stage}</p>
      {d.ipa && <p className="mt-1 truncate font-mono text-xs text-muted" title={d.ipa}>{d.ipa}</p>}
      {d.stalled && <p role="status" className="mt-3 rounded-md bg-warn-bg px-3 py-2 text-sm text-warn">No update for {ago(d.ageSec).replace(" ago", "")}. The deploy process may have been interrupted.</p>}
      {d.error && <pre role="alert" className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-bad-bg px-3 py-2 font-mono text-xs text-bad">{d.error}</pre>}
      <p className="mt-3 text-xs text-muted">Last update {ago(d.ageSec)}</p>
    </div>
  );
}

// ------------------------------------------------------------------ page
export default function Dashboard() {
  const { data, failures, now } = useTelemetry();
  const lost = failures >= 3;

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">CrossDock</h1>
          <p className="text-sm text-muted">Windows → Mac → iPhone toolchain, live</p>
        </div>
        <p className="text-sm text-muted" aria-live="polite">
          {lost ? (
            <span className="font-semibold text-bad">▲ Lost contact with the dashboard API, retrying…</span>
          ) : data ? (
            <span><span className="text-good" aria-hidden="true">●</span> Live · refreshed {ago(Math.max(0, Math.round((now - Date.parse(data.generatedAt)) / 1000)))}</span>
          ) : (
            "Loading…"
          )}
        </p>
      </header>

      {!data ? (
        <p className="rounded-xl border border-line bg-card px-5 py-10 text-center text-muted">Reading telemetry…</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <Card title="Connection status" hint="TCP file sync · SSH tunnel">
            <Link title="TCP file sync" sub="win-sender → Mac listener" link={data.tcp} />
            <Link title="SSH to the Mac" sub="editor language server / deploy session" link={data.ssh} />
          </Card>
          <Card title="Deployment" hint="build → fetch → install">
            <Deployment d={data.deployment} />
          </Card>
          <Card title="Last 10 synced files" hint="latency = change detected → Mac acknowledged" className="md:col-span-2">
            <SyncTable syncs={data.syncs} stats={data.syncStats} now={now} />
          </Card>
        </div>
      )}
    </main>
  );
}
