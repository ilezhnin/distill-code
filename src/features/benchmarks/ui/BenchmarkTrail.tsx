// One attempt's steps as a trail down the dialog: a check and its time on
// what is behind it, a clock on what it does now, quiet rings on what is
// still ahead. A step with parts (a panel's judges, a check's verdicts, the
// cause it stopped on) opens and closes; the one the attempt is in is open.
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconCheck,
  IconChevronDown,
  IconHourglass,
  IconMinus,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Spinner } from "@/shared/ui/spinner";
import type {
  TrailState,
  TrailStep,
  TrailSubstep,
} from "../lib/benchmarkAttemptTrail";
import { compactElapsed } from "../lib/benchmarkTaskTiming";

/** Steps that say something the reader acts on: these start open. */
const OPEN: ReadonlySet<TrailState> = new Set(["running", "waiting", "failed"]);

const STATUS_TONE: Record<TrailState, string> = {
  done: "text-muted-foreground",
  running: "text-info",
  waiting: "text-warning",
  pending: "text-muted-foreground",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
};

function Marker({ state }: { state: TrailState }) {
  const disc = "flex size-5 shrink-0 items-center justify-center rounded-full";
  switch (state) {
    case "done":
      return (
        <span className={cn(disc, "bg-success/15 text-success")}>
          <IconCheck aria-hidden className="size-3" stroke={3} />
        </span>
      );
    case "running":
      return (
        <span className={disc}>
          <Spinner decorative className="size-5 text-info" />
        </span>
      );
    case "waiting":
      return (
        <span className={cn(disc, "bg-warning/15 text-warning")}>
          <IconHourglass aria-hidden className="size-3" />
        </span>
      );
    case "failed":
      return (
        <span className={cn(disc, "bg-destructive/15 text-destructive")}>
          <IconX aria-hidden className="size-3" stroke={3} />
        </span>
      );
    case "skipped":
      return (
        <span className={cn(disc, "text-muted-foreground/60")}>
          <IconMinus aria-hidden className="size-3" />
        </span>
      );
    default:
      return (
        <span className={disc}>
          <span className="size-2.5 rounded-full border border-muted-foreground/50" />
        </span>
      );
  }
}

const DOT_TONE: Record<TrailState, string> = {
  done: "bg-success",
  running: "bg-info animate-pulse",
  waiting: "bg-warning",
  pending: "border border-muted-foreground/50",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground/40",
};

function Substep({ substep }: { substep: TrailSubstep }) {
  return (
    <li className="flex min-h-6 items-start gap-2 text-xs">
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 shrink-0 rounded-full",
          DOT_TONE[substep.state],
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 break-words py-0.5",
          substep.state === "pending" || substep.state === "skipped"
            ? "text-muted-foreground"
            : "text-foreground",
        )}
      >
        {substep.title}
      </span>
      {substep.detail ? (
        <span className="shrink-0 py-0.5 text-muted-foreground tabular-nums">
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

export function BenchmarkTrail({
  steps,
  now,
}: {
  steps: TrailStep[];
  /** The dialog's clock, so every running step counts in step. */
  now: number;
}) {
  const { t } = useTranslation("benchmarks");
  const base = useId();
  // What the reader opened or closed by hand; every other step follows its
  // state, so the open step moves on with the attempt.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const done = steps.filter((step) => step.state === "done").length;
  return (
    <section className="space-y-2" aria-label={t("trail.label")}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-medium tracking-tight text-foreground">
          {t("trail.label")}
        </h2>
        <span
          className="text-xs text-muted-foreground tabular-nums"
          title={t("trail.steps", { done, total: steps.length })}
        >
          {done}/{steps.length}
        </span>
      </div>
      <ol>
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          const foldable = step.substeps.length > 0;
          const open = foldable && (chosen[step.id] ?? OPEN.has(step.state));
          const time = stepTime(step, now);
          const ahead = step.state === "pending" || step.state === "skipped";
          const share =
            step.since != null && step.limitMs
              ? Math.min(1, Math.max(0, (now - step.since) / step.limitMs))
              : null;
          const row = (
            <>
              <span
                className={cn(
                  "min-w-0 truncate text-sm",
                  ahead ? "text-muted-foreground" : "text-foreground",
                  step.state === "skipped" && "line-through",
                )}
              >
                {step.title}
              </span>
              {step.status ? (
                <span
                  className={cn(
                    "min-w-0 truncate text-xs",
                    STATUS_TONE[step.state],
                  )}
                  title={step.status}
                >
                  {step.status}
                </span>
              ) : null}
              <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                {step.count ? <span>{step.count}</span> : null}
                {time ? <span>{time}</span> : null}
                {foldable ? (
                  <IconChevronDown
                    aria-hidden
                    className={cn(
                      "size-4 transition-transform",
                      open && "rotate-180",
                    )}
                  />
                ) : null}
              </span>
            </>
          );
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
              className="relative flex gap-3"
            >
              {last ? null : (
                // From under this marker to the top of the next one.
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-7 -bottom-1 left-2.5 w-px -translate-x-1/2",
                    step.state === "done" ? "bg-success/40" : "bg-border",
                  )}
                />
              )}
              <div className="pt-1.5">
                <Marker state={step.state} />
              </div>
              <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-2")}>
                {foldable ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={`${base}-${step.id}`}
                    aria-label={t("trail.stepNamed", {
                      title: step.title,
                      state: t(`trail.state.${step.state}`),
                    })}
                    className="-mx-2 flex h-8 w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
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
                  <div
                    className="flex h-8 items-center gap-2"
                    title={t("trail.stepNamed", {
                      title: step.title,
                      state: t(`trail.state.${step.state}`),
                    })}
                  >
                    {row}
                  </div>
                )}
                {share != null ? (
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(share * 100)}
                    aria-label={t("trail.limit")}
                    className="mb-1 h-1 overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full",
                        share >= 0.9 ? "bg-warning" : "bg-info",
                      )}
                      style={{ width: `${Math.max(1, share * 100)}%` }}
                    />
                  </div>
                ) : null}
                {open ? (
                  <ul id={`${base}-${step.id}`} className="pb-1">
                    {step.substeps.map((substep) => (
                      <Substep key={substep.id} substep={substep} />
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
