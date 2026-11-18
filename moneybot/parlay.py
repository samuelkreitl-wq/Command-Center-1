"""Build 2-4 leg parlays from independent positive-edge legs.

Kalshi combos (KXMVECROSSCATEGORY... markets) trade on shard 1 and are quoted per request,
so the builder reports the combined fair probability, the market-implied combo price
(product of leg asks) and the most you should pay for the combo to keep >= 2c edge.
"""
import math, itertools, json, datetime as dt
from .config import ET, KELLY_MULT, SCANS
from . import kalshi, ledger
from .fair import weather

def corr_group(r):
    c = r["category"]
    if c == "weather":   # nearby cities share air masses: group by NWS time zone band
        st = weather.STATIONS.get(r["series"])
        return f"wx{st[3]}" if st else r["series"]
    if c == "crypto": return "crypto"            # BTC/ETH/SOL/XRP move together
    if c == "commodities": return r.get("group") or "commod"
    return r["event_ticker"]                     # sports: one leg per game

def growth(p, price, kfrac):
    b = (1 - price) / price
    f = kfrac
    if f <= 0 or f >= 1: return -1
    return p * math.log(1 + f * b) + (1 - p) * math.log(1 - f)

def build(scan, min_legs=2, max_legs=4, top=12, n_out=5, bankroll=100.0, verdicts=("PASS",), min_leg_p=0.30, venues=None):
    legs = [r for r in scan["picks"] if (not venues or r.get("venue", "kalshi") in venues) and r["best"]["verdict"] in verdicts and r["best"]["p_side"] >= min_leg_p]
    # keep best leg per correlation group, then top-N by edge
    best = {}
    for r in sorted(legs, key=lambda r: -r["best"]["edge_c"]):
        best.setdefault(corr_group(r), r)
    pool = sorted(best.values(), key=lambda r: -r["best"]["edge_c"])[:top]
    out = []
    for k in range(min_legs, max_legs + 1):
        for combo in itertools.combinations(pool, k):
            if len({corr_group(r) for r in combo}) < k: continue
            pf = math.prod(r["best"]["p_side"] for r in combo)
            pm = math.prod(r["best"]["price"] for r in combo)
            if pm <= 0.01 or pm >= 0.97: continue
            fee = kalshi.fee_per_contract(10, pm)
            cost = pm + fee
            f = (pf - cost) / (1 - cost)
            if f <= 0: continue
            out.append(dict(legs=combo, p_fair=pf, p_mkt=pm, fee=fee, kelly_full=f, g=growth(pf, cost, f * KELLY_MULT),
                            cats=len({r["category"] for r in combo})))
    out.sort(key=lambda x: (-(x["cats"] >= 2), -x["g"]))
    res = []
    used = set()
    for x in out:
        key = frozenset(r["ticker"] for r in x["legs"])
        if any(len(key & u) >= max(2, len(key) - 1) for u in used): continue
        used.add(key)
        stake = KELLY_MULT * x["kelly_full"] * bankroll
        max_price = x["p_fair"] - 0.02 - x["fee"]
        pid = "P" + dt.datetime.now(ET).strftime("%m%d%H%M") + f"-{len(res)+1}"
        res.append(dict(parlay_id=pid, n_legs=len(x["legs"]), categories=sorted({r["category"] for r in x["legs"]}),
                        combined_fair=round(x["p_fair"], 4), combined_mkt_price=round(x["p_mkt"], 4),
                        edge_c=round(100 * (x["p_fair"] - x["p_mkt"]) - 100 * x["fee"], 2),
                        max_combo_price_to_pay=round(max_price, 3), quarter_kelly=round(KELLY_MULT * x["kelly_full"], 4),
                        stake_usd_at_bankroll=round(stake, 2), payout_multiple=round(1 / x["p_mkt"], 2),
                        venues=sorted({r.get("venue", "kalshi") for r in x["legs"]}),
                        legs=[dict(ticker=r["ticker"], venue=r.get("venue", "kalshi"), category=r["category"], side=r["best"]["side"], price=r["best"]["price"],
                                   p_side=r["best"]["p_side"], edge_c=r["best"]["edge_c"], title=r["title"], deadline=r.get("deadline"))
                              for r in x["legs"]],
                        note=("Kalshi combos live on shard 1 (KXMVECROSSCATEGORY); request a combo quote and only accept <= max_combo_price_to_pay. Legs assumed independent."
                              if all(r.get("venue", "kalshi") == "kalshi" for r in x["legs"]) else
                              "MIXED VENUES: Polymarket has no native parlays, so this can only be placed as separate single tickets (no all-or-nothing payout). Combined numbers are for reference.")))
        if len(res) >= n_out: break
    return res

def log_parlays(ps):
    now = dt.datetime.now(ET); rows = []
    for p in ps:
        for l in p["legs"]:
            rows.append(dict(date_et=now.date().isoformat(), ts_et=now.isoformat(timespec="seconds"), source="parlay", category=l["category"],
                             group="", ticker=l["ticker"], title=l["title"], side=l["side"], price=l["price"], p_side=l["p_side"],
                             p_side_raw=l["p_side"], edge_c=l["edge_c"], verdict="PARLAY-LEG", parlay_id=p["parlay_id"]))
    return ledger.add_picks(rows)

def fmt(p):
    s = [f"{p['parlay_id']}: {p['n_legs']} legs ({', '.join(p['categories'])}) fair {p['combined_fair']*100:.1f}% vs market-implied "
         f"{p['combined_mkt_price']*100:.1f}c (x{p['payout_multiple']}) edge {p['edge_c']:+.1f}c | pay at most {p['max_combo_price_to_pay']*100:.1f}c | "
         f"qK {p['quarter_kelly']:.3f} = ${p['stake_usd_at_bankroll']:.2f} per bankroll"]
    s.append(f"    note: {p['note']}")
    for l in p["legs"]:
        s.append(f"    - [{l['venue']}] {l['ticker']} {l['side']} @{l['price']*100:.0f}c fair {l['p_side']*100:.1f}% ({l['edge_c']:+.1f}c)  {l['title'][:70]}")
    return "\n".join(s)
