import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import type { Capability, InventoryModel } from "../types";
import { BenchmarkRunDialog } from "../ui/BenchmarkRunDialog";
import { configuration, definition, run } from "./fixtures";

vi.mock("@/features/providers/api/providerAccounts", () => ({
  listProviderAccounts: vi.fn(async () => ({
    accounts: [
      {
        id: "account-1",
        providerId: "claude-acp",
        label: "Test account",
        enabled: true,
      },
    ],
    defaults: {},
    automaticSwitching: {},
  })),
}));
vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: {
    getCapabilities: vi.fn(),
    getInventory: vi.fn(),
    previewRun: vi.fn(),
    startRun: vi.fn(),
    providerDataUse: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  vi.mocked(benchmarkApi.getCapabilities).mockResolvedValue([
    {
      providerId: "claude-acp",
      executionProfile: "native_text",
      supported: true,
      reason: "Verified",
    },
  ]);
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration,
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: true,
      reason: null,
    },
  ]);
  vi.mocked(benchmarkApi.previewRun).mockResolvedValue({
    valid: true,
    issues: [],
    executionCount: 1,
    estimatedCost: null,
    costReason: "Provider does not report cost",
  });
  vi.mocked(benchmarkApi.startRun).mockResolvedValue(run);
  vi.mocked(benchmarkApi.providerDataUse).mockResolvedValue([
    {
      providerId: "claude-acp",
      name: "Anthropic",
      trainsOnSubmissions: false,
      stated: false,
    },
  ]);
});
afterEach(cleanup);

it("leaves a refusal to the plan check", async () => {
  const user = userEvent.setup();
  const refusal =
    "model-1 on Test: the account's plan no longer offers this model";
  vi.mocked(benchmarkApi.previewRun).mockResolvedValue({
    valid: false,
    issues: [refusal],
    executionCount: 1,
    estimatedCost: null,
    costReason: "",
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[definition]}
        selectedVersionIds={[definition.versions[0].id]}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(screen.getByRole("option", { name: "Test account" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  expect(screen.queryByText("Train tasks only")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(refusal);
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
});

it("offers only the latest publication and discards stale preselected versions", async () => {
  const user = userEvent.setup();
  const latest = {
    ...definition.versions[0],
    id: "version-new",
    publishedAt: definition.versions[0].publishedAt + 1,
    manifest: { ...definition.draft, name: "Current test" },
  };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[
          { ...definition, versions: [definition.versions[0], latest] },
        ]}
        selectedVersionIds={[definition.versions[0].id]}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText("0 of 1 selected")).toBeInTheDocument();
  expect(
    screen.queryByRole("checkbox", { name: definition.draft.name }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Current test" }));
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(screen.getByRole("option", { name: "Test account" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
      expect.objectContaining({ versionIds: ["version-new"] }),
    ),
  );
});

it("counts every workflow step against the explicit execution budget", async () => {
  const user = userEvent.setup();
  const workflowDefinition = {
    ...definition,
    versions: [
      {
        ...definition.versions[0],
        manifest: {
          ...definition.versions[0].manifest,
          workflow: {
            schemaVersion: 1,
            driverRevision: "1",
            steps: [
              { id: "first", prompt: "Analyze.", includePreviousOutput: false },
              { id: "second", prompt: "Answer.", includePreviousOutput: true },
            ],
          },
        },
      },
    ],
  };
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[workflowDefinition]}
        selectedVersionIds={["version-1"]}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(screen.getByRole("option", { name: "Test account" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  // Two workflow steps, three repetitions each.
  expect(screen.getByText("6 executions")).toBeInTheDocument();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
    { target: { value: "5" } },
  );
  expect(screen.getByRole("button", { name: "Check plan" })).toBeDisabled();
});

it("requires a fresh validated plan and sends the pinned account with a stable request key", async () => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[definition]}
        selectedVersionIds={["version-1"]}
        onClose={vi.fn()}
        onStarted={onStarted}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(screen.getByRole("option", { name: "Test account" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
  await user.click(screen.getByRole("combobox", { name: "Native effort" }));
  await user.click(screen.getByRole("option", { name: "high" }));
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start batch" })).toBeEnabled(),
  );
  expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
    expect.objectContaining({
      configurations: [
        expect.objectContaining({
          accountId: "account-1",
          modelId: "model-1",
          effort: "high",
          fastMode: false,
        }),
      ],
    }),
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Repetitions" }), {
    target: { value: "2" },
  });
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start batch" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Start batch" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith("run-1"));
  const checked = vi.mocked(benchmarkApi.previewRun).mock.calls.at(-1)?.[0];
  expect(benchmarkApi.startRun).toHaveBeenCalledWith(checked);
  expect(checked?.repetitions).toBe(2);
  expect(screen.getByText("Expected spend: Not reported")).toBeInTheDocument();
});

it("offers the CLI sign-in of a provider without managed accounts and preselects it", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.getCapabilities).mockResolvedValue([
    {
      providerId: "claude-acp",
      executionProfile: "native_text",
      supported: true,
      reason: "Verified",
      cliAccountId: null,
    },
    {
      providerId: "grok-acp",
      executionProfile: "native_text",
      supported: true,
      reason: "Verified",
      cliAccountId: "cli-login-grok-acp",
    },
  ]);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[definition]}
        selectedVersionIds={["version-1"]}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(await screen.findByRole("option", { name: /Grok/ }));
  await waitFor(() =>
    expect(benchmarkApi.getInventory).toHaveBeenCalledWith(
      "grok-acp",
      "cli-login-grok-acp",
    ),
  );
  expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent(
    "CLI sign-in",
  );
  // A provider with managed accounts keeps the explicit choice, and has no
  // CLI identity to offer.
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent(
    "No account",
  );
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  expect(screen.getByRole("option", { name: "Test account" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "CLI sign-in" })).toBeNull();
});

it("selects the CLI sign-in whenever the capabilities naming it arrive", async () => {
  const user = userEvent.setup();
  let arrive: (capabilities: Capability[]) => void = () => {};
  vi.mocked(benchmarkApi.getCapabilities).mockReturnValue(
    new Promise((resolve) => {
      arrive = resolve;
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[definition]}
        selectedVersionIds={["version-1"]}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  // Grok is chosen before the capabilities are known.
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(await screen.findByRole("option", { name: /Grok/ }));
  arrive([
    {
      providerId: "grok-acp",
      executionProfile: "native_text",
      supported: true,
      reason: "Verified",
      cliAccountId: "cli-login-grok-acp",
    },
  ]);
  await waitFor(() =>
    expect(benchmarkApi.getInventory).toHaveBeenCalledWith(
      "grok-acp",
      "cli-login-grok-acp",
    ),
  );
  // No inventory was asked for without the sign-in.
  expect(benchmarkApi.getInventory).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("combobox", { name: "Account" })).toHaveTextContent(
    "CLI sign-in",
  );
  // "No account" can only be refused for a provider that signs in through
  // its CLI, so it is not offered.
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  expect(screen.getByRole("option", { name: "CLI sign-in" })).toBeVisible();
  expect(screen.queryByRole("option", { name: "No account" })).toBeNull();
});

/** Picks Claude Code, the test account and the test model in a fresh dialog. */
async function chooseTestModel(
  user: ReturnType<typeof userEvent.setup>,
  testDefinition = definition,
  otherDefinitions: (typeof definition)[] = [],
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[testDefinition, ...otherDefinitions]}
        selectedVersionIds={[testDefinition, ...otherDefinitions].flatMap(
          (entry) => entry.versions.map((version) => version.id),
        )}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("combobox", { name: "Provider" }));
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(screen.getByRole("option", { name: "Test account" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
}

it("checks and starts a newly selected model without a separate add step or an arbitrary 20-call ceiling", async () => {
  const user = userEvent.setup();
  const workflow = {
    schemaVersion: 1,
    driverRevision: "1",
    steps: Array.from({ length: 9 }, (_, index) => ({
      id: `step-${index}`,
      prompt: "Return the next integer.",
      includePreviousOutput: true,
    })),
  };
  await chooseTestModel(user, {
    ...definition,
    versions: [
      {
        ...definition.versions[0],
        manifest: { ...definition.draft, workflow },
      },
    ],
  });
  expect(screen.getByText("27 executions")).toBeInTheDocument();
  expect(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
  ).toHaveValue(27);
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start batch" })).toBeEnabled(),
  );
  const checked = vi.mocked(benchmarkApi.previewRun).mock.calls[0][0];
  expect(checked.configurations).toHaveLength(1);
  expect(checked.maxExecutions).toBe(27);
  await user.click(screen.getByRole("checkbox", { name: "Fast mode" }));
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start batch" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Start batch" }));
  await waitFor(() =>
    expect(benchmarkApi.startRun).toHaveBeenCalledWith(
      vi.mocked(benchmarkApi.previewRun).mock.calls.at(-1)?.[0],
    ),
  );
});

it("keeps added configurations, deduplicates the current choice and can remove it", async () => {
  const user = userEvent.setup();
  await chooseTestModel(user);
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  expect(screen.getByText("3 executions")).toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
  expect(screen.getByText("3 executions")).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Fast mode" }));
  expect(screen.getByText("6 executions")).toBeInTheDocument();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
    { target: { value: "5" } },
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "The plan needs 6 executions; the limit is 5.",
  );
  expect(screen.getByRole("button", { name: "Check plan" })).toBeDisabled();
  await user.click(screen.getAllByRole("button", { name: "Remove" })[1]);
  expect(screen.getByText("3 executions")).toBeInTheDocument();
  expect(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
  ).toHaveValue(5);
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByText("0 executions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check plan" })).toBeDisabled();
});

function pairedInventory(): InventoryModel[] {
  return [
    {
      configuration,
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: false,
      available: true,
      reason: null,
    },
    {
      configuration: {
        ...configuration,
        id: "repository-config",
        executionProfile: "protected_repository",
        inventoryRevision: "repository-runtime-2",
      },
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: false,
      available: true,
      reason: null,
    },
  ];
}

const repositoryDefinition = {
  ...definition,
  id: "repository-test",
  versions: [
    {
      ...definition.versions[0],
      id: "repository-version",
      definitionId: "repository-test",
      manifest: {
        ...definition.draft,
        name: "Repository check",
        evaluator: { ...definition.draft.evaluator, kind: "repository" },
      },
    },
  ],
};

it("offers each model once and sends both runtimes for a mixed test selection", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue(pairedInventory());
  await chooseTestModel(user, definition, [repositoryDefinition]);
  expect(screen.getByText("6 executions")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  expect(
    screen.getAllByRole("option").map((entry) => entry.textContent),
  ).toEqual(["Choose a model", "Test model"]);
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start batch" })).toBeEnabled(),
  );
  const checked = vi.mocked(benchmarkApi.previewRun).mock.calls[0][0];
  expect(checked.versionIds).toEqual(["version-1", "repository-version"]);
  expect(checked.maxExecutions).toBe(6);
  expect(checked.configurations).toEqual([
    expect.objectContaining({
      executionProfile: "native_text",
      inventoryRevision: "inventory-1",
      accountId: "account-1",
      effort: "high",
    }),
    expect.objectContaining({
      executionProfile: "protected_repository",
      inventoryRevision: "repository-runtime-2",
      accountId: "account-1",
      effort: "high",
    }),
  ]);
  expect(new Set(checked.configurations.map((entry) => entry.id)).size).toBe(2);
  await user.click(screen.getByRole("button", { name: "Start batch" }));
  await waitFor(() =>
    expect(benchmarkApi.startRun).toHaveBeenCalledWith(checked),
  );
});

it("can run repository-only tests even when text execution is unavailable", async () => {
  const user = userEvent.setup();
  const entries = pairedInventory();
  entries[0].available = false;
  entries[0].reason = "Text runtime is not ready.";
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue(entries);
  await chooseTestModel(user, repositoryDefinition);
  expect(screen.getByText("3 executions")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        versionIds: ["repository-version"],
        configurations: [
          expect.objectContaining({ executionProfile: "protected_repository" }),
        ],
      }),
    ),
  );
});

it("keeps each added effort as one model choice with both required runtimes", async () => {
  const user = userEvent.setup();
  const entries = pairedInventory();
  for (const entry of entries) entry.efforts = ["low", "high"];
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue(entries);
  await chooseTestModel(user, definition, [repositoryDefinition]);
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
  expect(screen.getByText("6 executions")).toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "Native effort" }));
  await user.click(screen.getByRole("option", { name: "low" }));
  expect(screen.getByText("12 executions")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() => expect(benchmarkApi.previewRun).toHaveBeenCalledTimes(1));
  const checked = vi.mocked(benchmarkApi.previewRun).mock.calls[0][0];
  expect(
    checked.configurations.map((entry) => [
      entry.effort,
      entry.executionProfile,
    ]),
  ).toEqual([
    ["high", "native_text"],
    ["high", "protected_repository"],
    ["low", "native_text"],
    ["low", "protected_repository"],
  ]);
  expect(new Set(checked.configurations.map((entry) => entry.id)).size).toBe(4);
});

it("includes only the runtime needed by the selected tests", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue(pairedInventory());
  await chooseTestModel(user);
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  expect(screen.getByText("3 executions")).toBeInTheDocument();
  expect(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
  ).toHaveValue(3);
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        maxExecutions: 3,
        configurations: [
          expect.objectContaining({ executionProfile: "native_text" }),
        ],
      }),
    ),
  );
});

it("resolves a saved model again when the selected tests change and removes the whole model", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue(pairedInventory());
  await chooseTestModel(user, definition, [repositoryDefinition]);
  await user.click(screen.getByRole("checkbox", { name: "Repository check" }));
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start batch" })).toBeEnabled(),
  );
  expect(
    vi.mocked(benchmarkApi.previewRun).mock.calls[0][0].configurations,
  ).toHaveLength(1);
  await user.click(screen.getByRole("checkbox", { name: "Repository check" }));
  expect(screen.getByText("6 executions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() => expect(benchmarkApi.previewRun).toHaveBeenCalledTimes(2));
  expect(
    vi.mocked(benchmarkApi.previewRun).mock.calls[1][0].configurations,
  ).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(screen.getByText("0 executions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
});

it.each([
  "missing",
  "unavailable",
  "changed",
])("blocks a mixed plan when a needed runtime is %s instead of omitting its tests", async (issue) => {
  const user = userEvent.setup();
  const entries = pairedInventory();
  if (issue === "missing") entries.pop();
  if (issue === "unavailable") {
    entries[1].available = false;
    entries[1].reason = "Sign in to the repository runtime.";
  }
  if (issue === "changed") entries[1].efforts = ["low"];
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue(entries);
  await chooseTestModel(user, definition, [repositoryDefinition]);
  expect(screen.getByText("6 executions")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(
    "cannot run all selected tests",
  );
  if (issue === "unavailable")
    expect(screen.getByRole("status")).toHaveTextContent(
      entries[1].reason ?? "",
    );
  expect(screen.getByRole("button", { name: "Check plan" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
  expect(benchmarkApi.previewRun).not.toHaveBeenCalled();
  // A text-only selection is still valid on this same model.
  await user.click(screen.getByRole("checkbox", { name: "Repository check" }));
  expect(screen.getByText("3 executions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check plan" })).toBeEnabled();
});

it("offers only the levels a model lists and starts at its highest", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration: { ...configuration, effort: null, fastMode: null },
      name: "Test model",
      // An older runtime may still list the CLI's "default"; it is no level.
      efforts: ["low", "default", "high", "xhigh", "ultra"],
      supportsFastMode: false,
      available: true,
      reason: null,
    },
  ]);
  await chooseTestModel(user);
  const effort = screen.getByRole("combobox", { name: "Native effort" });
  // The highest level is chosen for the operator; "ultra" never is.
  expect(effort).toHaveTextContent("xhigh");
  await user.click(effort);
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["low", "high", "xhigh", "ultra"]);
  expect(screen.queryByRole("option", { name: "default" })).toBeNull();
  expect(screen.queryByRole("option", { name: "Provider default" })).toBeNull();
  expect(
    screen.queryByRole("option", { name: "No effort setting" }),
  ).toBeNull();
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        configurations: [
          expect.objectContaining({ modelId: "model-1", effort: "xhigh" }),
        ],
      }),
    ),
  );
});

it("starts each model at max when it lists max", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration: { ...configuration, effort: null, fastMode: null },
      name: "Test model",
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      supportsFastMode: false,
      available: true,
      reason: null,
    },
  ]);
  await chooseTestModel(user);
  expect(
    screen.getByRole("combobox", { name: "Native effort" }),
  ).toHaveTextContent("max");
});

it("runs a model without an effort control unset, with no other choice", async () => {
  const user = userEvent.setup();
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration: { ...configuration, effort: null, fastMode: null },
      name: "Test model",
      efforts: [],
      supportsFastMode: false,
      available: true,
      reason: null,
    },
  ]);
  await chooseTestModel(user);
  const effort = screen.getByRole("combobox", { name: "Native effort" });
  expect(effort).toHaveTextContent("No effort setting");
  await user.click(effort);
  expect(
    screen.getAllByRole("option").map((option) => option.textContent),
  ).toEqual(["No effort setting"]);
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: "Add another configuration" }),
  );
  await user.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        configurations: [
          expect.objectContaining({ modelId: "model-1", effort: null }),
        ],
      }),
    ),
  );
});
