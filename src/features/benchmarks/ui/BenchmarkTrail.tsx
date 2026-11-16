// One attempt's steps as a trail on a card: a check on what is behind it, a
// turning ring and a clock on what it does now, quiet rings on what is still
// ahead. One line runs down the markers; a step with parts (a panel's
// judges, a check's verdicts, the cause it stopped on) branches off it to a
// rail of dots and back, and opens and closes. The step the attempt is in
// starts open, and while one of its parts is being worked on a short light
// runs down the branch into that part.
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  IconBox,
  IconChevronDown,
  IconFileText,
  IconFlag,
  IconHourglassEmpty,
  IconListCheck,
  IconPlayerPauseFilled,
  IconScale,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Shimmer } from "@/shared/ui/ai-elements/shimmer";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import type {
  TrailState,
  TrailStep,
  TrailStepId,
  TrailSubstep,
} from "../lib/benchmarkAttemptTrail";
import { compactElapsed } from "../lib/benchmarkTaskTiming";

/** Steps that say something the reader acts on: these start open. */
const OPEN: ReadonlySet<TrailState> = new Set(["running", "waiting", "failed"]);
/** Steps the attempt has not reached: their words stay quiet. */
const AHEAD: ReadonlySet<TrailState> = new Set(["pending", "skipped"]);
/** How much later each step down the trail draws itself in, in ms. */
const STAGGER = 90;

const STEP_ICON: Record<TrailStepId, typeof IconBox> = {
  queue: IconHourglassEmpty,
  prepare: IconBox,
  work: IconSparkles,
  check: IconListCheck,
  judges: IconScale,
  result: IconFlag,
};

const STATUS_TONE: Record<TrailState, string> = {
  done: "text-muted-foreground",
  running: "text-info",
  waiting: "text-warning",
  pending: "text-muted-foreground",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

function Marker({ state, order }: { state: TrailState; order: number }) {
  const disc =
    "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full";
  switch (state) {
    case "done":
      // The disc pops in and the check draws itself, one step after another.
      return (
        <span
          className={cn(
            disc,
            "bg-info/20 text-info motion-safe:animate-trail-pop",
          )}
          style={{ animationDelay: `${order * STAGGER}ms` }}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            className="size-3.5"
          >
            <path
              d="M5 12.5l4.5 4.5L19 7.5"
              pathLength={1}
              strokeDasharray={1}
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="motion-safe:animate-trail-check"
              style={{ animationDelay: `${order * STAGGER + 120}ms` }}
            />
          </svg>
        </span>
      );
    case "running":
      return (
        <span className={disc}>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            className="size-6 animate-spin text-info motion-reduce:animate-none"
          >
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeOpacity="0.25"
              strokeWidth="2"
            />
            <path
              d="M12 2a10 10 0 0 1 10 10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    case "waiting":
      return (
        <span className={cn(disc, "bg-warning/20 text-warning")}>
          <IconPlayerPauseFilled aria-hidden className="size-3" />
        </span>
      );
    case "failed":
      return (
        <span
          className={cn(
            disc,
            "bg-destructive/20 text-destructive motion-safe:animate-trail-pop",
          )}
          style={{ animationDelay: `${order * STAGGER}ms` }}
        >
          <IconX aria-hidden className="size-3.5" stroke={3} />
        </span>
      );
    case "skipped":
      return (
        <span
          className={cn(
            disc,
            "border-2 border-dashed border-muted-foreground/30",
          )}
        />
      );
    default:
      return (
        <span className={cn(disc, "border-2 border-muted-foreground/40")} />
      );
  }
}

const DOT_TONE: Record<TrailState, string> = {
  done: "bg-muted-foreground/70",
  running: "bg-info ring-4 ring-info/20",
  waiting: "bg-warning ring-4 ring-warning/20",
  pending: "border border-muted-foreground/50 bg-background",
  failed: "bg-destructive ring-4 ring-destructive/20",
  skipped: "bg-muted-foreground/30",
};

function Substep({ substep }: { substep: TrailSubstep }) {
  const dot =
    "absolute top-[11px] -left-[18px] size-1.5 -translate-x-1/2 rounded-full";
  return (
    <li
      data-part-state={substep.state}
      className="relative flex min-h-7 items-start gap-3 text-[13px] leading-5"
    >
      {/* The dot rings as the light running down the branch reaches it. */}
      {substep.state === "running" ? (
        <span
          aria-hidden
          className={cn(
            dot,
            "hidden bg-info motion-safe:block motion-safe:animate-trail-ring",
          )}
        />
      ) : null}
      {/* On the branch's rail, level with the first line of its words. */}
      <span aria-hidden className={cn(dot, DOT_TONE[substep.state])} />
      <span
        className={cn(
          "min-w-0 flex-1 break-words py-1",
          substep.state === "running" ||
            substep.state === "waiting" ||
            substep.state === "failed"
            ? "text-foreground"
            : "text-muted-foreground",
        )}
      >
        {substep.title}
      </span>
      {substep.detail ? (
        <span className="shrink-0 py-1 text-muted-foreground/80 tabular-nums">
          {substep.detail}
        </span>
      ) : null}
    </li>
  );
}

/** A step's time: its clock against its limit while it runs, else what it took. */
function stepTime(step: TrailStep, now: number): string | null {
  if (step.since != null) {
    const elapsed = compactElapsed(Math.max(0, now - step.since));
    return step.limitMs
      ? `${elapsed} / ${compactElapsed(step.limitMs)}`
      : elapsed;
  }
  return step.durationMs != null ? compactElapsed(step.durationMs) : null;
}

/**
 * The line from a step's marker to the next one, drawn in where the attempt
 * went. Past an open step it leaves the markers' column for the rail its
 * parts sit on and comes back before the next marker; the last step's branch
 * ends at its last part.
 */
function Rail({
  state,
  branch,
  last,
  order,
}: {
  state: TrailState;
  branch: boolean;
  last: boolean;
  order: number;
}) {
  const went = state === "done";
  if (!branch)
    return last ? null : (
      <span
        aria-hidden
        className="absolute top-8 -bottom-2 left-[11px] w-0.5 rounded-full bg-border"
      >
        {went ? (
          // Fills from the marker it leaves, once that marker's check is in.
          <span
            className="absolute inset-0 origin-top rounded-full bg-info motion-safe:animate-trail-fill"
            style={{ animationDelay: `${order * STAGGER + 60}ms` }}
          />
        ) : null}
      </span>
    );
  const bend = "absolute left-[11px] h-4 w-[22px] overflow-visible";
  return (
    <span
      aria-hidden
      className={cn(
        "motion-safe:animate-fade-in",
        went ? "text-info" : "text-border",
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 22 16"
        fill="none"
        className={cn(bend, "top-8")}
      >
        <path
          d="M1 0C1 9 21 7 21 16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span
        className={cn(
          "absolute top-12 left-[31px] w-0.5 rounded-full bg-current",
          last ? "bottom-[26px]" : "bottom-2",
        )}
      />
      {last ? null : (
        <svg
          aria-hidden="true"
          viewBox="0 0 22 16"
          fill="none"
          className={cn(bend, "-bottom-2")}
        >
          <path
            d="M21 0C21 9 1 7 1 16"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
  );
}

/** The light's dashes, tail first: each longer one is fainter. */
const TAIL: [length: number, opacity: number][] = [
  [34, 0.18],
  [22, 0.4],
  [10, 1],
];
/** The length of the bend from a marker to the branch's rail, in px. */
const BEND = 27;

/**
 * A short light, bright at its head and fading behind, that runs from the
 * step's marker round the bend and down the branch's rail to the part being
 * worked on, `to` px down the step.
 */
function Light({ to }: { to: number }) {
  const length = BEND + Math.max(0, to - 48);
  return (
    <svg
      aria-hidden="true"
      fill="none"
      className="pointer-events-none absolute inset-0 hidden size-full overflow-visible text-info motion-safe:block"
    >
      {TAIL.map(([dash, opacity]) => (
        <path
          key={dash}
          d={`M12 32C12 41 32 39 32 48V${to}`}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeOpacity={opacity}
          strokeDasharray={`${dash} ${length + dash}`}
          className="animate-trail-light"
          style={
            {
              "--trail-from": `${dash}px`,
              "--trail-to": `${dash - length}px`,
            } as CSSProperties
          }
        />
      ))}
    </svg>
  );
}

function Step({
  step,
  order,
  last,
  open,
  onOpenChange,
  now,
  modelIcon,
}: {
  step: TrailStep;
  order: number;
  last: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  now: number;
  modelIcon?: ReactNode;
}) {
  const { t } = useTranslation("benchmarks");
  const item = useRef<HTMLLIElement>(null);
  // Where the part being worked on sits, for the light to run to. Its rows
  // wrap, so it is measured rather than counted.
  const [target, setTarget] = useState<number | null>(null);
  const lit =
    open &&
    step.state === "running" &&
    step.substeps.some((substep) => substep.state === "running");
  const parts = step.substeps.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a part added or removed moves the one being worked on
  useLayoutEffect(() => {
    const element = item.current;
    if (!lit || !element) {
      setTarget(null);
      return;
    }
    const measure = () => {
      const part = element.querySelector<HTMLElement>(
        '[data-part-state="running"]',
      );
      // Level with the part's dot; nothing is laid out where none is measured.
      setTarget(part && part.offsetTop > 0 ? part.offsetTop + 14 : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [lit, parts]);

  const foldable = parts > 0;
  const time = stepTime(step, now);
  const ahead = AHEAD.has(step.state);
  const share =
    step.since != null && step.limitMs
      ? Math.min(1, Math.max(0, (now - step.since) / step.limitMs))
      : null;
  const Icon = step.collects ? IconFileText : STEP_ICON[step.id];
  const named = t("trail.stepNamed", {
    title: step.title,
    state: t(`trail.state.${step.state}`),
  });
  const row = (
    <>
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-background/60 text-muted-foreground",
          ahead && "opacity-50",
        )}
      >
        {step.id === "work" && modelIcon ? (
          modelIcon
        ) : (
          <Icon aria-hidden className="size-3.5" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-sm",
          ahead
            ? "text-muted-foreground"
            : step.state === "done"
              ? "text-foreground/80"
              : "font-medium text-foreground",
          step.state === "skipped" && "line-through",
        )}
      >
        {step.title}
      </span>
      {foldable ? (
        <IconChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      ) : null}
      <span className="ml-auto flex min-w-0 shrink items-center gap-2.5 pl-2 text-sm tabular-nums">
        {step.status ? (
          step.state === "running" ? (
            <Shimmer
              as="span"
              continuous
              tone="current"
              duration={2.2}
              className="truncate [--shimmer-ink:var(--color-info)]"
            >
              {step.status}
            </Shimmer>
          ) : (
            <span
              className={cn("truncate", STATUS_TONE[step.state])}
              title={step.status}
            >
              {step.status}
            </span>
          )
        ) : null}
        {step.count ? (
          <span className="shrink-0 text-muted-foreground">{step.count}</span>
        ) : null}
        {time ? (
          <span className="shrink-0 text-muted-foreground">{time}</span>
        ) : null}
      </span>
    </>
  );
  const rowClass =
    "flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5";
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <li
        ref={item}
        data-step={step.id}
        data-state={step.state}
        aria-current={
          step.state === "running" || step.state === "waiting"
            ? "step"
            : undefined
        }
        className="relative"
      >
        <Rail state={step.state} branch={open} last={last} order={order} />
        {target != null ? <Light to={target} /> : null}
        <div className="flex h-10 items-center gap-1.5">
          <Marker state={step.state} order={order} />
          {foldable ? (
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-label={named}
                className={cn(
                  rowClass,
                  "text-left outline-none hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-info/70",
                )}
              >
                {row}
              </button>
            </CollapsibleTrigger>
          ) : (
            <div className={rowClass} title={named}>
              {row}
            </div>
          )}
        </div>
        {share != null ? (
          <div className="pr-1.5 pb-1 pl-[76px]">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              aria-label={t("trail.limit")}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-1000 ease-linear",
                  share >= 0.9 ? "bg-warning" : "bg-info",
                )}
                style={{ width: `${Math.max(1, share * 100)}%` }}
              />
            </div>
          </div>
        ) : null}
        {/* The parts fold open and closed; the branch follows the step's height. */}
        <CollapsibleContent className="overflow-hidden motion-safe:data-[state=closed]:animate-collapsible-up motion-safe:data-[state=open]:animate-collapsible-down">
          <ul className="pt-2 pr-1.5 pb-3 pl-[50px]">
            {step.substeps.map((substep) => (
              <Substep key={substep.id} substep={substep} />
            ))}
          </ul>
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}

export function BenchmarkTrail({
  steps,
  now,
  badge,
  modelIcon,
}: {
  steps: TrailStep[];
  /** The dialog's clock, so every running step counts in step. */
  now: number;
  /** The attempt's state, beside the count of steps behind it. */
  badge?: ReactNode;
  /** The mark of who answers, on the step where the model works. */
  modelIcon?: ReactNode;
}) {
  const { t } = useTranslation("benchmarks");
  // What the reader opened or closed by hand; every other step follows its
  // state, so the open step moves on with the attempt.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const done = steps.filter((step) => step.state === "done").length;
  return (
    <section
      aria-label={t("trail.label")}
      className="rounded-2xl border border-border bg-muted/30 p-4"
    >
      <div className="flex items-center justify-between gap-3 pb-2">
        <h2 className="font-display text-base font-medium tracking-tight text-foreground">
          {t("trail.label")}
        </h2>
        <span className="flex items-center gap-3">
          {badge}
          <span
            className="text-sm text-muted-foreground tabular-nums"
            title={t("trail.steps", { done, total: steps.length })}
          >
            {done}/{steps.length}
          </span>
        </span>
      </div>
      <ol>
        {steps.map((step, index) => (
          <Step
            key={step.id}
            step={step}
            order={index}
            last={index === steps.length - 1}
            open={
              step.substeps.length > 0 &&
              (chosen[step.id] ?? OPEN.has(step.state))
            }
            onOpenChange={(open) =>
              setChosen((previous) => ({ ...previous, [step.id]: open }))
            }
            now={now}
            modelIcon={modelIcon}
          />
        ))}
      </ol>
    </section>
  );
}
