"""CSV ledgers: predictions (every evaluated market) and picks (every suggested pick)."""
import csv, os, tempfile
from .config import DATA, LEDGER_PICKS, LEDGER_PRED

PRED_COLS = ["date_et", "ts_et", "source", "category", "series", "event_ticker", "ticker", "title",
             "p_model_raw", "p_yes_fair", "p_market_yes", "yes_ask", "no_ask", "close_time",
             "result", "outcome_yes", "settled_at", "venue", "value_key", "pred_mu", "pred_sd", "value_unit", "actual_value"]
PICK_COLS = ["date_et", "ts_et", "source", "category", "group", "ticker", "title", "side", "price", "fee_c",
             "p_side_raw", "p_side", "edge_c", "kelly_quarter", "verdict", "parlay_id", "close_time",
             "result", "won", "pnl_per_contract", "settled_at", "venue", "pred_value", "band"]

def read(path):
    if not path.exists(): return []
    with open(path, newline="") as f: return list(csv.DictReader(f))

def write(path, rows, cols):
    DATA.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore"); w.writeheader(); w.writerows(rows)
    os.replace(tmp, path)

def append_unique(path, cols, new_rows, key):
    rows = read(path); seen = {key(r) for r in rows}; added = 0
    for r in new_rows:
        k = key(r)
        if k in seen: continue
        seen.add(k); rows.append({c: ("" if r.get(c) is None else r.get(c)) for c in cols}); added += 1
    if added: write(path, rows, cols)
    return added

def add_predictions(rows):
    return append_unique(LEDGER_PRED, PRED_COLS, rows, lambda r: (r["date_et"], r["ticker"]))

def add_picks(rows):
    return append_unique(LEDGER_PICKS, PICK_COLS, rows, lambda r: (r["date_et"], r["ticker"], r["side"], r.get("parlay_id") or ""))
