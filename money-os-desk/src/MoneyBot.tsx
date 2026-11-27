import { useEffect, useState } from "react";
import type { FormEvent } from "react";

const STAKE_FLOORS = [1, 5, 10, 15, 20, 25] as const;
const FLOOR_NOTE = "Strict no-bumping — picks below this floor are skipped";
const POLYMARKET_BADGE = "Manual Review Only — Auto-Execution Parked";
const POLYMARKET_KEYLESS_NOTE = "Polymarket scanning uses public keyless endpoints only. No API key is required or requested. Auto-execution stays parked.";
const CLOB_TOKEN_WARNING = "No CLOB token id on this pick. Shown as scan-only. Nothing is sent.";

type FloorPayload = {
  min_stake_usd: number;
  updated_at: string | null;
  source: "env" | "file" | "default";
  persisted_min_stake_usd: number | null;
  note?: string;
};

type Pick = {
  id: string;
  title: string;
  ticker: string | null;
  recommended_side: "YES" | "NO" | null;
  verdict: "PASS" | "SKIP" | "WATCH" | "FAIL";
  ask: number | null;
  fair_prob: number | null;
  net_edge_cents: number | null;
  dynamic_bar_cents: number | null;
  quarter_kelly_usd: number | null;
  floor_usd: number;
  eligible: boolean;
  reason: string;
  warnings: string[];
  url: string | null;
  venue: string | null;
  spread: number | null;
  manual_only: boolean;
  auto_execution: "parked" | "dry-run";
  scan_only?: boolean;
  keyless?: boolean;
  clob_token_ids?: string[] | null;
  plain: string;
  sample: boolean;
};

type CatalogRow = { id: string; title: string; ticker: string | null; venue: string | null; manual_only?: boolean };

type HourlyPayload = {
  source: "live" | "sample";
  sample: boolean;
  label: string | null;
  scanned_at: string | null;
  floor_usd: number;
  polymarket_auto_execution?: "parked";
  polymarket_scan?: "keyless";
  polymarket_keyless_note?: string;
  picks: Pick[];
  catalog: CatalogRow[];
};

type DryRun = {
  at?: string;
  confirmation?: string;
  title?: string;
  side?: string;
  ticker?: string;
  sample?: boolean;
};

type SuggestPayload = {
  ambiguous?: boolean;
  error?: string;
  pick?: Pick;
  matches?: CatalogRow[];
  label?: string | null;
  sample?: boolean;
};

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function sourceLabel(source: FloorPayload["source"] | undefined): string {
  if (source === "env") return "Environment override";
  if (source === "file") return "Settings file";
  if (source === "default") return "Default";
  return "Reading";
}

function money(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function venueLabel(venue: string | null): string {
  if (venue === "polymarket") return "Polymarket";
  if (venue === "kalshi") return "Kalshi";
  return venue ? venue : "Market";
}

export function MoneyBotSection() {
  const [floor, setFloor] = useState<FloorPayload | null>(null);
  const [hourly, setHourly] = useState<HourlyPayload | null>(null);
  const [activity, setActivity] = useState<DryRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [placingId, setPlacingId] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [suggestion, setSuggestion] = useState<SuggestPayload | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [selectorError, setSelectorError] = useState("");

  const load = async () => {
    const [nextFloor, nextHourly, nextActivity] = await Promise.all([
      readJson<FloorPayload>("/api/moneybot/floor"),
      readJson<HourlyPayload>("/api/moneybot/hourly"),
      readJson<{ dry_runs: DryRun[] }>("/api/moneybot/activity"),
    ]);
    setFloor(nextFloor);
    setHourly(nextHourly);
    setActivity(nextActivity.dry_runs || []);
  };

  useEffect(() => {
    let active = true;
    void load()
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Money Bot is unavailable");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const chooseFloor = async (value: number) => {
    if (loading || saving != null) return;
    if (floor?.min_stake_usd === value && floor.source !== "env") return;
    setSaving(value);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/moneybot/floor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min_stake_usd: value }),
      });
      const data = await res.json() as FloorPayload & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setFloor(data);
      const nextHourly = await readJson<HourlyPayload>("/api/moneybot/hourly");
      setHourly(nextHourly);
      setSuggestion(null);
      if (data.source === "env" && data.min_stake_usd !== value) {
        setNotice(`Saved ${money(value)} to the settings file. The active floor stays ${money(data.min_stake_usd)} while MONEYBOT_MIN_STAKE_USD is set.`);
      } else {
        setNotice(`Stake floor saved at ${money(data.min_stake_usd)}.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the stake floor");
    } finally {
      setSaving(null);
    }
  };

  const dryRun = async (id: string) => {
    if (placingId) return;
    setPlacingId(id);
    setError("");
    try {
      const res = await fetch("/api/moneybot/dry-run-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json() as { confirmation?: string; error?: string; live?: boolean };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.live) throw new Error("Live execution was reported. This control only records a dry run.");
      const confirmation = data.confirmation || "Dry Run Recorded";
      setPlaced((current) => ({ ...current, [id]: confirmation }));
      const nextActivity = await readJson<{ dry_runs: DryRun[] }>("/api/moneybot/activity");
      setActivity(nextActivity.dry_runs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dry run was not recorded");
    } finally {
      setPlacingId(null);
    }
  };

  const lookup = async (value: string) => {
    const trimmed = value.trim();
    setSelectorError("");
    setSuggestion(null);
    if (!trimmed) {
      setSelectorError("Enter a market title or ticker.");
      return;
    }
    setSuggesting(true);
    try {
      const data = await readJson<SuggestPayload>(`/api/moneybot/suggest?q=${encodeURIComponent(trimmed)}`);
      setSuggestion(data);
    } catch (err) {
      setSelectorError(err instanceof Error ? err.message : "No suggestion was returned");
    } finally {
      setSuggesting(false);
    }
  };

  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    void lookup(query);
  };

  const catalog = hourly?.catalog || [];
  const filtered = catalog.filter((row) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return row.title.toLowerCase().includes(q) || (row.ticker || "").toLowerCase().includes(q) || row.id.toLowerCase().includes(q);
  }).slice(0, 8);
  const active = floor?.min_stake_usd;

  return (
    <main className="main" data-testid="section-moneybot">
      <div className="page-heading">
        <div>
          <div className="eyebrow">Live Status · Recent Activity · Controls</div>
          <h1>Money Bot</h1>
          <p>Quarter-Kelly suggestions stay on this desk. Placement here is a dry run and does not send an order.</p>
        </div>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="moneybot-header">
        <section className="panel" data-testid="moneybot-live-status" aria-labelledby="moneybot-live-heading">
          <div className="panel-head">
            <div>
              <div className="panel-title" id="moneybot-live-heading">Live Status</div>
              <div className="panel-kicker">{loading ? "Reading" : sourceLabel(floor?.source)}</div>
            </div>
            <span className="window-badge">{hourly?.sample ? "SAMPLE" : hourly ? "LIVE" : "—"}</span>
          </div>
          <div className="floor-summary">
            <div className="subtle-label">Quarter-Kelly stake floor</div>
            <div className="floor-value" data-testid="stake-floor-value">{loading || active == null ? "—" : money(active)}</div>
            <p className="floor-note">{floor?.note || FLOOR_NOTE}</p>
            <p className="floor-meta">{hourly?.sample ? hourly.label : hourly?.scanned_at ? `Latest scan ${when(hourly.scanned_at)}` : loading ? "Reading the scan" : "No scan timestamp"}</p>
            {floor?.source === "default" && !loading && <p className="floor-meta">Default $5 until a floor is saved.</p>}
            {floor?.source === "env" && <p className="floor-meta">MONEYBOT_MIN_STAKE_USD is the active floor.</p>}
            {floor?.updated_at && <p className="floor-meta">Updated {when(floor.updated_at)}</p>}
          </div>
        </section>

        <section className="panel" data-testid="moneybot-activity" aria-labelledby="moneybot-activity-heading">
          <div className="panel-head">
            <div>
              <div className="panel-title" id="moneybot-activity-heading">Recent Activity</div>
              <div className="panel-kicker">Dry runs only</div>
            </div>
          </div>
          {activity.length === 0 ? <div className="placeholder">No dry-run orders recorded.</div> : (
            <ul className="activity-list">
              {activity.slice(0, 6).map((row, index) => (
                <li key={`${row.at || "run"}-${index}`}>
                  <strong>{row.confirmation || "Dry Run Recorded"}</strong>
                  <span>{row.side || "—"} · {row.title || row.ticker || "Pick"}{row.sample ? " · sample" : ""}</span>
                  <span>{when(row.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" data-testid="moneybot-controls" aria-labelledby="moneybot-controls-heading">
          <div className="panel-head">
            <div>
              <div className="panel-title" id="moneybot-controls-heading">Controls</div>
              <div className="panel-kicker">One tap · six floors</div>
            </div>
          </div>
          <div className="floor-pills" role="group" aria-label="Quarter-Kelly stake floor" aria-busy={saving != null}>
            {STAKE_FLOORS.map((value) => (
              <button
                key={value}
                type="button"
                className={`floor-pill ${active === value ? "active" : ""}`}
                aria-pressed={active === value}
                disabled={loading || saving != null}
                data-testid={`stake-floor-${value}`}
                onClick={() => void chooseFloor(value)}
              >
                {saving === value ? "Saving" : `$${value}`}
              </button>
            ))}
          </div>
          <div className="floor-status" data-testid="stake-floor-status" aria-live="polite">
            {saving != null ? `Saving $${saving}…` : notice}
          </div>
        </section>
      </div>

        <section className="panel" data-testid="hourly-picks" aria-labelledby="hourly-picks-heading">
        <div className="panel-head">
          <div>
            <div className="panel-title" id="hourly-picks-heading">Hourly Forecast Suggested Picks</div>
            <div className="panel-kicker">{hourly?.sample ? "Sample fallback" : "Latest scan"}</div>
          </div>
          <span className="parked-badge" data-testid="polymarket-parked">{POLYMARKET_BADGE}</span>
        </div>
        <p className="keyless-note" data-testid="polymarket-keyless">{hourly?.polymarket_keyless_note || POLYMARKET_KEYLESS_NOTE}</p>
        {hourly?.sample && <div className="sample-banner" role="note" data-testid="sample-banner">{hourly.label}</div>}
        <div className="pick-grid">
          {loading && <div className="placeholder">Reading the hourly forecast.</div>}
          {!loading && (hourly?.picks.length || 0) === 0 && <div className="placeholder">No suggested picks in the latest scan.</div>}
          {(hourly?.picks || []).map((pick) => (
            <PickCard key={pick.id} pick={pick} placing={placingId === pick.id} confirmation={placed[pick.id]} onDryRun={dryRun} />
          ))}
        </div>
      </section>

      <section className="panel" data-testid="market-selector" aria-labelledby="market-selector-heading">
        <div className="panel-head">
          <div>
            <div className="panel-title" id="market-selector-heading">Any-Market Selector</div>
            <div className="panel-kicker">Search the latest scan</div>
          </div>
          <span className="parked-badge">{POLYMARKET_BADGE}</span>
        </div>
        <p className="keyless-note">{POLYMARKET_KEYLESS_NOTE}</p>
        <form className="selector-form" onSubmit={onSearch}>
          <label className="selector-label">
            <span className="size-label">Market</span>
            <input
              className="input"
              aria-label="Search markets"
              data-testid="market-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Title or ticker"
            />
          </label>
          <button className="button-secondary" type="submit" disabled={suggesting}>{suggesting ? "Looking" : "Show suggestion"}</button>
        </form>
        <div className="catalog-list" role="list">
          {filtered.map((row) => (
            <button key={row.id} type="button" className="catalog-row" onClick={() => { setQuery(row.ticker || row.title); void lookup(row.id); }}>
              <strong>{row.title}</strong>
              <span>{row.manual_only ? "Polymarket · manual" : (row.ticker || row.venue || "scan")}</span>
            </button>
          ))}
        </div>
        {selectorError && <div className="form-error" role="alert">{selectorError}</div>}
        {suggestion?.ambiguous && (
          <div className="suggestion-block" data-testid="suggestion">
            <p>More than one market matches. Choose one.</p>
            <div className="catalog-list">
              {(suggestion.matches || []).map((row) => (
                <button key={row.id} type="button" className="catalog-row" onClick={() => void lookup(row.id)}>
                  <strong>{row.title}</strong>
                  <span>{row.ticker || row.id}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {suggestion?.pick && (
          <div className="suggestion-block" data-testid="suggestion">
            {suggestion.sample && suggestion.label && <div className="sample-banner" role="note">{suggestion.label}</div>}
            <PickCard pick={suggestion.pick} placing={placingId === suggestion.pick.id} confirmation={placed[suggestion.pick.id]} onDryRun={dryRun} />
          </div>
        )}
      </section>
    </main>
  );
}

function tokenIds(pick: Pick): string[] {
  return Array.isArray(pick.clob_token_ids) ? pick.clob_token_ids.filter((id) => typeof id === "string" && id.trim()) : [];
}

function PickCard({ pick, placing, confirmation, onDryRun }: { pick: Pick; placing: boolean; confirmation?: string; onDryRun: (id: string) => void }) {
  const warnings = Array.isArray(pick.warnings) ? pick.warnings : [];
  const missingTokens = !!pick.manual_only && tokenIds(pick).length === 0;
  const shownWarnings = missingTokens && !warnings.includes(CLOB_TOKEN_WARNING) ? [...warnings, CLOB_TOKEN_WARNING] : warnings;
  return (
    <article className={`mb-card ${pick.eligible ? "pass" : "skip"}`} data-testid={`pick-${pick.id}`}>
      <header>
        <strong>{pick.verdict}</strong>
        {pick.recommended_side && <span>{pick.recommended_side}</span>}
        {pick.sample && <span className="stale-tag">SAMPLE</span>}
        {pick.manual_only && <span className="parked-badge" data-testid={`parked-${pick.id}`}>{POLYMARKET_BADGE}</span>}
        {missingTokens && <span className="stale-tag" data-testid={`scan-only-${pick.id}`}>SCAN-ONLY</span>}
      </header>
      <h3>{pick.title}</h3>
      <p className="mb-plain">{pick.plain}</p>
      {pick.spread != null && <p className="mb-spread">Spread {`${(pick.spread * 100).toFixed(1)}¢`}</p>}
      {pick.reason && <p className={pick.eligible ? "mb-reason" : "trigger"}>{pick.reason}</p>}
      {shownWarnings.length > 0 && (
        <ul className="stamps">
          {shownWarnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      {pick.url && <p><a className="market-link" href={pick.url} target="_blank" rel="noreferrer noopener">{venueLabel(pick.venue)} market</a></p>}
      {pick.eligible && !pick.manual_only && (
        <button className="button-secondary" type="button" disabled={placing} onClick={() => onDryRun(pick.id)}>
          {placing ? "Recording" : "Dry run this pick"}
        </button>
      )}
      {confirmation && <p className="dry-run-confirm" role="status">{confirmation}</p>}
    </article>
  );
}
