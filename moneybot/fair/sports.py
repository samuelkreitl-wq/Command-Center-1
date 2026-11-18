"""Sports fair values from ESPN scoreboard JSON (DraftKings moneylines), vig removed.
If no line is found the market is marked no-edge (fair=None)."""
import re, datetime as dt
from functools import lru_cache
import requests
from ..config import UA
from ..kalshi import ticker_date

LEAGUES = {
    "KXNBAGAME": "basketball/nba", "KXNCAAMBGAME": "basketball/mens-college-basketball",
    "KXNCAAWBGAME": "basketball/womens-college-basketball", "KXNFLGAME": "football/nfl",
    "KXNCAAFGAME": "football/college-football", "KXNHLGAME": "hockey/nhl",
}

def american_to_p(a):
    a = float(str(a).replace("+", ""))
    return -a / (-a + 100) if a < 0 else 100 / (a + 100)

def norm(s): return re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("state", "st").replace("saint", "st"))

@lru_cache(maxsize=64)
def scoreboard(league, day):
    p = {"dates": day.strftime("%Y%m%d")}
    if "college" in league: p.update(groups="50" if "basketball" in league else "80", limit=300)
    try:
        return requests.get(f"https://site.api.espn.com/apis/site/v2/sports/{league}/scoreboard", params=p, headers={"User-Agent": "Mozilla/5.0"}, timeout=20).json().get("events", [])
    except Exception:
        return []

def _names(team):
    return {norm(team.get(k)) for k in ("location", "displayName", "shortDisplayName", "name", "abbreviation", "nickname") if team.get(k)}

def _ml(odds, side):
    ml = (odds or {}).get("moneyline") or {}
    s = ml.get(side) or {}
    for k in ("close", "current", "open"):
        o = (s.get(k) or {}).get("odds")
        if o and o not in ("OFF", "EVEN"): return o
        if o == "EVEN": return "+100"
    return None

def fair_yes(m, now=None):
    series = m["event_ticker"].split("-")[0]
    lg = LEAGUES.get(series)
    if not lg: return None
    day, _ = ticker_date(m["event_ticker"])
    if not day: return None
    team = norm(m.get("yes_sub_title"))
    if not team: return None
    for d in (day, day - dt.timedelta(days=1)):
        for e in scoreboard(lg, d):
            c = e["competitions"][0]
            comps = c.get("competitors", [])
            suf = norm(m["ticker"].rsplit("-", 1)[-1])
            evcode = norm(m["event_ticker"].split("-")[-1][7:])          # e.g. ELONSCAR
            opp = evcode.replace(suf, "", 1) if suf and suf in evcode else ""
            hit = [x for x in comps if team in _names(x.get("team", {})) or (suf and suf == norm(x.get("team", {}).get("abbreviation")))]
            if not hit or len(comps) != 2: continue
            other = [x for x in comps if x is not hit[0]][0]
            if opp and m.get("_venue") != "polymarket":
                on = _names(other.get("team", {})); oab = norm(other.get("team", {}).get("abbreviation"))
                if not (opp == oab or any(n.startswith(opp[:4]) for n in on) or oab.startswith(opp[:3])):
                    continue                                              # same name, wrong game (e.g. South Carolina St.)
            if m.get("_opponent") and norm(m["_opponent"]) not in _names(other.get("team", {})):
                continue
            st = (c.get("status") or e.get("status") or {}).get("type", {}).get("state")
            if st != "pre":
                return dict(p_yes=None, reason=f"game state {st}; no live model", group=m["event_ticker"])
            odds = (c.get("odds") or [None])[0]
            h, a = _ml(odds, "home"), _ml(odds, "away")
            if not (h and a): return dict(p_yes=None, reason="no ESPN/DK moneyline", group=m["event_ticker"])
            ph, pa = american_to_p(h), american_to_p(a)
            ph, pa = ph / (ph + pa), pa / (ph + pa)
            side = hit[0].get("homeAway")
            p = ph if side == "home" else pa
            return dict(p_yes=p, model="DraftKings moneyline via ESPN, vig removed (multiplicative)",
                        inputs=dict(espn_event=e.get("shortName"), espn_id=e.get("id"), team=hit[0].get("team", {}).get("displayName"), home_ml=h, away_ml=a, team_side=side, provider=(odds or {}).get("provider", {}).get("name")),
                        unverified=["Sportsbook line may lag injury news; ESPN 'close' field read as current line"], group=m["event_ticker"])
    return dict(p_yes=None, reason="no matching ESPN game", group=m["event_ticker"])
