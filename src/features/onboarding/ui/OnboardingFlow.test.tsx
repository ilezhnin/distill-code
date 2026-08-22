import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOnboardingSnapshot,
  resetOnboardingStoreForTests,
} from "../model/onboardingStore";
import { OnboardingFlow } from "./OnboardingFlow";

const mockUpdateTelemetryEnabled = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

vi.mock("@/shared/telemetry/consent", () => ({
  updateTelemetryEnabled: mockUpdateTelemetryEnabled,
  telemetryConsentEnforced: () => false,
}));

function renderFlow() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <OnboardingFlow />
    </QueryClientProvider>,
  );
}

describe("OnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    resetOnboardingStoreForTests();
  });

  it("completes first-run onboarding without sharing usage data", async () => {
    renderFlow();

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(getOnboardingSnapshot()).toMatchObject({
      lifecycle: "completed",
      step: "complete",
      shareUsageData: false,
    });
    expect(
      screen.queryByRole("checkbox", { name: /share anonymous usage data/i }),
    ).not.toBeInTheDocument();
    expect(mockUpdateTelemetryEnabled).toHaveBeenCalledWith(false);
  });
});
