import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRoutingPolicyStore } from "@/features/agents/stores/routingPolicyStore";
import { DEFAULT_ROUTING_POLICY } from "@/features/agents/lib/routingPolicy";
import { RoutingPolicySection } from "../RoutingPolicySection";

const mocks = vi.hoisted(() => ({
  readDistillDocument: vi.fn(async (_path: string) => null as string | null),
  writeDistillDocument: vi.fn(async (_path: string, _contents: string) => {}),
}));

vi.mock("@/shared/api/distillStore", () => ({
  isDesktopRuntime: () => true,
  readDistillDocument: mocks.readDistillDocument,
  writeDistillDocument: mocks.writeDistillDocument,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("RoutingPolicySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRoutingPolicyStore.setState({
      policy: { ...DEFAULT_ROUTING_POLICY },
      hydrated: false,
      hydrationFailed: false,
    });
  });

  it("says nothing while the policy is being persisted normally", () => {
    useRoutingPolicyStore.setState({ hydrated: true });
    render(<RoutingPolicySection />);

    expect(screen.queryByTestId("routing-not-persisted")).toBeNull();
  });

  it("warns that edits will not survive when the policy could not be read", async () => {
    const { hydrateRoutingPolicyStore } = await import(
      "@/features/agents/stores/routingPolicyStore"
    );
    mocks.readDistillDocument.mockRejectedValueOnce(
      new Error("sharing violation"),
    );
    await expect(hydrateRoutingPolicyStore()).rejects.toThrow(
      "sharing violation",
    );

    render(<RoutingPolicySection />);
    expect(screen.getByTestId("routing-not-persisted")).toHaveTextContent(
      "routing.notPersisted",
    );

    // The retry reads again and, on success, the warning goes away.
    mocks.readDistillDocument.mockResolvedValueOnce(
      JSON.stringify({ ...DEFAULT_ROUTING_POLICY, waveNearLimitPercent: 70 }),
    );
    await userEvent.click(screen.getByTestId("routing-retry-hydration"));

    expect(screen.queryByTestId("routing-not-persisted")).toBeNull();
    expect(useRoutingPolicyStore.getState().hydrated).toBe(true);
    expect(useRoutingPolicyStore.getState().policy.waveNearLimitPercent).toBe(
      70,
    );
  });
});
