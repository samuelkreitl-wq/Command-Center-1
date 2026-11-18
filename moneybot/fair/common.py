import math
def N(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def clamp(p, lo=0.005, hi=0.995): return max(lo, min(hi, p))
def strike_prob(m, cdf):
    """P(YES) for a Kalshi strike market given cdf(x)=P(X<=x) of the settlement value."""
    st = m.get("strike_type"); fl = m.get("floor_strike"); cp = m.get("cap_strike")
    if st == "greater" and fl is not None: return 1 - cdf(float(fl))
    if st == "less" and cp is not None: return cdf(float(cp))
    if st == "between" and fl is not None and cp is not None: return cdf(float(cp)) - cdf(float(fl))
    return None
