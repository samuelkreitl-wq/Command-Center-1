"""Offline unit tests: python -m pytest moneybot/test_moneybot.py  (or python -m moneybot.test_moneybot)"""
import math
from moneybot import kalshi, calibrate, scanner, polymarket
from moneybot.fair.common import N, strike_prob
from moneybot.fair import weather

def test_fee():
    assert kalshi.fee_total(1, 0.39) == 0.02 and kalshi.fee_total(10, 0.39) == 0.17

def test_band_rounding():
    # Kalshi B70.5 = 70..71 inclusive -> integrate 69.5..71.5
    p = weather.wx_obs.bracket_prob_yes("between", 70, 71, 70.5, 1.0, None, N)
    assert abs(p - (N(1.0) - N(-1.0))) < 1e-9
    # observed max already above the band kills YES
    assert weather.wx_obs.bracket_prob_yes("between", 70, 71, 70.5, 1.0, 72, N) == 0.0

def test_polymarket_bands():
    assert polymarket._band_from_title("80-81°F") == dict(strike_type="between", floor_strike=80, cap_strike=81)
    assert polymarket._band_from_title("71°F or below") == dict(strike_type="less", cap_strike=72)
    assert polymarket._band_from_title("90°F or higher") == dict(strike_type="greater", floor_strike=89)

def test_strike_prob():
    cdf = lambda x: N((x - 100) / 10)
    assert abs(strike_prob(dict(strike_type="greater", floor_strike=100), cdf) - 0.5) < 1e-9

def test_recal_identity():
    a, b = calibrate.fit_ab([0.2, 0.8] * 50, [0, 1] * 50)
    assert b > 1   # perfectly separated -> sharpen

def test_kelly():
    s = scanner.price_side(0.6, 0.5, 100, 100.0)
    assert s["kelly_full"] > 0 and s["contracts"] > 0 and s["edge_c"] < 10

if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"): f(); print("ok", k)
