"""Per-category calibration: Brier, log loss, reliability buckets, and a learned correction.

Correction applied to future fair values (per category):
  q = sigmoid(a + b * logit(p_model))          # recalibration, ridge-shrunk toward a=0, b=1
  fair = w * q + (1 - w) * p_market            # blend with market mid, w shrunk toward 1
Both are only fitted once a category has >= MIN_N settled predictions.
"""
import json, math, datetime as dt
from .config import CALIB, LEDGER_PRED, LEDGER_PICKS, ET
from . import ledger

MIN_N = 15
MIN_EVENTS = 8   # distinct (day, event) groups needed before a category's correction switches on
RIDGE = 15.0     # pseudo-observations pulling (a, b) toward (0, 1)
W_PRIOR_N = 30   # pseudo-observations pulling w toward W_PRIOR
W_PRIOR = 0.5    # neutral prior: half model, half market until data says otherwise

def logit(p): p = min(max(p, 1e-4), 1 - 1e-4); return math.log(p / (1 - p))
def sig(x): return 1 / (1 + math.exp(-max(-35, min(35, x))))

def load():
    try: return json.loads(CALIB.read_text())
    except Exception: return {}

_C = None
def apply(category, p_model, p_market=None):
    global _C
    if _C is None: _C = load().get("categories", {})
    c = _C.get(category)
    if p_model is None: return None
    if not c or not c.get("active"): return p_model
    q = sig(c["a"] + c["b"] * logit(p_model))
    w = c.get("w", 1.0)
    if p_market is None: return q
    return w * q + (1 - w) * p_market

_V = None
VALUE_MIN_N = 8
def value_adjust(key, mu, sd):
    """Shrunk mean-error (bias) and z-score scale from settled value predictions for this station/asset."""
    global _V
    if _V is None: _V = load().get("values", {})
    v = _V.get(key)
    if not v or v.get("n", 0) < VALUE_MIN_N: return mu, sd, None
    n = v["n"]; k = n / (n + 20)
    bias = k * v.get("mean_err_raw", 0.0) if v.get("unit") == "F" else 0.0     # only shift temps; prices stay driftless
    scale = 1 + k * (min(2.5, max(0.6, v.get("z_rms", 1.0))) - 1)
    return mu + bias, sd * scale, dict(n=n, bias_added=round(bias, 2), sd_scale=round(scale, 3))

def value_stats():
    rows = [r for r in ledger.read(LEDGER_PRED) if r.get("actual_value") not in ("", None) and _f(r.get("pred_mu")) is not None]
    seen, per = set(), {}
    for r in rows:   # one prediction per (day, event): the first estimate
        k = (r["date_et"], r["event_ticker"])
        if k in seen: continue
        seen.add(k)
        mu, sd, a = _f(r["pred_mu"]), _f(r["pred_sd"]) or 1.0, _f(r["actual_value"])
        if a is None: continue
        d = per.setdefault(r["value_key"], dict(errs=[], zs=[], unit=r.get("value_unit")))
        d["errs"].append(a - mu); d["zs"].append((a - mu) / max(sd, 1e-9))
    out = {}
    for key, d in per.items():
        e, z = d["errs"], d["zs"]; n = len(e)
        out[key] = dict(n=n, unit=d["unit"], mae=round(sum(abs(x) for x in e) / n, 4), mean_err_raw=round(sum(e) / n, 4),
                        rmse=round(math.sqrt(sum(x * x for x in e) / n), 4), z_rms=round(math.sqrt(sum(x * x for x in z) / n), 3))
    return out

def fit_ab(ps, ys):
    a, b = 0.0, 1.0
    xs = [logit(p) for p in ps]
    for _ in range(50):
        ga, gb = RIDGE * a, RIDGE * (b - 1); haa, hab, hbb = RIDGE, 0.0, RIDGE
        for x, y in zip(xs, ys):
            q = sig(a + b * x); r = q - y; w = q * (1 - q)
            ga += r; gb += r * x; haa += w; hab += w * x; hbb += w * x * x
        det = haa * hbb - hab * hab
        if abs(det) < 1e-12: break
        da = (hbb * ga - hab * gb) / det; db = (haa * gb - hab * ga) / det
        a -= da; b -= db
        if abs(da) + abs(db) < 1e-8: break
    return a, b

def brier(ps, ys): return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ps) if ps else None
def logloss(ps, ys):
    return -sum(y * math.log(max(p, 1e-4)) + (1 - y) * math.log(max(1 - p, 1e-4)) for p, y in zip(ps, ys)) / len(ps) if ps else None

def buckets(ps, ys, k=10):
    out = []
    for i in range(k):
        lo, hi = i / k, (i + 1) / k
        sel = [(p, y) for p, y in zip(ps, ys) if lo <= p < hi or (i == k - 1 and p == 1)]
        if sel: out.append(dict(bin=f"{lo:.1f}-{hi:.1f}", n=len(sel), mean_pred=round(sum(p for p, _ in sel) / len(sel), 3),
                                freq_yes=round(sum(y for _, y in sel) / len(sel), 3)))
    return out

def _f(x):
    try: return float(x)
    except (TypeError, ValueError): return None

def run(verbose=True):
    rows = [r for r in ledger.read(LEDGER_PRED) if r.get("outcome_yes") in ("0", "1") and _f(r.get("p_model_raw")) is not None]
    cats = {}
    for r in rows: cats.setdefault(r["category"], []).append(r)
    res = {}
    for cat, rs in sorted(cats.items()):
        ps = [_f(r["p_model_raw"]) for r in rs]; ys = [int(r["outcome_yes"]) for r in rs]
        pm = [_f(r["p_market_yes"]) for r in rs]
        have_m = [i for i, x in enumerate(pm) if x is not None]
        n_eff = len({(r["date_et"], r["event_ticker"]) for r in rs})   # same-event rows are correlated
        c = dict(n=len(rs), n_events=n_eff, brier_model=round(brier(ps, ys), 4), logloss_model=round(logloss(ps, ys), 4),
                 base_rate_yes=round(sum(ys) / len(ys), 3), reliability=buckets(ps, ys))
        if have_m:
            c["brier_market"] = round(brier([pm[i] for i in have_m], [ys[i] for i in have_m]), 4)
            c["brier_model_same_rows"] = round(brier([ps[i] for i in have_m], [ys[i] for i in have_m]), 4)
        a, b, w = 0.0, 1.0, 1.0
        global RIDGE
        ridge0 = RIDGE
        if n_eff >= MIN_EVENTS:
            RIDGE = ridge0 * len(rs) / n_eff
            a, b = fit_ab(ps, ys)
            RIDGE = ridge0
            qs = [sig(a + b * logit(p)) for p in ps]
            c["brier_recal_in_sample"] = round(brier(qs, ys), 4)
            if len(have_m) >= MIN_N:
                best = min((brier([wv * qs[i] + (1 - wv) * pm[i] for i in have_m], [ys[i] for i in have_m]), wv)
                           for wv in [x / 20 for x in range(21)])
                n = n_eff; w = (n * best[1] + W_PRIOR_N * W_PRIOR) / (n + W_PRIOR_N)
                c["w_fit_raw"] = best[1]
        c.update(a=round(a, 4), b=round(b, 4), w=round(w, 3), active=n_eff >= MIN_EVENTS)
        res[cat] = c
    # pick-level performance (selection effects / winner's curse)
    picks = [r for r in ledger.read(LEDGER_PICKS) if r.get("won") in ("0", "1")]
    pk = {}
    for r in picks:
        d = pk.setdefault(r["category"], dict(n=0, wins=0, exp_wins=0.0, pnl=0.0))
        d["n"] += 1; d["wins"] += int(r["won"]); d["exp_wins"] += _f(r["p_side_raw"]) or _f(r["p_side"]) or 0
        d["pnl"] += _f(r["pnl_per_contract"]) or 0
    for d in pk.values(): d["exp_wins"] = round(d["exp_wins"], 2); d["pnl"] = round(d["pnl"], 3)
    vals = value_stats()
    out = dict(updated_et=dt.datetime.now(ET).isoformat(timespec="seconds"), min_n=MIN_N, categories=res, picks=pk, values=vals)
    CALIB.parent.mkdir(parents=True, exist_ok=True)
    tmp = CALIB.with_suffix(".tmp"); tmp.write_text(json.dumps(out, indent=1)); tmp.replace(CALIB)
    if verbose:
        print(f"Calibration ({len(rows)} settled predictions) -> {CALIB}")
        for cat, c in res.items():
            print(f"  {cat:12s} n={c['n']:4d} events={c['n_events']:3d} Brier model={c['brier_model']} market={c.get('brier_market','-')} "
                  f"(model on same rows {c.get('brier_model_same_rows','-')}) a={c['a']} b={c['b']} w={c['w']} {'ACTIVE' if c['active'] else 'collecting'}")
            for bk in c["reliability"]: print(f"      {bk['bin']}: n={bk['n']:3d} pred={bk['mean_pred']:.3f} actual={bk['freq_yes']:.3f}")
        if vals:
            print("  Value-forecast errors (actual - predicted), per station/asset:")
            for k, v in sorted(vals.items()): print(f"    {k:10s} n={v['n']:3d} MAE={v['mae']} bias={v['mean_err_raw']} RMSE={v['rmse']} z_rms={v['z_rms']} {v['unit']}")
        else:
            print("  Value-forecast errors: none settled yet (starts with today's scans)")
        if pk:
            print("  Picks (settled):")
            for cat, d in pk.items(): print(f"    {cat:12s} n={d['n']} wins={d['wins']} expected={d['exp_wins']} P&L/contract sum=${d['pnl']}")
    return out
