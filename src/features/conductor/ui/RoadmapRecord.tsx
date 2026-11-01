/**
 * A conductor's roadmap, shown as the goal and its stages.
 *
 * The `distill-roadmap` block is written for the app — JSON the engine reads
 * to keep the goal across restarts and to decide whether an accepted wave is
 * followed up. Shown as code it was a wall of braces in the middle of the
 * conductor's answer. So it reads the way the plan does: one line with the
 * goal and the status, one line per stage with its state, and the evidence a
 * done stage cites folded under it. The raw block stays reachable only when it
 * could not be read, beside the notice that says why.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconFlag } from "@tabler/icons-react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";

import { cn } from "@/shared/lib/cn";
import { DisclosureLine } from "@/shared/ui/ai-elements/disclosure-line";

import {
  ROADMAP_FENCE_TAG,
  parseRoadmapBody,
  roadmapProgress,
  type RoadmapStage,
} from "../flockRoadmap";

/** The glyph each stage state carries, before its title. */
const STAGE_GLYPH: Record<RoadmapStage["status"], string> = {
  pending: "○",
  active: "◐",
  done: "●",
  blocked: "⊘",
};

function Stage({ stage, number }: { stage: RoadmapStage; number: number }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const state = t(`conductor.wave.roadmap.stage.${stage.status}`);
  const label = `${stage.title} · ${state}`;
  return (
    <li className="flex min-w-0 gap-2">
      <span className="w-4 shrink-0 pt-px text-right text-xs tabular-nums text-muted-foreground">
        {number}
      </span>
      <span
        aria-hidden
        className={cn(
          "w-3 shrink-0 pt-px text-xs",
          stage.status === "done" && "text-success",
          stage.status === "blocked" && "text-destructive",
          stage.status === "active" && "text-foreground",
          stage.status === "pending" && "text-muted-foreground",
        )}
      >
        {STAGE_GLYPH[stage.status]}
      </span>
      {stage.evidence.length > 0 ? (
        <DisclosureLine
          className="min-w-0 flex-1"
          label={label}
          open={open}
          onOpenChange={setOpen}
        >
          <div className="space-y-1 pt-1 pb-1 text-xs leading-relaxed text-muted-foreground">
            <p>{t("conductor.wave.roadmap.evidence")}</p>
            <ul className="list-disc pl-4">
              {stage.evidence.map((item) => (
                <li key={item} className="[overflow-wrap:anywhere]">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </DisclosureLine>
      ) : (
        <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
          {label}
        </span>
      )}
    </li>
  );
}

function RoadmapRecord({ code, isIncomplete }: CustomRendererProps) {
  const { t } = useTranslation("chat");
  const [rawOpen, setRawOpen] = useState(false);
  if (isIncomplete) {
    return (
      <p className="my-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconFlag aria-hidden className="size-3.5 shrink-0" />
        {t("conductor.wave.roadmap.writing")}
      </p>
    );
  }
  const parse = parseRoadmapBody(code);
  if (parse.kind !== "roadmap") {
    // The notice in the chat says what is wrong; the block stays readable.
    return (
      <DisclosureLine
        className="my-2 text-muted-foreground"
        icon={<IconFlag aria-hidden className="size-3.5 shrink-0" />}
        label={t("conductor.wave.roadmap.unreadable")}
        open={rawOpen}
        onOpenChange={setRawOpen}
      >
        <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {code}
        </pre>
      </DisclosureLine>
    );
  }
  const { roadmap } = parse;
  const progress = roadmapProgress(roadmap);
  return (
    <div className="my-2 space-y-1" data-roadmap>
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconFlag aria-hidden className="size-3.5 shrink-0" />
        {t("conductor.wave.roadmap.title")}
        {" · "}
        {t(`conductor.wave.roadmap.status.${roadmap.status}`)}
        {roadmap.stages.length > 0 ? (
          <>
            {" · "}
            {t("conductor.wave.roadmap.progress", progress)}
          </>
        ) : null}
      </p>
      <p className="text-sm [overflow-wrap:anywhere]">
        <span className="text-muted-foreground">
          {t("conductor.wave.roadmap.goal")}:{" "}
        </span>
        {roadmap.goal}
      </p>
      {roadmap.note ? (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {t("conductor.wave.roadmap.note")}: {roadmap.note}
        </p>
      ) : null}
      {roadmap.stages.length > 0 ? (
        <ol className="space-y-0.5">
          {roadmap.stages.map((stage, index) => (
            <Stage
              key={`${index}-${stage.title}`}
              stage={stage}
              number={index + 1}
            />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** The fence renderer that draws a `distill-roadmap` block as its stages. */
export const roadmapRenderer: CustomRenderer = {
  language: ROADMAP_FENCE_TAG,
  component: RoadmapRecord,
};
