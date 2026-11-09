import { useEffect, useState } from "react";

type Frame = { id: string; direction: string | null; stale: boolean; ageMs: number | null; fromCache?: boolean };

function age(ms: number | null) {
  if (ms == null) return "no cache";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export default function TimeframeStrip() {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [path, setPath] = useState<string>("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const response = await fetch("/api/trade/context");
        if (!response.ok) throw new Error(String(response.status));
        const body = await response.json() as { frames?: Frame[]; path?: string };
        if (!stop) {
          setFrames(body.frames ?? []);
          setPath(body.path ?? "");
          setFailed(false);
        }
      } catch {
        if (!stop) setFailed(true);
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 60_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="tf-strip" data-testid="tf-strip">
      {frames.map((frame) => (
        <span key={frame.id} data-testid={`tf-${frame.id}`} className={frame.stale || !frame.direction ? "stale" : frame.direction.toLowerCase()}>
          {frame.id} {frame.stale || !frame.direction ? "STALE" : frame.direction}
          <small>{frame.fromCache ? `cache ${age(frame.ageMs)}` : "fresh"}</small>
        </span>
      ))}
      {!frames.length && <span className="stale">{failed ? "Timeframes STALE" : "Timeframes loading"}</span>}
      {path === "conflict" && <span className="conflict" data-testid="tf-conflict">CONFLICT</span>}
    </div>
  );
}
