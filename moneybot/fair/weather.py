"""Weather fair values for KXHIGH* daily-high markets.

Forecast max ~ Normal(mu, sd): mu = mean of NWS hourly max and Open-Meteo multi-model daily max,
sd = base(lead) (+) model spread. Same-day markets use the observed max so far
(tools/wx_obs.py full-precision METAR parse) as a hard floor.
"""
import sys, math, datetime as dt
from functools import lru_cache
import requests
from ..config import DESK, UA, UTC
from .common import N

try:   # prefer the money-desk copy (tools/wx_obs.py, Samuel's Nov-18 tenths fix); fall back to the vendored copy
    sys.path.insert(0, str(DESK / "tools"))
    import wx_obs  # noqa: E402
except ImportError:
    from . import wx_obs  # noqa: E402

STATIONS = wx_obs.STATIONS
NWS_H = {"User-Agent": UA["User-Agent"], "Accept": "application/geo+json"}
OM_MODELS = ["gfs_seamless", "ecmwf_ifs025", "icon_seamless", "gem_seamless"]

@lru_cache(maxsize=64)
def nws_hourly(lat, lon):
    p = requests.get(f"https://api.weather.gov/points/{lat},{lon}", headers=NWS_H, timeout=25).json()
    url = p["properties"]["forecastHourly"]
    return requests.get(url, headers=NWS_H, timeout=25).json()["properties"]["periods"]

@lru_cache(maxsize=64)
def open_meteo(lat, lon):
    r = requests.get("https://api.open-meteo.com/v1/forecast", params=dict(
        latitude=lat, longitude=lon, daily="temperature_2m_max", temperature_unit="fahrenheit",
        timezone="auto", forecast_days=4, models=",".join(OM_MODELS)), timeout=25).json()
    d = r["daily"]; out = {}
    for i, day in enumerate(d["time"]):
        vals = [d[k][i] for k in d if k.startswith("temperature_2m_max") and d[k][i] is not None]
        out[day] = vals
    return out

@lru_cache(maxsize=64)
def wu_daily(path, stn):
    """Weather Underground (The Weather Company = settlement source) 10-day page -> {'11/18': high_F}."""
    import re, html
    t = requests.get(f"https://www.wunderground.com/forecast/us/{path}/{stn}", headers={"User-Agent": "Mozilla/5.0"}, timeout=25).text
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S)
    s = html.unescape(re.sub("<[^>]+>", "|", s)); s = re.sub(r"(\s*\|\s*)+", "|", s)
    out = {}
    for m in re.finditer(r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d+/\d+)\|(-?\d+)°", s):
        out.setdefault(m.group(1), int(m.group(2)))
    return out

@lru_cache(maxsize=64)
def obs(stn, day, std_off):
    return wx_obs.observed_max(stn, day, std_off)

def forecast(series, day, now=None):
    return forecast_station(*STATIONS[series], day=day, now=now)

def forecast_station(stn, lat, lon, std_off, wu_path, day, now=None):
    now = now or dt.datetime.now(UTC)
    tz = dt.timezone(dt.timedelta(hours=std_off))
    d0 = dt.datetime.combine(day, dt.time(), tz); d1 = d0 + dt.timedelta(days=1)
    src, vals = {}, []
    try:
        hrs = [p for p in nws_hourly(lat, lon) if d0 <= dt.datetime.fromisoformat(p["startTime"]) < d1
               and dt.datetime.fromisoformat(p["startTime"]) >= now - dt.timedelta(hours=1)]
        if hrs:
            nws = max(p["temperature"] for p in hrs); src["nws_hourly_max"] = nws; vals.append(nws)
    except Exception as e:
        src["nws_error"] = str(e)[:80]
    try:
        om = open_meteo(lat, lon).get(day.isoformat(), [])
        if om: src["open_meteo_models"] = [round(v, 1) for v in om]; vals += [sum(om) / len(om)]
    except Exception as e:
        src["om_error"] = str(e)[:80]
    try:
        if not wu_path: raise ValueError("no WU page mapped")
        wu = wu_daily(wu_path, stn).get(f"{day.month}/{day.day:02d}") or wu_daily(wu_path, stn).get(f"{day.month}/{day.day}")
        if wu is not None: src["wu_twc_high"] = wu; vals += [wu, wu]   # settlement provider: double weight
    except Exception as e:
        src["wu_error"] = str(e)[:80]
    if not vals: return None
    mu = sum(vals) / len(vals)
    spread = 0.0
    allv = vals + src.get("open_meteo_models", [])
    if len(allv) > 1:
        m = sum(allv) / len(allv); spread = math.sqrt(sum((v - m) ** 2 for v in allv) / (len(allv) - 1))
    local_now = now.astimezone(tz)
    lead_h = (d0 + dt.timedelta(hours=16) - local_now).total_seconds() / 3600   # hours to ~4 PM local (typical peak)
    # sigma shrinks as the day's peak approaches/passes; floored ~0.7F late in the day
    if lead_h <= 0: base = 0.7
    elif lead_h < 12: base = 0.7 + 0.09 * lead_h
    else: base = 1.8 + 0.02 * min(lead_h, 72)
    sd = math.sqrt(base ** 2 + (0.8 * spread * min(1.0, max(lead_h, 0) / 6)) ** 2)
    o = None
    if d0 <= local_now < d1 + dt.timedelta(hours=8):
        try:
            o = obs(stn, day, std_off)
            src["obs"] = {k: o.get(k) for k in ("lo_F", "hi_F", "lo_whole", "hi_whole", "last", "lastF", "n")}
            # station bias vs the NWS hourly forecast for the latest observed hour, carried into the remaining peak
            try:
                last = dt.datetime.fromisoformat(o["last"]) if o.get("last") else None
                per = [p for p in nws_hourly(lat, lon) if last and dt.datetime.fromisoformat(p["startTime"]) <= last < dt.datetime.fromisoformat(p["endTime"])]
                if per and o.get("lastF") is not None and lead_h > 0:
                    bias = o["lastF"] - per[0]["temperature"]
                    src["station_bias_vs_nws_now_F"] = round(bias, 2)
                    mu += 0.6 * max(-4.0, min(4.0, bias)) * min(1.0, 6 / max(lead_h, 1))
            except Exception:
                pass
            if o.get("lo_F") is not None:
                mu = max(mu, o["lo_F"] + (0.3 if lead_h > 0 else 0.0))   # running max is a hard floor
        except Exception as e:
            src["obs_error"] = str(e)[:80]
    try:
        from .. import calibrate
        mu, sd, adj = calibrate.value_adjust(stn, mu, sd)
        if adj: src["value_calibration"] = adj
    except Exception:
        pass
    return dict(mu=round(mu, 2), sd=round(sd, 2), spread=round(spread, 2), lead_h=round(lead_h, 1),
                obs_whole=(o or {}).get("lo_whole"), src=src)

def fair_yes(m, now=None):
    series = m["event_ticker"].split("-")[0]
    if series not in STATIONS: return None
    from ..kalshi import ticker_date
    day, _ = ticker_date(m["event_ticker"])
    if not day: return None
    f = forecast(series, day, now)
    if not f: return None
    p = wx_obs.bracket_prob_yes(m.get("strike_type"), m.get("floor_strike"), m.get("cap_strike"),
                                f["mu"], f["sd"], f["obs_whole"], N)
    unv = ["Settles on The Weather Company value; mu blends WU/TWC page high (2x), NWS hourly, Open-Meteo models; obs from NWS METAR",
           "Normal error model; sd is a heuristic until calibration has enough settled weather picks"]
    return dict(p_yes=p, model=f"N(mu={f['mu']}F, sd={f['sd']}F)", inputs=f, unverified=unv, group=series,
                value=dict(mu=f["mu"], sd=f["sd"], unit="F", key=STATIONS[series][0]))
