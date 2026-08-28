import type { StructuredReport } from "./types";
import type { WaveTelemetryRecord } from "./waveTelemetryStore";

/**
 * What a root request did, written into the project so it outlives the chat
 * (P55).
 *
 * Everything this app knows about a finished piece of work lives in a
 * conversation: the plan, the reports, the verdict, the notices. That is the
 * right place for it while the work is happening and the wrong place six
 * months later, when the question is "why is this like this?" and the person
 * asking has the repository and not the transcript. Chats are searched by
 * whoever remembers they exist; a file in `docs/runs/` is found by whoever
 * opens the folder.
 *
 * Written outside `.distill` on purpose. That folder is this tool's own state
 * and is excluded from git for exactly that reason — but a closeout is meant
 * to be committed with the work it describes, so a folder git ignores could
 * not serve it.
 *
 * The content is assembled from what was actually recorded — the steps, their
 * outcomes, the decisions and risks their reports carried — and never from a
 * model asked to summarize itself. A closeout that a model wrote about its own
 * work would inherit exactly the optimism the verdict loop exists to check.
 */

export interface CloseoutInput {
  /** Every wave of one root request, oldest first. */
  waves: readonly WaveTelemetryRecord[];
  /** The report a step's run produced, when it produced one. */
  reportOf: (runId: string | null | undefined) => StructuredReport | undefined;
  /** The run id of a step, so its report can be found. */
  runIdOf: (waveId: string, stepIndex: number) => string | null | undefined;
  /** What the operator asked for, in their own words, when it is known. */
  request?: string;
  title: string;
  at: number;
}

/** File name for a closeout: dated, slugged, and safe as a plain name. */
export function closeoutFileName(title: string, at: number): string {
  const day = new Date(at).toISOString().slice(0, 10);
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "run";
  return `${day}-${slug}.md`;
}

function bullets(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `- ${line}`);
}

/**
 * The closeout, as Markdown.
 *
 * Pure, so what it says can be proven without a folder or a clock. Sections
 * are omitted rather than left empty: a heading with nothing under it reads as
 * "we looked and found nothing", which is a different claim from "this run
 * produced none of that".
 */
export function buildRunCloseout(input: CloseoutInput): string {
  const { waves } = input;
  const last = waves[waves.length - 1];
  const lines: string[] = [
    `# ${input.title}`,
    "",
    `_${new Date(input.at).toISOString().slice(0, 10)} · ${waves.length} wave${waves.length === 1 ? "" : "s"} · ${last ? outcomeWord(last.outcome) : "unfinished"}_`,
    "",
  ];

  if (input.request?.trim()) {
    lines.push("## The request", "", input.request.trim(), "");
  }

  const decisions: string[] = [];
  const risks: string[] = [];
  const artifacts: string[] = [];
  const stepLines: string[] = [];

  for (const [waveIndex, wave] of waves.entries()) {
    const heading =
      waves.length === 1
        ? "## What was done"
        : waveIndex === 0
          ? "## What was done"
          : `## Revision ${waveIndex}`;
    stepLines.push(heading, "");
    for (const step of wave.steps) {
      const report = input.reportOf(input.runIdOf(wave.waveId, step.stepIndex));
      const summary = report?.summary?.trim();
      stepLines.push(
        `- **${step.role}** (${report?.status ?? step.outcome})${summary ? ` — ${summary}` : ""}`,
      );
      for (const decision of report?.decisions ?? []) decisions.push(decision);
      for (const risk of report?.risks ?? []) risks.push(risk);
      for (const artifact of report?.artifacts ?? []) {
        artifacts.push(artifact.path ?? artifact.url ?? artifact.label);
      }
    }
    stepLines.push("");
  }
  lines.push(...stepLines);

  if (decisions.length > 0) {
    lines.push("## Decisions", "", ...bullets(decisions), "");
  }
  if (artifacts.length > 0) {
    lines.push("## Files and artifacts", "", ...bullets(artifacts), "");
  }
  if (risks.length > 0) {
    lines.push("## Risks left open", "", ...bullets(risks), "");
  }

  lines.push(
    "---",
    "",
    "Written by Distill from what the run recorded — the plan, the steps and their reports — not from a model asked to summarize its own work.",
  );
  return lines.join("\n");
}

function outcomeWord(outcome: WaveTelemetryRecord["outcome"]): string {
  switch (outcome) {
    case "accepted":
      return "accepted";
    case "revised":
      return "revised";
    case "needs-operator":
      return "handed back to the operator";
    default:
      return "closed";
  }
}
