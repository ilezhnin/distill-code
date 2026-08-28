import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";

import { runEventsFor, subscribeRunEvents, type RunEvent } from "../runJournal";

/**
 * The run's own events, unpolished (P28).
 *
 * "Polished by default, raw on demand" was named as a product principle and
 * then never built: everything the app showed about a wave was a rendering —
 * a chip, a status verb, a digest card — and each of those is a summary of
 * something the operator could not get at. This is the other half. It shows
 * the transitions the app actually recorded, in order, with their timings, and
 * makes no attempt to be pretty about it.
 *
 * It is deliberately not a log viewer. There is no filtering language, no
 * search and no severity: the journal is tens of lines per wave, so the useful
 * operation is reading it, and the useful filter — one step's own events — is
 * a prop rather than a control.
 */
export function RawEventRail({
  waveId,
  sessionId,
  className,
}: {
  waveId: string;
  /** Only this executor's events. Omitted → the whole wave. */
  sessionId?: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const events = useSyncExternalStore(
    subscribeRunEvents,
    () => runEventsFor(waveId),
    () => EMPTY,
  );
  const rows = useMemo(
    () =>
      sessionId
        ? events.filter(
            (event) => event.sessionId === sessionId || !event.sessionId,
          )
        : events,
    [events, sessionId],
  );
  const first = rows[0]?.at;

  if (rows.length === 0) {
    return (
      <p
        className={cn("px-3 py-4 text-xs text-muted-foreground", className)}
        data-testid="raw-event-rail-empty"
      >
        {t("conductor.raw.empty")}
      </p>
    );
  }

  return (
    <ol
      className={cn(
        "min-w-0 overflow-x-auto px-2 py-2 font-mono text-[11px] leading-5",
        className,
      )}
      data-testid="raw-event-rail"
    >
      {rows.map((event) => (
        <li
          key={`${event.seq ?? event.at}-${event.kind}`}
          data-testid="raw-event-row"
          data-kind={event.kind}
          className="flex min-w-0 gap-2 whitespace-pre text-muted-foreground"
        >
          <span className="shrink-0 tabular-nums">
            {relativeTime(event.at, first ?? event.at)}
          </span>
          <span className="shrink-0 text-foreground">{event.kind}</span>
          {typeof event.stepIndex === "number" ? (
            <span className="shrink-0">#{event.stepIndex + 1}</span>
          ) : null}
          <span className="min-w-0">{formatDetail(event)}</span>
        </li>
      ))}
    </ol>
  );
}

const EMPTY: readonly RunEvent[] = Object.freeze([]);

/**
 * Seconds since the run's first event.
 *
 * Wall-clock timestamps answer "when did this happen on a Tuesday"; the
 * question a trace is read for is "how long was the gap", and a relative
 * offset answers it without arithmetic.
 */
function relativeTime(at: number, first: number): string {
  const seconds = Math.max(0, (at - first) / 1000);
  return `+${seconds.toFixed(1)}s`;
}

function formatDetail(event: RunEvent): string {
  if (!event.detail) return "";
  return Object.entries(event.detail)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}
