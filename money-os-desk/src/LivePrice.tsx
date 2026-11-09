import { useEffect, useState } from "react";
import { isLivePriceStale, parseKrakenLast } from "./lib/price-freshness";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function LivePrice() {
  const [price, setPrice] = useState<number | null>(null);
  const [ts, setTs] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const response = await fetch("/api/kraken/Ticker?pair=XBTUSD");
        if (!response.ok) throw new Error(String(response.status));
        const last = parseKrakenLast(await response.json());
        if (last == null) throw new Error("bad ticker");
        if (!stop) {
          setPrice(last);
          setTs(Date.now());
          setError(false);
        }
      } catch {
        if (!stop) setError(true);
      }
    };
    void pull();
    const poll = setInterval(() => void pull(), 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, []);

  const stale = isLivePriceStale(ts, now, error);
  return (
    <div className="live-btc" data-testid="live-btc" data-stale={stale ? "true" : "false"}>
      <span>BTC</span>
      <strong>{price != null && !stale ? money(price) : "—"}</strong>
      {stale ? <em data-testid="live-btc-stale">STALE</em> : <em>LIVE</em>}
    </div>
  );
}
