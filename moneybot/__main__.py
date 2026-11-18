"""python -m moneybot scan|parlays|settle|calibrate|report|backfill"""
import argparse, json, sys
from . import scanner, parlay, settle, calibrate, monitor

def main(argv=None):
    ap = argparse.ArgumentParser(prog="moneybot", description="Kalshi money bot engine (read-only: never places orders)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan"); s.add_argument("--cats", default="weather,crypto,commodities,sports"); s.add_argument("--venues", default="kalshi,polymarket")
    s.add_argument("--bankroll", type=float, default=100.0); s.add_argument("--top", type=int, default=15)
    s.add_argument("--no-log", action="store_true"); s.add_argument("--json", action="store_true")
    p = sub.add_parser("parlays"); p.add_argument("--bankroll", type=float, default=100.0); p.add_argument("--n", type=int, default=5)
    p.add_argument("--rescan", action="store_true"); p.add_argument("--venues", default="kalshi,polymarket"); p.add_argument("--include-watch", action="store_true"); p.add_argument("--json", action="store_true")
    sub.add_parser("settle"); sub.add_parser("backfill"); sub.add_parser("calibrate")
    r = sub.add_parser("report"); r.add_argument("--positions", help="positions JSON (default pnl/dumps/latest.json)"); r.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    if a.cmd == "scan":
        out = scanner.scan(a.cats.split(","), bankroll=a.bankroll, log=not a.no_log, venues=tuple(a.venues.split(",")))
        if a.json: print(json.dumps(out, indent=1, default=str)); return
        print(f"Scan {out['created_et']}: {out['n_markets']} markets, {out['n_priced']} priced -> {out['path']}")
        for c, v in out["by_category"].items(): print(f"  {c:11s} markets={v['markets']:4d} priced={v['priced']:4d} PASS={v['pass_']}")
        for e in out["errors"]: print("  ERROR", e)
        for r_ in [x for x in out["picks"] if x["best"]["verdict"] == "PASS"][:a.top]: print(scanner.fmt_pick(r_))
        cv = [x for x in out.get("cross_venue", []) if x.get("locks_under_1")]
        print(f"  cross-venue matches: {len(out.get('cross_venue', []))}, priced under $1 together: {len(cv)} (true arb: {sum(1 for x in cv if x.get('arb'))})")
        for x in cv[:5]: print(f"    [{x['kind']}] {x['kalshi']} vs {x['polymarket']}: {x['best_combo']} costs {x['combo_cost']*100:.1f}c | {x['note']}")
        w = [x for x in out["picks"] if x["best"]["verdict"] != "PASS"][:5]
        if w: print("  -- top non-PASS --"); [print(scanner.fmt_pick(x)) for x in w]
    elif a.cmd == "parlays":
        from .config import SCANS
        sc = scanner.scan(bankroll=a.bankroll) if a.rescan else json.loads((SCANS / "latest.json").read_text())
        ps = parlay.build(sc, bankroll=a.bankroll, n_out=a.n, verdicts=("PASS", "WATCH") if a.include_watch else ("PASS",), venues=a.venues.split(","))
        parlay.log_parlays(ps)
        if a.json: print(json.dumps(ps, indent=1, default=str)); return
        print(f"Parlays from scan {sc['created_et']} (bankroll ${a.bankroll:g} for Kelly):")
        for x in ps: print(parlay.fmt(x))
        if not ps: print("  none: fewer than 2 independent PASS legs")
    elif a.cmd == "backfill":
        print("backfill added (predictions, picks):", settle.backfill())
    elif a.cmd == "settle":
        settle.settle()
    elif a.cmd == "calibrate":
        calibrate.run()
    elif a.cmd == "report":
        from . import polymarket
        rep = monitor.report(a.positions); pm = polymarket.positions(); rep["polymarket"] = pm
        if a.json: print(json.dumps(rep, indent=1, default=str)); return
        print(monitor.fmt(rep))
        if pm.get("skipped"): print(f"Polymarket: {pm['reason']} (API key env vars present: {pm['api_keys_present']}; never used for orders)")
        else:
            print(f"Polymarket wallet {pm['wallet']}: {len(pm['positions'])} positions")
            for x in pm["positions"]: print(f"  {x['title'][:60]} {x['outcome']} x{x['size']} avg {x['avg_price']} now {x['cur_price']} P&L {x['cash_pnl']}")

if __name__ == "__main__":
    sys.exit(main())
