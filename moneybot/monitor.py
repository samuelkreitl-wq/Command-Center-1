"""Read-only position monitor. Input: a positions JSON (default: pnl/dumps/latest.json, written by the
hourly routine from read-only Replit pulls). Never places, changes or cancels orders."""
import json, datetime as dt
from pathlib import Path
from . import kalshi, scanner
from .config import PNL_DUMP, UTC, ET, EXIT_WINDOW_MIN, TAKE_PROFIT_C, TAKE_PROFIT_PCT

def category_of(series):
    for c, (ser, fn, _) in scanner.CATS.items():
        if series in ser: return c, fn
    return "other", None

def report(path=None, now=None):
    now = now or dt.datetime.now(UTC)
    p = Path(path or PNL_DUMP)
    d = json.loads(p.read_text())
    pos = [x for x in d.get("positions", []) if abs(kalshi.fnum(x.get("position_fp"), 0)) > 0]
    orders = [o for o in d.get("orders", []) if o.get("status") == "resting"]
    pulled = (d.get("notes") or {}).get("pulled_at_et", "unknown")
    mk = kalshi.markets_by_tickers([x["ticker"] for x in pos])
    rows = []
    for x in pos:
        t = x["ticker"]; q = kalshi.fnum(x["position_fp"]); n = abs(q); side = "YES" if q > 0 else "NO"
        cost = kalshi.fnum(x.get("market_exposure_dollars"), 0) / n
        fees_in = kalshi.fnum(x.get("fees_paid_dollars"), 0) / n
        m = mk.get(t, {})
        bid = kalshi.fnum(m.get("yes_bid_dollars" if side == "YES" else "no_bid_dollars"))
        dl = kalshi.deadline(m) if m else None
        mins = round((dl - now).total_seconds() / 60) if dl else None
        cat, fn = category_of(t.split("-")[0])
        fair = None
        if fn and m:
            r = scanner.evaluate(m, cat, fn, now, 100.0)
            if r and r.get("p_yes_fair") is not None:
                fair = r["p_yes_fair"] if side == "YES" else 1 - r["p_yes_fair"]
        net = None; action = "HOLD"; why = []
        if bid is not None:
            sell_fee = kalshi.fee_per_contract(n, bid)
            net = bid - sell_fee - cost - fees_in
            good = net * 100 >= TAKE_PROFIT_C or (cost > 0 and net >= TAKE_PROFIT_PCT * cost)
            if mins is not None and mins <= EXIT_WINDOW_MIN:
                action, why = "EXIT-DEADLINE", [f"{mins} min to deadline (rule: out by 45 min)"]
            elif fair is not None and bid - sell_fee >= fair + 0.01:
                action = "SELL-CANDIDATE"; why.append(f"bid net {100*(bid-sell_fee):.1f}c >= fair {100*fair:.1f}c")
                if not good: why.append("below take-profit bar (cut-risk case)")
            elif good and fair is not None and bid >= fair - 0.02:
                action = "TAKE-PROFIT-CANDIDATE"; why.append("profit bar met and bid near fair")
            else:
                why.append("fair above bid" if fair is not None and fair > bid else "no model / waiting")
        rows.append(dict(ticker=t, side=side, contracts=n, cost_c=round(100 * cost, 1), bid_c=None if bid is None else round(100 * bid),
                         fair_c=None if fair is None else round(100 * fair, 1), net_if_sold_c=None if net is None else round(100 * net, 1),
                         pnl_if_sold_usd=None if net is None else round(net * n, 2), mins_to_deadline=mins, action=action, why="; ".join(why),
                         resting=[dict(id=o["order_id"][:13], side=o.get("side"), yes_price=o.get("yes_price_dollars"), no_price=o.get("no_price_dollars"),
                                       remaining=o.get("remaining_count_fp")) for o in orders if o.get("ticker") == t]))
    bal = d.get("balances", {})
    return dict(as_of_et=now.astimezone(ET).isoformat(timespec="seconds"), positions_pulled_et=pulled, source=str(p),
                cash_usd=bal.get("balance_dollars"), shards=bal.get("balance_breakdown"), positions=rows,
                note="Read-only. Suggestions only; the exit-monitor routine is what acts.")

def fmt(r):
    s = [f"Positions as of {r['positions_pulled_et']} (quotes/fair {r['as_of_et']}); cash ${r['cash_usd']}"]
    for x in r["positions"]:
        s.append(f"  {x['ticker']:36s} {x['side']} x{x['contracts']:g} cost {x['cost_c']}c bid {x['bid_c']}c fair {x['fair_c']}c "
                 f"net {x['net_if_sold_c']}c/ct (${x['pnl_if_sold_usd']}) {x['mins_to_deadline']}m -> {x['action']} ({x['why']})"
                 f" | resting: {len(x['resting'])}")
    return "\n".join(s)
