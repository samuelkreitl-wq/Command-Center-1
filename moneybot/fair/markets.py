"""Crypto (Coinbase/Kraken spot + realized vol) and commodity (Pyth / Yahoo) fair values.

Settlement value at expiry ~ lognormal around current spot, zero drift, sigma from realized
5-minute (crypto) or hourly (commodities) returns, inflated a bit for fat tails.
"""
import math, time, datetime as dt
from functools import lru_cache
import requests
from ..config import UA, UTC
from ..kalshi import ts
from .common import N, strike_prob

CRYPTO = {  # series -> coinbase product, kraken pair
    "KXBTCD": ("BTC-USD", "XBTUSD"), "KXBTC": ("BTC-USD", "XBTUSD"),
    "KXETHD": ("ETH-USD", "ETHUSD"), "KXETH": ("ETH-USD", "ETHUSD"),
    "KXSOLD": ("SOL-USD", "SOLUSD"), "KXSOLE": ("SOL-USD", "SOLUSD"),
    "KXXRPD": ("XRP-USD", "XRPUSD"), "KXXRP": ("XRP-USD", "XRPUSD"),
    "KXDOGED": ("DOGE-USD", "XDGUSD"), "KXDOGE": ("DOGE-USD", "XDGUSD"),
}
COMMOD = {  # series -> (pyth feed id or None, yahoo symbol for vol / fallback spot)
    "KXGOLDD": ("765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", "GC=F"),
    "KXSILVERD": ("f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e", "SI=F"),
    "KXWTI": (None, "CLF27.NYM"),   # rules: ICE/NYMEX Jan-2027 contract daily settlement
}
TAIL = 1.15  # vol inflation for fat tails / settlement-averaging mismatch

@lru_cache(maxsize=32)
def coinbase(product):
    end = int(time.time()); start = end - 24 * 3600
    c = requests.get(f"https://api.coinbase.com/api/v3/brokerage/market/products/{product}/candles",
                     params=dict(granularity="FIVE_MINUTE", start=start, end=end), headers=UA, timeout=20).json()["candles"]
    closes = [float(x["close"]) for x in sorted(c, key=lambda x: int(x["start"]))]
    spot = closes[-1]
    try:
        t = requests.get(f"https://api.coinbase.com/api/v3/brokerage/market/products/{product}", headers=UA, timeout=15).json()
        spot = float(t.get("price") or spot)
    except Exception: pass
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:]) if a > 0 and b > 0]
    var5 = sum(r * r for r in rets) / max(1, len(rets))
    sigma_ann = math.sqrt(var5 * 12 * 24 * 365)
    return spot, sigma_ann, len(rets)

@lru_cache(maxsize=32)
def kraken(pair):
    d = requests.get("https://api.kraken.com/0/public/Ticker", params={"pair": pair}, timeout=15).json()["result"]
    v = next(iter(d.values())); return (float(v["a"][0]) + float(v["b"][0])) / 2

@lru_cache(maxsize=16)
def yahoo(sym):
    r = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}", params=dict(interval="1h", range="10d"),
                     headers={"User-Agent": "Mozilla/5.0"}, timeout=20).json()["chart"]["result"][0]
    closes = [c for c in r["indicators"]["quote"][0]["close"] if c]
    rets = [math.log(b / a) for a, b in zip(closes, closes[1:])]
    var_h = sum(x * x for x in rets) / max(1, len(rets))
    sigma_ann = math.sqrt(var_h * 23 * 252)        # ~23 trading hours/day
    return float(r["meta"]["regularMarketPrice"]), sigma_ann, len(rets)

@lru_cache(maxsize=16)
def pyth(feed):
    d = requests.get("https://hermes.pyth.network/v2/updates/price/latest", params={"ids[]": feed, "parsed": "true"}, timeout=15).json()
    p = d["parsed"][0]["price"]; return float(p["price"]) * 10 ** int(p["expo"]), int(p["publish_time"])

def _lognormal_cdf(spot, sigma_ann, T_years):
    s = max(1e-6, sigma_ann * math.sqrt(max(T_years, 1 / (365 * 24 * 60))))
    return lambda x: N((math.log(max(x, 1e-12) / spot) + 0.5 * s * s) / s), s

def fair_yes(m, now=None):
    now = now or dt.datetime.now(UTC)
    series = m["event_ticker"].split("-")[0]
    exp = ts(m.get("close_time"))   # settlement instant == close for these series
    if not exp: return None
    T = (exp - now).total_seconds() / (365 * 24 * 3600)
    if T <= 0: return None
    unv = []
    if series in CRYPTO:
        prod, kp = CRYPTO[series]
        spot, sig, n = coinbase(prod)
        try:
            k = kraken(kp); spot = (spot + k) / 2
        except Exception: unv.append("Kraken spot unavailable; Coinbase only")
        unv.append("Settles on CF Benchmarks 60-s RTI average; model uses Coinbase/Kraken spot")
        group, src = "crypto", f"{prod} spot {spot:.6g}, 24h realized vol {sig:.2%} (n={n})"
    elif series in COMMOD:
        feed, ysym = COMMOD[series]
        ys, sig, n = yahoo(ysym)
        spot = ys
        if feed:
            try:
                ps, pt = pyth(feed); spot = ps
                src = f"Pyth spot {ps:.2f} (vol from {ysym}, {sig:.1%}, n={n})"
            except Exception:
                unv.append("Pyth unavailable; using Yahoo futures (basis vs spot not removed)"); src = f"{ysym} {ys}"
        else:
            src = f"{ysym} {ys} (Jan-27 futures), hourly vol {sig:.1%} n={n}"
            unv.append("Yahoo quote may be delayed ~10 min")
        if exp.astimezone(UTC).weekday() >= 5 or T * 365 > 4: unv.append("Weekend/multi-day gap risk")
        group, src = "metals" if series != "KXWTI" else "energy", src
    else:
        return None
    key = CRYPTO[series][0] if series in CRYPTO else series
    sd_mult = 1.0
    try:
        from .. import calibrate
        _, sdm, adj = calibrate.value_adjust(key, 0.0, 1.0)
        sd_mult = sdm
        if adj: unv.append(f"sigma scaled x{sd_mult:.2f} from settled value errors")
    except Exception: pass
    cdf, s = _lognormal_cdf(spot, sig * TAIL * sd_mult, T)
    p = strike_prob(m, cdf)
    if p is None: return None
    return dict(p_yes=max(0.0, min(1.0, p)), model=f"lognormal sigma_T={s:.4f}", inputs=dict(spot=spot, sigma_ann=sig, T_h=round(T * 8760, 2), src=src),
                unverified=unv, group=group, value=dict(mu=round(spot, 6), sd=round(spot * s, 6), unit="USD", key=key))
