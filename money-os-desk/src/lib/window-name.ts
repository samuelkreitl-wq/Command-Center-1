/** A 15-minute window is named by its END time in America/New_York. */

export function windowNameByEnd(closeTime: string | undefined): string {
  if (!closeTime) return "Window";
  const date = new Date(closeTime);
  if (Number.isNaN(date.getTime())) return "Window";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${time} ET window`;
}

export function formatEt(iso: string | number | undefined): string {
  if (iso == null || iso === "") return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
}
