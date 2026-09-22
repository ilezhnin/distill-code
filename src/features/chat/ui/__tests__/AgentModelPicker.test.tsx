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
  codexModels,
  modelRow,
  modelRowLabels,
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
  it("lists Fable 5.1, Opus 5, Sonnet 5 and Haiku 4.5 on the main page, followed by More models", async () => {
    const user = userEvent.setup();
    render(<PickerHarness models={claudeModels} initialModelId="opus[1m]" />);

    await openPicker(user);

    expect(modelRowLabels("model")).toEqual([
      "Fable 5.1",
      "Opus 5",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
    expect(moreModelsRow()).toHaveTextContent(/^More models$/);
    expect(moreColumnHidden()).toBe("true");
  });

  it("opens More models on Fable 5, Opus 4.8, Opus 4.7, Opus 4.6 and Sonnet 4.6 with the first of them focused", async () => {
    const user = userEvent.setup();
    render(<PickerHarness models={claudeModels} initialModelId="opus[1m]" />);
    await openPicker(user);

    await user.click(moreModelsRow() as HTMLButtonElement);

    expect(moreColumnHidden()).toBe("false");
    expect(modelRowLabels("more")).toEqual([
      "Fable 5",
      "Opus 4.8",
      "Opus 4.7",
      "Opus 4.6",
      "Sonnet 4.6",
    ]);
    await waitFor(() => expect(modelRow("more", "Fable 5")).toHaveFocus());
  });

  it("keeps Fable 5 checked inside More models without promoting it, and reopens on that page with it focused", async () => {
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
    await user.click(moreModelsRow() as HTMLButtonElement);

    await user.click(modelRow("more", "Fable 5"));

    expect(onModelChange).toHaveBeenLastCalledWith("claude-fable-5[1m]");
    expect(modelRow("more", "Fable 5")).toHaveAttribute("data-selected");
    expect(modelRowLabels("model")).toEqual([
      "Fable 5.1",
      "Opus 5",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
    expect(moreModelsRow()).toHaveTextContent("Fable 5");

    // Escape leaves the page first, and only then closes the picker.
    await user.keyboard("{Escape}");
    expect(moreColumnHidden()).toBe("true");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(document.querySelector('[data-col="model"]')).toBeNull();
    });
    expect(trigger()).toHaveTextContent("Fable 5");

    await openPicker(user);

    expect(moreColumnHidden()).toBe("false");
    await waitFor(() => expect(modelRow("more", "Fable 5")).toHaveFocus());
  });

  it("shows the default alias in place of its twin only while default is the selection", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    const { unmount } = render(
      <PickerHarness
        models={claudeModels}
        initialModelId="sonnet"
        onModelChange={onModelChange}
      />,
    );
    await openPicker(user);
    expect(modelRowLabels("model")).toEqual([
      "Fable 5.1",
      "Opus 5",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
    await user.click(modelRow("model", "Opus 5"));
    expect(onModelChange).toHaveBeenLastCalledWith("opus[1m]");
    unmount();

    render(
      <PickerHarness
        models={claudeModels}
        initialModelId="default"
        onModelChange={onModelChange}
      />,
    );
    await openPicker(user);
    expect(modelRowLabels("model")).toEqual([
      "Fable 5.1",
      "Opus 5",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
    expect(modelRow("model", "Opus 5")).toHaveAttribute("data-selected");
    await user.click(modelRow("model", "Opus 5"));
    expect(onModelChange).toHaveBeenLastCalledWith("default");
  });

  it("keeps Codex's current generation main and selects an older model from More", async () => {
    const user = userEvent.setup();
    render(
      <PickerHarness
        models={codexModels}
        providerId={CODEX_PROVIDER_ID}
        initialModelId="gpt-6-sol"
      />,
    );

    await openPicker(user);

    expect(modelRowLabels("model")).toEqual([
      "GPT-6-Astra",
      "GPT-6-Sol",
      "GPT-6-Luna",
    ]);
    await user.click(moreModelsRow() as HTMLButtonElement);
    expect(modelRowLabels("more")).toEqual([
      "GPT-5.6-Sol",
      "GPT-5.6-Terra",
      "GPT-5.6-Luna",
      "GPT-5.5",
      "GPT-5.3-Codex-Spark",
    ]);
    await user.click(modelRow("more", "GPT-5.6-Sol"));
    expect(modelRow("more", "GPT-5.6-Sol")).toHaveAttribute("data-selected");
    expect(moreModelsRow()).toHaveTextContent("GPT-5.6-Sol");
  });

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

  it.each([
    ["Fable 5.1", "claude-fable-5-1[1m]", false],
    ["Sonnet 5", "sonnet", false],
    ["Haiku 4.5", "haiku", false],
    ["Opus 5", "opus[1m]", true],
  ])("shows the fast toggle on %s only when that model has fast mode", async (_name, modelId, expected) => {
    const user = userEvent.setup();
    render(
      <PickerHarness
        models={claudeModels}
        initialModelId={modelId}
        fastMode={{ onChange: vi.fn() }}
      />,
    );

    await openPicker(user);

    const toggle = screen.queryByRole("switch", { name: "Fast" });
    if (expected) {
      expect(toggle).toBeInTheDocument();
    } else {
      expect(toggle).toBeNull();
    }
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

  it("leaves those models enabled when no turn is running", async () => {
    const user = userEvent.setup();
    render(<PickerHarness models={claudeModels} initialModelId="opus[1m]" />);
    await openPicker(user);

    expect(modelRow("model", "Fable 5.1")).toBeEnabled();
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

  it("moves with Down and Up inside a column and with Right and Left across columns", async () => {
    const user = userEvent.setup();
    render(
      <PickerHarness
        models={claudeModels}
        initialModelId="opus[1m]"
        providerColumnMode="visible"
        agents={[
          { id: CLAUDE_PROVIDER_ID, label: "Claude Code" },
          { id: CODEX_PROVIDER_ID, label: "Codex" },
        ]}
      />,
    );
    await openPicker(user);
    const agentRow = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-col="agent"] button[data-picker-nav-item]',
        ),
      )[0];
    await waitFor(() => expect(agentRow()).toHaveFocus());

    await user.keyboard("{ArrowRight}");
    expect(modelRow("model", "Fable 5.1")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(modelRow("model", "Opus 5")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(modelRow("model", "Fable 5.1")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(agentRow()).toHaveFocus();

    await user.keyboard("{ArrowRight}{ArrowUp}");
    expect(moreModelsRow()).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(modelRow("more", "Fable 5")).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(modelRow("more", "Opus 4.8")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(moreColumnHidden()).toBe("true");
    await waitFor(() => expect(moreModelsRow()).toHaveFocus());
  });
});
