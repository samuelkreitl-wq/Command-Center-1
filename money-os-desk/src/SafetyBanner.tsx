import { useEffect, useState } from "react";

type Safety = {
  level: "none" | "watch" | "danger";
  stale?: boolean;
  since?: number | null;
  computedAt?: number | null;
  active?: { id: string; level: string; detail: string }[];
  note?: string;
};

export default function SafetyBanner() {
  const [status, setStatus] = useState<Safety | null>(null);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const response = await fetch("/api/safety-net");
        if (!response.ok) return;
        const body = await response.json() as Safety;
        if (!stop) setStatus(body);
      } catch {
        /* the banner stays quiet if the status endpoint is down */
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), 15000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  if (!status || status.level === "none") return null;
  const when = status.since ? new Date(status.since).toLocaleString() : "just now";
  return (
    <div className={`safety-banner ${status.level}`} role="status" data-testid="safety-banner">
      <strong>{status.level === "danger" ? "DANGER" : "WATCH"}</strong>
      <span>{(status.active ?? []).map((item) => item.detail).join(" · ") || "Safety net is active."}</span>
      <span>Since {when}.{status.stale ? " STALE scenario." : ""} {status.note}</span>
    </div>
  );
}
