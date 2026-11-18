"""Scan open Kalshi markets in weather / crypto / commodities / sports and price them."""
import json, math, datetime as dt
from concurrent.futures import ThreadPoolExecutor
from . import kalshi, calibrate, ledger
from .config import ET, UTC, SCANS, MIN_EDGE_C, MIN_EDGE_PCT, KELLY_MULT, NO_BUY_WITHIN_MIN
from .fair import weather, markets as fm, sports

CATS = {
    "weather": (list(weather.STATIONS), weather.fair_yes, 60),
    "crypto": (list(fm.CRYPTO), fm.fair_yes, 48),
    "commodities": (list(fm.COMMOD), fm.fair_yes, 72),
    "sports": (list(sports.LEAGUES), sports.fair_yes, 24 * 8),
}
SUSPECT_EDGE_C = 25.0

def price_side(p, ask, depth, bankroll, fee_fn=None):
    """Return dict for buying a side at `ask` with win prob p (quarter Kelly at planned size)."""
    if ask is None or not (0.02 <= ask <= 0.97): return None
    fpc = fee_fn or kalshi.fee_per_contract
    fee10 = fpc(10, ask)
    cost = ask + fee10
    f = (p - cost) / (1 - cost) if cost < 1 else -1
    stake = max(0.0, KELLY_MULT * f * bankroll)
    C = int(stake // cost) if stake > 0 else 0
    if depth is not None: C = min(C, int(depth))
    feec = fpc(max(C, 1), ask)
    edge_c = 100 * (p - ask) - 100 * feec
    edge_worst = 100 * (p - ask) - 100 * fpc(1, ask)
    return dict(price=ask, fee_c=round(100 * feec, 2), edge_c=round(edge_c, 2), edge_c_1ct=round(edge_worst, 2),
                kelly_full=round(f, 4), kelly_quarter=round(KELLY_MULT * max(f, 0), 4), contracts=C,
                stake_usd=round(C * (ask + feec), 2), depth=depth)

GAP_GUARD = 0.15   # |fair - market mid| above this -> WATCH only (reality check needed)

def evaluate(m, cat, fn, now, bankroll, venue="kalshi", fee_fn=None):
    try: fv = fn(m, now)
    except Exception as e: fv = dict(p_yes=None, reason=f"model error: {str(e)[:90]}")
    if not fv: return None
    ya, na = kalshi.fnum(m.get("yes_ask_dollars")), kalshi.fnum(m.get("no_ask_dollars"))
    yb = kalshi.fnum(m.get("yes_bid_dollars"))
    pm = (ya + yb) / 2 if ya and yb else None
    raw = fv.get("p_yes")
    rec = dict(venue=venue, category=cat, series=m["event_ticker"].split("-")[0], event_ticker=m["event_ticker"], ticker=m["ticker"],
               title=m.get("_title") or f"{m.get('title','')} — {m.get('yes_sub_title','')}", close_time=m.get("close_time"),
               deadline=(kalshi.deadline(m).isoformat() if kalshi.deadline(m) else None),
               yes_ask=ya, no_ask=na, yes_bid=yb, p_market_yes=pm, p_model_raw=raw, group=fv.get("group", m["event_ticker"]),
               model=fv.get("model"), inputs=fv.get("inputs"), value=fv.get("value"),
               strike_type=m.get("strike_type"), floor_strike=m.get("floor_strike"), cap_strike=m.get("cap_strike"), unverified=fv.get("unverified", []), reason=fv.get("reason"))
    if raw is None:
        rec.update(p_yes_fair=None, best=None); return rec
    p = calibrate.apply(cat, raw, pm)
    rec["p_yes_fair"] = round(p, 4)
    yes = price_side(p, ya, kalshi.fnum(m.get("yes_ask_size_fp")), bankroll, fee_fn)
    no = price_side(1 - p, na, kalshi.fnum(m.get("yes_bid_size_fp")), bankroll, fee_fn)
    sides = [("YES", yes, p, raw), ("NO", no, 1 - p, 1 - raw)]
    sides = [s for s in sides if s[1]]
    if not sides: rec["best"] = None; return rec
    side, s, ps, pr = max(sides, key=lambda x: x[1]["edge_c"])
    s.update(side=side, p_side=round(ps, 4), p_side_raw=round(pr, 4))
    ok = s["edge_c"] >= MIN_EDGE_C and s["edge_c"] >= 100 * MIN_EDGE_PCT * s["price"]
    flags = []
    if s["edge_c"] >= SUSPECT_EDGE_C: flags.append("edge >= 25c: likely model/data error, needs a human look")
    if (s.get("depth") or 0) < 1: flags.append("no displayed depth at ask")
    if pm is not None and abs(raw - pm) > 2 * GAP_GUARD:
        flags.append(f"raw model vs market gap {abs(raw-pm)*100:.0f} pts > {2*GAP_GUARD*100:.0f}: calibration is carrying the pick")
    if pm is not None and abs(p - pm) > GAP_GUARD: flags.append(f"fair vs market gap {abs(p-pm)*100:.0f} pts > {GAP_GUARD*100:.0f}: model likely missing info")
    if s["edge_c_1ct"] < MIN_EDGE_C: flags.append("edge fails at 1-contract fee rounding")
    hard = [f for f in flags if not f.startswith("edge fails at 1-contract")]
    s["verdict"] = "PASS" if ok and not hard else ("WATCH" if s["edge_c"] > 0 else "NO-EDGE")
    s["flags"] = flags
    rec["best"] = s
    return rec

def scan(categories=None, bankroll=100.0, log=True, now=None, venues=("kalshi", "polymarket")):
    now = now or dt.datetime.now(UTC)
    categories = categories or list(CATS)
    jobs = []
    for cat in (categories if "kalshi" in venues else []):
        series_list, fn, horizon_h = CATS[cat]
        for sr in series_list:
            jobs.append((cat, sr, fn, horizon_h))

    def run_series(job):
        cat, sr, fn, horizon_h = job
        try: ms = kalshi.markets(series=sr)
        except Exception as e: return [dict(category=cat, series=sr, error=str(e)[:100])]
        out = []
        for m in ms:
            dl = kalshi.deadline(m)
            if not dl: continue
            mins = (dl - now).total_seconds() / 60
            if mins < NO_BUY_WITHIN_MIN or mins > horizon_h * 60: continue
            ya, na = kalshi.fnum(m.get("yes_ask_dollars")), kalshi.fnum(m.get("no_ask_dollars"))
            if not ya and not na: continue
            if cat == "crypto" and ya is not None and na is not None and (ya <= 0.02 or na <= 0.02):
                continue   # far-from-spot strikes: skip (no tradeable edge, saves model calls)
            r = evaluate(m, cat, fn, now, bankroll)
            if r: r["mins_to_deadline"] = round(mins); out.append(r)
        return out

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = [r for rs in ex.map(run_series, jobs) for r in rs]
    if "polymarket" in venues:
        from . import polymarket
        try: results += polymarket.scan(categories, now, bankroll)
        except Exception as e: results.append(dict(category="polymarket", series="*", error=f"polymarket scan failed: {str(e)[:120]}"))
    errors = [r for r in results if "error" in r]
    recs = [r for r in results if "error" not in r]
    picks = sorted([r for r in recs if r.get("best") and r["best"]["edge_c"] > 0], key=lambda r: -r["best"]["edge_c"])
    stamp = dt.datetime.now(ET)
    out = dict(created_et=stamp.isoformat(timespec="seconds"), bankroll_for_kelly=bankroll, n_markets=len(recs),
               n_priced=sum(1 for r in recs if r.get("p_yes_fair") is not None),
               by_category={f"{v}/{c}": dict(markets=sum(1 for r in recs if r["category"] == c and r.get("venue") == v),
                                    priced=sum(1 for r in recs if r["category"] == c and r.get("venue") == v and r.get("p_yes_fair") is not None),
                                    pass_=sum(1 for r in picks if r["category"] == c and r.get("venue") == v and r["best"]["verdict"] == "PASS"))
                            for v in venues for c in categories},
               errors=errors, picks=picks, cross_venue=_cross(recs), unpriced_sample=[dict(ticker=r["ticker"], reason=r.get("reason")) for r in recs if r.get("p_yes_fair") is None][:25])
    SCANS.mkdir(parents=True, exist_ok=True)
    path = SCANS / f"{stamp:%Y-%m-%d_%H%M}_scan.json"
    (SCANS / "latest.json").write_text(json.dumps(out, indent=1, default=str))
    path.write_text(json.dumps(out, indent=1, default=str))
    out["path"] = str(path)
    if log:
        d = stamp.date().isoformat(); t = stamp.isoformat(timespec="seconds")
        ledger.add_predictions([dict(date_et=d, ts_et=t, source="scan", venue=r.get("venue", "kalshi"), category=r["category"], series=r["series"],
                                     event_ticker=r["event_ticker"], ticker=r["ticker"], title=r["title"],
                                     p_model_raw=r["p_model_raw"], p_yes_fair=r["p_yes_fair"], p_market_yes=r["p_market_yes"],
                                     yes_ask=r["yes_ask"], no_ask=r["no_ask"], close_time=r["close_time"],
                                     value_key=(r.get("value") or {}).get("key"), pred_mu=(r.get("value") or {}).get("mu"),
                                     pred_sd=(r.get("value") or {}).get("sd"), value_unit=(r.get("value") or {}).get("unit"))
                                for r in recs if r.get("p_model_raw") is not None])
        ledger.add_picks([dict(date_et=d, ts_et=t, source="scan", venue=r.get("venue", "kalshi"), category=r["category"], group=r["group"], ticker=r["ticker"],
                               title=r["title"], side=r["best"]["side"], price=r["best"]["price"], fee_c=r["best"]["fee_c"],
                               p_side_raw=r["best"]["p_side_raw"], p_side=r["best"]["p_side"], edge_c=r["best"]["edge_c"],
                               kelly_quarter=r["best"]["kelly_quarter"], verdict=r["best"]["verdict"], close_time=r["close_time"],
                               pred_value=value_str(r), band=band_str(r))
                          for r in picks if r["best"]["verdict"] == "PASS"])
    return out

def band_str(r):
    st, fl, cp = r.get("strike_type"), r.get("floor_strike"), r.get("cap_strike")
    temp = r.get("category") == "weather"
    f = (lambda x: f"{x:g}") if temp else (lambda x: f"{x:,.6g}")
    if st == "between": return f"{f(fl)}-{f(cp)}" if temp else f"{f(fl)} to {f(cp)}"
    if st == "greater": return f">={f(fl + 1)}" if temp else f">{f(fl)}"
    if st == "less": return f"<={f(cp - 1)}" if temp else f"<{f(cp)}"
    return "-"

def value_str(r):
    v = r.get("value")
    if not v: return ""
    if v["unit"] == "F": return f"predicted high {v['mu']:.1f}±{v['sd']:.1f}F vs band {band_str(r)}"
    return f"predicted {v['mu']:,.6g}±{v['sd']:,.4g} at settle vs {band_str(r)}"

def fmt_pick(r):
    b = r["best"]
    vs = value_str(r)
    if vs: vs = f"{vs} -> P(YES)={r['p_yes_fair']:.2f}"
    return (f"[{b['verdict']:5s}] {r.get('venue','kalshi')[:4]} {r['category']:11s} {r['ticker'][:44]:44s} {b['side']:3s} @{b['price']*100:4.0f}c "
            f"fair {b['p_side']*100:5.1f}% (raw {b['p_side_raw']*100:5.1f}%) edge {b['edge_c']:+6.2f}c "
            f"qK {b['kelly_quarter']:.3f} -> {b['contracts']} ct ${b['stake_usd']:.2f} | {r['mins_to_deadline']}m left | {vs or r.get('model')}"
            + (f" | FLAGS: {'; '.join(b['flags'])}" if b["flags"] else ""))


def _cross(recs):
    try:
        from . import polymarket
        return polymarket.cross_venue(recs)
    except Exception as e:
        return [dict(error=f"cross-venue compare failed: {str(e)[:100]}")]
