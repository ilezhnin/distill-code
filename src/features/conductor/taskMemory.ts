/**
 * What a root request already tried and lost (P33).
 *
 * A revision is the loop's only correction, and until this existed it was a
 * correction made blind: the conductor sees the digest it just judged, and the
 * revision's workers see the previous wave's reports — but nothing carries the
 * shape of a failure forward as an instruction. Two revisions of the same
 * request could, and did, spend their budget re-attempting the thing that had
 * already failed, each one arriving at it honestly from a plan that never
 * knew.
 *
 * So the request keeps a short episodic record of itself: one JSON document
 * per root request, in the project's own `.distill` folder beside its memory,
 * written when a wave finishes and read when the next wave of the same root
 * spawns. It is not the operator's memory and never becomes one — nothing here
 * goes through the `distill-memory` protocol, nothing reaches another request,
 * and `LAWS/MEMORY.md` governs none of it. It is the request's own scratch
 * record, which dies with the request's folder.
 *
 * Two deliberate limits:
 *
 * - **A chat without a project keeps nothing.** The document lives in the
 *   project folder — the same home `projectMemoryDocuments.ts` chose, for the
 *   same reason — and a conductor running outside a project has nowhere to put
 *   it. Such a request simply has no task memory; it must not fail, and it
 *   must not fall back to the operator's global folder, where one request's
 *   scratch record would outlive the work it is about.
 * - **Reading salvages rather than validates**, like `memoryStore`: a document
 *   written by another build, half-truncated, or hand-edited yields whatever
 *   rows still parse. A record of past failures that itself fails is the one
 *   outcome with no value at all.
 */

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  readProjectDocument,
  writeProjectDocument,
} from "@/shared/api/projectStore";
import { getTextContent, type Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { StructuredReport } from "./types";

/** Schema version of the stored document. */
export const TASK_MEMORY_VERSION = 1;

/** Folder inside the project's `.distill`, one file per root request. */
export const TASK_MEMORY_DIR = "task-memory";

/**
 * Upper bound on the failed attempts one request carries into a prompt.
 *
 * A root request spends at most three waves of at most five steps, so this is
 * never reached in practice; it exists so a hand-edited or foreign document
 * cannot push an unbounded block into every worker's first message.
 */
export const MAX_TASK_MEMORY_FAILED_ATTEMPTS = 30;

/** Bound on one rendered attempt line. Long enough to say what happened. */
const MAX_ATTEMPT_LINE_PART = 400;

/** The header the revision's workers read. Exact wording is the contract. */
export const FAILED_ATTEMPTS_HEADING =
  "Already tried and failed on this request — do not repeat blindly:";

/** The verdict a wave ended on, in the document's own vocabulary. */
export type TaskMemoryVerdict =
  | "accept"
  | "revise"
  | "needs-operator"
  | "undecided";

export interface TaskMemoryStep {
  role: string;
  label?: string;
  status: StructuredReport["status"];
  summary: string;
  decisions: string[];
  /** `label|path` for a report that named one, the bare label otherwise. */
  artifacts: string[];
  risks: string[];
  reason?: string;
}

export interface TaskMemoryWave {
  waveId: string;
  /** 1-based: the first wave of a root request is attempt 1. */
  attempt: number;
  verdict: TaskMemoryVerdict;
  steps: TaskMemoryStep[];
}

export interface TaskMemoryFailedAttempt {
  /** The attempt number of the wave this failure happened in. */
  wave: number;
  role: string;
  /** What was attempted — the report's own summary. */
  what: string;
  /** Why it did not work — the report's reason, or its risks. */
  why: string;
}

export interface TaskMemoryDocument {
  version: typeof TASK_MEMORY_VERSION;
  rootRequestId: string;
  goal: string;
  waves: TaskMemoryWave[];
  failedAttempts: TaskMemoryFailedAttempt[];
}

/** How this module reaches the disk. Swapped wholesale in tests. */
export interface TaskMemoryIo {
  /** The project folder this conductor writes into, or `null` for none. */
  projectRootFor: (conductorSessionId: string) => string | null;
  read: (projectRoot: string, path: string) => Promise<string | null>;
  write: (projectRoot: string, path: string, contents: string) => Promise<void>;
}

const defaultIo: TaskMemoryIo = {
  projectRootFor: (conductorSessionId) => {
    // The graph knows a conductor's project; the session store is the fallback
    // for a conductor the graph never registered. Same order as the closeout
    // writer, which resolves the same folder for the same kind of file.
    const projectId =
      useConductorGraphStore.getState().nodesById[conductorSessionId]
        ?.projectId ||
      useChatSessionStore.getState().getSession(conductorSessionId)
        ?.projectId ||
      "";
    if (!projectId) return null;
    const project = useProjectStore
      .getState()
      .projects.find((candidate) => candidate.id === projectId);
    return project?.workingDirs?.[0]?.trim() || null;
  },
  read: readProjectDocument,
  write: writeProjectDocument,
};

let io: TaskMemoryIo = defaultIo;

export function setTaskMemoryIoForTests(next: Partial<TaskMemoryIo>): void {
  io = { ...defaultIo, ...next };
}

export function resetTaskMemoryIoForTests(): void {
  io = defaultIo;
}

/**
 * Where one root request's document lives, relative to `.distill`.
 *
 * The id is a message id and reaches the filesystem, so everything outside a
 * conservative alphabet becomes `_`: the backend refuses traversal already,
 * and this keeps the refusal from being the thing that stops a write.
 */
export function taskMemoryDocumentPath(rootRequestId: string): string {
  const safe =
    rootRequestId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "unknown";
  return `${TASK_MEMORY_DIR}/${safe}.json`;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isReportStatus(value: unknown): value is StructuredReport["status"] {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "blocked"
  );
}

/** How one report's artifacts read in the document: `label|path`. */
function artifactLines(report: StructuredReport): string[] {
  return report.artifacts.map((artifact) => {
    const where = artifact.path?.trim() || artifact.url?.trim() || "";
    const label = artifact.label?.trim() || "";
    return where ? `${label}|${where}` : label;
  });
}

/** One step of a finished wave, as the document keeps it. */
export function taskMemoryStepOf(entry: {
  role: string;
  label?: string;
  report: StructuredReport;
}): TaskMemoryStep {
  const { report } = entry;
  return {
    role: entry.role,
    ...(entry.label ? { label: entry.label } : {}),
    status: report.status,
    summary: report.summary,
    decisions: [...report.decisions],
    artifacts: artifactLines(report),
    risks: [...report.risks],
    ...(report.reason ? { reason: report.reason } : {}),
  };
}

/**
 * The failures a wave contributes to the request's record.
 *
 * `failed` and `blocked` only: a cancelled step says nothing about whether the
 * approach works — the operator or a budget stopped it — and repeating it is
 * often exactly the right move. `why` prefers the report's own reason and
 * falls back to its risks, because a `failed` report has no reason field and
 * "it failed" alone is not something a later plan can steer by.
 */
export function failedAttemptsOf(
  attempt: number,
  steps: readonly TaskMemoryStep[],
): TaskMemoryFailedAttempt[] {
  return steps
    .filter((step) => step.status === "failed" || step.status === "blocked")
    .map((step) => ({
      wave: attempt,
      role: step.role,
      what: step.summary.trim(),
      why: step.reason?.trim() || step.risks.join("; "),
    }));
}

/** The first line of the operator request a root wave was planned from. */
export function taskMemoryGoal(
  messages: readonly Message[],
  rootRequestId: string,
  fallback = "",
): string {
  const planIndex = messages.findIndex(
    (message) => message.id === rootRequestId,
  );
  for (let index = planIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    // A digest is a user message the app itself sent; it is never the goal.
    if (message.metadata?.origin === "berdctl_cross_session") continue;
    const line = getTextContent(message)
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (line) return line.slice(0, MAX_ATTEMPT_LINE_PART);
  }
  return fallback.trim().slice(0, MAX_ATTEMPT_LINE_PART);
}

function emptyDocument(
  rootRequestId: string,
  goal: string,
): TaskMemoryDocument {
  return {
    version: TASK_MEMORY_VERSION,
    rootRequestId,
    goal,
    waves: [],
    failedAttempts: [],
  };
}

function parseStep(value: unknown): TaskMemoryStep | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.role !== "string" || !raw.role) return null;
  return {
    role: raw.role,
    ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
    // A status this build does not know is read as `failed`: the row exists
    // because a step ended, and the safe reading of "ended, unrecognisably" is
    // not "completed".
    status: isReportStatus(raw.status) ? raw.status : "failed",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    decisions: stringList(raw.decisions),
    artifacts: stringList(raw.artifacts),
    risks: stringList(raw.risks),
    ...(typeof raw.reason === "string" && raw.reason
      ? { reason: raw.reason }
      : {}),
  };
}

function parseWave(value: unknown): TaskMemoryWave | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.waveId !== "string" || !raw.waveId) return null;
  const steps = Array.isArray(raw.steps)
    ? raw.steps
        .map(parseStep)
        .filter((step): step is TaskMemoryStep => step !== null)
    : [];
  return {
    waveId: raw.waveId,
    attempt:
      typeof raw.attempt === "number" && Number.isFinite(raw.attempt)
        ? raw.attempt
        : 1,
    verdict:
      raw.verdict === "accept" ||
      raw.verdict === "revise" ||
      raw.verdict === "needs-operator"
        ? raw.verdict
        : "undecided",
    steps,
  };
}

function parseFailedAttempt(value: unknown): TaskMemoryFailedAttempt | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const what = typeof raw.what === "string" ? raw.what.trim() : "";
  // An attempt with nothing to say is not a warning, it is noise in a prompt.
  if (!what) return null;
  return {
    wave:
      typeof raw.wave === "number" && Number.isFinite(raw.wave) ? raw.wave : 0,
    role: typeof raw.role === "string" ? raw.role : "",
    what,
    why: typeof raw.why === "string" ? raw.why.trim() : "",
  };
}

/**
 * Reads a stored document for whatever it still holds.
 *
 * Never throws and never returns `null`: a corrupt file, a foreign schema and
 * an absent file all yield an empty document for this root, so the request
 * carries on with less history rather than with no wave.
 */
export function parseTaskMemoryDocument(
  raw: string | null | undefined,
  rootRequestId: string,
): TaskMemoryDocument {
  if (!raw) return emptyDocument(rootRequestId, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyDocument(rootRequestId, "");
  }
  if (!parsed || typeof parsed !== "object") {
    return emptyDocument(rootRequestId, "");
  }
  const value = parsed as Record<string, unknown>;
  return {
    version: TASK_MEMORY_VERSION,
    // The file the document was found under is the fact; the id inside it is a
    // memento, exactly as `projectMemoryDocuments` treats the project id.
    rootRequestId,
    goal: typeof value.goal === "string" ? value.goal : "",
    waves: Array.isArray(value.waves)
      ? value.waves
          .map(parseWave)
          .filter((wave): wave is TaskMemoryWave => wave !== null)
      : [],
    failedAttempts: Array.isArray(value.failedAttempts)
      ? value.failedAttempts
          .map(parseFailedAttempt)
          .filter(
            (attempt): attempt is TaskMemoryFailedAttempt => attempt !== null,
          )
          .slice(-MAX_TASK_MEMORY_FAILED_ATTEMPTS)
      : [],
  };
}

/**
 * The document with one finished wave folded in.
 *
 * Idempotent on `waveId`: the digest pass can run twice for the same wave —
 * a retried digest, a restart mid-flight — and a request whose record grew a
 * duplicate wave would count its own failures twice in the next prompt.
 */
export function withRecordedWave(
  document: TaskMemoryDocument,
  wave: TaskMemoryWave,
): TaskMemoryDocument {
  const waves = document.waves.filter(
    (candidate) => candidate.waveId !== wave.waveId,
  );
  waves.push(wave);
  const failedAttempts = [
    ...document.failedAttempts.filter(
      (attempt) => attempt.wave !== wave.attempt,
    ),
    ...failedAttemptsOf(wave.attempt, wave.steps).filter(
      (attempt) => attempt.what.length > 0,
    ),
  ]
    .sort((left, right) => left.wave - right.wave)
    .slice(-MAX_TASK_MEMORY_FAILED_ATTEMPTS);
  return { ...document, waves, failedAttempts };
}

/** The document with one wave's verdict filled in, once it is known. */
export function withRecordedVerdict(
  document: TaskMemoryDocument,
  waveId: string,
  verdict: TaskMemoryVerdict,
): TaskMemoryDocument {
  return {
    ...document,
    waves: document.waves.map((wave) =>
      wave.waveId === waveId ? { ...wave, verdict } : wave,
    ),
  };
}

function trimPart(value: string): string {
  const text = value.trim();
  return text.length > MAX_ATTEMPT_LINE_PART
    ? `${text.slice(0, MAX_ATTEMPT_LINE_PART - 1)}…`
    : text;
}

/**
 * The block a revision's workers read, or `null` when there is nothing to say.
 *
 * `null`, not an empty heading: a header over no lines reads as "nothing has
 * been tried yet, and we are telling you about it", which is both untrue on a
 * first wave and pure noise in a prompt.
 */
export function formatFailedAttempts(
  attempts: readonly TaskMemoryFailedAttempt[],
): string | null {
  const lines = attempts
    .filter((attempt) => attempt.what.trim().length > 0)
    .map((attempt) => {
      const who = attempt.role ? ` (${attempt.role})` : "";
      const why = trimPart(attempt.why);
      return `- wave ${attempt.wave}${who}: ${trimPart(attempt.what)}${
        why ? ` — why it failed: ${why}` : ""
      }`;
    });
  if (lines.length === 0) return null;
  return [FAILED_ATTEMPTS_HEADING, ...lines].join("\n");
}

/**
 * The stored document for one root request. Empty when there is nowhere to
 * look — a chat outside a project, or a build with no folder behind it.
 */
export async function readTaskMemory(
  conductorSessionId: string,
  rootRequestId: string,
): Promise<TaskMemoryDocument> {
  try {
    const root = io.projectRootFor(conductorSessionId);
    if (!root) return emptyDocument(rootRequestId, "");
    const raw = await io.read(root, taskMemoryDocumentPath(rootRequestId));
    return parseTaskMemoryDocument(raw, rootRequestId);
  } catch (error) {
    console.error("Failed to read the task memory document:", error);
    return emptyDocument(rootRequestId, "");
  }
}

async function updateTaskMemory(
  conductorSessionId: string,
  rootRequestId: string,
  apply: (document: TaskMemoryDocument) => TaskMemoryDocument,
): Promise<TaskMemoryDocument | null> {
  try {
    const root = io.projectRootFor(conductorSessionId);
    if (!root) return null;
    const path = taskMemoryDocumentPath(rootRequestId);
    const current = parseTaskMemoryDocument(
      await io.read(root, path),
      rootRequestId,
    );
    const next = apply(current);
    await io.write(root, path, JSON.stringify(next));
    return next;
  } catch (error) {
    // A request whose record could not be written is a request with less
    // history, never a wave that stops: this is a courtesy to the next wave,
    // and it must not be able to break the one that earned it.
    console.error("Failed to write the task memory document:", error);
    return null;
  }
}

/**
 * Records one finished wave against its root request.
 *
 * Called where the digest is built, not where the verdict lands: between those
 * two points sits a whole model turn, and the revision wave the verdict may
 * create starts spawning in the same tick it is created. Writing at the digest
 * is what makes "the next wave sees this" a fact rather than a race.
 */
export async function recordWaveInTaskMemory(args: {
  conductorSessionId: string;
  rootRequestId: string;
  goal: string;
  wave: TaskMemoryWave;
}): Promise<TaskMemoryDocument | null> {
  return updateTaskMemory(
    args.conductorSessionId,
    args.rootRequestId,
    (document) =>
      withRecordedWave(
        // The goal is written once and kept: a later wave has no better view
        // of what was asked, and an empty one must not erase it.
        document.goal ? document : { ...document, goal: args.goal },
        args.wave,
      ),
  );
}

/** Stamps a wave's verdict once the conductor has given one. */
export async function recordTaskMemoryVerdict(args: {
  conductorSessionId: string;
  rootRequestId: string;
  waveId: string;
  verdict: TaskMemoryVerdict;
}): Promise<TaskMemoryDocument | null> {
  return updateTaskMemory(
    args.conductorSessionId,
    args.rootRequestId,
    (document) => withRecordedVerdict(document, args.waveId, args.verdict),
  );
}

/**
 * The failed-attempts block for the next wave of a root request, or `null`.
 *
 * Only a revision reads it. A first wave has nothing behind it by definition,
 * and asking the disk about it would put an IPC round-trip in front of every
 * spawn the app makes.
 */
export async function loadFailedAttemptsBlock(args: {
  conductorSessionId: string;
  rootRequestId: string;
  revisionCount: number;
}): Promise<string | null> {
  if (args.revisionCount <= 0) return null;
  const document = await readTaskMemory(
    args.conductorSessionId,
    args.rootRequestId,
  );
  return formatFailedAttempts(document.failedAttempts);
}
