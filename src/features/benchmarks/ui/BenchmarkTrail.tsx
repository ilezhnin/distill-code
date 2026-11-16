// One attempt's steps as a trail on a card: a check on what is behind it, a
// turning ring and a clock on what it does now, quiet rings on what is still
// ahead. One line runs down the markers; a step with parts (a panel's
// judges, a check's verdicts, the cause it stopped on) branches off it to a
// rail of dots and back, and opens and closes. The step the attempt is in
// starts open.
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconBox,
  IconCheck,
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

/** The line's ink below a step: the trail is drawn in where the attempt went. */
function railTone(state: TrailState): string {
  return state === "done" ? "text-info" : "text-border";
}

function Marker({ state }: { state: TrailState }) {
  const disc =
    "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full";
  switch (state) {
    case "done":
      return (
        <span className={cn(disc, "bg-info/20 text-info")}>
          <IconCheck aria-hidden className="size-3.5" stroke={3} />
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
        <span className={cn(disc, "bg-destructive/20 text-destructive")}>
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
  return (
    <li className="relative flex min-h-7 items-start gap-3 text-[13px] leading-5">
      {/* On the branch's rail, level with the first line of its words. */}
      <span
        aria-hidden
        className={cn(
          "absolute top-[11px] -left-[18px] size-1.5 -translate-x-1/2 rounded-full",
          DOT_TONE[substep.state],
        )}
      />
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
 * The line from a step's marker to the next one. Past an open step it leaves
 * the markers' column for the rail its parts sit on and comes back before the
 * next marker; the last step's branch ends at its last part.
 */
function Rail({
  state,
  branch,
  last,
}: {
  state: TrailState;
  branch: boolean;
  last: boolean;
}) {
  const tone = railTone(state);
  if (!branch)
    return last ? null : (
      <span
        aria-hidden
        className={cn(
          "absolute top-8 -bottom-2 left-[11px] w-0.5 rounded-full bg-current",
          tone,
        )}
      />
    );
  const bend = "absolute left-[11px] h-4 w-[22px] overflow-visible";
  return (
    <span aria-hidden className={tone}>
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
  const base = useId();
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
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          const foldable = step.substeps.length > 0;
          const open = foldable && (chosen[step.id] ?? OPEN.has(step.state));
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
                  <span className="shrink-0 text-muted-foreground">
                    {step.count}
                  </span>
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
            <li
              key={step.id}
              data-step={step.id}
              data-state={step.state}
              aria-current={
                step.state === "running" || step.state === "waiting"
                  ? "step"
                  : undefined
              }
              className="relative"
            >
              <Rail state={step.state} branch={open} last={last} />
              <div className="flex h-10 items-center gap-1.5">
                <Marker state={step.state} />
                {foldable ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={`${base}-${step.id}`}
                    aria-label={named}
                    className={cn(
                      rowClass,
                      "text-left outline-none hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:ring-2 focus-visible:ring-info/70",
                    )}
                    onClick={() =>
                      setChosen((previous) => ({
                        ...previous,
                        [step.id]: !open,
                      }))
                    }
                  >
                    {row}
                  </button>
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
                        "h-full rounded-full",
                        share >= 0.9 ? "bg-warning" : "bg-info",
                      )}
                      style={{ width: `${Math.max(1, share * 100)}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {open ? (
                <ul
                  id={`${base}-${step.id}`}
                  className="animate-fade-in pt-2 pr-1.5 pb-3 pl-[50px] motion-reduce:animate-none"
                >
                  {step.substeps.map((substep) => (
                    <Substep key={substep.id} substep={substep} />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
