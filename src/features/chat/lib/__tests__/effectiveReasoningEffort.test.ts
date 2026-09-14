import { describe, expect, it, vi } from "vitest";
import type { ChatSessionReasoningEffortConfig } from "@/features/chat/stores/chatSessionStore";
import {
  hasSelectableReasoningEffort,
  resolveEffectiveReasoningEffort,
  ULTRACODE_OPTION_ID,
} from "../effectiveReasoningEffort";

function effortConfig(
  configId: string,
  ids: string[],
  currentValue = ids[0] ?? "",
): ChatSessionReasoningEffortConfig {
  return {
    configId,
    currentValue,
    options: ids.map((id) => ({ id, name: id })),
  };
}

describe("resolveEffectiveReasoningEffort", () => {
  it("uses the session's own effort config and writes a selection back through it", () => {
    const config = effortConfig(
      "reasoning_effort",
      ["low", "medium", "high"],
      "medium",
    );
    const onChange = vi.fn();

    const effort = resolveEffectiveReasoningEffort({
      sessionReasoningEffort: { config, onChange },
    });
    effort.onSelect("high");

    expect(effort.config).toBe(config);
    expect(onChange).toHaveBeenCalledWith("high");
  });

  it("offers no control when the session states no effort config", () => {
    const effort = resolveEffectiveReasoningEffort({
      sessionReasoningEffort: { onChange: vi.fn() },
    });

    expect(effort.config).toBeUndefined();
    expect(hasSelectableReasoningEffort(effort.config)).toBe(false);
    expect(resolveEffectiveReasoningEffort({}).config).toBeUndefined();
  });

  it("keeps a config with a single value as it is instead of inventing a ladder", () => {
    const config = effortConfig("reasoning_effort", ["high"]);

    const effort = resolveEffectiveReasoningEffort({
      sessionReasoningEffort: { config },
    });

    expect(effort.config).toBe(config);
    expect(hasSelectableReasoningEffort(effort.config)).toBe(false);
  });

  it("adds Ultracode to Claude's effort option on a model that runs max, and selecting it applies max and arms it", () => {
    const config = effortConfig(
      "effort",
      ["low", "medium", "high", "xhigh", "max"],
      "high",
    );
    const onChange = vi.fn();
    const setArmed = vi.fn();

    const effort = resolveEffectiveReasoningEffort({
      sessionReasoningEffort: {
        config,
        onChange,
        ultracode: { armed: false, setArmed },
      },
    });
    effort.onSelect(ULTRACODE_OPTION_ID);

    expect(effort.config?.options.map((option) => option.id)).toContain(
      ULTRACODE_OPTION_ID,
    );
    expect(onChange).toHaveBeenCalledWith("max");
    expect(setArmed).toHaveBeenCalledWith(true);
  });

  it("never offers Ultracode on codex's reasoning_effort, even with xhigh and max", () => {
    const config = effortConfig("reasoning_effort", [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    const effort = resolveEffectiveReasoningEffort({
      sessionReasoningEffort: {
        config,
        ultracode: { armed: false, setArmed: vi.fn() },
      },
    });

    expect(effort.config).toBe(config);
  });

  it("offers no Ultracode on a Claude model whose top stop is below xhigh", () => {
    const config = effortConfig("effort", ["low", "medium", "high"]);

    const effort = resolveEffectiveReasoningEffort({
      sessionReasoningEffort: {
        config,
        ultracode: { armed: false, setArmed: vi.fn() },
      },
    });

    expect(effort.config).toBe(config);
  });
});
