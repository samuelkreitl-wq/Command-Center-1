import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  KALSHI_KEYS_MISSING,
  TRADE_LOG_REFRESH_MS,
  etDay,
  formatCount,
  formatEdge,
  formatEt,
  formatMoney,
  formatPrice,
  formatProb,
  formatSignedMoney,
  formatStake,
  type FillRow,
  type PickRow,
  type PositionRow,
  type SkippedRow,
  type TradeLogView,
} from "./lib/trade-log";

type FilterState = { q: string; tab: string; verdict: string; side: string; from: string; to: string };
const EMPTY_FILTER: FilterState = { q: "", tab: "", verdict: "", side: "", from: "", to: "" };

type Column<T> = { header: string; className?: string; cell: (row: T) => ReactNode };

export function TradeLogSection() {
  const [view, setView] = useState<TradeLogView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const generation = useRef(0);
  const load = useCallback(async () => {
    const id = ++generation.current;
    setRefreshing(true);
    try {
      const res = await fetch("/api/desk/trade-log");
      if (!res.ok) throw new Error(`Trade log HTTP ${res.status}`);
      const body = (await res.json()) as TradeLogView;
      if (id !== generation.current) return;
      setView(body);
      setError("");
    } catch (err) {
      if (id !== generation.current) return;
      setError(err instanceof Error ? err.message : "Trade log unavailable");
    } finally {
      if (id === generation.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), TRADE_LOG_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const keysMissing = view != null && !view.kalshi.configured;
  return (
    <main className="main" data-testid="section-trade-log">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Read only · Kalshi and the pick feed</div>
          <h1>Trade log</h1>
          <p>Today's picks, open positions, and running P&amp;L. This tab does not place or cancel an order.</p>
        </div>
        <div className="log-heading-actions">
          <button className="refresh-button" type="button" data-testid="trade-log-refresh" onClick={() => void load()} disabled={refreshing}>
            <span className={`refresh-icon ${refreshing ? "refreshing" : ""}`}>↻</span>{refreshing ? "Updating" : "Refresh"}
          </button>
          <div className="time-stamp" data-testid="trade-log-status">EVERY 5 MIN<br />{view ? `UPDATED ${formatEt(view.refreshedAt)}` : "WAITING"}</div>
        </div>
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {view?.feed.error && <p className="data-note" role="status">Pick feed: {view.feed.error}</p>}
      {view && !view.feed.error && (
        <p className="data-note" data-testid="feed-generated">
          Pick feed {view.feed.host || "—"} · generated {formatEt(view.feed.generatedAt)}
        </p>
      )}
      {keysMissing && (
        <section className="panel needs-key" data-testid="kalshi-keys-missing">
          <div className="panel-head"><div className="panel-title">{KALSHI_KEYS_MISSING}</div></div>
          <p>Set <code>KALSHI_API_KEY_ID</code> and <code>KALSHI_PRIVATE_KEY_PEM</code> on the server. Live positions, settlement P&amp;L, and fills stay blank until then. Picks and skipped orders still come from the pick feed.</p>
        </section>
      )}
      {view?.kalshi.configured && view.kalshi.error && <div className="error-banner" role="alert">{view.kalshi.error}</div>}

      <div className="log-stack">
        <TableSection
          title="Today's picks"
          testId="trade-today"
          rows={view?.picksToday ?? []}
          loading={loading && !view}
          empty="No picks for today."
          filters={["search", "tab", "verdict", "side"]}
          searchText={pickSearch}
          tab={(row) => row.tab}
          verdict={(row) => row.verdict}
          side={(row) => row.side}
          columns={pickColumns}
        />
        <TableSection
          title="Current positions"
          testId="trade-positions"
          rows={view?.positions ?? []}
          loading={loading && !view}
          empty={keysMissing ? KALSHI_KEYS_MISSING : "No open positions."}
          filters={["search", "tab", "verdict", "side"]}
          searchText={(row) => `${row.ticker} ${row.market} ${row.shardLabel}`}
          tab={(row) => row.tab}
          verdict={(row) => row.verdict}
          side={(row) => row.side}
          columns={positionColumns}
        />
        <PnlSection view={view} loading={loading && !view} />
        <TableSection
          title="Full pick log"
          testId="trade-log-table"
          rows={view?.pickLog ?? []}
          loading={loading && !view}
          empty="No picks in the log."
          filters={["search", "tab", "verdict", "side", "date"]}
          searchText={pickSearch}
          tab={(row) => row.tab}
          verdict={(row) => row.verdict}
          side={(row) => row.side}
          day={(row) => etDay(row.timestamp)}
          columns={pickColumns}
        />
        <TableSection
          title="Recent fills"
          testId="trade-fills"
          kicker={fillKicker(view)}
          rows={view?.fills ?? []}
          loading={loading && !view}
          empty={keysMissing && !(view?.fills.length) ? KALSHI_KEYS_MISSING : "No fills."}
          filters={["search", "tab", "verdict", "side", "date"]}
          searchText={(row) => `${row.ticker} ${row.market} ${row.action}`}
          tab={(row) => row.tab}
          verdict={(row) => row.verdict}
          side={(row) => row.side}
          day={(row) => etDay(row.timestamp)}
          columns={fillColumns}
        />
        <TableSection
          title="Skipped orders"
          testId="trade-skipped"
          rows={view?.skipped ?? []}
          loading={loading && !view}
          empty="No skipped orders."
          filters={["search", "tab", "verdict", "side", "date"]}
          searchText={(row) => `${row.ticker} ${row.market} ${row.reason}`}
          tab={(row) => row.tab}
          verdict={(row) => row.verdict}
          side={(row) => row.side}
          day={(row) => etDay(row.timestamp)}
          columns={skippedColumns}
        />
      </div>
    </main>
  );
}

function fillKicker(view: TradeLogView | null): string {
  if (!view || view.fills.length === 0) return "";
  return view.fills[0].source === "kalshi" ? "Live Kalshi" : "Pick feed";
}

function PnlSection({ view, loading }: { view: TradeLogView | null; loading: boolean }) {
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const days = view?.pnl.byDay ?? [];
  const filtered = days.filter((day) => inRange(day.date, filter.from, filter.to));
  return (
    <details className="panel log-panel" open data-testid="trade-pnl">
      <summary>
        <h2>Running P&amp;L</h2>
        <span className="log-count">{view?.pnl.source === "kalshi" ? "Kalshi" : view?.pnl.source === "feed" ? "Pick feed" : ""}</span>
      </summary>
      {loading ? <div className="placeholder">Loading the trade log.</div> : (
        <>
          <div className="log-metrics">
            <Metric label="Realized" value={view?.pnl.realized ?? null} />
            <Metric label="Unrealized" value={view?.pnl.unrealized ?? null} />
            <Metric label="Total" value={view?.pnl.total ?? null} />
          </div>
          {view?.pnl.note && <p className="data-note log-note">{view.pnl.note}</p>}
          <div className="panel-head">
            <div>
              <div className="panel-title">Cash by shard</div>
              <div className="panel-kicker">From Kalshi balance</div>
            </div>
          </div>
          {(view?.kalshi.shards.length ?? 0) === 0 ? (
            <div className="placeholder">{view && !view.kalshi.configured ? KALSHI_KEYS_MISSING : "No shard balances."}</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Shard</th><th>Cash</th></tr></thead>
                <tbody>
                  {view?.kalshi.shards.map((shard) => (
                    <tr key={shard.index}>
                      <td className="table-primary">{shard.label}</td>
                      <td>{formatMoney(shard.dollars)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <FilterBar title="Running P&L" value={filter} onChange={setFilter} rows={days} tab={() => ""} verdict={() => ""} side={() => ""} show={["date"]} />
          {filtered.length === 0 ? (
            <div className="placeholder">{days.length ? "Nothing matches these filters." : "No settlement days."}</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Day (ET)</th><th>Realized</th><th>Unrealized</th><th>Total</th></tr></thead>
                <tbody>
                  {filtered.map((day) => (
                    <tr key={day.date}>
                      <td className="table-primary">{day.date}</td>
                      <td className={tone(day.realized)}>{formatSignedMoney(day.realized)}</td>
                      <td className={tone(day.unrealized)}>{formatSignedMoney(day.unrealized)}</td>
                      <td className={tone(day.total)}>{formatSignedMoney(day.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </details>
  );
}

function Metric({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="log-metric">
      <div className="metric-label">{label}</div>
      <div className={`log-metric-value ${tone(value)}`}>{formatSignedMoney(value)}</div>
    </div>
  );
}

function TableSection<T>({
  title,
  testId,
  kicker,
  rows,
  loading,
  empty,
  filters,
  searchText,
  tab,
  verdict,
  side,
  day,
  columns,
}: {
  title: string;
  testId: string;
  kicker?: string;
  rows: T[];
  loading: boolean;
  empty: string;
  filters: Array<"search" | "tab" | "verdict" | "side" | "date">;
  searchText: (row: T) => string;
  tab: (row: T) => string;
  verdict: (row: T) => string;
  side: (row: T) => string;
  day?: (row: T) => string;
  columns: Column<T>[];
}) {
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const filtered = useMemo(() => rows.filter((row) => {
    if (filter.q && !searchText(row).toLowerCase().includes(filter.q.trim().toLowerCase())) return false;
    if (filter.tab && tab(row) !== filter.tab) return false;
    if (filter.verdict && verdict(row) !== filter.verdict) return false;
    if (filter.side && side(row) !== filter.side) return false;
    if (day && !inRange(day(row), filter.from, filter.to)) return false;
    return true;
  }), [rows, filter, searchText, tab, verdict, side, day]);
  return (
    <details className="panel log-panel" open data-testid={testId}>
      <summary>
        <h2>{title}</h2>
        <span className="log-count">{kicker ? `${kicker} · ` : ""}{filtered.length === rows.length ? rows.length : `${filtered.length} of ${rows.length}`}</span>
      </summary>
      {loading ? <div className="placeholder">Loading the trade log.</div> : (
        <>
          <FilterBar title={title} value={filter} onChange={setFilter} rows={rows} tab={tab} verdict={verdict} side={side} show={filters} />
          {filtered.length === 0 ? (
            <div className="placeholder">{rows.length ? "Nothing matches these filters." : empty}</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>{columns.map((column) => <th key={column.header}>{column.header}</th>)}</tr></thead>
                <tbody>
                  {filtered.map((row, index) => (
                    <tr key={rowKey(row, index)}>
                      {columns.map((column) => <td key={column.header} className={column.className}>{column.cell(row)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </details>
  );
}

function FilterBar<T>({
  title,
  value,
  onChange,
  rows,
  tab,
  verdict,
  side,
  show,
}: {
  title: string;
  value: FilterState;
  onChange: (next: FilterState) => void;
  rows: T[];
  tab: (row: T) => string;
  verdict: (row: T) => string;
  side: (row: T) => string;
  show: Array<"search" | "tab" | "verdict" | "side" | "date">;
}) {
  const tabs = unique(rows.map(tab));
  const verdicts = unique(rows.map(verdict));
  const sides = unique(rows.map(side));
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });
  return (
    <div className="log-filters">
      {show.includes("search") && (
        <label className="log-filter log-filter-search">
          <span>Search</span>
          <input className="input" aria-label={`${title} search`} value={value.q} placeholder="Ticker or market" onChange={(event) => set({ q: event.target.value })} />
        </label>
      )}
      {show.includes("tab") && (
        <label className="log-filter">
          <span>Tab</span>
          <select className="input" aria-label={`${title} tab`} value={value.tab} onChange={(event) => set({ tab: event.target.value })}>
            <option value="">All</option>
            {tabs.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      )}
      {show.includes("verdict") && (
        <label className="log-filter">
          <span>Verdict</span>
          <select className="input" aria-label={`${title} verdict`} value={value.verdict} onChange={(event) => set({ verdict: event.target.value })}>
            <option value="">All</option>
            {verdicts.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      )}
      {show.includes("side") && (
        <label className="log-filter">
          <span>Side</span>
          <select className="input" aria-label={`${title} side`} value={value.side} onChange={(event) => set({ side: event.target.value })}>
            <option value="">All</option>
            {sides.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      )}
      {show.includes("date") && (
        <>
          <label className="log-filter">
            <span>From</span>
            <input className="input" type="date" aria-label={`${title} from`} value={value.from} onChange={(event) => set({ from: event.target.value })} />
          </label>
          <label className="log-filter">
            <span>To</span>
            <input className="input" type="date" aria-label={`${title} to`} value={value.to} onChange={(event) => set({ to: event.target.value })} />
          </label>
        </>
      )}
    </div>
  );
}

const pickColumns: Column<PickRow>[] = [
  { header: "Time (ET)", cell: (row) => formatEt(row.timestamp) },
  { header: "Tab", cell: (row) => row.tab || "—" },
  { header: "Market", className: "table-primary cell-note", cell: (row) => row.market || "—" },
  { header: "Ticker", cell: (row) => row.ticker || "—" },
  { header: "Side", className: "", cell: (row) => <span className={sideTone(row.side)}>{row.side || "—"}</span> },
  { header: "Price", cell: (row) => formatPrice(row.price) },
  { header: "Fair", cell: (row) => formatProb(row.fairProb) },
  { header: "Edge", cell: (row) => formatEdge(row.edgeCents) },
  { header: "Stake", cell: (row) => formatStake(row.stakeDollars, row.stakeContracts) },
  { header: "Verdict", cell: (row) => <span className={verdictTone(row.verdict)}>{row.verdict || "—"}</span> },
  { header: "Close (ET)", cell: (row) => formatEt(row.closeTime) },
  { header: "Notes", className: "cell-note", cell: (row) => row.notes || "—" },
];

const positionColumns: Column<PositionRow>[] = [
  { header: "Market", className: "table-primary cell-note", cell: (row) => row.market },
  { header: "Ticker", cell: (row) => row.ticker },
  { header: "Side", cell: (row) => <span className={sideTone(row.side)}>{row.side}</span> },
  { header: "Contracts", cell: (row) => formatCount(row.contracts) },
  { header: "Avg", cell: (row) => formatPrice(row.avgPrice) },
  { header: "Mark", cell: (row) => formatPrice(row.mark) },
  { header: "Unrealized", cell: (row) => <span className={tone(row.unrealized)}>{formatSignedMoney(row.unrealized)}</span> },
  { header: "Shard", cell: (row) => row.shardLabel },
  { header: "Updated (ET)", cell: (row) => formatEt(row.updated) },
];

const fillColumns: Column<FillRow>[] = [
  { header: "Time (ET)", cell: (row) => formatEt(row.timestamp) },
  { header: "Ticker", className: "table-primary", cell: (row) => row.ticker || "—" },
  { header: "Side", cell: (row) => <span className={sideTone(row.side)}>{row.side || "—"}</span> },
  { header: "Action", cell: (row) => row.action || "—" },
  { header: "Contracts", cell: (row) => formatCount(row.count) },
  { header: "Price", cell: (row) => formatPrice(row.price) },
  { header: "Fee", cell: (row) => formatMoney(row.fee) },
  { header: "Shard", cell: (row) => row.shardLabel },
];

const skippedColumns: Column<SkippedRow>[] = [
  { header: "Time (ET)", cell: (row) => formatEt(row.timestamp) },
  { header: "Tab", cell: (row) => row.tab || "—" },
  { header: "Market", className: "table-primary cell-note", cell: (row) => row.market || "—" },
  { header: "Ticker", cell: (row) => row.ticker || "—" },
  { header: "Side", cell: (row) => <span className={sideTone(row.side)}>{row.side || "—"}</span> },
  { header: "Price", cell: (row) => formatPrice(row.price) },
  { header: "Reason", className: "cell-note", cell: (row) => row.reason || "—" },
];

function pickSearch(row: PickRow): string {
  return `${row.ticker} ${row.market} ${row.notes} ${row.tab}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function inRange(day: string, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function tone(value: number | null): string {
  if (value == null || value === 0) return "";
  return value > 0 ? "result-good" : "result-bad";
}

function sideTone(side: string): string {
  if (side === "YES") return "result-good";
  if (side === "NO") return "result-bad";
  return "";
}

function verdictTone(verdict: string): string {
  if (verdict === "PASS") return "result-good";
  if (verdict === "FAIL") return "result-bad";
  return "";
}

function rowKey(row: unknown, index: number): string {
  if (row && typeof row === "object" && "id" in row && typeof row.id === "string" && row.id) return row.id;
  return String(index);
}
