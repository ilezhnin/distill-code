import type {
  WaveStepTelemetry,
  WaveTelemetryRecord,
} from "./waveTelemetryStore";

/**
 * What this installation has actually measured about its own models (P39).
 *
 * The one sanctioned answer to "which model should do this?". Reputational
 * priors about models are a refused idea here — they are gossip with a
 * version number, they age badly, and they are wrong in the particular ways
 * that matter to one operator's setup. What is not gossip is what happened on
 * this machine: how often a given model, asked for a given kind of step,
 * finished it; how often its work came back degraded; how often the waves it
 * planned were accepted.
 *
 * Derived from the telemetry records already being kept, so nothing new is
 * collected and nothing is stored twice. The conductor is handed the summary
 * as facts rather than advice, and it is free to disagree — a small sample is
 * a weak fact, and the block says the sample size for exactly that reason.
 */

/**
 * Below this many observations a rate is noise, and putting noise into a
 * prompt as a fact is worse than saying nothing: a model that failed its one
 * and only step would read as "fails 100% of the time" forever.
 */
export const MIN_FACT_OBSERVATIONS = 5;

export interface StepFact {
  role: string;
  modelId: string;
  harnessId?: string;
  runs: number;
  /** Steps that reached `completed`. */
  completed: number;
  /** Steps whose report never arrived and was stubbed. */
  degraded: number;
}

export interface ConductorFact {
  modelId: string;
  harnessId?: string;
  waves: number;
  accepted: number;
  revised: number;
  needsOperator: number;
}

export interface FactsLedger {
  steps: StepFact[];
  conductors: ConductorFact[];
}

function stepKey(step: WaveStepTelemetry): string | null {
  if (!step.modelId) return null;
  return step.role + " " + step.modelId + " " + (step.harnessId ?? "");
}

/**
 * Aggregates the records into facts, dropping everything under the threshold.
 *
 * Ordered by sample size, largest first: when the block has to be trimmed,
 * the facts that survive should be the ones with the most behind them.
 */
export function buildFactsLedger(
  records: readonly WaveTelemetryRecord[],
  minObservations: number = MIN_FACT_OBSERVATIONS,
): FactsLedger {
  const steps = new Map<string, StepFact>();
  const conductors = new Map<string, ConductorFact>();

  for (const record of records) {
    for (const step of record.steps) {
      const key = stepKey(step);
      if (!key || !step.modelId) continue;
      const fact = steps.get(key) ?? {
        role: step.role,
        modelId: step.modelId,
        ...(step.harnessId ? { harnessId: step.harnessId } : {}),
        runs: 0,
        completed: 0,
        degraded: 0,
      };
      fact.runs += 1;
      if (step.outcome === "completed") fact.completed += 1;
      if (step.reportDegraded) fact.degraded += 1;
      steps.set(key, fact);
    }

    const modelId = record.conductorModelId;
    if (!modelId) continue;
    const key = modelId + " " + (record.conductorHarnessId ?? "");
    const fact = conductors.get(key) ?? {
      modelId,
      ...(record.conductorHarnessId
        ? { harnessId: record.conductorHarnessId }
        : {}),
      waves: 0,
      accepted: 0,
      revised: 0,
      needsOperator: 0,
    };
    fact.waves += 1;
    if (record.outcome === "accepted") fact.accepted += 1;
    if (record.outcome === "revised") fact.revised += 1;
    if (record.outcome === "needs-operator") fact.needsOperator += 1;
    conductors.set(key, fact);
  }

  return {
    steps: [...steps.values()]
      .filter((fact) => fact.runs >= minObservations)
      .sort((left, right) => right.runs - left.runs),
    conductors: [...conductors.values()]
      .filter((fact) => fact.waves >= minObservations)
      .sort((left, right) => right.waves - left.waves),
  };
}

function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/** How many facts of each kind the prompt block will carry. */
export const MAX_PROMPT_FACTS = 8;

/**
 * The ledger as prompt text, or an empty string when there is nothing to say.
 *
 * Written as measurements with their sample size attached, never as advice.
 * "Sol completed 9 of 11 brigade steps here" is a fact the conductor can
 * weigh against everything else it knows; "prefer Sol for brigade steps"
 * would be this app's opinion wearing a fact's clothes, and the app has not
 * earned one.
 */
export function renderFactsForPrompt(ledger: FactsLedger): string {
  const lines: string[] = [];
  for (const fact of ledger.steps.slice(0, MAX_PROMPT_FACTS)) {
    const degraded =
      fact.degraded > 0
        ? ", " + fact.degraded + " finished without a report"
        : "";
    lines.push(
      "- " +
        fact.modelId +
        ' on "' +
        fact.role +
        '" steps: ' +
        fact.completed +
        " of " +
        fact.runs +
        " completed" +
        degraded +
        ".",
    );
  }
  for (const fact of ledger.conductors.slice(0, MAX_PROMPT_FACTS)) {
    lines.push(
      "- Waves planned on " +
        fact.modelId +
        ": " +
        percent(fact.accepted, fact.waves) +
        "% accepted, " +
        percent(fact.revised, fact.waves) +
        "% revised, " +
        percent(fact.needsOperator, fact.waves) +
        "% handed back (" +
        fact.waves +
        " waves).",
    );
  }
  if (lines.length === 0) return "";
  return [
    "## What this installation has measured",
    "",
    "Counts from waves that actually ran here, not opinions about models. Small numbers are weak evidence; the sample size is given so you can weigh them.",
    "",
    ...lines,
  ].join("\n");
}
