import { i18n } from "@/shared/i18n";

import type { SessionNode, StructuredReport } from "./types";

const REPORT_FENCE_PATTERN = /```distill-report\s*([\s\S]*?)```/i;

export function wrapOrchestratorTaskPrompt(task: string): string {
  return `${task.trim()}

Do this step and stop. Do not carry on into the next piece of work, and do not keep trying variations once you have an answer or once you are genuinely stuck. If you cannot finish — blocked, missing access, the task turns out to be impossible — that is a legitimate result: report it with "status": "failed" and "needsOperator": true instead of looping.

Put in "decisions" every choice and assumption you made that someone continuing from your report would otherwise have to guess. They get this report, never your conversation.

When you finish, end with this report block and no extra commentary after it:

\`\`\`distill-report
{
  "status": "completed",
  "summary": "What you did and the main result",
  "decisions": [],
  "artifacts": [],
  "risks": [],
  "needsOperator": false,
  "nextSuggestedTask": null
}
\`\`\``;
}

export function parseStructuredReport(
  runId: string,
  status: StructuredReport["status"],
  assistantText: string,
): StructuredReport {
  const fenced = assistantText.match(REPORT_FENCE_PATTERN);
  if (fenced?.[1]) {
    try {
      const parsed = JSON.parse(fenced[1]) as Partial<StructuredReport>;
      const summary =
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : stripReportFence(assistantText);
      return {
        runId,
        status:
          parsed.status === "completed" ||
          parsed.status === "failed" ||
          parsed.status === "cancelled"
            ? parsed.status
            : status,
        summary,
        decisions: Array.isArray(parsed.decisions)
          ? parsed.decisions.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        artifacts: Array.isArray(parsed.artifacts)
          ? parsed.artifacts.flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const artifact = item as StructuredReport["artifacts"][number];
              if (typeof artifact.label !== "string") return [];
              return [
                {
                  label: artifact.label,
                  ...(typeof artifact.path === "string"
                    ? { path: artifact.path }
                    : {}),
                  ...(typeof artifact.url === "string"
                    ? { url: artifact.url }
                    : {}),
                },
              ];
            })
          : [],
        risks: Array.isArray(parsed.risks)
          ? parsed.risks.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
        needsOperator: parsed.needsOperator === true,
        nextSuggestedTask:
          typeof parsed.nextSuggestedTask === "string"
            ? parsed.nextSuggestedTask
            : null,
      };
    } catch {
      // Fall through to the plain-text summary.
    }
  }

  return {
    runId,
    status,
    summary: stripReportFence(assistantText) || assistantText.trim(),
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: status !== "completed",
    nextSuggestedTask: null,
  };
}

export function stripReportFence(text: string): string {
  return text.replace(REPORT_FENCE_PATTERN, "").trim();
}

/**
 * Renders a set of finished children's reports as the prose a reader sees.
 *
 * Takes only the display name off the node so callers that hold a partial node
 * (the digest builder works from wave steps, not from graph nodes) can use it.
 */
export function formatConductorAnswer(
  results: Array<{
    node: Pick<SessionNode, "displayName">;
    report: StructuredReport;
  }>,
): string {
  return results
    .map(({ node, report }) => {
      const lines = [
        `**${node.displayName}** — ${i18n.t(`chat:conductor.status.${report.status}`)}`,
        report.summary,
      ];
      if (report.decisions.length > 0) {
        lines.push(
          i18n.t("chat:conductor.decisions"),
          ...report.decisions.map((item) => `- ${item}`),
        );
      }
      if (report.artifacts.length > 0) {
        lines.push(
          i18n.t("chat:conductor.artifacts"),
          ...report.artifacts.map((artifact) =>
            artifact.path || artifact.url
              ? `- ${artifact.label} (${artifact.path ?? artifact.url})`
              : `- ${artifact.label}`,
          ),
        );
      }
      if (report.risks.length > 0) {
        lines.push(
          i18n.t("chat:conductor.risks"),
          ...report.risks.map((item) => `- ${item}`),
        );
      }
      if (report.operatorIntervened) {
        lines.push(i18n.t("chat:conductor.operatorIntervened"));
      }
      if (report.needsOperator) {
        lines.push(i18n.t("chat:conductor.needsOperator"));
      }
      if (report.nextSuggestedTask) {
        lines.push(
          `${i18n.t("chat:conductor.nextTask")}: ${report.nextSuggestedTask}`,
        );
      }
      return lines.filter(Boolean).join("\n");
    })
    .join("\n\n");
}
