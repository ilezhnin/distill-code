import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BENCHMARK_SETTINGS,
  useBenchmarkSettingsStore,
} from "@/features/benchmarks/stores/benchmarkSettingsStore";
import type {
  CandidateObservation,
  InventoryModel,
  JudgeCalibration,
  JudgeCalibrationControl,
  JudgePoolEntry,
  JudgePoolRow,
  JudgePoolStatus,
} from "@/features/benchmarks/types";
import type { ProviderAccount } from "@/features/providers/api/providerAccounts";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { renderWithProviders } from "@/test/render";

import { BenchmarkSettings } from "../BenchmarkSettings";

const mocks = vi.hoisted(() => ({
  copyKeyToSandbox: vi.fn(),
  getCreditSpend: vi.fn(),
  judgePool: vi.fn(),
  calibrateJudge: vi.fn(),
  getCandidateObservations: vi.fn(),
}));

vi.mock("@/features/benchmarks/api/benchmarks", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/features/benchmarks/api/benchmarks")
    >();
  return {
    ...actual,
    benchmarkApi: {
      ...actual.benchmarkApi,
      copyKeyToSandbox: mocks.copyKeyToSandbox,
      getCreditSpend: mocks.getCreditSpend,
      judgePool: mocks.judgePool,
      calibrateJudge: mocks.calibrateJudge,
      getCandidateObservations: mocks.getCandidateObservations,
    },
  };
});
vi.mock(
  "@/features/providers/stores/providerAccountsStore",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/providers/stores/providerAccountsStore")
    >()),
    startProviderAccountsMonitor: vi.fn(),
  }),
);

function account(
  id: string,
  providerId: string,
  label: string,
): ProviderAccount {
  return {
    id,
    providerId,
    label,
    authMethod: providerId === "zai-acp" ? "api_key" : "oauth",
    enabled: true,
    autoSwitch: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function showAccounts(accounts: ProviderAccount[]) {
  useProviderAccountsStore.setState({
    accounts,
    defaults: {},
    automaticSwitching: {},
    statuses: {},
    authStates: {},
    loaded: true,
    refreshing: false,
    error: null,
  });
}

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  renderWithProviders(
    <QueryClientProvider client={client}>
      <BenchmarkSettings />
    </QueryClientProvider>,
  );
}

function row(label: string) {
  const element = screen
    .getByText(label)
    .closest<HTMLElement>('[data-slot="settings-row"]');
  if (!element) throw new Error(`No settings row for ${label}`);
  return within(element);
}

const RECIPE = "controls-v1";
const STARTED_AT = Date.UTC(2026, 9, 18, 16, 0);

function judge(
  providerId: string,
  modelId: string,
  effort: string | null,
  extra: Partial<JudgePoolEntry> = {},
): JudgePoolEntry {
  return { providerId, modelId, effort, disclosureConfirmed: true, ...extra };
}

const alpha = judge("codex-acp", "judge-alpha", "high");
const beta = judge("codex-acp", "judge-beta", null);
const gamma = judge("grok-acp", "judge-gamma", "medium");
const delta = judge("kimi-acp", "judge-delta", "high");
const epsilon = judge("zai-acp", "judge-epsilon", null, { inputs: ["text"] });
const theta = judge("codex-acp", "judge-theta", "high", {
  disclosureConfirmed: false,
});
const zeta = judge("codex-acp", "judge-zeta", "low");

function control(
  controlId: string,
  expected: "pass" | "fail",
  score: number | null,
  inBand: boolean,
  reason = "",
): JudgeCalibrationControl {
  return { recordId: "record-1", controlId, expected, score, inBand, reason };
}

function calibration(
  entry: JudgePoolEntry,
  status: JudgeCalibration["status"],
  controls: JudgeCalibrationControl[] = [],
  failure: string | null = null,
): JudgeCalibration {
  return {
    entry,
    recipe: RECIPE,
    status,
    startedAt: STARTED_AT,
    finishedAt: status === "running" ? null : STARTED_AT + 60_000,
    accountId: `${entry.providerId}-account`,
    controls,
    failure,
  };
}

const passed = calibration(alpha, "passed", [
  control("accepted-1", "pass", 0.9, true),
  control("accepted-2", "pass", 0.8, true),
  control("rejected-1", "fail", 0.1, true),
]);
const running = calibration(gamma, "running");
const failed = calibration(delta, "failed", [
  control("accepted-1", "pass", 0.9, true),
  control("accepted-2", "pass", 0.3, false, "Missed the second requirement"),
]);
const interrupted = calibration(
  epsilon,
  "interrupted",
  [],
  "The app closed during the calibration",
);
const outside = calibration(zeta, "passed", [
  control("accepted-1", "pass", 0.9, true),
  control("rejected-1", "fail", 0.2, true),
]);

function poolRow(
  entry: JudgePoolEntry,
  vendor: string,
  latest: JudgeCalibration | null,
  reason: string | null,
): JudgePoolRow {
  return { entry, vendor, calibration: latest, seats: !reason, reason };
}

const status: JudgePoolStatus = {
  recipe: RECIPE,
  pool: [
    poolRow(alpha, "OpenAI", passed, null),
    poolRow(beta, "OpenAI", null, "It has not passed calibration."),
    poolRow(gamma, "xAI", running, "It is calibrating."),
    poolRow(delta, "Moonshot AI", failed, "Its calibration failed."),
    { ...poolRow(epsilon, "Z.ai", interrupted, null), seats: false },
    poolRow(theta, "OpenAI", null, "Its provider's data use is not confirmed"),
  ],
  calibrations: [passed, running, failed, interrupted, outside],
};

function model(
  providerId: string,
  modelId: string,
  name: string,
  efforts: string[] = [],
): InventoryModel {
  return {
    configuration: {
      id: `${providerId}:${modelId}`,
      providerId,
      accountId: `${providerId}-account`,
      modelId,
      effort: null,
      fastMode: null,
      billingMode: "subscription",
      executionProfile: "native_text",
      inventoryRevision: null,
    },
    name,
    efforts,
    supportsFastMode: false,
    available: true,
    reason: null,
  };
}

function observation(
  providerId: string,
  capturedAt: number,
  models: InventoryModel[],
): CandidateObservation {
  return {
    id: `${providerId}-${capturedAt}`,
    capturedAt,
    providerId,
    accountId: `${providerId}-account`,
    models,
    authoritative: true,
  };
}

const observations = [
  observation("codex-acp", 1, [
    model("codex-acp", "judge-retired", "Judge Retired", ["high"]),
  ]),
  observation("codex-acp", 2, [
    model("codex-acp", "judge-alpha", "Judge Alpha", ["low", "medium", "high"]),
    model("codex-acp", "judge-beta", "Judge Beta"),
    model("codex-acp", "judge-eta", "Judge Eta", [
      "default",
      "low",
      "medium",
      "high",
    ]),
    model("codex-acp", "judge-theta", "Judge Theta", ["high"]),
    model("codex-acp", "judge-zeta", "Judge Zeta", ["low"]),
  ]),
  observation("grok-acp", 2, [
    model("grok-acp", "judge-gamma", "Judge Gamma", ["medium"]),
  ]),
  observation("kimi-acp", 2, [
    model("kimi-acp", "judge-delta", "Judge Delta", ["high"]),
  ]),
  observation("zai-acp", 2, [
    model("zai-acp", "judge-epsilon", "Judge Epsilon"),
  ]),
];

const pool = () => useBenchmarkSettingsStore.getState().settings.judgePool;

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  mocks.getCreditSpend.mockResolvedValue({ limit: null, spent: 0 });
  mocks.judgePool.mockResolvedValue({
    recipe: RECIPE,
    pool: [],
    calibrations: [],
  });
  mocks.getCandidateObservations.mockResolvedValue([]);
  useBenchmarkSettingsStore.setState({
    settings: { ...DEFAULT_BENCHMARK_SETTINGS },
    hydrated: false,
  });
});

const COPY = "Copy key to benchmark sandbox";

describe("BenchmarkSettings Z.ai sandbox keys", () => {
  it("copies each Z.ai account's key into the sandbox and says so", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    mocks.copyKeyToSandbox.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    showAccounts([
      account("zai-1", "zai-acp", "Coding Plan Lite"),
      account("zai-2", "zai-acp", "Coding Plan Pro"),
      account("codex-1", "codex-acp", "Work Codex"),
    ]);
    show();

    expect(
      screen.getByRole("heading", {
        name: "Z.ai keys in the benchmark sandbox",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: COPY })).toHaveLength(2);
    expect(screen.queryByText("Work Codex")).not.toBeInTheDocument();
    expect(
      row("Coding Plan Lite").getByText(
        /Copy it again after you change the key/,
      ),
    ).toBeInTheDocument();

    await user.click(
      row("Coding Plan Pro").getByRole("button", { name: COPY }),
    );

    expect(mocks.copyKeyToSandbox).toHaveBeenCalledTimes(1);
    expect(mocks.copyKeyToSandbox).toHaveBeenCalledWith("zai-acp", "zai-2");
    const pending = await row("Coding Plan Pro").findByRole("button", {
      name: /Copying/,
    });
    expect(pending).toBeDisabled();

    finish();

    expect(await row("Coding Plan Pro").findByRole("status")).toHaveTextContent(
      "Key copied to the benchmark sandbox.",
    );
    expect(
      row("Coding Plan Lite").queryByRole("status"),
    ).not.toBeInTheDocument();
  });

  it("shows why a copy failed and lets it be tried again", async () => {
    const user = userEvent.setup();
    mocks.copyKeyToSandbox
      .mockRejectedValueOnce({
        code: "infrastructure_failure",
        message: "bench-login zai exited with status 1",
      })
      .mockResolvedValueOnce(undefined);
    showAccounts([account("zai-1", "zai-acp", "Coding Plan Lite")]);
    show();

    const lite = row("Coding Plan Lite");
    await user.click(lite.getByRole("button", { name: COPY }));

    expect(await lite.findByRole("alert")).toHaveTextContent(
      "Not copied: bench-login zai exited with status 1",
    );

    await user.click(lite.getByRole("button", { name: COPY }));

    expect(await lite.findByRole("status")).toHaveTextContent(
      "Key copied to the benchmark sandbox.",
    );
    expect(lite.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.copyKeyToSandbox).toHaveBeenCalledTimes(2);
  });

  it("says there is no Z.ai account instead of offering a copy", () => {
    showAccounts([account("codex-1", "codex-acp", "Work Codex")]);
    show();

    expect(
      row("No Z.ai Coding Plan accounts").getByText(/under AI providers/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: COPY }),
    ).not.toBeInTheDocument();
  });
});

describe("BenchmarkSettings judges", () => {
  /** Shows the page once the pool's status and the model names are in. */
  async function showJudges() {
    useBenchmarkSettingsStore.setState({
      settings: {
        ...DEFAULT_BENCHMARK_SETTINGS,
        judgePool: [alpha, beta, gamma, delta, epsilon, theta],
      },
    });
    mocks.judgePool.mockResolvedValue(status);
    mocks.getCandidateObservations.mockResolvedValue(observations);
    showAccounts([]);
    show();
    await screen.findByText("Judge Alpha");
    await screen.findByText("Takes judge seats");
  }

  it("says where judges come from and that the pool starts empty", async () => {
    show();

    expect(
      screen.getByText(/never by a model from the candidate's own vendor/),
    ).toBeInTheDocument();
    expect(row("No judges yet").getByText(/then calibrate it/)).toBeVisible();
    expect(
      await screen.findByText(/once a benchmark run has listed/),
    ).toBeInTheDocument();
  });

  it("shows each judge's calibration and whether it takes seats", async () => {
    await showJudges();

    const ready = row("Judge Alpha");
    expect(ready.getByText("OpenAI · Codex · high")).toBeInTheDocument();
    expect(
      ready.getByText("Passed: 3 of 3 controls in band"),
    ).toBeInTheDocument();
    expect(ready.getByText("Takes judge seats")).toBeInTheDocument();
    expect(
      ready.getByRole("checkbox", { name: "Data use confirmed" }),
    ).toBeChecked();
    expect(ready.getByRole("button", { name: "Calibrate" })).toBeEnabled();

    const fresh = row("Judge Beta");
    expect(
      fresh.getByText("OpenAI · Codex · No effort setting"),
    ).toBeInTheDocument();
    expect(fresh.getByText("Not calibrated")).toBeInTheDocument();
    expect(
      fresh.getByText("Takes no seats: It has not passed calibration."),
    ).toBeInTheDocument();

    const calibrating = row("Judge Gamma");
    expect(calibrating.getByText("xAI · Grok · medium")).toBeInTheDocument();
    expect(calibrating.getByRole("status")).toHaveTextContent(
      /^Calibrating since /,
    );
    expect(
      calibrating.getByRole("button", { name: "Calibrate" }),
    ).toBeDisabled();

    const rejected = row("Judge Delta");
    expect(
      rejected.getByText("Failed: 1 of 2 controls out of band"),
    ).toBeInTheDocument();
    expect(
      rejected.getByText(
        "accepted-2: should pass, scored 0.3. Missed the second requirement",
      ),
    ).toBeInTheDocument();
    expect(rejected.queryByText(/accepted-1/)).not.toBeInTheDocument();

    const cut = row("Judge Epsilon");
    expect(
      cut.getByText("Z.ai · No effort setting · Text rubrics only"),
    ).toBeInTheDocument();
    expect(
      cut.getByText("Interrupted: The app closed during the calibration"),
    ).toBeInTheDocument();
    expect(cut.getByText("Takes no seats yet")).toBeInTheDocument();

    const unconfirmed = row("Judge Theta");
    expect(
      unconfirmed.getByText(
        "Does not judge and cannot be calibrated: Its provider's data use is not confirmed",
      ),
    ).toBeInTheDocument();
    expect(
      unconfirmed.getByRole("checkbox", { name: "Data use confirmed" }),
    ).not.toBeChecked();
    expect(
      unconfirmed.getByRole("button", { name: "Calibrate" }),
    ).toBeDisabled();

    expect(
      screen.getByRole("heading", {
        name: "Calibrated models outside the pool",
      }),
    ).toBeInTheDocument();
    const compared = row("Judge Zeta");
    expect(
      compared.getByText("Passed: 2 of 2 controls in band"),
    ).toBeInTheDocument();
    expect(
      compared.getByRole("button", { name: "Add to pool" }),
    ).toBeInTheDocument();
    expect(
      compared.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("calibrates the entry and shows it running", async () => {
    const user = userEvent.setup();
    await showJudges();
    mocks.calibrateJudge.mockResolvedValue(calibration(beta, "running"));

    await user.click(
      row("Judge Beta").getByRole("button", { name: "Calibrate" }),
    );

    expect(mocks.calibrateJudge).toHaveBeenCalledTimes(1);
    expect(mocks.calibrateJudge).toHaveBeenCalledWith(beta);
    expect(await row("Judge Beta").findByRole("status")).toHaveTextContent(
      /^Calibrating since /,
    );
    expect(
      await row("Judge Beta").findByRole("button", { name: "Calibrate" }),
    ).toBeDisabled();
  });

  it("says why a calibration did not start", async () => {
    const user = userEvent.setup();
    await showJudges();
    mocks.calibrateJudge.mockRejectedValue({
      code: "capability_missing",
      message: "No enabled account offers this model",
    });

    await user.click(
      row("Judge Beta").getByRole("button", { name: "Calibrate" }),
    );

    expect(await row("Judge Beta").findByRole("alert")).toHaveTextContent(
      "Calibration not started: No enabled account offers this model",
    );
    expect(
      await row("Judge Beta").findByRole("button", { name: "Calibrate" }),
    ).toBeEnabled();
  });

  it("removes a judge from the pool and asks the service again", async () => {
    const user = userEvent.setup();
    await showJudges();
    expect(mocks.judgePool).toHaveBeenCalledTimes(1);

    await user.click(
      row("Judge Alpha").getByRole("button", { name: "Remove" }),
    );

    expect(pool()).toEqual([beta, gamma, delta, epsilon, theta]);
    // Its calibration stays, so it is listed among the models outside.
    expect(
      row("Judge Alpha").getByRole("button", { name: "Add to pool" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.judgePool).toHaveBeenCalledTimes(2));
  });

  it("adds a calibrated model back to the pool, unconfirmed", async () => {
    const user = userEvent.setup();
    await showJudges();

    await user.click(
      row("Judge Zeta").getByRole("button", { name: "Add to pool" }),
    );

    expect(pool().at(-1)).toEqual({ ...zeta, disclosureConfirmed: false });
    const added = row("Judge Zeta");
    expect(added.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(
      added.getByRole("checkbox", { name: "Data use confirmed" }),
    ).not.toBeChecked();
    expect(added.getByRole("button", { name: "Calibrate" })).toBeDisabled();
  });

  it("confirms a provider's data use before the entry calibrates", async () => {
    const user = userEvent.setup();
    await showJudges();

    await user.click(
      row("Judge Theta").getByRole("checkbox", { name: "Data use confirmed" }),
    );

    expect(pool().at(-1)).toEqual({ ...theta, disclosureConfirmed: true });
    expect(
      row("Judge Theta").getByRole("button", { name: "Calibrate" }),
    ).toBeEnabled();
    expect(
      row("Judge Theta").queryByText(/Does not judge/),
    ).not.toBeInTheDocument();
  });

  it("adds a listed model at a chosen effort, unconfirmed", async () => {
    const user = userEvent.setup();
    await showJudges();

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Choose a provider", "Codex", "Grok", "Kimi Code", "Z.ai"]);
    await user.click(screen.getByRole("option", { name: "Codex" }));

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    // Only what the newest probe of an account lists is offered.
    expect(
      screen.queryByRole("option", { name: "Judge Retired" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Judge Alpha" }));

    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(
      "high",
    );
    expect(
      screen.getByText("This model and effort are already in the pool."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add judge" })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(screen.getByRole("option", { name: "Judge Eta" }));
    await user.click(screen.getByRole("combobox", { name: "Effort" }));
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["low", "medium", "high"]);
    await user.click(screen.getByRole("option", { name: "medium" }));
    await user.click(screen.getByRole("combobox", { name: "Rubrics" }));
    await user.click(screen.getByRole("option", { name: "Text rubrics only" }));
    await user.click(screen.getByRole("button", { name: "Add judge" }));

    expect(pool().at(-1)).toEqual({
      providerId: "codex-acp",
      modelId: "judge-eta",
      effort: "medium",
      inputs: ["text"],
      disclosureConfirmed: false,
    });
    const added = row("Judge Eta");
    expect(
      added.getByText("OpenAI · Codex · medium · Text rubrics only"),
    ).toBeInTheDocument();
    expect(
      added.getByText(/Does not judge and cannot be calibrated until/),
    ).toBeInTheDocument();
    expect(added.getByRole("button", { name: "Calibrate" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Choose a model",
    );
  });
});
