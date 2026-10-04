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
import type { Capability } from "../types";
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
});
afterEach(cleanup);

it("pins a catch-up configuration to today's runtime and budgets the selected cases before preview", async () => {
  const definitions = Array.from({ length: 21 }, (_, index) => ({
    ...definition,
    id: `definition-${index}`,
    versions: [
      {
        ...definition.versions[0],
        id: `version-${index}`,
        manifest: {
          ...definition.versions[0].manifest,
          limits: {
            ...definition.versions[0].manifest.limits,
            timeoutSeconds: 600,
          },
        },
      },
    ],
  }));
  const selectedVersionIds = definitions.map((entry) => entry.versions[0].id);
  // The row's newest attempt ran on a runtime that has since changed.
  const stale = { ...configuration, inventoryRevision: "runtime-then" };
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration: { ...configuration, inventoryRevision: "runtime-now" },
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: true,
      reason: null,
    },
  ]);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={definitions}
        selectedVersionIds={selectedVersionIds}
        selectedConfiguration={stale}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("21 executions")).toBeInTheDocument();
  expect(benchmarkApi.getInventory).toHaveBeenCalledWith(
    "claude-acp",
    "account-1",
  );
  expect(
    screen.getByRole("spinbutton", { name: "Time limit (seconds)" }),
  ).toHaveValue(600);
  expect(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
  ).toHaveValue(21);
  expect(screen.getByRole("button", { name: "Start batch" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Check plan" }));
  await waitFor(() =>
    expect(benchmarkApi.previewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        configurations: [
          expect.objectContaining({
            modelId: "model-1",
            effort: "high",
            fastMode: false,
            billingMode: "subscription",
            inventoryRevision: "runtime-now",
          }),
        ],
        versionIds: selectedVersionIds,
        repetitions: 1,
        timeoutSeconds: 600,
        maxExecutions: 21,
      }),
    ),
  );
  expect(benchmarkApi.startRun).not.toHaveBeenCalled();
});

it("does not plan a catch-up for a model the runtime no longer lists", async () => {
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([]);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[definition]}
        selectedVersionIds={["version-1"]}
        selectedConfiguration={configuration}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "model-1 is no longer available on this account.",
  );
  expect(screen.getByText("0 executions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check plan" })).toBeDisabled();
  expect(benchmarkApi.previewRun).not.toHaveBeenCalled();
});

it("shows why the runtime blocks a catch-up model it still lists", async () => {
  vi.mocked(benchmarkApi.getInventory).mockResolvedValue([
    {
      configuration,
      name: "Test model",
      efforts: ["high"],
      supportsFastMode: true,
      available: false,
      reason:
        "Installed Claude bridge changed; benchmark adapter requires verification",
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
        selectedConfiguration={configuration}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Installed Claude bridge changed; benchmark adapter requires verification",
  );
  expect(alert).not.toHaveTextContent("no longer available");
  expect(screen.getByText("0 executions")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Check plan" })).toBeDisabled();
  expect(benchmarkApi.previewRun).not.toHaveBeenCalled();
});

it("reserves judge calls per judged case and owes nothing on cases the candidate wrote", async () => {
  const version = definition.versions[0];
  const caseOf = (
    index: number,
    kind: string,
    authoredBy?: string[],
  ): typeof definition => ({
    ...definition,
    id: `definition-${index}`,
    versions: [
      {
        ...version,
        id: `version-${index}`,
        manifest: {
          ...version.manifest,
          evaluator: { ...version.manifest.evaluator, kind },
          environment: authoredBy ? { authoredBy } : {},
        },
      },
    ],
  });
  const definitions = [
    ...Array.from({ length: 6 }, (_, index) => caseOf(index, "rubric")),
    caseOf(6, "exact"),
    // Written by the candidate: never planned, so never counted.
    caseOf(7, "rubric", ["MODEL-1"]),
    caseOf(8, "exact", ["model-1"]),
  ];
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={definitions}
        selectedVersionIds={definitions.map((entry) => entry.versions[0].id)}
        selectedConfiguration={configuration}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  // Six judged cases at one turn plus three judge calls, one exact case.
  expect(await screen.findByText("25 executions")).toBeInTheDocument();
  expect(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
  ).toHaveValue(25);
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
  await user.click(screen.getByRole("button", { name: "Add configuration" }));
  expect(screen.getByText("2 executions")).toBeInTheDocument();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Maximum executions" }),
    { target: { value: "1" } },
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
  await user.click(screen.getByRole("button", { name: "Add configuration" }));
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
async function chooseTestModel(user: ReturnType<typeof userEvent.setup>) {
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
  await user.click(screen.getByRole("option", { name: "Claude Code" }));
  await user.click(screen.getByRole("combobox", { name: "Account" }));
  await user.click(screen.getByRole("option", { name: "Test account" }));
  await user.click(screen.getByRole("combobox", { name: "Model" }));
  await user.click(screen.getByRole("option", { name: "Test model" }));
}

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
  await user.click(screen.getByRole("button", { name: "Add configuration" }));
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
  await user.click(screen.getByRole("button", { name: "Add configuration" }));
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

it("does not catch up a row measured at the CLI's default", async () => {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkRunDialog
        definitions={[definition]}
        selectedVersionIds={["version-1"]}
        selectedConfiguration={{ ...configuration, effort: "default" }}
        onClose={vi.fn()}
        onStarted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "model-1 no longer offers this effort",
  );
  expect(screen.getByText("0 executions")).toBeInTheDocument();
  expect(benchmarkApi.previewRun).not.toHaveBeenCalled();
});
