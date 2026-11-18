"""Full-precision observed daily max for Kalshi high-temp markets (Money Desk).

Fix 2026-11-18 (Samuel OK'd): the old wxobs.py took max() of api.weather.gov
`temperature.value`, which for the 5-minute ASOS reports is whole degC
(e.g. "25" = anything 24.5..25.4 C = 76.1..77.7 F). That understated the high
by up to ~1 F and let KXHIGHMIA-26NOV18-B78.5 NO PASS.

Now:
  * METAR T-group (Tsnnnsnnn, tenths degC) from each rawMessage -> exact sample.
  * 6-hour max group 1snnn (and 6-hour min 2snnn) in tenths degC; used as a
    confirmed lower bound only if the whole 6-h window lies inside the CLI day,
    otherwise only as an upper-possible value.
  * 24-hour group 4snnnsnnn (max/min, reported at local-std midnight) -> used
    when the window is the CLI day (only useful after the day ends).
  * Reports with no T-group: decimal value treated as interval
    [v-0.5, v+0.5) degC when it is a whole number (5-min obs), exact otherwise.
  * No whole-degC rounding anywhere; F = C*9/5+32 kept to 0.01, and the
    ASOS whole-F value is recovered as round-half-up(F).
CLI day = local STANDARD time midnight..midnight (NWS climate convention).
Output: lo_F = definitely reached (confirmed); hi_F = could already have been
reached (upper possibility). Model must treat both as hard constraints and use
the worse variant.
"""
import re, json, math, time, urllib.request, datetime as dt

H = {"User-Agent": "money-desk (samuel)", "Accept": "application/geo+json"}

# series -> (station, lat, lon, std UTC offset hours, wunderground path)
STATIONS = {
 "KXHIGHNY":("KNYC",40.7789,-73.9692,-5,"ny/new-york"),
 "KXHIGHPHIL":("KPHL",39.8683,-75.2311,-5,"pa/philadelphia"),
 "KXHIGHTBOS":("KBOS",42.3606,-71.0097,-5,"ma/boston"),
 "KXHIGHTDC":("KDCA",38.8483,-77.0342,-5,"va/arlington"),
 "KXHIGHCHI":("KMDW",41.7861,-87.7522,-6,"il/chicago"),
 "KXHIGHMIA":("KMIA",25.7881,-80.3169,-5,"fl/miami"),
 "KXHIGHAUS":("KAUS",30.1945,-97.67,-6,"tx/austin"),
 "KXHIGHTDAL":("KDFW",32.8998,-97.0403,-6,"tx/dallas"),
 "KXHIGHTATL":("KATL",33.6301,-84.4418,-5,"ga/atlanta"),
 "KXHIGHTHOU":("KHOU",29.6375,-95.2825,-6,"tx/houston"),
 "KXHIGHLAX":("KLAX",33.9382,-118.3866,-8,"ca/los-angeles"),
 "KXHIGHDEN":("KDEN",39.8466,-104.6562,-7,"co/denver"),
 "KXHIGHTMIN":("KMSP",44.8831,-93.2289,-6,"mn/minneapolis"),
 "KXHIGHTLV":("KLAS",36.0719,-115.1634,-8,"nv/las-vegas"),
 "KXHIGHTSEA":("KSEA",47.4447,-122.3144,-8,"wa/seattle"),
 "KXHIGHTPHX":("KPHX",33.4278,-112.0037,-7,"az/phoenix"),
 "KXHIGHTOKC":("KOKC",35.3889,-97.6006,-6,"ok/oklahoma-city"),
 "KXHIGHTSATX":("KSAT",29.5443,-98.4839,-6,"tx/san-antonio"),
 "KXHIGHTNOLA":("KMSY",29.9934,-90.2580,-6,"la/new-orleans"),
 "KXHIGHTSFO":("KSFO",37.6197,-122.3647,-8,"ca/san-francisco"),
}

def c2f(c): return c * 9 / 5 + 32
def whole_f(f): return math.floor(f + 0.5)   # ASOS/CLI whole-degree F

def _tenths(sign, digits): return (-1 if sign == "1" else 1) * int(digits) / 10.0

def parse_metar(raw):
    """Return dict with t (degC tenths), max6, min6, max24, min24 where present."""
    out = {}
    if not raw: return out
    rmk = raw.split(" RMK ", 1)[1] if " RMK " in raw else ""
    m = re.search(r"\bT([01])(\d{3})([01])(\d{3})\b", rmk)
    if m: out["t"] = _tenths(m.group(1), m.group(2))
    else:
        m = re.search(r"\bT([01])(\d{3})\b", rmk)
        if m: out["t"] = _tenths(m.group(1), m.group(2))
    m = re.search(r"(?<![\w/])1([01])(\d{3})(?![\w/])", rmk)
    if m: out["max6"] = _tenths(m.group(1), m.group(2))
    m = re.search(r"(?<![\w/])2([01])(\d{3})(?![\w/])", rmk)
    if m: out["min6"] = _tenths(m.group(1), m.group(2))
    m = re.search(r"(?<![\w/])4([01])(\d{3})([01])(\d{3})(?![\w/])", rmk)
    if m: out["max24"] = _tenths(m.group(1), m.group(2)); out["min24"] = _tenths(m.group(3), m.group(4))
    if not out.get("t"):  # main-body temp group as last resort (whole C)
        m = re.search(r"\s(M?\d{2})/(M?\d{2})?\s", raw)
        if m: out["t_whole"] = int(m.group(1).replace("M", "-"))
    return out

def _get(u, tries=4):
    for i in range(tries):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=25))
        except Exception:
            if i == tries - 1: raise
            time.sleep(2 * (i + 1))

def observed_max(stn, day, std_off, now_utc=None):
    """Observed high so far for CLI day `day` (date) at station stn (UTC offset std_off)."""
    d0 = dt.datetime.combine(day, dt.time(), dt.timezone.utc) - dt.timedelta(hours=std_off)
    d1 = d0 + dt.timedelta(days=1)
    q0 = (d0 - dt.timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%SZ")  # grab 6-h groups that straddle
    feats = _get(f"https://api.weather.gov/stations/{stn}/observations?start={q0}&limit=500")["features"]
    lo = hi = None; src_lo = src_hi = None; n = 0; last = None; lastF = None
    def up(val_lo, val_hi, why):
        nonlocal lo, hi, src_lo, src_hi
        if val_lo is not None and (lo is None or val_lo > lo): lo, src_lo = val_lo, why
        if val_hi is not None and (hi is None or val_hi > hi): hi, src_hi = val_hi, why
    for f in feats:
        p = f["properties"]; t = dt.datetime.fromisoformat(p["timestamp"])
        raw = p.get("rawMessage") or ""; g = parse_metar(raw); v = (p.get("temperature") or {}).get("value")
        inday = d0 <= t < d1
        # 6-h max: window (t-6h, t]
        if "max6" in g and t > d0:
            w0 = t - dt.timedelta(hours=6)
            if w0 >= d0 - dt.timedelta(minutes=10) and t <= d1 + dt.timedelta(minutes=10):
                up(g["max6"], g["max6"], f"6h max {g['max6']}C @{p['timestamp']}")
            else:  # straddles the day boundary: max could be in-day, not confirmed
                up(None, g["max6"], f"6h max {g['max6']}C @{p['timestamp']} (window straddles CLI day)")
        if "max24" in g and abs((t - d1).total_seconds()) < 3600:
            up(g["max24"], g["max24"], f"24h max {g['max24']}C @{p['timestamp']}")
        if not inday: continue
        if "t" in g: c_lo = c_hi = g["t"]; why = f"T-group {g['t']}C @{p['timestamp']}"
        elif v is not None:
            if abs(v - round(v)) < 1e-6: c_lo, c_hi = v - 0.5, v + 0.49; why = f"whole-C obs {v}C @{p['timestamp']} (+-0.5)"
            else: c_lo = c_hi = v; why = f"decimal obs {v}C @{p['timestamp']}"
        elif "t_whole" in g: c_lo, c_hi = g["t_whole"] - 0.5, g["t_whole"] + 0.49; why = f"METAR whole {g['t_whole']}C"
        else: continue
        n += 1; up(c_lo, c_hi, why)
        if last is None or t > last: last, lastF = t, round(c2f((c_lo + c_hi) / 2), 1)
    r = dict(stn=stn, n=n, last=last.isoformat() if last else None, lastF=lastF,
             lo_F=round(c2f(lo), 2) if lo is not None else None, hi_F=round(c2f(hi), 2) if hi is not None else None,
             lo_whole=whole_f(c2f(lo)) if lo is not None else None, hi_whole=whole_f(c2f(hi)) if hi is not None else None,
             src_lo=src_lo, src_hi=src_hi, day_utc=[d0.isoformat(), d1.isoformat()])
    r["maxF"] = r["lo_F"]  # backward-compatible key (confirmed value, full precision)
    return r

def bracket_prob_yes(st, floor, cap, mu, sd, obs_whole, N):
    """P(YES) for a Kalshi high-temp market given forecast daily max ~N(mu,sd) and
    observed whole-F max so far (hard floor: final CLI >= obs_whole)."""
    if st == "less": a, b = -1e9, cap - 0.5
    elif st == "greater": a, b = floor + 0.5, 1e9
    else: a, b = floor - 0.5, cap + 0.5
    Pb = 1.0 if b >= 1e9 else N((b - mu) / sd)
    Pa = 0.0 if a <= -1e9 else N((a - mu) / sd)
    if obs_whole is None: return max(0.0, Pb - Pa)
    if obs_whole > b: return 0.0           # already above bracket -> YES dead
    if obs_whole >= a: return Pb           # already in bracket -> YES unless it climbs past
    return max(0.0, Pb - Pa)
