/**
 * A conductor's plan, shown as the steps it starts.
 *
 * The `distill-wave` block is a brief for the workers: one long instruction
 * per step, written for a model, often in another language than the operator
 * speaks to the conductor. Shown whole it buried the conductor's answer under
 * paragraphs nobody was meant to read. So the plan reads like a task list —
 * one line per step, named the way its chip and its chat are named — and each
 * line opens onto the brief and what the step may see, for when the operator
 * wants to check what a worker was actually told. Step numbers match the
 * chips, which is what lets a failure be blamed on the right step.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconListCheck } from "@tabler/icons-react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";

import { DisclosureLine } from "@/shared/ui/ai-elements/disclosure-line";

import { waveStepAccessKey } from "../flockConductorTranscript";
import { WAVE_FENCE_TAG, parseWavePlanBody, type WaveStep } from "../flockWave";
import { waveStepDisplayName } from "../roleLayers";

/** Steps with the number their chips carry. */
function numberSteps(
  steps: readonly WaveStep[],
): { step: WaveStep; number: number }[] {
  return steps.map((step, position) => ({ step, number: position + 1 }));
}

function PlanStep({ step, number }: { step: WaveStep; number: number }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const details = [
    t(waveStepAccessKey(step)),
    step.model
      ? step.effort
        ? `${step.model} · ${step.effort}`
        : step.model
      : step.effort,
  ].filter(Boolean);
  return (
    <li className="flex min-w-0 gap-2">
      <span className="w-4 shrink-0 pt-px text-right text-xs tabular-nums text-muted-foreground">
        {number}
      </span>
      <DisclosureLine
        className="min-w-0 flex-1"
        label={waveStepDisplayName(step.role, step.subtask, step.label)}
        open={open}
        onOpenChange={setOpen}
      >
        <div className="space-y-1 pt-1 pb-1 text-xs leading-relaxed text-muted-foreground">
          <p>{details.join(" · ")}</p>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            {step.subtask}
          </p>
        </div>
      </DisclosureLine>
    </li>
  );
}

function WavePlanRecord({ code, isIncomplete }: CustomRendererProps) {
  const { t } = useTranslation("chat");
  const [rawOpen, setRawOpen] = useState(false);
  if (isIncomplete) {
    return (
      <p className="my-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconListCheck aria-hidden className="size-3.5 shrink-0" />
        {t("conductor.wave.plan.writing")}
      </p>
    );
  }
  const plan = parseWavePlanBody(code);
  if (plan.kind !== "plan") {
    // The refusal notice says what is wrong; the block stays readable beside it.
    return (
      <DisclosureLine
        className="my-2 text-muted-foreground"
        icon={<IconListCheck aria-hidden className="size-3.5 shrink-0" />}
        label={t("conductor.wave.plan.unreadable")}
        open={rawOpen}
        onOpenChange={setRawOpen}
      >
        <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {code}
        </pre>
      </DisclosureLine>
    );
  }
  return (
    <div className="my-2 space-y-1" data-wave-plan>
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconListCheck aria-hidden className="size-3.5 shrink-0" />
        {t("conductor.wave.plan.title", { count: plan.steps.length })}
      </p>
      <ol className="space-y-0.5">
        {numberSteps(plan.steps).map(({ step, number }) => (
          <PlanStep key={number} step={step} number={number} />
        ))}
      </ol>
    </div>
  );
}

/** The fence renderer that draws a `distill-wave` block as its steps. */
export const wavePlanRenderer: CustomRenderer = {
  language: WAVE_FENCE_TAG,
  component: WavePlanRecord,
};
