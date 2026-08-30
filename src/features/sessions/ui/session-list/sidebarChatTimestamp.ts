/**
 * Relative-time formatting for sidebar chat rows.
 *
 * Kept out of the row component's module so that module exports components
 * only: a mixed module loses react-refresh, and vite invalidates the whole
 * sidebar instead of hot-swapping the row.
 */

/**
 * Compact single-unit relative time for sidebar chat rows: `5m`, `3h`, `2d`,
 * `1w`, `4mo`, `2y`. Under a minute renders as `now`.
 */
export function formatSidebarChatTimestamp(
  value: string | null | undefined,
  options: { now?: Date } = {},
): string {
  const trimmedValue = value?.trim();
  if (!trimmedValue) return "";

  const date = new Date(trimmedValue);
  if (!Number.isFinite(date.getTime())) return "";

  const now = options.now ?? new Date();
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${Math.max(years, 1)}y`;
}
