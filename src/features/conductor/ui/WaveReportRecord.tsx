/**
 * A worker's report, shown as what it says.
 *
 * The `distill-report` block ends a worker's turn: it is the worker talking
 * to the app, and its JSON in the transcript read as the worker's last word
 * being a wall of braces. The harnesses people work in every day end a
 * subagent's transcript with its result as plain text; this record is that
 * for a report — the outcome on one line, the summary as prose, and the
 * decisions, files and risks one click away, the way the conductor's plan is
 * drawn as its steps and a memory request as its outcome. The raw block is
 * never shown while the report can be read at all.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconClipboardText } from "@tabler/icons-react";
import type { CustomRenderer, CustomRendererProps } from "streamdown";

import { cn } from "@/shared/lib/cn";
import { DisclosureLine } from "@/shared/ui/ai-elements/disclosure-line";

import {
  REPORT_FENCE_TAG,
  parseReportFenceBody,
  type ReportFenceBody,
} from "../orchestratorReport";
import { BrigadeStatusGlyph } from "./BrigadeChip";

function ReportList({
  title,
  items,
}: {
  title: string;
  items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="text-foreground/80">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {items.map((item) => (
          <li key={item} className="[overflow-wrap:anywhere]">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the details line counts, so it says what a click will show. */
export function reportDetailParts(
  report: Pick<
    ReportFenceBody,
    "decisions" | "artifacts" | "risks" | "nextSuggestedTask"
  >,
  t: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  const parts: string[] = [];
  if (report.decisions.length > 0) {
    parts.push(
      t("conductor.report.decisionCount", { count: report.decisions.length }),
    );
  }
  if (report.artifacts.length > 0) {
    parts.push(
      t("conductor.report.artifactCount", { count: report.artifacts.length }),
    );
  }
  if (report.risks.length > 0) {
    parts.push(t("conductor.report.riskCount", { count: report.risks.length }));
  }
  if (report.nextSuggestedTask) {
    parts.push(t("conductor.report.nextCount"));
  }
  return parts;
}

function ReportDetails({ report }: { report: ReportFenceBody }) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const parts = reportDetailParts(report, t);
  if (parts.length === 0) return null;
  return (
    <DisclosureLine
      className="text-muted-foreground"
      label={parts.join(", ")}
      open={open}
      onOpenChange={setOpen}
    >
      <div
        className="space-y-2 pt-1 pb-1 text-xs leading-relaxed text-muted-foreground"
        data-testid="wave-report-details"
      >
        <ReportList title={t("conductor.decisions")} items={report.decisions} />
        <ReportList
          title={t("conductor.artifacts")}
          items={report.artifacts.map((artifact) => {
            const where = artifact.path ?? artifact.url;
            return where && where !== artifact.label
              ? `${artifact.label} (${where})`
              : artifact.label;
          })}
        />
        <ReportList title={t("conductor.risks")} items={report.risks} />
        {report.nextSuggestedTask ? (
          <p className="[overflow-wrap:anywhere]">
            {t("conductor.nextTask")}: {report.nextSuggestedTask}
          </p>
        ) : null}
      </div>
    </DisclosureLine>
  );
}

function WaveReportRecord({ code, isIncomplete }: CustomRendererProps) {
  const { t } = useTranslation("chat");
  const [rawOpen, setRawOpen] = useState(false);
  if (isIncomplete) {
    return (
      <p className="my-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconClipboardText aria-hidden className="size-3.5 shrink-0" />
        {t("conductor.report.writing")}
      </p>
    );
  }
  // The fence alone says nothing about the run: a fence with no readable
  // status is read as the worker claiming it finished, and the risk line the
  // parser adds for an unrecognized status says so.
  const report = parseReportFenceBody(code, "completed");
  if (!report) {
    return (
      <DisclosureLine
        className="my-2 text-muted-foreground"
        icon={<IconClipboardText aria-hidden className="size-3.5 shrink-0" />}
        label={t("conductor.report.unreadable")}
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
    <div
      className="my-2 space-y-1"
      data-wave-report
      data-report-status={report.status}
    >
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconClipboardText aria-hidden className="size-3.5 shrink-0" />
        <span>
          {t("conductor.report.title", {
            status: t(`conductor.status.${report.status}`),
          })}
        </span>
        <BrigadeStatusGlyph status={report.status} />
      </p>
      <p
        className={cn(
          "text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
          report.summary ? "text-foreground" : "text-muted-foreground",
        )}
        data-testid="wave-report-summary"
      >
        {report.summary || t("conductor.report.noSummary")}
      </p>
      {report.status === "blocked" && report.reason ? (
        <p className="text-sm text-warning [overflow-wrap:anywhere]">
          {t("conductor.blockedReason", { reason: report.reason })}
        </p>
      ) : null}
      {report.needsOperator && report.status !== "blocked" ? (
        <p className="text-sm text-warning">{t("conductor.needsOperator")}</p>
      ) : null}
      <ReportDetails report={report} />
    </div>
  );
}

/** The fence renderer that draws a `distill-report` block as the report. */
export const waveReportRenderer: CustomRenderer = {
  language: REPORT_FENCE_TAG,
  component: WaveReportRecord,
};
