import { describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";

import type { WaveRejectionReason } from "./waveEngine";
import type { WaveClosureReason } from "./waveVerdict";
import {
  WAVE_CLOSURE_REASON_KEYS,
  WAVE_REJECTION_REASON_KEYS,
  waveRejectionNoticeText,
  waveRetryLabel,
  waveSpawnFailureText,
  waveStepBlockedNoticeText,
  waveStepExplicitModelNoticeText,
} from "./waveNotices";

const ALL_REASONS = Object.keys(
  WAVE_REJECTION_REASON_KEYS,
) as WaveRejectionReason[];

describe("waveNotices", () => {
  it("has an English string for every enumerated reason", async () => {
    await i18n.loadNamespaces("chat");
    for (const reason of ALL_REASONS) {
      const key = `chat:conductor.wave.reason.${WAVE_REJECTION_REASON_KEYS[reason]}`;
      expect(i18n.exists(key), key).toBe(true);
      expect(i18n.t(key)).not.toBe(key);
    }
  });

  it("renders the reason from the code, with the parser detail appended", async () => {
    await i18n.loadNamespaces("chat");
    const text = waveRejectionNoticeText({
      reason: "too-many-steps",
      detail: "A wave takes at most 5 steps, got 7.",
    });
    expect(text).toContain(i18n.t("chat:conductor.wave.invalidTitle"));
    expect(text).toContain(
      i18n.t("chat:conductor.wave.reason.tooManySteps", { step: 1 }),
    );
    expect(text).toContain("got 7");
  });

  it("interpolates the human step number for per-step reasons", async () => {
    await i18n.loadNamespaces("chat");
    const text = waveRejectionNoticeText({
      reason: "subtask-empty",
      detail: "",
      stepIndex: 2,
    });
    expect(text).toContain("3");
  });

  it("never renders a bare key", async () => {
    await i18n.loadNamespaces("chat");
    expect(waveRetryLabel()).not.toContain("conductor.wave");
    expect(waveSpawnFailureText(0, "boom")).toContain("boom");
    expect(waveSpawnFailureText(0, "boom")).not.toContain(
      "conductor.wave.spawnFailed",
    );
  });

  it("names the step, the worker and the model when an explicit model runs near its limit", async () => {
    await i18n.loadNamespaces("chat");
    const text = waveStepExplicitModelNoticeText({
      stepIndex: 1,
      name: "Brigade",
      model: "Claude Opus 5",
    });
    expect(text).toContain("2");
    expect(text).toContain("Brigade");
    expect(text).toContain("Claude Opus 5");
    expect(text).not.toContain("conductor.wave");
  });

  it("has an English string for every closure reason", async () => {
    await i18n.loadNamespaces("chat");
    for (const reason of Object.keys(
      WAVE_CLOSURE_REASON_KEYS,
    ) as WaveClosureReason[]) {
      const key = `chat:conductor.wave.verdict.reason.${WAVE_CLOSURE_REASON_KEYS[reason]}`;
      expect(i18n.exists(key), key).toBe(true);
      expect(i18n.t(key)).not.toBe(key);
    }
  });

  it("names the blocked step and quotes the worker's reason", async () => {
    await i18n.loadNamespaces("chat");
    const text = waveStepBlockedNoticeText({
      stepIndex: 0,
      name: "Scout · callers",
      reason: "the callers file does not exist",
    });
    expect(text).toContain(
      i18n.t("chat:conductor.wave.verdict.needsOperatorTitle"),
    );
    expect(text).toContain("1");
    expect(text).toContain("Scout · callers");
    expect(text).toContain("the callers file does not exist");
    expect(text).not.toContain("conductor.wave");
  });

  it("omits the reason line when the report carried none", async () => {
    await i18n.loadNamespaces("chat");
    const text = waveStepBlockedNoticeText({
      stepIndex: 2,
      name: "Bohr",
    });
    expect(text).toContain("3");
    expect(text).toContain("Bohr");
    expect(text).not.toContain("{{reason}}");
    expect(text).not.toContain("conductor.wave");
  });
});
