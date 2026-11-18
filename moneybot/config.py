import os
from pathlib import Path
from datetime import timezone, timedelta
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
UTC = timezone.utc
PKG = Path(__file__).resolve().parent
DESK = PKG.parent                      # /home/box/shared/money-desk
DATA = Path(os.environ.get("MONEYBOT_DATA", PKG / "data"))
SCANS = DATA / "scans"
LEDGER_PICKS = DATA / "ledger_picks.csv"        # every suggested pick (PASS/WATCH) + parlays legs
LEDGER_PRED = DATA / "ledger_predictions.csv"   # every evaluated market, first estimate per ticker per day
CALIB = DATA / "calibration.json"
PICKS_LOG = DESK / "hourly" / "picks-log.csv"
PNL_DUMP = DESK / "pnl" / "dumps" / "latest.json"

KALSHI = "https://api.elections.kalshi.com/trade-api/v2"
UA = {"User-Agent": "money-desk-moneybot/0.1 (samuel)"}

# Playbook thresholds (MONEY_DESK_PLAYBOOK.md §1.3-1.5, exit rules Nov 18)
MIN_EDGE_C = 2.0          # cents/contract after fees
MIN_EDGE_PCT = 0.03       # of price
KELLY_MULT = 0.25         # quarter Kelly
NO_BUY_WITHIN_MIN = 75    # don't suggest buys closing sooner (exit rule forces out at <=45 min)
EXIT_WINDOW_MIN = 45
TAKE_PROFIT_C = 5.0
TAKE_PROFIT_PCT = 0.10
