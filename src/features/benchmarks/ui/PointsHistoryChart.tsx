import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  centerWindow,
  clampWindow,
  isMajorTick,
  matchingRange,
  nearestIndex,
  panWindow,
  placePoints,
  RANGE_CHOICES,
  type RangeChoice,
  resizeWindow,
  revealTime,
  smoothPath,
  type TimeTick,
  type TimeWindow,
  timeTicks,
  utcOffset,
  valueAxis,
  windowFor,
} from "@/features/benchmarks/lib/benchmarkHistoryWindow";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { toggleVariants } from "@/shared/ui/toggle";

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

/** Width before the first layout and where nothing lays out (tests). */
const FALLBACK_WIDTH = 640;
/** Room on the right for the value labels. */
const GUTTER = 44;
/** Margin left of the plot, so a marker on its edge stays whole. */
const INSET = 12;
/** Least height between value labels. */
const VALUE_SPACING = 72;
const NAVIGATOR_HEIGHT = 48;
/** Strip at the top of the navigator for its date labels. */
const NAVIGATOR_LABELS = 16;
/** Least distance between date labels along the bottom of the plot. */
const TICK_SPACING = 90;
const NAVIGATOR_TICK_SPACING = 150;
const BAND_WIDTH = 14;
const DAY = 86_400_000;

type Zoom = { choice: RangeChoice } | { choice: null; view: TimeWindow };
type Drag = { mode: "window" | "start" | "end"; x: number; view: TimeWindow };

function keyboardFocus(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setWidth(Math.floor(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Points over time for one configuration, read like a stock chart: zoom
 * ranges, a plot whose hover band snaps to the nearest measurement, and a
 * navigator over the whole history. Every measurement is a point that selects
 * it for the page; lines connect only the same measured case set.
 */
export function PointsHistoryChart({
  points,
  selectedId,
  onSelect,
  toolbar,
}: {
  points: HistoryPoint[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Controls at the end of the zoom row. */
  toolbar?: ReactNode;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const ids = useId();
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const markers = useRef(new Map<string, SVGCircleElement>());
  const pendingFocus = useRef<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const width = useWidth(frame) || FALLBACK_WIDTH;
  const [zoom, setZoom] = useState<Zoom>({ choice: "max" });
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  // A point reached by keyboard outside the window is focused once drawn.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id || !markers.current.has(id)) return;
    pendingFocus.current = null;
    markers.current.get(id)?.focus();
  });

  const measured = points.filter((point) => point.points != null);
  const extent = {
    start: measured[0]?.at ?? 0,
    end: measured.at(-1)?.at ?? 0,
  };
  const full = extent.end - extent.start;
  const view = zoom.choice
    ? windowFor(zoom.choice, extent)
    : clampWindow(zoom.view, extent);

  // The first and last measurements sit on the plot's edges, as do the grid and the navigator.
  const left = INSET;
  const right = width - GUTTER;
  const plotTop = 12;
  const plotHeight = Math.round(Math.min(360, Math.max(220, width * 0.2)));
  const plotBottom = plotTop + plotHeight;
  const navTop = plotBottom + 36;
  const navBottom = navTop + NAVIGATOR_HEIGHT;
  /** Milliseconds per navigator pixel. */
  const perPixel = full / (right - left);
  const setView = (next: TimeWindow) => {
    if (next.start === view.start && next.end === view.end) return;
    // A window that lands on a range within half a pixel lights its button again.
    const choice = matchingRange(next, extent, perPixel / 2);
    setZoom(choice ? { choice } : { choice: null, view: next });
  };

  // Visible points, plus one neighbour each side so a line runs off the edge.
  let low = measured.findIndex((point) => point.at >= view.start);
  if (low === -1) low = measured.length;
  const high = measured.findLastIndex((point) => point.at <= view.end);
  const visible = measured.slice(low, high + 1);
  const drawn = measured.slice(Math.max(0, low - 1), high + 2);
  // The value axis rescales to what is drawn, neighbours included, so no line leaves the plot.
  const axis = valueAxis(
    drawn.map((point) => point.points as number),
    Math.floor(plotHeight / VALUE_SPACING),
  );
  const y = (value: number) =>
    plotBottom - ((value - axis.min) / (axis.max - axis.min)) * plotHeight;
  const placed = placePoints(
    drawn.map((point) => point.at),
    view,
    left,
    right,
  );
  const xOf = new Map(drawn.map((point, index) => [point.id, placed[index]]));
  const x = (point: HistoryPoint) => xOf.get(point.id) ?? (left + right) / 2;
  const visibleX = visible.map(x);
  const drawnIds = new Set(drawn.map((point) => point.id));
  const segments = historySegments(points)
    .map((segment) => segment.filter((point) => drawnIds.has(point.id)))
    .filter((segment) => segment.length > 1);
  const span = view.end - view.start;
  const timeX = (at: number) =>
    span > 0
      ? left + ((at - view.start) / span) * (right - left)
      : x(visible[0]);
  // Sparse points carry markers; dense ones show a marker on hover only.
  const sparse = visible.length <= (right - left) / 10;

  const active =
    visible.find((point) => point.id === hovered) ??
    visible.find((point) => point.id === focused) ??
    null;
  const tabStop =
    visible.find((point) => point.id === focused)?.id ??
    visible.find((point) => point.id === selectedId)?.id ??
    visible.at(-1)?.id;
  const localX = (clientX: number) =>
    clientX - (svg.current?.getBoundingClientRect().left ?? 0);
  const nearest = (clientX: number) =>
    visible[nearestIndex(visibleX, localX(clientX))] ?? null;

  const focusPoint = (index: number) => {
    const target = measured[Math.min(Math.max(index, 0), measured.length - 1)];
    if (!target) return;
    const marker = markers.current.get(target.id);
    if (marker) {
      marker.focus();
      return;
    }
    pendingFocus.current = target.id;
    setView(revealTime(view, target.at, extent));
  };
  const pointKeys = (event: KeyboardEvent, point: HistoryPoint) => {
    const index = measured.indexOf(point);
    const moves: Record<string, number> = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: measured.length - 1,
    };
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(point.id);
    } else if (event.key in moves) {
      event.preventDefault();
      focusPoint(moves[event.key]);
    }
  };

  const navX = (at: number) =>
    full > 0
      ? left + ((at - extent.start) / full) * (right - left)
      : (left + right) / 2;
  const navAxis = valueAxis(
    measured.map((point) => point.points as number),
    1,
  );
  const navY = (value: number) =>
    navBottom -
    3 -
    ((value - navAxis.min) / (navAxis.max - navAxis.min)) *
      (NAVIGATOR_HEIGHT - NAVIGATOR_LABELS - 5);
  const windowStart = navX(view.start);
  const windowEnd = navX(view.end);
  const navMiddle = navTop + NAVIGATOR_HEIGHT / 2;
  const startDrag = (event: PointerEvent<SVGGElement>) => {
    if (full <= 0 || event.button !== 0) return;
    const part = (event.target as Element)
      .closest("[data-navigator]")
      ?.getAttribute("data-navigator");
    let base = view;
    let mode: Drag["mode"] = "window";
    if (part === "start" || part === "end") mode = part;
    else if (part !== "window") {
      base = centerWindow(
        view,
        extent.start + (localX(event.clientX) - left) * perPixel,
        extent,
      );
      setView(base);
    }
    drag.current = { mode, x: event.clientX, view: base };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<SVGGElement>) => {
    const current = drag.current;
    if (!current) return;
    const delta = (event.clientX - current.x) * perPixel;
    setView(
      current.mode === "window"
        ? panWindow(current.view, delta, extent)
        : resizeWindow(
            current.view,
            current.mode,
            current.view[current.mode] + delta,
            extent,
          ),
    );
  };
  const endDrag = (event: PointerEvent<SVGGElement>) => {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const windowKeys = (event: KeyboardEvent) => {
    const step = span / 10;
    const delta: Record<string, number> = {
      ArrowLeft: -step,
      ArrowRight: step,
      PageDown: -span,
      PageUp: span,
      Home: -full,
      End: full,
    };
    if (!(event.key in delta)) return;
    event.preventDefault();
    setView(panWindow(view, delta[event.key], extent));
  };
  const edgeKeys = (event: KeyboardEvent, edge: "start" | "end") => {
    const step = full / 20;
    const at: Record<string, number> = {
      ArrowLeft: view[edge] - step,
      ArrowRight: view[edge] + step,
      Home: extent.start,
      End: extent.end,
    };
    if (!(event.key in at)) return;
    event.preventDefault();
    setView(resizeWindow(view, edge, at[event.key], extent));
  };

  const tickLabel = (tick: TimeTick) => {
    if (
      tick.unit === "year" ||
      (tick.unit === "month" && tick.boundary === "year")
    )
      return formatDate(tick.at, { year: "numeric" });
    if (tick.unit === "month") return formatDate(tick.at, { month: "short" });
    if ((tick.unit === "minute" || tick.unit === "hour") && !tick.boundary)
      return formatDate(tick.at, { hour: "numeric", minute: "2-digit" });
    return formatDate(tick.at, { month: "short", day: "numeric" });
  };
  const ticks = timeTicks(view, Math.floor((right - left) / TICK_SPACING));
  const navigatorTicks = timeTicks(
    extent,
    Math.floor((right - left) / NAVIGATOR_TICK_SPACING),
  );
  const rangeDate = (at: number) =>
    formatDate(
      at,
      span < 7 * DAY
        ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : { dateStyle: "medium" },
    );
  const tooltipId = `${ids}-tooltip`;
  const later = active
    ? [
        active.backfilled
          ? t("history.backfilled", { count: active.backfilled })
          : null,
        active.revised ? t("history.revised", { count: active.revised }) : null,
      ].filter((line): line is string => line !== null)
    : [];
  const activeX = active ? x(active) : 0;
  const offset = active ? utcOffset(active.at) : "";
  const time = (at: number) =>
    formatDate(at, { hour: "numeric", minute: "2-digit" });

  return (
    <figure className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        {full > 0 ? (
          <fieldset
            aria-label={t("history.zoom")}
            className="flex min-w-0 flex-wrap items-center gap-0.5"
          >
            <span aria-hidden className="mr-2 text-xs text-muted-foreground">
              {t("history.zoom")}
            </span>
            {RANGE_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={zoom.choice === choice}
                data-state={zoom.choice === choice ? "on" : "off"}
                className={cn(
                  toggleVariants({ size: "sm" }),
                  "h-7 min-w-0 px-2 text-xs tabular-nums",
                )}
                onClick={() => setZoom({ choice })}
              >
                {t(`history.ranges.${choice}`)}
              </button>
            ))}
          </fieldset>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {full > 0 ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("history.span", {
                start: rangeDate(view.start),
                end: rangeDate(view.end),
              })}
            </span>
          ) : null}
          {toolbar}
        </div>
      </div>
      <div ref={frame} className="relative min-w-0">
        {/* Named by aria-label: a native <title> opens an instant tooltip over the plot. */}
        <svg
          ref={svg}
          aria-label={t("history.chartLabel")}
          width={width}
          height={(full > 0 ? navBottom : plotBottom + 24) + 1}
          className="block select-none overflow-visible"
        >
          <defs>
            <linearGradient id={`${ids}-fill`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.2" />
              <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`${ids}-plot`}>
              <rect
                x={left}
                y={0}
                width={right - left}
                height={plotBottom + 1}
              />
            </clipPath>
          </defs>
          {axis.ticks.map((tick) => (
            <g key={tick}>
              <line
                data-history-grid
                x1={left}
                x2={right}
                y1={y(tick) + 0.5}
                y2={y(tick) + 0.5}
                stroke="var(--border)"
              />
              <text
                x={right + 8}
                y={y(tick) + 4}
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {tick}
              </text>
            </g>
          ))}
          {ticks.map((tick) => {
            const at = timeX(tick.at);
            const anchor =
              at < left + 20 ? "start" : at > right - 20 ? "end" : "middle";
            return (
              <g key={tick.at}>
                <line
                  x1={at}
                  x2={at}
                  y1={plotBottom}
                  y2={plotBottom + 5}
                  stroke="var(--border)"
                />
                <text
                  x={at}
                  y={plotBottom + 19}
                  textAnchor={anchor}
                  className={cn(
                    "text-[11px] tabular-nums",
                    isMajorTick(tick)
                      ? "fill-foreground font-medium"
                      : "fill-muted-foreground",
                  )}
                >
                  {tickLabel(tick)}
                </text>
              </g>
            );
          })}
          {span <= 0 && visible.length ? (
            <text
              x={x(visible[0])}
              y={plotBottom + 19}
              textAnchor="middle"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {formatDate(visible[0].at, { month: "short", day: "numeric" })}
            </text>
          ) : null}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the pointer snaps to the nearest point; each point is also a focusable button */}
          <g
            // Chromium puts a clickable SVG group in the tab order; the points are the stops.
            tabIndex={-1}
            className="cursor-pointer outline-none"
            onPointerMove={(event) => {
              if (!drag.current) setHovered(nearest(event.clientX)?.id ?? null);
            }}
            onPointerLeave={() => setHovered(null)}
            onClick={(event) => {
              const point = nearest(event.clientX);
              if (point) onSelect(point.id);
            }}
          >
            <rect
              data-history-plot
              x={0}
              y={plotTop - 8}
              width={right + INSET}
              height={plotHeight + 8}
              fill="transparent"
            />
            {active ? (
              <rect
                data-history-band
                x={activeX - BAND_WIDTH / 2}
                y={plotTop - 4}
                width={BAND_WIDTH}
                height={plotBottom - plotTop + 4}
                fill="var(--muted-foreground)"
                fillOpacity={0.14}
              />
            ) : null}
            {visible
              .filter((point) => point.id === selectedId)
              .map((point) => (
                <line
                  key={point.id}
                  x1={x(point)}
                  x2={x(point)}
                  y1={plotTop - 4}
                  y2={plotBottom}
                  stroke="var(--chart-1)"
                  strokeOpacity={0.5}
                  strokeDasharray="3 3"
                />
              ))}
            <g clipPath={`url(#${ids}-plot)`}>
              {segments.map((segment) => {
                const xs = segment.map(x);
                const line = smoothPath(
                  xs,
                  segment.map((point) => y(point.points as number)),
                );
                return (
                  <g key={segment[0].id} data-history-segment>
                    <path
                      d={`${line} L${xs[xs.length - 1]},${plotBottom} L${xs[0]},${plotBottom} Z`}
                      fill={`url(#${ids}-fill)`}
                    />
                    <path
                      d={line}
                      fill="none"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      strokeLinejoin="round"
                    />
                  </g>
                );
              })}
            </g>
            {active ? (
              <circle
                cx={activeX}
                cy={y(active.points as number)}
                r={11}
                fill="var(--chart-1)"
                fillOpacity={0.25}
              />
            ) : null}
            {visible.map((point) => {
              const selected = point.id === selectedId;
              const lifted = selected || point.id === active?.id;
              return (
                // biome-ignore lint/a11y/useSemanticElements: a point on an SVG line cannot be a <button> element
                <circle
                  key={point.id}
                  ref={(node) => {
                    if (node) markers.current.set(point.id, node);
                    else markers.current.delete(point.id);
                  }}
                  data-history-point={point.id}
                  cx={x(point)}
                  cy={y(point.points as number)}
                  r={selected ? 6 : lifted ? 5 : 3.5}
                  fill={selected ? "var(--chart-1)" : "var(--background)"}
                  stroke={selected ? "var(--background)" : "var(--chart-1)"}
                  strokeWidth={2}
                  opacity={sparse || lifted ? 1 : 0}
                  role="button"
                  tabIndex={point.id === tabStop ? 0 : -1}
                  aria-pressed={selected}
                  aria-describedby={
                    point.id === active?.id ? tooltipId : undefined
                  }
                  aria-label={t("history.pointLabel", {
                    date: formatDate(point.at, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                    points: point.points,
                    scored: point.scored,
                    planned: point.planned,
                  })}
                  className="outline-none focus-visible:stroke-foreground"
                  onFocus={(event) => {
                    // A clicked point is selected; only keyboard focus holds the tooltip open.
                    if (keyboardFocus(event.currentTarget))
                      setFocused(point.id);
                  }}
                  onBlur={() =>
                    setFocused((current) =>
                      current === point.id ? null : current,
                    )
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(point.id);
                  }}
                  onKeyDown={(event) => pointKeys(event, point)}
                />
              );
            })}
          </g>
          {full > 0 ? (
            <g
              className="touch-none"
              onPointerDown={startDrag}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <rect
                data-navigator-track
                x={left + 0.5}
                y={navTop + 0.5}
                width={right - left - 1}
                height={NAVIGATOR_HEIGHT}
                rx={4}
                fill="transparent"
                stroke="var(--border)"
                className="cursor-pointer"
              />
              {navigatorTicks.map((tick) => {
                const at = navX(tick.at);
                const label = tickLabel(tick);
                return (
                  <g key={tick.at} className="pointer-events-none">
                    <line
                      x1={at}
                      x2={at}
                      y1={navTop + 1}
                      y2={navBottom}
                      stroke="var(--border)"
                    />
                    {/* A label that would run under the end handle is left out. */}
                    {at + 4 + label.length * 6 < right - 6 ? (
                      <text
                        x={at + 4}
                        y={navTop + 13}
                        className="fill-muted-foreground text-[10px] tabular-nums"
                      >
                        {label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              {historySegments(points).map((segment) => {
                const xs = segment.map((point) => navX(point.at));
                if (segment.length === 1)
                  return (
                    <circle
                      key={segment[0].id}
                      cx={xs[0]}
                      cy={navY(segment[0].points as number)}
                      r={2}
                      fill="var(--chart-1)"
                      className="pointer-events-none"
                    />
                  );
                const line = smoothPath(
                  xs,
                  segment.map((point) => navY(point.points as number)),
                );
                return (
                  <g key={segment[0].id} className="pointer-events-none">
                    <path
                      d={`${line} L${xs[xs.length - 1]},${navBottom} L${xs[0]},${navBottom} Z`}
                      fill="var(--chart-1)"
                      fillOpacity={0.1}
                    />
                    <path
                      d={line}
                      fill="none"
                      stroke="var(--chart-1)"
                      strokeOpacity={0.7}
                      strokeWidth={1}
                    />
                  </g>
                );
              })}
              <rect
                data-navigator="window"
                role="slider"
                tabIndex={0}
                aria-label={t("history.navigator")}
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(
                  full > span
                    ? ((view.start - extent.start) / (full - span)) * 100
                    : 0,
                )}
                aria-valuetext={t("history.span", {
                  start: rangeDate(view.start),
                  end: rangeDate(view.end),
                })}
                x={windowStart}
                y={navTop + 1}
                width={Math.max(1, windowEnd - windowStart)}
                height={NAVIGATOR_HEIGHT - 1}
                fill="var(--muted-foreground)"
                fillOpacity={0.1}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.6}
                className={cn(
                  "outline-none focus-visible:stroke-foreground",
                  span < full && "cursor-grab active:cursor-grabbing",
                )}
                onKeyDown={windowKeys}
              />
              {(["start", "end"] as const).map((edge) => {
                const at = edge === "start" ? windowStart : windowEnd;
                return (
                  <g
                    key={edge}
                    data-navigator={edge}
                    role="slider"
                    tabIndex={0}
                    aria-label={t(
                      edge === "start"
                        ? "history.navigatorStart"
                        : "history.navigatorEnd",
                    )}
                    aria-orientation="horizontal"
                    aria-valuemin={extent.start}
                    aria-valuemax={extent.end}
                    aria-valuenow={Math.round(view[edge])}
                    aria-valuetext={rangeDate(view[edge])}
                    className="group cursor-ew-resize outline-none"
                    onKeyDown={(event) => edgeKeys(event, edge)}
                  >
                    <rect
                      x={at - 8}
                      y={navTop}
                      width={16}
                      height={NAVIGATOR_HEIGHT}
                      fill="transparent"
                    />
                    <rect
                      x={at - 4.5}
                      y={navMiddle - 9}
                      width={9}
                      height={18}
                      rx={2}
                      fill="var(--background)"
                      stroke="var(--muted-foreground)"
                      className="group-focus-visible:stroke-foreground"
                    />
                    {[-1.5, 1.5].map((dx) => (
                      <line
                        key={dx}
                        x1={at + dx}
                        x2={at + dx}
                        y1={navMiddle - 4}
                        y2={navMiddle + 4}
                        stroke="var(--muted-foreground)"
                      />
                    ))}
                  </g>
                );
              })}
            </g>
          ) : null}
        </svg>
        {active ? (
          <div
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none absolute z-10 w-max max-w-72 -translate-y-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-popover"
            style={{
              top: Math.min(
                Math.max(y(active.points as number), plotTop + 48),
                plotBottom - 48,
              ),
              ...(activeX > width / 2
                ? { right: width - activeX + BAND_WIDTH }
                : { left: activeX + BAND_WIDTH }),
            }}
          >
            <p className="font-medium">
              {formatDate(active.at, {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </p>
            <p className="tabular-nums text-muted-foreground">
              {offset
                ? `${t("history.localTime", { time: time(active.at), offset })} · ${t(
                    "history.utcTime",
                    {
                      time: formatDate(active.at, {
                        timeZone: "UTC",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }),
                    },
                  )}`
                : t("history.utcTime", { time: time(active.at) })}
            </p>
            <p className="mt-2 flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-full bg-chart-1" />
              <span className="text-muted-foreground">
                {t("history.series")}
              </span>
              <span className="ml-auto pl-4 text-sm font-semibold tabular-nums">
                {active.points}
              </span>
            </p>
            <p className="tabular-nums text-muted-foreground">
              {t("history.cases", {
                scored: active.scored,
                planned: active.planned,
              })}
            </p>
            {later.map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </figure>
  );
}
