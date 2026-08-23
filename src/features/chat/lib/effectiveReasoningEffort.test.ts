import { describe, expect, it, vi } from "vitest";

import {
  appendUltracodeKeyword,
  hasSelectableReasoningEffort,
  resolveEffectiveReasoningEffort,
  selectedReasoningEffortLabel,
  supportsUltracode,
  ULTRACODE_OPTION_ID,
} from "./effectiveReasoningEffort";
import type { ChatSessionReasoningEffortConfig } from "../stores/chatSessionStore";
import type { ModelOption } from "../types";

const claudeEffortConfig: ChatSessionReasoningEffortConfig = {
  configId: "effort",
  currentValue: "high",
  options: [
    { id: "default", name: "Default" },
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
    { id: "max", name: "Max" },
  ],
};

const nativeThinkingConfig: ChatSessionReasoningEffortConfig = {
  configId: "thinking_effort",
  currentValue: "medium",
  options: [
    { id: "off", name: "off" },
    { id: "low", name: "low" },
    { id: "medium", name: "medium" },
    { id: "high", name: "high" },
    { id: "max", name: "max" },
  ],
};

const models = (ids: string[]): ModelOption[] =>
  ids.map((id) => ({ id, name: id }));

describe("resolveEffectiveReasoningEffort", () => {
  it("uses a selectable session config over other sources", () => {
    const onChange = vi.fn();
    const effective = resolveEffectiveReasoningEffort({
      availableModels: models(["default", "sonnet"]),
      currentModelId: "default",
      selectedAgentId: "claude-acp",
      sessionReasoningEffort: { config: claudeEffortConfig, onChange },
    });

    expect(effective.config).toBe(claudeEffortConfig);
    effective.onSelect("low");
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("composes wire model ids for embedded-effort model lists", () => {
    const onModelChange = vi.fn();
    const effective = resolveEffectiveReasoningEffort({
      availableModels: models(["grok-4[low]", "grok-4[high]"]),
      currentModelId: "grok-4[low]",
      selectedAgentId: "grok-acp",
      onModelChange,
    });

    expect(effective.usesModelEmbeddedReasoning).toBe(true);
    effective.onSelect("high");
    expect(onModelChange).toHaveBeenCalledWith(
      "grok-4[high]",
      expect.objectContaining({ id: "grok-4[high]" }),
    );
  });

  describe("ultracode augmentation", () => {
    const armable = (armed = false) => ({
      armed,
      setArmed: vi.fn(),
    });

    it("appends the ultracode stop to a qualifying Claude effort config", () => {
      const ultracode = armable();
      const effective = resolveEffectiveReasoningEffort({
        availableModels: models(["default"]),
        currentModelId: "default",
        selectedAgentId: "claude-acp",
        sessionReasoningEffort: {
          config: claudeEffortConfig,
          onChange: vi.fn(),
          ultracode,
        },
      });

      expect(effective.config?.options.at(-1)).toEqual({
        id: ULTRACODE_OPTION_ID,
        name: "Ultracode",
      });
      expect(effective.config?.currentValue).toBe("high");
    });

    it("does not augment native thinking_effort configs", () => {
      const effective = resolveEffectiveReasoningEffort({
        availableModels: models(["gpt-oss"]),
        currentModelId: "gpt-oss",
        selectedAgentId: "goose",
        sessionReasoningEffort: {
          config: nativeThinkingConfig,
          onChange: vi.fn(),
          ultracode: armable(),
        },
      });

      expect(
        effective.config?.options.some(
          (option) => option.id === ULTRACODE_OPTION_ID,
        ),
      ).toBe(false);
    });

    it("shows ultracode as current while armed", () => {
      const effective = resolveEffectiveReasoningEffort({
        availableModels: models(["default"]),
        currentModelId: "default",
        selectedAgentId: "claude-acp",
        sessionReasoningEffort: {
          config: claudeEffortConfig,
          onChange: vi.fn(),
          ultracode: armable(true),
        },
      });

      expect(effective.config?.currentValue).toBe(ULTRACODE_OPTION_ID);
      expect(
        effective.config && selectedReasoningEffortLabel(effective.config),
      ).toBe("Ultracode");
    });

    it("selecting ultracode pins the top effort and arms the keyword", () => {
      const onChange = vi.fn();
      const ultracode = armable();
      const effective = resolveEffectiveReasoningEffort({
        availableModels: models(["default"]),
        currentModelId: "default",
        selectedAgentId: "claude-acp",
        sessionReasoningEffort: {
          config: claudeEffortConfig,
          onChange,
          ultracode,
        },
      });

      effective.onSelect(ULTRACODE_OPTION_ID);
      expect(onChange).toHaveBeenCalledWith("max");
      expect(ultracode.setArmed).toHaveBeenCalledWith(true);
    });

    it("selecting ultracode while already at the top effort skips the set", () => {
      const onChange = vi.fn();
      const ultracode = armable();
      const effective = resolveEffectiveReasoningEffort({
        availableModels: models(["default"]),
        currentModelId: "default",
        selectedAgentId: "claude-acp",
        sessionReasoningEffort: {
          config: { ...claudeEffortConfig, currentValue: "max" },
          onChange,
          ultracode,
        },
      });

      effective.onSelect(ULTRACODE_OPTION_ID);
      expect(onChange).not.toHaveBeenCalled();
      expect(ultracode.setArmed).toHaveBeenCalledWith(true);
    });

    it("selecting a real effort level disarms ultracode", () => {
      const onChange = vi.fn();
      const ultracode = armable(true);
      const effective = resolveEffectiveReasoningEffort({
        availableModels: models(["default"]),
        currentModelId: "default",
        selectedAgentId: "claude-acp",
        sessionReasoningEffort: {
          config: claudeEffortConfig,
          onChange,
          ultracode,
        },
      });

      effective.onSelect("low");
      expect(ultracode.setArmed).toHaveBeenCalledWith(false);
      expect(onChange).toHaveBeenCalledWith("low");
    });
  });
});

describe("supportsUltracode", () => {
  it("requires the Claude bridge effort config with a top tier", () => {
    expect(supportsUltracode(claudeEffortConfig)).toBe(true);
    expect(
      supportsUltracode({
        configId: "effort",
        currentValue: "xhigh",
        options: [
          { id: "low", name: "Low" },
          { id: "xhigh", name: "Xhigh" },
        ],
      }),
    ).toBe(true);
    expect(supportsUltracode(nativeThinkingConfig)).toBe(false);
    expect(
      supportsUltracode({
        configId: "effort",
        currentValue: "low",
        options: [
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
        ],
      }),
    ).toBe(false);
    expect(supportsUltracode(undefined)).toBe(false);
  });
});

describe("appendUltracodeKeyword", () => {
  it("appends the keyword on its own trailing line", () => {
    expect(appendUltracodeKeyword("Fix the bug")).toBe(
      "Fix the bug\n\nultracode",
    );
  });

  it("does not double-append when the prompt already ends with it", () => {
    expect(appendUltracodeKeyword("Fix the bug\n\nultracode")).toBe(
      "Fix the bug\n\nultracode",
    );
  });

  it("leaves empty prompts untouched", () => {
    expect(appendUltracodeKeyword("")).toBe("");
    expect(appendUltracodeKeyword("   ")).toBe("   ");
  });
});

describe("hasSelectableReasoningEffort", () => {
  it("needs a config id and at least two options", () => {
    expect(hasSelectableReasoningEffort(claudeEffortConfig)).toBe(true);
    expect(
      hasSelectableReasoningEffort({
        configId: "effort",
        currentValue: "high",
        options: [{ id: "high", name: "High" }],
      }),
    ).toBe(false);
    expect(hasSelectableReasoningEffort(undefined)).toBe(false);
  });
});
