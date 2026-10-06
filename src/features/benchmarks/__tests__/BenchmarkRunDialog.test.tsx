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
