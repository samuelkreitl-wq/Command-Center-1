"""Settle ledgers from public Kalshi market results, and backfill from hourly/picks-log.csv."""
import csv, datetime as dt
from . import kalshi, ledger
from .config import ET, LEDGER_PICKS, LEDGER_PRED, PICKS_LOG

TAB2CAT = {"Climate and Weather": "weather", "Crypto": "crypto", "Commodities": "commodities", "Sports": "sports",
           "Financials": "financials"}

def _f(x):
    try: return float(x)
    except (TypeError, ValueError): return None

def backfill():
    """Import picks with a fair_prob from the hourly picks log (fair_prob is P(chosen side wins))."""
    if not PICKS_LOG.exists(): return 0, 0
    rows = list(csv.DictReader(open(PICKS_LOG, newline="")))
    preds, picks = [], []
    for r in rows:
        fp, pr = _f(r.get("fair_prob")), _f(r.get("price"))
        if fp is None or pr is None or not r.get("ticker"): continue
        cat = TAB2CAT.get(r["tab"], "other")
        side = (r.get("side") or "").upper()
        if side not in ("YES", "NO"): continue
        p_yes = fp if side == "YES" else 1 - fp
        mkt_yes = pr if side == "YES" else 1 - pr       # ask-based (biased by half the spread)
        d = r["timestamp_et"][:10]
        ev = r["ticker"].rsplit("-", 1)[0]
        preds.append(dict(date_et=d, ts_et=r["timestamp_et"], source="backfill-picks-log", category=cat, series=ev.split("-")[0],
                          event_ticker=ev, ticker=r["ticker"], title=r["market_title"], p_model_raw=round(p_yes, 4),
                          p_yes_fair=round(p_yes, 4), p_market_yes=round(mkt_yes, 4), close_time=r.get("close_time_et")))
        picks.append(dict(date_et=d, ts_et=r["timestamp_et"], source="backfill-picks-log", category=cat, group=ev, ticker=r["ticker"],
                          title=r["market_title"], side=side, price=pr, p_side_raw=fp, p_side=fp, edge_c=r.get("edge_cents_after_fees"),
                          verdict=r.get("verdict"), close_time=r.get("close_time_et")))
    return ledger.add_predictions(preds), ledger.add_picks(picks)

def polymarket_results(slugs):
    """Map closed Polymarket markets to Kalshi-like {result: yes/no} (YES = first outcome)."""
    import json as _j
    from . import polymarket
    out = {}
    for sl in slugs:
        try: d = polymarket.g("/markets", slug=sl)
        except Exception: continue
        if not d: continue
        m = d[0]
        if not m.get("closed"): continue
        px = [float(x) for x in _j.loads(m.get("outcomePrices") or "[]")]
        if len(px) == 2 and max(px) > 0.99: out[sl] = dict(result="yes" if px[0] > 0.99 else "no", status="finalized")
    return out

def settle(verbose=True):
    pred, picks = ledger.read(LEDGER_PRED), ledger.read(LEDGER_PICKS)
    open_all = [r for r in pred + picks if r.get("result") in ("", None)]
    open_t = {r["ticker"] for r in open_all if r.get("venue") != "polymarket"}
    open_p = {r["ticker"] for r in open_all if r.get("venue") == "polymarket"}
    mk = kalshi.markets_by_tickers(sorted(open_t)) if open_t else {}
    mk.update(polymarket_results(open_p))
    now = dt.datetime.now(ET).isoformat(timespec="seconds")
    n1 = n2 = 0
    for r in pred:
        m = mk.get(r["ticker"])
        if r.get("result") or not m: continue
        res = (m.get("result") or "").lower()
        if res in ("yes", "no"):
            r.update(result=res, outcome_yes=1 if res == "yes" else 0, settled_at=now, actual_value=m.get("expiration_value") or ""); n1 += 1
        elif m.get("status") in ("finalized", "settled") and res:
            r.update(result=res, settled_at=now)          # void / scalar: excluded from calibration
    for r in picks:
        m = mk.get(r["ticker"])
        if r.get("result") or not m: continue
        res = (m.get("result") or "").lower()
        if res in ("yes", "no"):
            won = int(res == r["side"].lower()); pr = _f(r["price"]) or 0
            fee = (_f(r.get("fee_c")) or 100 * kalshi.fee_per_contract(1, pr)) / 100
            r.update(result=res, won=won, pnl_per_contract=round(won - pr - fee, 4), settled_at=now); n2 += 1
    ledger.write(LEDGER_PRED, pred, ledger.PRED_COLS); ledger.write(LEDGER_PICKS, picks, ledger.PICK_COLS)
    if verbose:
        print(f"Settled {n1} predictions and {n2} picks (looked up {len(mk)}/{len(open_t)} open tickers).")
        print(f"  predictions: {sum(1 for r in pred if r.get('outcome_yes') in ('0','1',0,1))} settled / {len(pred)} total")
        print(f"  picks:       {sum(1 for r in picks if r.get('won') in ('0','1',0,1))} settled / {len(picks)} total")
    return n1, n2
