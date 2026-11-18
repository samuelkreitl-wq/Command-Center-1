"""Public (unauthenticated) Kalshi API helpers + fee math."""
import math, time, re
from datetime import datetime, date
import requests
from .config import KALSHI, UA, UTC

S = requests.Session(); S.headers.update(UA)

def get(path, params=None, tries=4):
    url = path if path.startswith("http") else KALSHI + path
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=25)
            if r.status_code == 429:
                time.sleep(1.5 * (i + 1)); continue
            r.raise_for_status(); return r.json()
        except requests.RequestException:
            if i == tries - 1: raise
            time.sleep(1.5 * (i + 1))

def markets(series=None, status="open", max_pages=6, **kw):
    out, cur = [], None
    for _ in range(max_pages):
        p = dict(limit=1000, status=status, **kw)
        if series: p["series_ticker"] = series
        if cur: p["cursor"] = cur
        d = get("/markets", p)
        out += d.get("markets", [])
        cur = d.get("cursor")
        if not cur or not d.get("markets"): break
    return out

def markets_by_tickers(tickers):
    out = {}
    tickers = list(dict.fromkeys(tickers))
    for i in range(0, len(tickers), 50):
        chunk = tickers[i:i + 50]
        try:
            d = get("/markets", {"tickers": ",".join(chunk), "limit": 1000})
            for m in d.get("markets", []): out[m["ticker"]] = m
        except Exception:
            pass
        for t in chunk:                       # fallback one by one for anything missing
            if t not in out:
                try: out[t] = get(f"/markets/{t}")["market"]
                except Exception: pass
    return out

def orderbook(ticker, depth=10):
    try:
        d = get(f"/markets/{ticker}/orderbook", {"depth": depth})
        return d.get("orderbook_fp") or d.get("orderbook")
    except Exception: return None

def fnum(x, d=None):
    try: return float(x)
    except (TypeError, ValueError): return d

def ts(s):
    if not s: return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

def deadline(m):
    """Earlier of close_time / expected_expiration_time (exit rule)."""
    c = [t for t in (ts(m.get("close_time")), ts(m.get("expected_expiration_time"))) if t]
    return min(c) if c else None

def fee_total(C, P, rate=0.07):
    """Kalshi taker fee, rounded up to the cent per order."""
    return math.ceil(rate * C * P * (1 - P) * 100 - 1e-9) / 100

def fee_per_contract(C, P, rate=0.07):
    C = max(1, int(C)); return fee_total(C, P, rate) / C

MON = {m: i for i, m in enumerate(["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"], 1)}
def ticker_date(event_ticker):
    """KXHIGHTMIN-26NOV19 -> date(2026,11,19); KXBTCD-26NOV1817 -> (date, hour 17)."""
    m = re.search(r"-(\d{2})([A-Z]{3})(\d{2})(\d{2})?", event_ticker)
    if not m: return None, None
    d = date(2000 + int(m.group(1)), MON[m.group(2)], int(m.group(3)))
    return d, (int(m.group(4)) if m.group(4) else None)
