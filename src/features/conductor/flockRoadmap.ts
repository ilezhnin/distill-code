/**
 * The conductor's roadmap: the goal it pursues on its own, the stages toward
 * it, and where each stands.
 *
 * Wire format — a fenced block in a conductor message, beside a wave or an
 * answer:
 *
 * ```distill-roadmap
 * {"goal":"...","status":"in-progress","stages":[{"title":"...","status":"done","evidence":["docs/STATUS.md"]}]}
 * ```
 *
 * The parse is tri-state like the wave's: no fence is nothing, a readable
 * fence is a roadmap, and anything else is refused with a reason the operator
 * can read. The app keeps the newest roadmap per conductor across restarts
 * (`waveStore.ts`), shows each change to the operator, and reads its status
 * to decide whether an accepted wave is followed by a "continue toward the
 * goal" turn (`waveLifecycle.ts`).
 */

import { scanFencedBlock } from "./flockWave";

/** Fence info-string that carries a roadmap. */
export const ROADMAP_FENCE_TAG = "distill-roadmap";

export const ROADMAP_STATUSES = [
  /** The conductor is working toward the goal; accepted waves are followed up. */
  "in-progress",
  /** The conductor stopped the loop itself; the operator's next word resumes it. */
  "paused",
  /** The goal is done. Terminal for the loop. */
  "reached",
  /** The conductor needs the operator before it can go on. */
  "needs-operator",
] as const;

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const ROADMAP_STAGE_STATUSES = [
  "pending",
  "active",
  "done",
  "blocked",
] as const;

export type RoadmapStageStatus = (typeof ROADMAP_STAGE_STATUSES)[number];

export interface RoadmapStage {
  title: string;
  status: RoadmapStageStatus;
  /** Files or notes that show a done stage is done. */
  evidence: string[];
}

/** The roadmap as the conductor wrote it, before the app's bookkeeping. */
export interface RoadmapBody {
  goal: string;
  status: RoadmapStatus;
  stages: RoadmapStage[];
  /** One line for the operator, when the conductor wrote one. */
  note?: string;
}

/**
 * The roadmap as the app keeps it: the conductor's body plus the bookkeeping
 * of where it came from and where the goal loop stands.
 */
export interface ConductorRoadmap extends RoadmapBody {
  conductorSessionId: string;
  /** When the app applied this version. */
  updatedAt: number;
  /** The conductor message that carried it, and when that message was made. */
  sourceMessageId: string;
  sourceCreatedAt: number;
  /** How many "continue toward the goal" turns the app has sent for this goal. */
  continueTurns: number;
  /**
   * The continue turn in flight, when one is: `pending` is decided but not
   * yet sent, `dispatching` is on its way into the transcript, `awaiting`
   * has landed and waits for the conductor's answer.
   */
  continueTurn?: {
    attempt: number;
    phase: "pending" | "dispatching" | "awaiting";
    startedAt: number;
  };
}

/** Caps: a roadmap is a page, not a document. */
export const MAX_ROADMAP_GOAL_LENGTH = 1_000;
export const MAX_ROADMAP_STAGES = 40;
export const MAX_ROADMAP_STAGE_TITLE_LENGTH = 300;
export const MAX_ROADMAP_EVIDENCE_PER_STAGE = 20;
export const MAX_ROADMAP_EVIDENCE_LENGTH = 500;
export const MAX_ROADMAP_NOTE_LENGTH = 1_000;

export type RoadmapInvalidReason =
  | "multiple-fences"
  | "unterminated-fence"
  | "malformed-json"
  | "not-an-object"
  | "goal-missing"
  | "status-unknown"
  | "stages-not-array"
  | "stage-invalid";

export interface RoadmapInvalid {
  kind: "invalid";
  reason: RoadmapInvalidReason;
  /** Operator-readable; safe to render verbatim. */
  detail: string;
}

export type FlockRoadmapParse =
  | { kind: "none" }
  | { kind: "roadmap"; roadmap: RoadmapBody }
  | RoadmapInvalid;

function invalid(reason: RoadmapInvalidReason, detail: string): RoadmapInvalid {
  return { kind: "invalid", reason, detail };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capped(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function parseStage(
  raw: unknown,
  index: number,
): RoadmapStage | RoadmapInvalid {
  if (!isJsonObject(raw)) {
    return invalid("stage-invalid", `Stage ${index + 1} is not a JSON object.`);
  }
  if (typeof raw.title !== "string" || !raw.title.trim()) {
    return invalid(
      "stage-invalid",
      `Stage ${index + 1} needs a non-empty "title".`,
    );
  }
  const status =
    typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
  if (!(ROADMAP_STAGE_STATUSES as readonly string[]).includes(status)) {
    return invalid(
      "stage-invalid",
      `Stage ${index + 1} has status "${String(raw.status)}"; use one of ${ROADMAP_STAGE_STATUSES.join(", ")}.`,
    );
  }
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
        .slice(0, MAX_ROADMAP_EVIDENCE_PER_STAGE)
        .map((item) => capped(item, MAX_ROADMAP_EVIDENCE_LENGTH))
    : [];
  return {
    title: capped(raw.title, MAX_ROADMAP_STAGE_TITLE_LENGTH),
    status: status as RoadmapStageStatus,
    evidence,
  };
}

/** Tri-state parse of the roadmap fence in a conductor message. */
export function parseFlockRoadmap(messageText: string): FlockRoadmapParse {
  const scan = scanFencedBlock(messageText, ROADMAP_FENCE_TAG);
  if (scan.kind === "none") return { kind: "none" };
  if (scan.kind === "multiple") {
    return invalid(
      "multiple-fences",
      `Found ${scan.count} ${ROADMAP_FENCE_TAG} blocks. Publish exactly one roadmap per message.`,
    );
  }
  if (scan.kind === "unterminated") {
    return invalid(
      "unterminated-fence",
      `The ${ROADMAP_FENCE_TAG} block was opened but never closed.`,
    );
  }
  return parseRoadmapBody(scan.body);
}

/**
 * Parses the JSON inside one roadmap fence. Shared by the message scan and by
 * the transcript renderer (`ui/RoadmapRecord.tsx`), which draws the block as
 * the goal and its stages rather than as JSON.
 */
export function parseRoadmapBody(
  body: string,
): { kind: "roadmap"; roadmap: RoadmapBody } | RoadmapInvalid {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return invalid(
      "malformed-json",
      `The ${ROADMAP_FENCE_TAG} block is not valid JSON: ${message}`,
    );
  }
  if (!isJsonObject(parsed)) {
    return invalid(
      "not-an-object",
      `The ${ROADMAP_FENCE_TAG} block must contain a JSON object with "goal", "status" and "stages".`,
    );
  }
  if (typeof parsed.goal !== "string" || !parsed.goal.trim()) {
    return invalid("goal-missing", `The roadmap needs a non-empty "goal".`);
  }
  const status =
    typeof parsed.status === "string"
      ? parsed.status.trim().toLowerCase()
      : "in-progress";
  if (!(ROADMAP_STATUSES as readonly string[]).includes(status)) {
    return invalid(
      "status-unknown",
      `The roadmap status "${String(parsed.status)}" is not one of ${ROADMAP_STATUSES.join(", ")}.`,
    );
  }
  if (parsed.stages !== undefined && !Array.isArray(parsed.stages)) {
    return invalid("stages-not-array", `"stages" must be an array.`);
  }
  const stages: RoadmapStage[] = [];
  for (const [index, raw] of (parsed.stages ?? []).entries()) {
    if (index >= MAX_ROADMAP_STAGES) break;
    const stage = parseStage(raw, index);
    if ("kind" in stage) return stage;
    stages.push(stage);
  }
  const note =
    typeof parsed.note === "string" && parsed.note.trim()
      ? capped(parsed.note, MAX_ROADMAP_NOTE_LENGTH)
      : undefined;
  return {
    kind: "roadmap",
    roadmap: {
      goal: capped(parsed.goal, MAX_ROADMAP_GOAL_LENGTH),
      status: status as RoadmapStatus,
      stages,
      ...(note ? { note } : {}),
    },
  };
}

/** The stage counts a notice or a prompt states. */
export function roadmapProgress(roadmap: Pick<RoadmapBody, "stages">): {
  done: number;
  total: number;
} {
  return {
    done: roadmap.stages.filter((stage) => stage.status === "done").length,
    total: roadmap.stages.length,
  };
}

/** The roadmap as a model reads it back: compact JSON, one line per stage. */
export function renderRoadmapForPrompt(roadmap: RoadmapBody): string {
  const lines = [
    `Goal: ${roadmap.goal}`,
    `Status: ${roadmap.status}`,
    ...(roadmap.note ? [`Note: ${roadmap.note}`] : []),
    roadmap.stages.length === 0
      ? "Stages: none listed yet."
      : `Stages:\n${roadmap.stages
          .map(
            (stage, index) =>
              `${index + 1}. [${stage.status}] ${stage.title}${
                stage.evidence.length > 0
                  ? ` — evidence: ${stage.evidence.join("; ")}`
                  : ""
              }`,
          )
          .join("\n")}`,
  ];
  return lines.join("\n");
}
