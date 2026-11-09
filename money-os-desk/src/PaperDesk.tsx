import { useEffect, useState } from "react";

type Stats = {
  winRate: number | null;
  wins: number;
  losses: number;
  settled: number;
  missed: number;
  totalPnl: number;
  perDay: { date: string; pnl: number }[];
  equity: { t: number; equity: number }[];
  currentStreak: { kind: string; length: number };
  longestWinStreak: number;
  longestLossStreak: number;
  byAlignment: { key: string; n: number; wins: number; pnl: number }[];
  byHour: { hour: number; n: number; pnl: number }[];
  calibration: { bucket: string; n: number; hitRate: number | null }[];
};

type Learning = {
  overall: { n: number; hits: number; rawHitRate: number | null; smoothed: number; trusted: boolean };
  byTimeframe: { key: string; label: string; n: number; hits: number; rawHitRate: number | null; smoothed: number; trusted: boolean; weight: number }[];
  byPattern: { key: string; n: number; hits: number; rawHitRate: number | null; smoothed: number; trusted: boolean; weight: number }[];
  recorded: number;
  minSamples: number;
  method: string;
};

function pct(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(0)}%`;
}

export default function PaperDesk() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [learning, setLearning] = useState<Learning | null>(null);
  const [mode, setMode] = useState("paper");
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    void fetch("/api/paper/stats").then((response) => response.json()).then(setStats).catch(() => setStats(null));
    void fetch("/api/learning/stats").then((response) => response.json()).then(setLearning).catch(() => setLearning(null));
    void fetch("/api/desk/mode").then((response) => response.json()).then((body) => {
      setMode(body.mode);
      setArmed(!!body.liveArmed);
    }).catch(() => undefined);
  }, []);
  async function changeMode(next: string) {
    const response = await fetch("/api/desk/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: next }) });
    const body = await response.json();
    setMode(body.mode || next);
    setArmed(!!body.liveArmed);
  }
  const equity = stats?.equity ?? [];
  const min = Math.min(0, ...equity.map((point) => point.equity));
  const max = Math.max(0, ...equity.map((point) => point.equity));
  const span = max - min || 1;
  const path = equity.map((point, index) => `${(index / Math.max(1, equity.length - 1)) * 280},${80 - ((point.equity - min) / span) * 70}`).join(" ");
  return (
    <section className="spoken-shell" data-testid="paper-desk">
      <div className="spoken-head">
        <div>
          <div className="eyebrow">Paper trader</div>
          <h2>Server-side practice book</h2>
          <p>Paper fills stay in this book. They cannot reach Kalshi. A live order still needs your explicit yes, TRADING_ENABLED, and keys.</p>
        </div>
        <label>Desk mode
          <select aria-label="Desk mode" value={mode} onChange={(event) => void changeMode(event.target.value)}>
            <option value="paper">PAPER</option>
            <option value="live">LIVE</option>
            <option value="both">BOTH</option>
          </select>
        </label>
      </div>
      <p>{armed ? "Live orders are armed." : "Live orders are not armed."} Default on a fresh deploy is PAPER with trading off.</p>
      {stats && (
        <div className="stat-grid">
          <div><span>Win rate</span><strong>{stats.winRate == null ? "—" : `${(stats.winRate * 100).toFixed(1)}%`}</strong></div>
          <div><span>Total P&L</span><strong>{stats.totalPnl.toFixed(2)}</strong></div>
          <div><span>Settled / missed</span><strong>{stats.settled} / {stats.missed}</strong></div>
          <div><span>Streak</span><strong>{stats.currentStreak.length ? `${stats.currentStreak.kind} ${stats.currentStreak.length}` : "—"}</strong></div>
          <div><span>Longest win / loss</span><strong>{stats.longestWinStreak} / {stats.longestLossStreak}</strong></div>
        </div>
      )}
      {equity.length > 1 && <svg viewBox="0 0 280 80" className="equity" role="img" aria-label="Paper equity curve"><polyline points={path} /></svg>}
      <h3>By day</h3>
      <ul>{stats?.perDay.map((day) => <li key={day.date}>{day.date}: {day.pnl.toFixed(2)}</li>)}</ul>
      <h3>By alignment</h3>
      <ul>{stats?.byAlignment.map((row) => <li key={row.key}>{row.key}: {row.wins}/{row.n} · {row.pnl.toFixed(2)}</li>)}</ul>
      <h3>By hour (ET)</h3>
      <ul>{stats?.byHour.map((row) => <li key={row.hour}>{row.hour}:00 · {row.pnl.toFixed(2)}</li>)}</ul>
      <div data-testid="learning-panel">
        <h3>Learning</h3>
        <p>{learning?.method}</p>
        {learning && <p>Overall {learning.overall.hits}/{learning.overall.n} ({pct(learning.overall.rawHitRate)}). Smoothed {pct(learning.overall.smoothed)}. Recorded calls {learning.recorded}. A weight moves only after {learning.minSamples} samples.</p>}
        <h3>Accuracy by timeframe</h3>
        <ul>{learning?.byTimeframe.map((row) => <li key={row.key}>{row.label}: {row.hits}/{row.n} raw {pct(row.rawHitRate)} smoothed {pct(row.smoothed)} weight {row.weight.toFixed(2)}{row.trusted ? "" : " (waiting for samples)"}</li>)}</ul>
        <h3>Accuracy by conflict pattern</h3>
        <ul>{learning?.byPattern.length ? learning.byPattern.map((row) => <li key={row.key}>{row.key}: {row.hits}/{row.n} raw {pct(row.rawHitRate)} smoothed {pct(row.smoothed)} weight {row.weight.toFixed(2)}{row.trusted ? "" : " (waiting for samples)"}</li>) : <li>No known conflict pattern has settled yet.</li>}</ul>
      </div>
      <h3>Calibration</h3>
      <ul>{stats?.calibration.filter((row) => row.n).map((row) => <li key={row.bucket}>{row.bucket}: n={row.n} hit {row.hitRate == null ? "—" : `${(row.hitRate * 100).toFixed(0)}%`}</li>)}</ul>
      <a href="/api/paper/export.csv">Download CSV</a>
    </section>
  );
}
