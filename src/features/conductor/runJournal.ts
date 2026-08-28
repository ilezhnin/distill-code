import { isDesktopRuntime } from "@/shared/api/distillStore";
import { distillDocument } from "@/shared/lib/distillDocument";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode, StructuredReport } from "./types";
import type { WaveState } from "./waveEngine";
import {
  getWaveEngineState,
  subscribeWaveEngineState,
  type WaveEngineState,
} from "./waveStore";

/**
 * What the app saw a run do, written down (P27).
 *
 * Until this existed, "why did that wave go wrong?" could only be answered by
 * watching it happen. The graph holds the *current* status of each executor
 * and the wave holds its *current* phase; both are overwritten as the run
 * proceeds, so by the time anything looks wrong the evidence of how it got
 * there is gone. A digest says four executors completed; it cannot say that
 * three of them were spawned nine seconds apart onto a model the harness then
 * refused, which is the actual story of the run that made this necessary.
 *
 * Two decisions are worth stating, because both are departures from the
 * obvious.
 *
 * **It is derived, not emitted.** Nothing in the wave engine calls into this
 * module. It subscribes to the two stores and writes down the transitions it
 * observes, which means a code path that forgets to log cannot exist, and the
 * journal cannot claim something the app's own state never showed. The cost is
 * that it records what changed rather than why, which is exactly the trade a
 * trace should make: the reasons are model prose and already in the
 * transcript, while the sequence and the timing are the part nothing else
 * keeps.
 *
 * **One JSON document per wave, not an append-only `.jsonl`.** The document
 * store's whole guarantee is that the renderer names a relative path and gets
 * an atomic whole-file write inside the root; appending would need a second
 * native command with a different failure mode (a torn line is unparseable
 * forever, while a torn document is impossible — the write is a rename). A
 * wave is capped at five steps and closes in minutes, so its journal is tens
 * of events, and rewriting it is cheaper than the debounce that batches it.
 * The property the plan asked for holds either way: the full cycle of a wave
 * can be read back from the folder with no application running.
 */

export type RunEventKind =
  | "wave-admitted"
  | "wave-phase"
  | "step-phase"
  | "step-spawned"
  | "step-status"
  | "step-report"
  | "wave-closed";

export interface RunEvent {
  /**
   * Position in this wave's journal, stamped on append.
   *
   * Two events of the same kind can land in the same millisecond — four steps
   * spawn from one store write — so the timestamp is not an identity. This is
   * the one the renderer keys on and the one a reader counts by.
   */
  seq?: number;
  /** Wall clock, when the app saw it. */
  at: number;
  kind: RunEventKind;
  waveId: string;
  conductorSessionId: string;
  rootRequestId: string;
  /** Present when the event is about one step of the wave. */
  stepIndex?: number;
  /** The executor's session, once one exists. */
  sessionId?: string;
  /** Everything else, flat and readable. */
  detail?: Record<string, string | number | boolean>;
}

/**
 * Events kept per wave.
 *
 * Far above what a five-step wave produces; the cap exists for the pathological
 * run that flaps a status, not for the normal one.
 */
export const MAX_RUN_EVENTS = 500;

/** Waves whose journals stay in memory. Older ones live on in the folder. */
const MAX_OPEN_JOURNALS = 24;

interface Journal {
  waveId: string;
  events: RunEvent[];
  write: (events: RunEvent[]) => void;
  flush: () => Promise<void>;
}

export function runJournalPath(waveId: string): string {
  // Wave ids are uuids, but a path is a path: anything that could climb out of
  // the folder is replaced rather than trusted.
  return `runs/${waveId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

const journals = new Map<string, Journal>();
const listeners = new Set<() => void>();

function parseEvents(raw: unknown): RunEvent[] {
  const document = raw as { version?: number; events?: unknown } | null;
  if (!document || !Array.isArray(document.events)) return [];
  const events: RunEvent[] = [];
  for (const value of document.events) {
    if (!value || typeof value !== "object") continue;
    const event = value as Partial<RunEvent>;
    if (
      typeof event.at !== "number" ||
      typeof event.kind !== "string" ||
      typeof event.waveId !== "string"
    ) {
      continue;
    }
    events.push(event as RunEvent);
  }
  return events;
}

function journalFor(waveId: string): Journal {
  const existing = journals.get(waveId);
  if (existing) return existing;
  const document = distillDocument<RunEvent[]>({
    path: runJournalPath(waveId),
    // No browser copy ever existed for these, and inventing one would put a
    // per-wave key back into the storage this release is emptying.
    legacyStorageKey: `goose:run-journal:${waveId}`,
    parse: parseEvents,
    serialize: (events) => ({ version: 1, waveId, events }),
  });
  const journal: Journal = {
    waveId,
    events: [],
    write: (events) => document.write(events),
    flush: () => document.flush(),
  };
  journals.set(waveId, journal);
  // Insertion-ordered: the first key is the least recently opened journal.
  while (journals.size > MAX_OPEN_JOURNALS) {
    const oldest = journals.keys().next();
    if (oldest.done || oldest.value === waveId) break;
    const dropped = journals.get(oldest.value);
    journals.delete(oldest.value);
    void dropped?.flush();
  }
  return journal;
}

/** Records one event. Never throws: this runs inside store subscriptions. */
export function appendRunEvent(event: RunEvent): void {
  try {
    const journal = journalFor(event.waveId);
    const seq = (journal.events[journal.events.length - 1]?.seq ?? -1) + 1;
    journal.events = [...journal.events, { ...event, seq }].slice(
      -MAX_RUN_EVENTS,
    );
    if (isDesktopRuntime()) journal.write(journal.events);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A reader that throws must not reach a store's write path.
      }
    }
  } catch {
    // A trace that cannot be written is a worse day, not a broken run.
  }
}

/** This session's events for one wave, oldest first. */
export function runEventsFor(waveId: string): readonly RunEvent[] {
  return journals.get(waveId)?.events ?? EMPTY_EVENTS;
}

const EMPTY_EVENTS: readonly RunEvent[] = Object.freeze([]);

/** Subscribes to new events. Returns the unsubscribe. */
export function subscribeRunEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Pushes every open journal to disk. Shutdown, and tests. */
export async function flushRunJournals(): Promise<void> {
  await Promise.all([...journals.values()].map((journal) => journal.flush()));
}

/** Drops the in-memory journals. Tests only. */
export function resetRunJournalsForTests(): void {
  journals.clear();
  listeners.clear();
}

function stepSummary(wave: WaveState): string {
  return wave.steps.map((step) => `${step.stepIndex}:${step.phase}`).join(" ");
}

function waveEventBase(
  wave: WaveState,
  kind: RunEventKind,
  at: number,
): RunEvent {
  return {
    at,
    kind,
    waveId: wave.waveId,
    conductorSessionId: wave.conductorSessionId,
    rootRequestId: wave.rootRequestId,
  };
}

/**
 * Diffs one wave-store snapshot against the previous one.
 *
 * Exported for its own test: this is the half that decides what a trace says,
 * and it must be provable without a store, a timer or a renderer.
 */
export function diffWaveStates(
  previous: WaveEngineState | null,
  next: WaveEngineState,
  at: number,
): RunEvent[] {
  const before = new Map(
    (previous?.waves ?? []).map((wave) => [wave.waveId, wave]),
  );
  const events: RunEvent[] = [];

  for (const wave of next.waves) {
    const old = before.get(wave.waveId);
    if (!old) {
      events.push({
        ...waveEventBase(wave, "wave-admitted", at),
        detail: {
          steps: wave.steps.length,
          revision: wave.revisionCount,
          planMessageId: wave.planMessageId,
          roles: wave.steps.map((step) => step.role).join(","),
        },
      });
      for (const step of wave.steps) {
        events.push({
          ...waveEventBase(wave, "step-phase", at),
          stepIndex: step.stepIndex,
          detail: { phase: step.phase, role: step.role },
        });
      }
      continue;
    }
    if (old.phase !== wave.phase) {
      events.push({
        ...waveEventBase(wave, "wave-phase", at),
        detail: {
          from: old.phase,
          to: wave.phase,
          steps: stepSummary(wave),
          ...(wave.verdictIssue ? { verdict: wave.verdictIssue.reason } : {}),
        },
      });
    }
    const oldSteps = new Map(old.steps.map((step) => [step.stepIndex, step]));
    for (const step of wave.steps) {
      const oldStep = oldSteps.get(step.stepIndex);
      if (!oldStep || oldStep.phase === step.phase) continue;
      events.push({
        ...waveEventBase(wave, "step-phase", at),
        stepIndex: step.stepIndex,
        ...(step.sessionId ? { sessionId: step.sessionId } : {}),
        detail: { from: oldStep.phase, to: step.phase, role: step.role },
      });
    }
  }

  for (const wave of previous?.waves ?? []) {
    if (next.waves.some((live) => live.waveId === wave.waveId)) continue;
    events.push({
      ...waveEventBase(wave, "wave-closed", at),
      detail: { phase: wave.phase, steps: stepSummary(wave) },
    });
  }

  return events;
}

/**
 * Diffs one graph snapshot against the previous one, for wave-owned nodes.
 *
 * Nodes with no `waveId` are ordinary chats and orchestrators started by hand;
 * they belong to no run and are deliberately not traced here.
 */
export function diffGraphNodes(
  previous: Record<string, SessionNode> | null,
  next: Record<string, SessionNode>,
  reports: Record<string, StructuredReport>,
  previousReports: Record<string, StructuredReport> | null,
  conductorOf: (waveId: string) => WaveState | undefined,
  at: number,
): RunEvent[] {
  const events: RunEvent[] = [];
  for (const key in next) {
    const node = next[key];
    if (!node?.waveId || node.sessionId !== key) continue;
    const wave = conductorOf(node.waveId);
    if (!wave) continue;
    const old = previous?.[key];
    if (!old) {
      events.push({
        ...waveEventBase(wave, "step-spawned", at),
        stepIndex: node.stepIndex,
        sessionId: node.sessionId,
        detail: {
          name: node.displayName,
          harness: node.harnessId,
          ...(node.modelId ? { model: node.modelId } : {}),
          status: node.status,
        },
      });
    } else if (old.status !== node.status) {
      events.push({
        ...waveEventBase(wave, "step-status", at),
        stepIndex: node.stepIndex,
        sessionId: node.sessionId,
        detail: { from: old.status, to: node.status, name: node.displayName },
      });
    }
    const runId = node.runId;
    if (!runId) continue;
    const report = reports[runId];
    if (!report || previousReports?.[runId]) continue;
    events.push({
      ...waveEventBase(wave, "step-report", at),
      stepIndex: node.stepIndex,
      sessionId: node.sessionId,
      detail: {
        status: report.status,
        artifacts: report.artifacts.length,
        risks: report.risks.length,
        needsOperator: report.needsOperator,
        summary: report.summary.slice(0, 200),
      },
    });
  }
  return events;
}

let installed = false;

/**
 * Starts writing the journal. Idempotent; returns the teardown.
 *
 * Both subscriptions are cheap diffs over maps the stores already replace by
 * identity, and they only ever look at wave-owned entries — so a session with
 * no brigade pays one map lookup per graph write.
 */
export function installRunJournal(): () => void {
  if (installed) return () => undefined;
  installed = true;

  let previousWaves: WaveEngineState | null = getWaveEngineState();
  const stopWaves = subscribeWaveEngineState((next) => {
    const events = diffWaveStates(previousWaves, next, Date.now());
    previousWaves = next;
    for (const event of events) appendRunEvent(event);
  });

  const graph = useConductorGraphStore.getState();
  let previousNodes: Record<string, SessionNode> | null = graph.nodesById;
  let previousReports: Record<string, StructuredReport> | null =
    graph.reportsByRunId;
  const stopGraph = useConductorGraphStore.subscribe((state) => {
    if (
      state.nodesById === previousNodes &&
      state.reportsByRunId === previousReports
    ) {
      return;
    }
    const waveById = new Map(
      getWaveEngineState().waves.map((wave) => [wave.waveId, wave]),
    );
    const events = diffGraphNodes(
      previousNodes,
      state.nodesById,
      state.reportsByRunId,
      previousReports,
      (waveId) => waveById.get(waveId),
      Date.now(),
    );
    previousNodes = state.nodesById;
    previousReports = state.reportsByRunId;
    for (const event of events) appendRunEvent(event);
  });

  return () => {
    installed = false;
    stopWaves();
    stopGraph();
  };
}
