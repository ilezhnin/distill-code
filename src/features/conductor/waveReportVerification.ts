/**
 * The verification gate on worker reports (P62).
 *
 * A report used to enter the digest and the next step's context on its own
 * say-so: "completed" was whatever the model wrote. The measured wins of
 * multi-agent systems sit on verification at the entrance to shared state,
 * not on topology — and the cheapest lie to catch is a claim of success
 * carrying nothing checkable. This module is the pure check; the engine
 * calls it through the `verifyStepReport` seam, and a report that fails is
 * QUARANTINED: its claims never reach a dependent step or the digest — a
 * substitute stub goes in its place, saying why (see
 * `synthesizeFailedVerificationReport` in waveEngine.ts).
 *
 * Scope, honestly stated: these are structural checks — does a claim of
 * success carry evidence at all — not fact checks. Whether the named files
 * exist is measured wave-wide by the artifact probe (E3b) and already
 * refuses an `accept`; per-step filesystem probing would ride the same
 * probe pattern and is deliberately not here yet. Failure, cancellation and
 * blockage pass untouched: they are their own honest signals, and the gate
 * guards claims of success only.
 */

import type { StructuredReport } from "./types";
import { roleStage } from "./roleLayers";

export type ReportVerification = { ok: true } | { ok: false; detail: string };

/**
 * Checks one worker report claiming `completed` against its step's stage.
 *
 * - Every report needs a non-empty summary: a wordless success is not a
 *   report, it is a status flip with a fence around it.
 * - A `prod`-stage step produced something, so its report must point at
 *   evidence — at least one artifact or one recorded decision. A completed
 *   prod report with neither is the signature of a model narrating instead
 *   of working.
 * - A `verify`-stage step's whole job is evidence, so its report must name
 *   at least one artifact — the same bar the accept-gate (E2) already holds
 *   the final verification step to; holding every verify step to it means a
 *   dependent step never builds on an evidence-free "checked, looks fine".
 * - Other stages (`pre`, `release`, `post`) and unknown roles get the
 *   summary check only: a brief is prose by nature, and inventing an
 *   evidence bar for it would quarantine honest work.
 */
export function verifyWaveStepReport(
  report: StructuredReport,
  step: { role: string },
): ReportVerification {
  if (report.status !== "completed") return { ok: true };
  if (!report.summary.trim()) {
    return { ok: false, detail: "the report's summary is empty" };
  }
  const stage = roleStage(step.role);
  if (stage === "prod") {
    if (report.artifacts.length === 0 && report.decisions.length === 0) {
      return {
        ok: false,
        detail:
          "a completed prod-stage report names no artifacts and no decisions — nothing checkable backs the claim of success",
      };
    }
    return { ok: true };
  }
  if (stage === "verify") {
    if (report.artifacts.length === 0) {
      return {
        ok: false,
        detail:
          "a completed verification report names no evidence artifacts — the accept gate (E2) requires them, and a dependent step must not build on an evidence-free pass",
      };
    }
    return { ok: true };
  }
  return { ok: true };
}
