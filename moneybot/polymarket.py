"""Polymarket venue: public Gamma discovery + CLOB books, same fair-value/edge pipeline.

Read-only. No keys needed. Optional POLYMARKET_WALLET enables the positions monitor via the
public data-api; POLYMARKET_API_KEY/SECRET/PASSPHRASE are only checked for presence, never used
to trade and never printed. Polymarket has no native parlays: multi-venue parlays are separate tickets.
"""
import os, re, json, datetime as dt
from functools import lru_cache
from zoneinfo import ZoneInfo
import requests
from .config import UTC, NO_BUY_WITHIN_MIN
from . import kalshi
from .fair import weather, markets as fm, sports

G = "https://gamma-api.polymarket.com"; CLOB = "https://clob.polymarket.com"; DATA_API = "https://data-api.polymarket.com"
S = requests.Session(); S.headers.update({"User-Agent": "Mozilla/5.0 (money-desk moneybot)"})
US_CITIES = ["nyc", "miami", "chicago", "dallas", "atlanta", "seattle", "los-angeles", "houston", "austin", "denver",
             "philadelphia", "boston", "phoenix", "san-francisco", "las-vegas", "minneapolis", "washington-dc", "new-orleans",
             "oklahoma-city", "san-antonio"]
COINS = {"bitcoin": "KXBTCD", "ethereum": "KXETHD", "solana": "KXSOLD", "xrp": "KXXRPD"}
SPORT_TAGS = {"nba": "KXNBAGAME", "nfl": "KXNFLGAME", "nhl": "KXNHLGAME", "ncaa-basketball": "KXNCAAMBGAME", "cfb": "KXNCAAFGAME"}
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

def g(path, **p):
    r = S.get(G + path, params=p, timeout=25); r.raise_for_status(); return r.json()

def event(slug):
    try:
        d = g("/events", slug=slug); return d[0] if d else None
    except Exception: return None

def fee_fn_for(m):
    fs = m.get("feeSchedule") or {}
    if not m.get("feesEnabled") or not fs: return lambda C, P: 0.0
    rate, ex = float(fs.get("rate", 0)), float(fs.get("exponent", 1))
    return lambda C, P: rate * (P * (1 - P)) ** ex          # taker fee per share (USDC), not cent-rounded

def _num(s): return float(s.replace(",", "").replace("$", ""))

@lru_cache(maxsize=64)
def station_meta(code):
    p = requests.get(f"https://api.weather.gov/stations/{code}", headers=weather.NWS_H, timeout=20).json()
    lon, lat = p["geometry"]["coordinates"]; tz = ZoneInfo(p["properties"]["timeZone"])
    std = dt.datetime(2026, 1, 15, tzinfo=tz).utcoffset().total_seconds() / 3600
    return code, round(lat, 4), round(lon, 4), int(std)

def _pseudo(m, yes_ask, no_ask, yes_bid, event_ticker, title, **extra):
    d = dict(ticker=m.get("slug"), event_ticker=event_ticker, _title=title, _venue="polymarket",
             yes_ask_dollars=yes_ask, no_ask_dollars=no_ask, yes_bid_dollars=yes_bid,
             yes_ask_size_fp=m.get("_ask_size", 100), yes_bid_size_fp=m.get("_bid_size", 100),
             close_time=m.get("endDate"), expected_expiration_time=m.get("endDate"))
    d.update(extra); return d

def _prices(m, outcome_index=0):
    """YES(outcome0) ask/bid from Gamma best quotes; NO ask = 1 - best bid."""
    a, b = m.get("bestAsk"), m.get("bestBid")
    if outcome_index == 1 and a is not None and b is not None: a, b = 1 - b, 1 - a
    return a, (1 - b if b is not None else None), b

def books(token_ids):
    """CLOB order books (public). Returns {token: (best_ask, ask_size, best_bid, bid_size)}."""
    out = {}
    for i in range(0, len(token_ids), 50):
        try:
            r = S.post(CLOB + "/books", json=[{"token_id": t} for t in token_ids[i:i + 50]], timeout=25).json()
        except Exception:
            continue
        for bk in r if isinstance(r, list) else []:
            asks = sorted(((float(x["price"]), float(x["size"])) for x in bk.get("asks", [])))
            bids = sorted(((float(x["price"]), float(x["size"])) for x in bk.get("bids", [])), reverse=True)
            out[bk.get("asset_id")] = (asks[0] if asks else (None, 0)) + (bids[0] if bids else (None, 0))
    return out

def _band_from_title(t):
    """'80-81°F' -> between 80..81; '71°F or below' -> less cap 72; '90°F or higher' -> greater floor 89 (Kalshi conventions)."""
    t = t.replace("°", "").replace("F", "").strip()
    if m := re.match(r"(-?\d+)-(-?\d+)$", t): return dict(strike_type="between", floor_strike=int(m[1]), cap_strike=int(m[2]))
    if m := re.match(r"(-?\d+) or below", t): return dict(strike_type="less", cap_strike=int(m[1]) + 1)
    if m := re.match(r"(-?\d+) or higher", t): return dict(strike_type="greater", floor_strike=int(m[1]) - 1)
    return None

def _crypto_strike(t, kind):
    t = t.strip()
    if kind == "above": return dict(strike_type="greater", floor_strike=_num(t))
    if t.startswith("<"): return dict(strike_type="less", cap_strike=_num(t[1:]))
    if t.startswith(">"): return dict(strike_type="greater", floor_strike=_num(t[1:]))
    if "-" in t: a, b = t.split("-"); return dict(strike_type="between", floor_strike=_num(a), cap_strike=_num(b))
    return None

def discover(categories, now):
    days = [now.astimezone(ZoneInfo("America/New_York")).date() + dt.timedelta(days=i) for i in (0, 1)]
    items = []   # (category, gamma_market, pseudo-kalshi-market, fair_fn, outcome_index)
    if "weather" in categories:
        for day in days:
            for city in US_CITIES:
                ev = event(f"highest-temperature-in-{city}-on-{MONTHS[day.month-1]}-{day.day}-{day.year}")
                if not ev: continue
                code = re.search(r"\((K[A-Z]{3})\)", ev.get("description", ""))
                if not code: continue
                for m in ev.get("markets", []):
                    if m.get("closed"): continue
                    band = _band_from_title(m.get("groupItemTitle") or "")
                    if not band: continue
                    items.append(("weather", m, dict(band, _station=code[1], _day=day.isoformat(), _city=city),
                                  _wx_fair, 0, f"pm-wx-{city}-{day:%m%d}", f"{ev['title']} — {m.get('groupItemTitle')}"))
    if "crypto" in categories:
        for day in days:
            for coin, ser in COINS.items():
                for kind in ("above", "price"):
                    ev = event(f"{coin}-{kind}-on-{MONTHS[day.month-1]}-{day.day}-{day.year}")
                    if not ev: continue
                    for m in ev.get("markets", []):
                        if m.get("closed"): continue
                        try: st = _crypto_strike(m.get("groupItemTitle") or "", kind)
                        except ValueError: st = None
                        if not st: continue
                        items.append(("crypto", m, dict(st, _series=ser), _crypto_fair, 0, f"{ser}-PM{day:%y%b%d}".upper(), m.get("question")))
    if "sports" in categories:
        end_max = (now + dt.timedelta(days=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
        for tag, ser in SPORT_TAGS.items():
            for off in (0, 50, 100):
                try: evs = g("/events", closed="false", tag_slug=tag, limit=50, offset=off, end_date_min=now.strftime("%Y-%m-%dT%H:%M:%SZ"), end_date_max=end_max)
                except Exception: break
                for ev in evs:
                    dm = re.search(r"(\d{4})-(\d{2})-(\d{2})$", ev.get("slug", ""))
                    if not dm: continue
                    for m in ev.get("markets", []):
                        if m.get("sportsMarketType") != "moneyline" or m.get("closed"): continue
                        outs = json.loads(m.get("outcomes") or "[]")
                        if len(outs) != 2: continue
                        d = dt.date(int(dm[1]), int(dm[2]), int(dm[3]))
                        et = f"{ser}-{d:%y}{d:%b}{d:%d}".upper()
                        items.append(("sports", m, dict(yes_sub_title=outs[0], _opponent=outs[1]), sports.fair_yes, 0, et, f"{m.get('question')} — {outs[0]}"))
                if len(evs) < 50: break
    return items

def _wx_fair(pm, now=None):
    code, lat, lon, std = station_meta(pm["_station"])
    k = [s for s, v in weather.STATIONS.items() if v[0] == code]
    wu = weather.STATIONS[k[0]][4] if k else None
    day = dt.date.fromisoformat(pm["_day"])
    f = weather.forecast_station(code, lat, lon, std, wu, day, now)
    if not f: return None
    p = weather.wx_obs.bracket_prob_yes(pm.get("strike_type"), pm.get("floor_strike"), pm.get("cap_strike"), f["mu"], f["sd"], f["obs_whole"], weather.N)
    return dict(p_yes=p, model=f"N(mu={f['mu']}F, sd={f['sd']}F)", inputs=f, value=dict(mu=f["mu"], sd=f["sd"], unit="F", key=code),
                unverified=["Polymarket resolves on routine METAR T-group max at the station; obs floor also uses 6-h max groups"], group=f"wx-{code}")

def _crypto_fair(pm, now=None):
    m = dict(pm, event_ticker=pm["_series"] + "-X", close_time=pm["close_time"])
    r = fm.fair_yes(m, now)
    if r: r["unverified"] = ["Polymarket resolves on Binance BTC/USDT-style 1-min close at noon ET; model uses Coinbase/Kraken spot"]
    return r

def scan(categories, now, bankroll):
    from .scanner import evaluate
    items = discover(categories, now)
    toks = []
    for cat, m, extra, fn, oi, et, title in items:
        ids = json.loads(m.get("clobTokenIds") or "[]")
        if ids: toks.append(ids[0])
    bk = books(toks)
    out = []
    for cat, m, extra, fn, oi, et, title in items:
        end = kalshi.ts(m.get("endDate"))
        if not end: continue
        mins = (end - now).total_seconds() / 60
        if mins < NO_BUY_WITHIN_MIN: continue
        ids = json.loads(m.get("clobTokenIds") or "[]")
        ya, na, yb = _prices(m, oi)
        src = "gamma"
        if ids and ids[0] in bk:
            a, asz, b, bsz = bk[ids[0]]
            if a is not None or b is not None:
                ya, yb = a, b; na = (1 - b) if b is not None else None; src = "clob"
                m = dict(m, _ask_size=asz, _bid_size=bsz)
        if not ya and not na: continue
        pmk = _pseudo(m, ya, na, yb, et, title, **extra)
        r = evaluate(pmk, cat, fn, now, bankroll, venue="polymarket", fee_fn=fee_fn_for(m))
        if r:
            r["mins_to_deadline"] = round(mins); r["price_source"] = src
            r["xkey"] = _xkey(cat, r, extra); r["pm_station"] = extra.get("_station")
            out.append(r)
    return out

def _xkey(cat, r, extra):
    if cat == "weather" and r.get("inputs"):
        return ("wx", extra.get("_day"), extra.get("strike_type"), extra.get("floor_strike"), extra.get("cap_strike"), extra.get("_city"))
    if cat == "sports" and r.get("inputs"):
        return ("sp", r["inputs"].get("espn_id"), sports.norm(r["inputs"].get("team")))
    return None

KALSHI_CITY = {v[4].split("/")[1]: k for k, v in weather.STATIONS.items()}
PM_CITY_ALIAS = {"nyc": "new-york", "washington-dc": "arlington"}

def kalshi_xkey(r):
    if r.get("venue", "kalshi") != "kalshi" or not r.get("inputs"): return None
    if r["category"] == "sports":
        return ("sp", r["inputs"].get("espn_id"), sports.norm(r["inputs"].get("team")))
    if r["category"] == "weather":
        city = weather.STATIONS[r["series"]][4].split("/")[1]
        day, _ = kalshi.ticker_date(r["event_ticker"])
        mk = r.get("_m") or {}
        return ("wx", day.isoformat() if day else None, r.get("strike_type"), r.get("floor_strike"), r.get("cap_strike"), city)
    return None

def cross_venue(recs):
    """Same event on both venues: compare prices and flag arbitrage (YES on one + NO on the other < $1 after fees)."""
    pm = {}
    for r in recs:
        if r.get("venue") == "polymarket" and r.get("xkey"):
            k = list(r["xkey"]);
            if k[0] == "wx": k[-1] = PM_CITY_ALIAS.get(k[-1], k[-1])
            pm[tuple(k)] = r
    out = []
    for r in recs:
        k = kalshi_xkey(r)
        if not k or k not in pm: continue
        p = pm[k]
        ky, kn, py, pn = r.get("yes_ask"), r.get("no_ask"), p.get("yes_ask"), p.get("no_ask")
        legs = []
        if ky and pn: legs.append(("Kalshi YES + Polymarket NO", ky + kalshi.fee_per_contract(10, ky) + pn + 0.05 * pn * (1 - pn)))
        if kn and py: legs.append(("Kalshi NO + Polymarket YES", kn + kalshi.fee_per_contract(10, kn) + py + 0.05 * py * (1 - py)))
        best = min(legs, key=lambda x: x[1]) if legs else None
        if k[0] == "wx":
            ks = weather.STATIONS[r["series"]][0]; ps = p.get("pm_station")
            same = ks == ps
            note = (f"Kalshi settles on The Weather Company value for {ks}; Polymarket on METAR max at {ps}. "
                    + ("Same station, different source: near-arb, small basis risk." if same else "DIFFERENT stations: this is a basis trade, not an arbitrage."))
            kind = "near-arb" if same else "basis-only"
        else:
            note = "Same game (matched via ESPN event id); check both venues' void/postponement rules"; kind = "arb"
        cheap = bool(best and best[1] < 0.985)
        out.append(dict(key=list(k), kalshi=r["ticker"], polymarket=p["ticker"], kalshi_yes_ask=ky, kalshi_no_ask=kn, pm_yes_ask=py, pm_no_ask=pn,
                        fair_yes=r.get("p_yes_fair"), best_combo=best[0] if best else None, combo_cost=round(best[1], 4) if best else None,
                        locks_under_1=cheap, arb=cheap and kind == "arb", near_arb=cheap and kind == "near-arb", kind=kind, note=note))
    return sorted(out, key=lambda x: x["combo_cost"] or 9)

def positions():
    """Read-only Polymarket positions via the public data-api for POLYMARKET_WALLET."""
    w = os.environ.get("POLYMARKET_WALLET")
    keys = all(os.environ.get(k) for k in ("POLYMARKET_API_KEY", "POLYMARKET_SECRET", "POLYMARKET_PASSPHRASE"))
    if not w:
        return dict(skipped=True, reason="POLYMARKET_WALLET not set; Polymarket positions skipped", api_keys_present=keys)
    try:
        rows = S.get(DATA_API + "/positions", params={"user": w, "sizeThreshold": 0.01, "limit": 200}, timeout=25).json()
    except Exception as e:
        return dict(skipped=True, reason=f"data-api error: {str(e)[:100]}", api_keys_present=keys)
    return dict(skipped=False, wallet=w[:6] + "…" + w[-4:], api_keys_present=keys, positions=[
        dict(title=r.get("title"), outcome=r.get("outcome"), size=r.get("size"), avg_price=r.get("avgPrice"), cur_price=r.get("curPrice"),
             cash_pnl=r.get("cashPnl"), pct_pnl=r.get("percentPnl"), end=r.get("endDate"), slug=r.get("slug")) for r in rows])
