import { i18n } from "@/shared/i18n";

import type { SessionNode, StructuredReport } from "./types";

const REPORT_FENCE_PATTERN = /```distill-report\s*([\s\S]*?)```/i;

/**
 * Hard cap on a blocked report's `reason`, applied by truncation.
 *
 * The reason is rendered verbatim into an operator notice when a wave step
 * blocks, so a worker that dumps its whole transcript into the field must not
 * flood the conductor chat. Truncation rather than rejection, because the
 * report parser is lenient by design — losing the tail of an oversized reason
 * is recoverable, losing the blocked claim itself is not. The cap is a short
 * paragraph: enough for a real explanation, an order of magnitude above the
 * step-label cap (60), which is a name and not an account.
 */
export const MAX_BLOCKED_REASON_LENGTH = 500;

/**
 * Stand-in reason for a `blocked` report whose worker gave none.
 *
 * A blocked report with no reason still blocks — downgrading it to "done"
 * because a field is missing would be the exact fabrication the status exists
 * to prevent — but the operator card must never render an empty line.
 */
export const MISSING_BLOCKED_REASON =
  "The worker reported it is blocked but gave no reason.";

/**
 * The visible trace of a report whose `status` field held a value the app
 * does not recognize.
 *
 * The status falls back to the run's own outcome — a typo must not invent a
 * `blocked` or un-invent a failure — but silently reading `"blocke"` as done
 * is how a wave gets built on a step that said it could not be done. So the
 * miss is recorded where every reader of the report will see it: as a risk,
 * which the digest, the operator card and every `access: "all"` handoff all
 * render.
 */
export function unrecognizedReportStatusRisk(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const shown = (text ?? String(value)).slice(0, 40);
  return `The report's "status" ("${shown}") is not one of completed, failed, cancelled or blocked; the run's own outcome was used instead.`;
}

function blockedReasonOf(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return MISSING_BLOCKED_REASON;
  return trimmed.length > MAX_BLOCKED_REASON_LENGTH
    ? `${trimmed.slice(0, MAX_BLOCKED_REASON_LENGTH - 1)}…`
    : trimmed;
}

export function wrapOrchestratorTaskPrompt(task: string): string {
  return `${task.trim()}

Do this step and stop. Do not carry on into the next piece of work, and do not keep trying variations once you have an answer or once you are genuinely stuck. Failure is a legitimate result: if you did the work and it did not succeed, report it with "status": "failed" and "needsOperator": true instead of looping. And if you cannot do the step at all — a file or input it names does not exist, the instructions contradict each other, something only the operator can unblock — report "status": "blocked" and put what is stopping you in a "reason" field. Never invent a result just to have something to report: a blocked report is acted on, a fabricated one is built on.

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
\`\`\`

"artifacts" is your evidence trail: list every file you created, changed, ran, or inspected, each as an object like {"label": "x.md", "path": "src/x.md"} (use "url" instead of "path" for a link). Bare strings are dropped by the reader — always the object form. An empty list reads as "I never touched the work", so leave it empty only when that is literally true.

The report block belongs in your reply and nowhere else: never write it — or any other fenced protocol block — into the files you create or edit. A file that ends up holding your report is a defect the next step will have to clean up.`;
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
      // A worker whose whole reply is the report block leaves nothing behind
      // once the fence is stripped. Falling back to the raw text (as the
      // unfenced path already does) keeps every report's summary non-empty:
      // an empty one reads as "no report yet" to every consumer, and one of
      // them re-attached it on every graph pass until the renderer crashed.
      const summary =
        typeof parsed.summary === "string" && parsed.summary.trim()
          ? parsed.summary.trim()
          : stripReportFence(assistantText) || assistantText.trim();
      const claimedStatus = (parsed as { status?: unknown }).status;
      const reportedStatus =
        claimedStatus === "completed" ||
        claimedStatus === "failed" ||
        claimedStatus === "cancelled" ||
        claimedStatus === "blocked"
          ? claimedStatus
          : status;
      // A status field that is present but unreadable is announced, never
      // swallowed: the fallback to the run's outcome is the safe *status*,
      // and the risk line is what keeps it from being a silent "done".
      const statusRisks =
        claimedStatus === undefined ||
        claimedStatus === null ||
        claimedStatus === reportedStatus
          ? []
          : [unrecognizedReportStatusRisk(claimedStatus)];
      return {
        runId,
        status: reportedStatus,
        ...(reportedStatus === "blocked"
          ? { reason: blockedReasonOf((parsed as { reason?: unknown }).reason) }
          : {}),
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
        risks: [
          ...(Array.isArray(parsed.risks)
            ? parsed.risks.filter(
                (item): item is string => typeof item === "string",
              )
            : []),
          ...statusRisks,
        ],
        // A blocked step is by definition the operator's to unblock, whatever
        // the worker set the flag to.
        needsOperator:
          parsed.needsOperator === true || reportedStatus === "blocked",
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
      if (report.status === "blocked" && report.reason) {
        // The reason is the one fact a blocked report exists to carry; the
        // summary alone reads like any other unfinished step.
        lines.push(
          i18n.t("chat:conductor.blockedReason", { reason: report.reason }),
        );
      }
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
