/** Hourly ET scan. This module cannot place an order. */

export function msUntilNextEtHour(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const intoHour = value("minute") * 60 + value("second");
  const wait = (3600 - intoHour) * 1000 - now.getMilliseconds();
  return wait <= 0 ? 1000 : wait;
}

export function startHourlyScanner(run: () => Promise<unknown>, now = () => new Date()): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void run().finally(schedule);
    }, msUntilNextEtHour(now()));
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
