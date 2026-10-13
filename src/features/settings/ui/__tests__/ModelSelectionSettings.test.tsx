import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_ROUTING_POLICY } from "@/features/agents/lib/routingPolicy";
import { useRoutingPolicyStore } from "@/features/agents/stores/routingPolicyStore";
import { benchmarkGovernanceApi as api } from "@/features/benchmarks/api/benchmarkGovernance";
import type { ClassPolicy } from "@/features/benchmarks/lib/benchmarkGovernance";
import { ModelSelectionSettings } from "../ModelSelectionSettings";
import { resolveSettingsSection } from "../settingsSections";
import { SETTINGS_SEARCH_ITEMS } from "../settingsSearchItems";

vi.mock("@/features/benchmarks/api/benchmarkGovernance", () => ({
  benchmarkGovernanceApi: { classPolicies: vi.fn() },
}));

const evidence: ClassPolicy = {
  workClassId: "debug",
  certificateId: null,
  certifiedAt: null,
  campaignId: null,
  modelId: null,
  qualifiedTraining: 2,
  qualifiedHeldOut: 3,
  heldOutWorkflows: 3,
  fits: 1,
  campaigns: 1,
};

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ModelSelectionSettings />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.mocked(api.classPolicies).mockReset().mockResolvedValue([evidence]);
  useRoutingPolicyStore.setState({
    policy: { ...DEFAULT_ROUTING_POLICY, classOverrides: {} },
    hydrated: false,
    hydrationFailed: false,
  });
});
afterEach(cleanup);

it("has its own destination and keeps detailed evidence out of the category overview", async () => {
  expect(resolveSettingsSection("routing")).toBe("routing");
  expect(
    SETTINGS_SEARCH_ITEMS.find((item) => item.id === "fallback-preferences")
      ?.sectionId,
  ).toBe("routing");
  show();
  expect(await screen.findByText("Using fallback preferences")).toBeVisible();
  expect(screen.queryByText(/Qualified cases/)).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  const debug = screen.getByRole("button", {
    name: "Debugging and bug fixing",
  });
  fireEvent.click(debug);
  const details = screen.getByText("Certification details");
  fireEvent.click(details);
  expect(
    await screen.findByText(/2 training, 3 held-out; 1 fits, 1 comparisons/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Writing" }));
  expect(debug).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText(/2 training, 3 held-out/)).toBeNull();
});

it("edits and resets one fallback order without changing other classes or usage limits", async () => {
  useRoutingPolicyStore.setState({
    policy: {
      ...DEFAULT_ROUTING_POLICY,
      chatNearLimitPercent: 94,
      classOverrides: { debug: ["Grok 4.7", "Astra"], writing: ["Astra"] },
    },
  });
  show();
  await screen.findByText("Using fallback preferences");
  fireEvent.click(
    screen.getByRole("button", { name: "Debugging and bug fixing" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move Astra up" }));
  expect(useRoutingPolicyStore.getState().policy.classOverrides.debug).toEqual([
    "Astra",
    "Grok 4.7",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Grok 4.7" }));
  expect(screen.getByRole("button", { name: "Remove Astra" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Use default order" }));
  expect(
    useRoutingPolicyStore.getState().policy.classOverrides.debug,
  ).toBeUndefined();
  expect(
    useRoutingPolicyStore.getState().policy.classOverrides.writing,
  ).toEqual(["Astra"]);
  expect(useRoutingPolicyStore.getState().policy.chatNearLimitPercent).toBe(94);
  fireEvent.click(screen.getByRole("button", { name: "Usage limits" }));
  fireEvent.change(
    screen.getByRole("spinbutton", {
      name: "Move wave steps off a platform at",
    }),
    { target: { value: "87" } },
  );
  expect(useRoutingPolicyStore.getState().policy.waveNearLimitPercent).toBe(87);
});

it("shows certification only with a complete certificate and never on a failed refresh", async () => {
  vi.mocked(api.classPolicies).mockResolvedValue([
    { ...evidence, certificateId: "test-certificate", certifiedAt: 1 },
    { ...evidence, workClassId: "writing", certificateId: "incomplete" },
  ]);
  const client = show();
  await screen.findByText(
    "Certified policies available for 1 of 14 categories",
  );
  expect(
    within(screen.getByTestId("routing-category-debug")).getByText("Certified"),
  ).toBeVisible();
  expect(
    within(screen.getByTestId("routing-category-writing")).getByText(
      "Fallback",
    ),
  ).toBeVisible();
  vi.mocked(api.classPolicies).mockRejectedValue(new Error("offline"));
  await client.refetchQueries({ queryKey: ["benchmarks", "class-policies"] });
  expect(
    await screen.findByText(/Task policy status could not be read/),
  ).toBeVisible();
  expect(screen.queryByText("Certified")).toBeNull();
  expect(
    within(screen.getByTestId("routing-category-debug")).getByText(
      "Unavailable",
    ),
  ).toBeVisible();
});

it("distinguishes loading from fallback and retains the persistence failure warning", () => {
  vi.mocked(api.classPolicies).mockImplementation(() => new Promise(() => {}));
  useRoutingPolicyStore.setState({ hydrationFailed: true });
  show();
  expect(screen.getByText("Loading task policy status...")).toBeVisible();
  expect(screen.queryByText("Using fallback preferences")).toBeNull();
  expect(screen.getByTestId("routing-not-persisted")).toHaveTextContent(
    /this run only/,
  );
  expect(
    screen.getByRole("button", { name: "Try reading again" }),
  ).toBeEnabled();
});
