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
  ProviderDataUse,
} from "@/features/benchmarks/types";
import type { ProviderAccount } from "@/features/providers/api/providerAccounts";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { renderWithProviders } from "@/test/render";

import { BenchmarkSettings } from "../BenchmarkSettings";

const mocks = vi.hoisted(() => ({
  getCreditSpend: vi.fn(),
  judgePool: vi.fn(),
  calibrateJudge: vi.fn(),
  getCandidateObservations: vi.fn(),
  providerDataUse: vi.fn(),
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
      getCreditSpend: mocks.getCreditSpend,
      judgePool: mocks.judgePool,
      calibrateJudge: mocks.calibrateJudge,
      getCandidateObservations: mocks.getCandidateObservations,
      providerDataUse: mocks.providerDataUse,
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

/** One provider's data use as the service reports it. */
function provider(
  providerId: string,
  name: string,
  trainsOnSubmissions: boolean,
  stated = false,
): ProviderDataUse {
  return { providerId, name, trainsOnSubmissions, stated };
}

/** What holds when the owner has named no provider. */
const defaultDataUse: ProviderDataUse[] = [
  provider("claude-acp", "Anthropic", false),
  provider("codex-acp", "OpenAI", false),
  provider("grok-acp", "xAI", false),
  provider("kimi-acp", "Moonshot AI", true),
  provider("zai-acp", "Z.ai", true),
];

const TRAINS = "May train on submitted data";

const RECIPE = "controls-v1";
const STARTED_AT = Date.UTC(2026, 9, 18, 16, 0);

function judge(
  providerId: string,
  modelId: string,
  effort: string | null,
  extra: Partial<JudgePoolEntry> = {},
): JudgePoolEntry {
  return { providerId, modelId, effort, ...extra };
}

const alpha = judge("codex-acp", "judge-alpha", "high");
const beta = judge("codex-acp", "judge-beta", null);
const gamma = judge("grok-acp", "judge-gamma", "medium");
const delta = judge("kimi-acp", "judge-delta", "high");
const epsilon = judge("zai-acp", "judge-epsilon", null, { inputs: ["text"] });
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
// Calibrated before its provider's data use ruled it out.
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
    poolRow(
      delta,
      "Moonshot AI",
      failed,
      "Moonshot AI may train on submitted data, so its models never judge",
    ),
    poolRow(
      epsilon,
      "Z.ai",
      interrupted,
      "Z.ai may train on submitted data, so its models never judge",
    ),
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

const settings = () => useBenchmarkSettingsStore.getState().settings;
const pool = () => settings().judgePool;

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
  mocks.providerDataUse.mockResolvedValue(defaultDataUse);
  useBenchmarkSettingsStore.setState({
    settings: { ...DEFAULT_BENCHMARK_SETTINGS },
    hydrated: false,
  });
});

describe("BenchmarkSettings provider data use", () => {
  /** The service's rows once the owner named xAI and Z.ai. */
  const stated: ProviderDataUse[] = [
    provider("claude-acp", "Anthropic", false),
    provider("codex-acp", "OpenAI", false),
    provider("grok-acp", "xAI", true, true),
    provider("kimi-acp", "Moonshot AI", true),
    provider("zai-acp", "Z.ai", false, true),
  ];

  /** Shows the page once the service's rows are in. */
  async function showDataUse(rows: ProviderDataUse[]) {
    mocks.providerDataUse.mockResolvedValue(rows);
    showAccounts([]);
    show();
    await screen.findByText("Moonshot AI");
  }

  it("lists every provider the service names, stated and default, and what that means", async () => {
    await showDataUse(stated);

    expect(
      screen.getByRole("heading", { name: "Provider data use" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Every provider runs every test, train and held-out/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never judges, because judges read rubrics/, {
        selector: "p",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/in its account settings/)).toBeInTheDocument();

    // The owner said xAI may train: shown as set, with the way back.
    const xai = row("xAI");
    expect(xai.getByText("Grok · Set by you")).toBeInTheDocument();
    expect(xai.getByRole("switch", { name: TRAINS })).toBeChecked();
    expect(xai.getByRole("button", { name: "Use default" })).toBeEnabled();

    // Moonshot AI trains by the backend's default.
    const moonshot = row("Moonshot AI");
    expect(moonshot.getByText("Kimi Code · Default")).toBeInTheDocument();
    expect(moonshot.getByRole("switch", { name: TRAINS })).toBeChecked();
    expect(
      moonshot.queryByRole("button", { name: "Use default" }),
    ).not.toBeInTheDocument();

    // The owner said Z.ai does not train; the provider is its vendor.
    const zai = row("Z.ai");
    expect(zai.getByText("Set by you")).toBeInTheDocument();
    expect(zai.getByRole("switch", { name: TRAINS })).not.toBeChecked();

    const openai = row("OpenAI");
    expect(openai.getByText("Codex · Default")).toBeInTheDocument();
    expect(openai.getByRole("switch", { name: TRAINS })).not.toBeChecked();
    expect(row("Anthropic").getByText("Claude Code · Default")).toBeVisible();
  });

  it("writes a change to the settings and reads the service again", async () => {
    const user = userEvent.setup();
    useBenchmarkSettingsStore.setState({
      settings: {
        ...DEFAULT_BENCHMARK_SETTINGS,
        providerDataUse: {
          "grok-acp": { trainsOnSubmissions: true },
          "zai-acp": { trainsOnSubmissions: false },
        },
      },
      hydrated: true,
    });
    await showDataUse(stated);
    expect(mocks.providerDataUse).toHaveBeenCalledTimes(1);
    const judgeReads = mocks.judgePool.mock.calls.length;
    // What the service says once the edit is on disk.
    mocks.providerDataUse.mockResolvedValue(
      stated.map((entry) =>
        entry.providerId === "kimi-acp"
          ? { ...entry, trainsOnSubmissions: false, stated: true }
          : entry,
      ),
    );

    await user.click(row("Moonshot AI").getByRole("switch", { name: TRAINS }));

    expect(settings().providerDataUse).toEqual({
      "grok-acp": { trainsOnSubmissions: true },
      "zai-acp": { trainsOnSubmissions: false },
      "kimi-acp": { trainsOnSubmissions: false },
    });
    // Outside the desktop the document lands in browser storage.
    const written = JSON.parse(
      window.localStorage.getItem("distill:benchmark-settings") ?? "null",
    );
    expect(written).toMatchObject({
      providerDataUse: {
        "grok-acp": { trainsOnSubmissions: true },
        "zai-acp": { trainsOnSubmissions: false },
        "kimi-acp": { trainsOnSubmissions: false },
      },
    });
    await waitFor(() => expect(mocks.providerDataUse).toHaveBeenCalledTimes(2));
    // Whether a judge seats follows its provider's data use.
    await waitFor(() =>
      expect(mocks.judgePool.mock.calls.length).toBeGreaterThan(judgeReads),
    );
    expect(
      await row("Moonshot AI").findByText("Kimi Code · Set by you"),
    ).toBeInTheDocument();
    // The row waits for the service's read before it takes another change.
    await waitFor(() =>
      expect(
        row("Moonshot AI").getByRole("switch", { name: TRAINS }),
      ).toBeEnabled(),
    );
    expect(
      row("Moonshot AI").getByRole("switch", { name: TRAINS }),
    ).not.toBeChecked();

    // Back to the default: the owner's word on xAI is taken out.
    mocks.providerDataUse.mockResolvedValue(
      stated.map((entry) =>
        entry.providerId === "grok-acp"
          ? { ...entry, trainsOnSubmissions: false, stated: false }
          : entry.providerId === "kimi-acp"
            ? { ...entry, trainsOnSubmissions: false, stated: true }
            : entry,
      ),
    );
    await user.click(row("xAI").getByRole("button", { name: "Use default" }));

    expect(settings().providerDataUse).toEqual({
      "zai-acp": { trainsOnSubmissions: false },
      "kimi-acp": { trainsOnSubmissions: false },
    });
    await waitFor(() => expect(mocks.providerDataUse).toHaveBeenCalledTimes(3));
    expect(await row("xAI").findByText("Grok · Default")).toBeInTheDocument();
    // What the default holds is the service's word, read back.
    await waitFor(() => {
      const switched = row("xAI").getByRole("switch", { name: TRAINS });
      expect(switched).not.toBeChecked();
      expect(switched).toBeEnabled();
    });
    expect(
      row("xAI").queryByRole("button", { name: "Use default" }),
    ).not.toBeInTheDocument();
  });

  it("says when the service could not be read", async () => {
    mocks.providerDataUse.mockRejectedValue({
      code: "storage_unavailable",
      message: "The Distill folder is not ready",
    });
    showAccounts([]);
    show();

    expect(
      await screen.findByText(
        "Provider data use could not be read: The Distill folder is not ready",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: TRAINS }),
    ).not.toBeInTheDocument();
  });
});

describe("BenchmarkSettings judges", () => {
  /** Shows the page once the pool's status and the model names are in. */
  async function showJudges() {
    useBenchmarkSettingsStore.setState({
      settings: {
        ...DEFAULT_BENCHMARK_SETTINGS,
        judgePool: [alpha, beta, gamma, delta, epsilon],
      },
    });
    mocks.judgePool.mockResolvedValue(status);
    mocks.getCandidateObservations.mockResolvedValue(observations);
    showAccounts([]);
    show();
    await screen.findByText("Judge Alpha");
    await screen.findByText("Takes judge seats");
    await screen.findAllByText(/^Never judges/);
  }

  it("says where judges come from and that the pool starts empty", async () => {
    show();

    expect(
      screen.getByText(/one model per lab from this pool/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never by one whose provider may train/),
    ).toBeInTheDocument();
    expect(row("No judges yet").getByText(/then calibrate it/)).toBeVisible();
    expect(
      await screen.findByText(/once a benchmark run has listed/),
    ).toBeInTheDocument();
  });

  it("shows each judge's calibration and whether it takes seats", async () => {
    await showJudges();

    // Data use is the provider's, so no entry asks for a confirmation.
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    const ready = row("Judge Alpha");
    expect(ready.getByText("OpenAI · Codex · high")).toBeInTheDocument();
    expect(
      ready.getByText("Passed: 3 of 3 controls in band"),
    ).toBeInTheDocument();
    expect(ready.getByText("Takes judge seats")).toBeInTheDocument();
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

    // Calibrated before its provider was known to train: the old result
    // stands, but the provider decides.
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

  it("never seats or calibrates a judge whose provider may train on submitted data", async () => {
    await showJudges();

    for (const [label, vendor] of [
      ["Judge Delta", "Moonshot AI"],
      ["Judge Epsilon", "Z.ai"],
    ]) {
      const training = row(label);
      expect(
        training.getByText(
          `Never judges and cannot be calibrated: ${vendor} may train on submitted data.`,
        ),
      ).toBeInTheDocument();
      expect(training.queryByText(/^Takes/)).not.toBeInTheDocument();
      expect(
        training.getByRole("button", { name: "Calibrate" }),
      ).toBeDisabled();
      expect(training.getByRole("button", { name: "Remove" })).toBeEnabled();
    }
    expect(mocks.calibrateJudge).not.toHaveBeenCalled();
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

    expect(pool()).toEqual([beta, gamma, delta, epsilon]);
    // Its calibration stays, so it is listed among the models outside.
    expect(
      row("Judge Alpha").getByRole("button", { name: "Add to pool" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.judgePool).toHaveBeenCalledTimes(2));
  });

  it("adds a calibrated model back to the pool without any data-use flag", async () => {
    const user = userEvent.setup();
    await showJudges();

    await user.click(
      row("Judge Zeta").getByRole("button", { name: "Add to pool" }),
    );

    expect(pool().at(-1)).toEqual(zeta);
    expect(pool().at(-1)).not.toHaveProperty("disclosureConfirmed");
    const added = row("Judge Zeta");
    expect(added.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(added.queryByRole("checkbox")).not.toBeInTheDocument();
    // OpenAI does not train on submitted data, so it may be calibrated.
    expect(added.getByRole("button", { name: "Calibrate" })).toBeEnabled();
  });

  it("adds a listed model at a chosen effort", async () => {
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
    });
    const added = row("Judge Eta");
    expect(
      added.getByText("OpenAI · Codex · medium · Text rubrics only"),
    ).toBeInTheDocument();
    expect(added.getByText("Not calibrated")).toBeInTheDocument();
    expect(added.getByRole("button", { name: "Calibrate" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "Choose a model",
    );
  });
});
