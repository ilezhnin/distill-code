export function formatLocalDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseTimestamp(
  value: string | number | null | undefined,
): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function formatUsageTokens(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value.toLocaleString();
}

export function formatUsageCost(
  value: number | null,
  unavailableLabel: string,
): string {
  if (value === null) {
    return unavailableLabel;
  }
  if (value > 0 && value < 0.005) {
    return "<$0.01";
  }
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function formatUsagePercent(
  value: number | null,
  unavailableLabel: string,
): string {
  if (value === null) {
    return unavailableLabel;
  }
  return `${Math.round(value * 100)}%`;
}

export function formatWorkedDuration(
  ms: number,
  labels: {
    zero: string;
    daysHours: (days: number, hours: number) => string;
    hoursMinutes: (hours: number, minutes: number) => string;
    minutes: (minutes: number) => string;
  },
): string {
  if (ms <= 0) {
    return labels.zero;
  }

  const totalMinutes = Math.floor(ms / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const remainingHours = totalHours % 24;
  const remainingMinutes = totalMinutes % 60;

  if (totalDays > 0) {
    return labels.daysHours(totalDays, remainingHours);
  }
  if (totalHours > 0) {
    return labels.hoursMinutes(totalHours, remainingMinutes);
  }
  return labels.minutes(totalMinutes);
}
