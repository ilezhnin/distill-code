import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { WelcomeStep } from "./WelcomeStep";

const consentMocks = vi.hoisted(() => ({
  update: vi.fn(async () => undefined),
}));

vi.mock("@/shared/telemetry/consent", () => ({
  updateTelemetryEnabled: consentMocks.update,
  telemetryConsentEnforced: () => false,
}));

function renderStep({
  onStart = vi.fn(),
  recordedShareUsageData = null,
  onRecordShareUsageData = vi.fn(),
}: {
  onStart?: Mock<() => void>;
  recordedShareUsageData?: boolean | null;
  onRecordShareUsageData?: Mock<(shareUsageData: boolean) => void>;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <WelcomeStep
        onStart={onStart}
        recordedShareUsageData={recordedShareUsageData}
        onRecordShareUsageData={onRecordShareUsageData}
      />
    </QueryClientProvider>,
  );
  return { onStart, onRecordShareUsageData };
}

describe("WelcomeStep", () => {
  afterEach(() => {
    consentMocks.update.mockReset().mockResolvedValue(undefined);
  });

  it("starts Distill without promo art or usage-sharing", async () => {
    const { onStart, onRecordShareUsageData } = renderStep();

    const heading = screen.getByRole("heading", {
      name: "Welcome to Distill. Your place for conducting work.",
    });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveFocus();
    expect(screen.queryByTestId("project-cube")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /share anonymous usage data/i }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));
    expect(consentMocks.update).toHaveBeenCalledExactlyOnceWith(false);
    expect(onRecordShareUsageData).toHaveBeenCalledExactlyOnceWith(false);
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("advances even when the disable write fails", async () => {
    const error = new Error("read-only disk");
    consentMocks.update.mockRejectedValue(error);
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const { onStart } = renderStep();

    await userEvent.click(screen.getByRole("button", { name: "Let’s go" }));

    expect(onStart).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(consoleWarn).toHaveBeenCalledWith(
        "Failed to persist the usage-data choice:",
        error,
      );
    });
    consoleWarn.mockRestore();
  });
});
