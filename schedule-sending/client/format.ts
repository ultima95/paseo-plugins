const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const DAY_MS = 86_400_000;

const pad = (value: number): string => String(value).padStart(2, "0");

// Plain getters instead of Intl: keeps output identical on every React Native runtime.
export function formatClock(ts: number): string {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDelta(ms: number): string {
  if (ms < 60_000) return "<1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function startOfDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatFireTime(fireAt: number, now: number): string {
  const dayDiff = Math.round((startOfDay(fireAt) - startOfDay(now)) / DAY_MS);
  const date = new Date(fireAt);
  let label: string;
  if (dayDiff === 0) label = "Today";
  else if (dayDiff === 1) label = "Tomorrow";
  else label = `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return `${label} ${formatClock(fireAt)}`;
}
