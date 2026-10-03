import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";

export interface HistoryPoint {
  id: string;
  at: number;
  points: number | null;
  series: string;
  scored: number;
  planned: number;
  backfilled?: number;
  revised?: number;
}

/** Never bridge a missing result or a change in measured versions or runtime. */
export function historySegments(points: HistoryPoint[]): HistoryPoint[][] {
  const segments: HistoryPoint[][] = [];
  let segment: HistoryPoint[] = [];
  for (const point of points) {
    if (point.points == null) {
      segment = [];
      continue;
    }
    if (!segment.length || segment[0].series !== point.series) {
      segment = [];
      segments.push(segment);
    }
    segment.push(point);
  }
  return segments;
}

/**
 * Current-pool observations. Lines connect only the same measured case set;
 * a change in coverage stays a separate observation, with its evidence intact.
 */
export function PointsHistoryChart({
  points,
  selectedId,
  onSelect,
}: {
  points: HistoryPoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const gradientId = useId();
  const width = 640;
  const height = 180;
  const padding = { left: 36, right: 20, top: 28, bottom: 32 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  // End points sit inside the plot so their labels stay clear of the axes.
  const inset = 28;
  const measured = points.filter((point) => point.points != null);
  const first = measured[0]?.at ?? 0;
  const last = measured.at(-1)?.at ?? first;
  const span = Math.max(1, last - first);
  const x = (at: number) =>
    measured.length <= 1
      ? padding.left + plotWidth / 2
      : padding.left + inset + ((at - first) / span) * (plotWidth - 2 * inset);
  // Labels keep a minimum distance; the selected point always keeps its label.
  const labelled = new Set<string>();
  const taken: number[] = [];
  const claim = (point: HistoryPoint) => {
    const at = x(point.at);
    if (taken.every((other) => Math.abs(other - at) >= 56)) {
      labelled.add(point.id);
      taken.push(at);
    }
  };
  const chosen = measured.find((point) => point.id === selectedId);
  if (chosen) claim(chosen);
  const latest = measured.at(-1);
  if (latest && latest !== chosen) claim(latest);
  for (const point of measured) if (point.id !== selectedId) claim(point);
  const oneDay =
    measured.length > 1 &&
    new Date(first).toDateString() === new Date(last).toDateString();
  const y = (value: number) => padding.top + (1 - value / 1000) * plotHeight;
  const path = (segment: HistoryPoint[]) =>
    segment
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${x(point.at).toFixed(1)},${y(point.points as number).toFixed(1)}`,
      )
      .join(" ");
  const date = (at: number) =>
    oneDay
      ? formatDate(at, { hour: "numeric", minute: "2-digit" })
      : formatDate(at, { month: "short", day: "numeric" });
  return (
    <figure>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-44 w-full">
        <title>{t("history.chartLabel")}</title>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.25" />
            <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 250, 500, 750, 1000].map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="currentColor"
              className="text-border"
              strokeDasharray={tick === 0 || tick === 1000 ? undefined : "2 4"}
            />
            <text
              x={padding.left - 6}
              y={y(tick) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px] tabular-nums"
            >
              {tick}
            </text>
          </g>
        ))}
        {historySegments(points)
          .filter((segment) => segment.length > 1)
          .map((segment) => (
            <g key={segment[0].id} data-history-segment>
              <path
                d={`${path(segment)} L${x(segment[segment.length - 1].at).toFixed(1)},${y(0)} L${x(segment[0].at).toFixed(1)},${y(0)} Z`}
                fill={`url(#${gradientId})`}
              />
              <path
                d={path(segment)}
                fill="none"
                stroke="var(--chart-1)"
                strokeWidth="2"
              />
            </g>
          ))}
        {measured.map((point) => {
          const selected = point.id === selectedId;
          const label = labelled.has(point.id);
          return (
            <g key={point.id}>
              {/* biome-ignore lint/a11y/useSemanticElements: a point on an SVG line cannot be a <button> element */}
              <circle
                cx={x(point.at)}
                cy={y(point.points as number)}
                r={selected ? 7 : 5}
                fill={selected ? "var(--chart-1)" : "var(--background)"}
                stroke="var(--chart-1)"
                strokeWidth="2"
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={t("history.pointLabel", {
                  date: formatDate(point.at, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                  points: point.points,
                  scored: point.scored,
                  planned: point.planned,
                })}
                className={cn(
                  "cursor-pointer outline-none focus-visible:stroke-foreground",
                )}
                onClick={() => onSelect(point.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(point.id);
                  }
                }}
              >
                <title>
                  {t("history.coverage", {
                    scored: point.scored,
                    planned: point.planned,
                  })}
                  {point.backfilled || point.revised
                    ? ` ${t("history.laterEvidence", { backfilled: point.backfilled ?? 0, revised: point.revised ?? 0 })}`
                    : ""}
                </title>
              </circle>
              <text
                x={x(point.at)}
                y={height - padding.bottom + 14}
                visibility={label ? undefined : "hidden"}
                textAnchor="middle"
                className={cn(
                  "text-[9px] tabular-nums",
                  selected ? "fill-foreground" : "fill-muted-foreground",
                )}
              >
                {date(point.at)}
              </text>
              <text
                x={x(point.at)}
                y={y(point.points as number) - 11}
                visibility={label ? undefined : "hidden"}
                textAnchor="middle"
                className={cn(
                  "text-[10px] font-semibold tabular-nums",
                  selected ? "fill-foreground" : "fill-muted-foreground",
                )}
              >
                {point.points} · {point.scored}/{point.planned}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
