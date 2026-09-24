import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type {
  AgentPickerOption,
  ChatInputFastMode,
  ModelOption,
} from "../../types";
import { AgentModelPicker } from "../AgentModelPicker";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  claudeModels,
  modelRow,
  moreModelsRow,
} from "./modelPickerFixtures";

afterEach(() => {
  cleanup();
});

/** Folded effort suffixes the model id must never carry again. */
const FOLDED_EFFORT_SUFFIX = /\[(minimal|low|medium|high|xhigh|max|ultra)\]$/;

interface HarnessProps {
  models: ModelOption[];
  providerId?: string;
  initialModelId: string | null;
  onModelChange?: (modelId: string) => void;
  fastMode?: ChatInputFastMode;
  runActive?: boolean;
  agents?: AgentPickerOption[];
  providerColumnMode?: "visible" | "gated";
}

/** Stands in for a composer: a pick becomes the current model. */
function PickerHarness({
  models,
  providerId = CLAUDE_PROVIDER_ID,
  initialModelId,
  onModelChange,
  fastMode,
  runActive,
  agents,
  providerColumnMode = "gated",
}: HarnessProps) {
  const [modelId, setModelId] = useState(initialModelId);
  return (
    <AgentModelPicker
      agents={agents ?? [{ id: providerId, label: "Agent" }]}
      selectedAgentId={providerId}
      onAgentChange={() => {}}
      currentModelId={modelId}
      currentModelProviderId={providerId}
      availableModels={models}
      onModelChange={(nextModelId) => {
        onModelChange?.(nextModelId);
        setModelId(nextModelId);
      }}
      fastMode={fastMode}
      runActive={runActive}
      providerColumnMode={providerColumnMode}
    />
  );
}

function trigger() {
  return screen.getByRole("button", { name: "Choose agent and model" });
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger());
  await waitFor(() => {
    expect(document.querySelector('[data-col="model"]')).not.toBeNull();
  });
}

function moreColumnHidden() {
  return (
    document.querySelector('[data-col="more"]')?.getAttribute("data-hidden") ??
    "absent"
  );
}

describe("AgentModelPicker", () => {
  it("hands onModelChange the row's base id from the main page, More models and search", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    render(
      <PickerHarness
        models={claudeModels}
        initialModelId="opus[1m]"
        onModelChange={onModelChange}
      />,
    );
    await openPicker(user);

    await user.click(modelRow("model", "Sonnet 5"));
    await user.click(moreModelsRow() as HTMLButtonElement);
    await user.click(modelRow("more", "Opus 4.8"));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Search models..." }));
    await user.keyboard("4.7");
    await user.click(modelRow("model", "Opus 4.7"));

    expect(onModelChange.mock.calls.map(([modelId]) => modelId)).toEqual([
      "sonnet",
      "claude-opus-4-8",
      "claude-opus-4-7",
    ]);
    for (const [modelId] of onModelChange.mock.calls) {
      expect(modelId).not.toMatch(FOLDED_EFFORT_SUFFIX);
    }
    // A pick from search lands back on the main page.
    expect(moreColumnHidden()).toBe("true");
    expect(moreModelsRow()).toHaveTextContent("Opus 4.7");
  });

  it("drives the fast toggle from the session's live option and asks for the opposite value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PickerHarness
        models={claudeModels}
        initialModelId="opus[1m]"
        fastMode={{
          config: {
            configId: "fast",
            name: "fast",
            enabled: true,
            kind: "select",
          },
          onChange,
        }}
      />,
    );
    await openPicker(user);

    const toggle = screen.getByRole("switch", { name: "Fast" });
    expect(toggle).toBeChecked();
    await user.click(toggle);

    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("disables models that reopen the session while a turn is running", async () => {
    const user = userEvent.setup();
    render(
      <PickerHarness
        models={claudeModels}
        initialModelId="opus[1m]"
        runActive
      />,
    );
    await openPicker(user);

    expect(modelRow("model", "Fable 5.1")).toBeDisabled();
    expect(modelRow("model", "Opus 5")).toBeEnabled();
    expect(modelRow("model", "Sonnet 5")).toBeEnabled();
    await user.click(moreModelsRow() as HTMLButtonElement);
    expect(modelRow("more", "Opus 4.8")).toBeDisabled();
    expect(modelRow("more", "Fable 5")).toBeEnabled();
  });

  it("offers another agent between turns only, and keeps a setup row reachable mid-turn", async () => {
    const user = userEvent.setup();
    const agents: AgentPickerOption[] = [
      { id: CLAUDE_PROVIDER_ID, label: "Claude Code" },
      { id: CODEX_PROVIDER_ID, label: "Codex" },
      {
        id: "grok-acp",
        label: "Grok",
        readiness: "not_ready",
        setupAction: "connect",
      },
    ];
    const agentRow = (label: string) =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-col="agent"] button[data-picker-nav-item]',
        ),
      ).find((row) => row.textContent?.includes(label));

    const { unmount } = render(
      <PickerHarness
        models={claudeModels}
        initialModelId="opus[1m]"
        providerColumnMode="visible"
        agents={agents}
        runActive
      />,
    );
    await openPicker(user);
    expect(agentRow("Codex")).toBeDisabled();
    expect(agentRow("Claude Code")).toBeEnabled();
    expect(agentRow("Grok")).toBeEnabled();
    unmount();

    render(
      <PickerHarness
        models={claudeModels}
        initialModelId="opus[1m]"
        providerColumnMode="visible"
        agents={agents}
      />,
    );
    await openPicker(user);
    expect(agentRow("Codex")).toBeEnabled();
  });
});
