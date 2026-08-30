import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { serializeAgentModelRanking } from "../../../lib/agentModelRanking";
import { ModelRankingField } from "../ModelRankingField";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

const RANKABLE_PROVIDERS = [
  { id: "claude-acp", label: "Claude Code" },
  { id: "grok-acp", label: "Grok" },
] as const;

const mocks = vi.hoisted(() => ({
  acpProviders: [
    { id: "claude-acp", label: "Claude Code" },
    { id: "grok-acp", label: "Grok" },
  ],
  models: {
    "claude-acp": [
      { id: "claude-opus-5", displayName: "Claude Opus 5" },
      { id: "claude-fable-5", displayName: "Claude Fable 5" },
    ],
    "grok-acp": [{ id: "grok-4-6", displayName: "Grok 4.6" }],
  } as Record<string, { id: string; displayName: string }[]>,
  rateLimits: [] as unknown[],
  inventoryProblem: null as {
    providerId: string;
    outcome: "empty" | "failed";
    reason?: string;
  } | null,
}));

const INSTALLED_MODELS = { ...mocks.models };

vi.mock("@/features/agents/stores/agentStore", () => ({
  useAgentStore: (selector: (state: { providers: unknown[] }) => unknown) =>
    selector({ providers: mocks.acpProviders }),
}));

vi.mock("@/features/providers/hooks/useProviderModels", () => ({
  useProviderModels: () => ({
    getModelsForAgent: (platform: string) => mocks.models[platform] ?? [],
    getError: () => null,
    getModelInventoryProblem: () => mocks.inventoryProblem,
  }),
}));

vi.mock("@/features/status/stores/providerRateLimitsStore", () => ({
  useProviderRateLimitsStore: (
    selector: (state: { snapshot?: { providers: unknown[] } }) => unknown,
  ) => selector({ snapshot: { providers: mocks.rateLimits } }),
}));

function ranking(
  entries: Array<{
    platform: "claude-acp" | "grok-acp";
    modelId: string;
    label: string;
    effort?: "xhigh";
  }>,
) {
  return serializeAgentModelRanking({ version: 1, entries });
}

function renderField(
  overrides: Omit<
    Partial<Parameters<typeof ModelRankingField>[0]>,
    "onChange"
  > = {},
) {
  const onChange = vi.fn();
  const props = {
    value: "",
    displayName: "Designer",
    ...overrides,
    onChange,
  };
  renderWithProviders(<ModelRankingField {...props} />);
  return { ...props, onChange };
}

const OPUS_THEN_GROK = [
  {
    platform: "claude-acp" as const,
    modelId: "claude-opus-5",
    label: "Opus 5",
    effort: "xhigh" as const,
  },
  { platform: "grok-acp" as const, modelId: "grok-4-6", label: "Grok 4.6" },
];

describe("ModelRankingField", () => {
  beforeEach(() => {
    mocks.rateLimits = [];
    mocks.models = { ...INSTALLED_MODELS };
    mocks.acpProviders = [...RANKABLE_PROVIDERS];
    mocks.inventoryProblem = null;
  });

  // Nothing to rank has three causes, and a disabled "Add model" button told
  // the operator none of them.
  it.each([
    {
      what: "a poll that never came back",
      problem: {
        providerId: "grok-acp",
        outcome: "failed" as const,
        reason: "bridge is not running",
      },
      expected: "Could not ask Grok for models: bridge is not running",
    },
    {
      what: "a provider that named no models",
      problem: { providerId: "grok-acp", outcome: "empty" as const },
      expected: "Grok reported no models",
    },
  ])("says the inventory is empty because of $what", ({
    problem,
    expected,
  }) => {
    mocks.models = {};
    mocks.inventoryProblem = problem;

    renderField();

    expect(
      screen.getByTestId("model-ranking-inventory-status"),
    ).toHaveTextContent(expected);
    expect(screen.getByTestId("model-ranking-add")).toBeDisabled();
  });

  it("stays quiet about the inventory when there are models to rank", () => {
    renderField();

    expect(
      screen.queryByTestId("model-ranking-inventory-status"),
    ).not.toBeInTheDocument();
  });

  it("starts an empty ranking from a plain add control", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField();

    // The empty state is a list with an add button, not a clickable riddle:
    // adding the first model must not require knowing about roles at all.
    await user.click(screen.getByTestId("model-ranking-add"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const written = JSON.parse(onChange.mock.calls[0][0] as string);
    expect(written.entries).toHaveLength(1);
    expect(written.entries[0].modelId).toBe("claude-opus-5");
  });

  it("adds the next rankable model when Goose leads the provider list", async () => {
    // Goose is first in the curated agent catalog and its combined model
    // list is huge. Parse drops any row whose platform has no rate-limit
    // meter, so adding Goose's first unused model used to round-trip back
    // to the same list — the Add button looked dead.
    mocks.acpProviders = [
      { id: "goose", label: "Goose" },
      { id: "claude-acp", label: "Claude Code" },
      { id: "grok-acp", label: "Grok" },
    ];
    mocks.models = {
      goose: [
        { id: "gpt-4.1", displayName: "GPT-4.1" },
        { id: "claude-opus-5", displayName: "Opus 5 via Goose" },
      ],
      ...INSTALLED_MODELS,
    };

    const initial = ranking([
      {
        platform: "claude-acp",
        modelId: "claude-opus-5",
        label: "Opus 5",
        effort: "xhigh",
      },
      {
        platform: "claude-acp",
        modelId: "claude-fable-5",
        label: "Fable 5",
        effort: "xhigh",
      },
    ]);

    function Harness() {
      const [value, setValue] = useState(initial);
      return (
        <ModelRankingField
          value={value}
          onChange={(next) => setValue(next ?? "")}
          displayName="Acceptor"
        />
      );
    }

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    expect(screen.getAllByTestId("model-ranking-row")).toHaveLength(2);
    await user.click(screen.getByTestId("model-ranking-add"));

    const rows = screen.getAllByTestId("model-ranking-row");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent("Grok 4.6");
    expect(screen.queryByText("GPT-4.1")).not.toBeInTheDocument();
  });

  it("keeps Add enabled when only Goose has the rankable models", async () => {
    // Live inventory often lives on Goose's combined catalog while the ACP
    // harness caches are empty. Skipping Goose entirely disabled Add.
    mocks.acpProviders = [{ id: "goose", label: "Goose" }];
    mocks.models = {
      goose: [
        { id: "gpt-4.1", displayName: "GPT-4.1" },
        { id: "claude-opus-5", displayName: "Opus 5" },
        { id: "grok-4-6", displayName: "Grok 4.6" },
      ],
    };

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <ModelRankingField
          value={value}
          onChange={(next) => setValue(next ?? "")}
        />
      );
    }

    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const add = screen.getByTestId("model-ranking-add");
    expect(add).toBeEnabled();
    await user.click(add);

    const rows = screen.getAllByTestId("model-ranking-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Opus 5");
    expect(screen.queryByText("GPT-4.1")).not.toBeInTheDocument();
  });

  it("keeps the empty explanation as secondary text under the add control", () => {
    renderField();

    const add = screen.getByTestId("model-ranking-add");
    const empty = screen.getByTestId("model-ranking-empty");
    expect(empty).toHaveTextContent("No ranking yet");
    // The helper follows the add control in the DOM, so the primary action
    // reads first and the explanation stays secondary.
    expect(
      add.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("offers to fill an untuned agent from its role", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField();

    // An empty box teaches nothing; the role's built-in order is the start.
    await user.click(screen.getByTestId("model-ranking-fill"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const written = JSON.parse(onChange.mock.calls[0][0] as string);
    // "Designer" is a frontend-ui role (heavy profile): Fable, then Opus —
    // Sol is not installed here, so it is not written as a dead row.
    expect(
      written.entries.map((entry: { label: string }) => entry.label),
    ).toEqual(["Fable 5", "Opus 5"]);
    expect(written.entries[0].effort).toBe("xhigh");
  });

  it("shows what the ranking resolves to right now", () => {
    renderField({ value: ranking(OPUS_THEN_GROK) });

    expect(screen.getByTestId("model-ranking-preview")).toHaveTextContent(
      "Opus 5",
    );
  });

  it("names the skipped model when the top choice is out of room", () => {
    mocks.rateLimits = [
      {
        provider: "claude-acp",
        session: {
          usedPercent: 100,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null,
        },
        weekly: null,
        updatedAt: 1,
        error: null,
        status: "ok",
        configured: true,
      },
    ];
    renderField({ value: ranking(OPUS_THEN_GROK) });

    const preview = screen.getByTestId("model-ranking-preview");
    expect(preview).toHaveTextContent("Grok 4.6");
    expect(preview).toHaveTextContent("Opus 5 is at its usage limit");
  });

  it("reorders on the operator's word, not on its own", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ value: ranking(OPUS_THEN_GROK) });

    const rows = screen.getAllByTestId("model-ranking-row");
    expect(rows).toHaveLength(2);

    // Row 1's own "move up" is disabled, so the enabled one belongs to row 2.
    const moveUp = screen
      .getAllByRole("button", { name: "Move up", hidden: true })
      .find((button) => !button.hasAttribute("disabled"));
    if (!moveUp) throw new Error("no enabled move-up control");
    await user.click(moveUp);
    const written = JSON.parse(onChange.mock.calls[0][0] as string);
    expect(
      written.entries.map((entry: { label: string }) => entry.label),
    ).toEqual(["Grok 4.6", "Opus 5"]);
  });

  it("clears the property when the last entry goes", async () => {
    const user = userEvent.setup();
    const { onChange } = renderField({ value: ranking([OPUS_THEN_GROK[0]]) });

    await user.click(
      screen.getByRole("button", { name: "Remove", hidden: true }),
    );
    // A stored empty list would read as "ranked to nothing" rather than
    // "never ranked", and would stop the role default from applying.
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
