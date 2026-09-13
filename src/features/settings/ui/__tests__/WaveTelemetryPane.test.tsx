import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  notePersistFailure,
  notePersistReadOutage,
  resetPersistHealthForTests,
} from "@/features/conductor/persistHealth";
import { emptyWaveTelemetryState } from "@/features/conductor/waveTelemetryStore";

import { WaveTelemetryPane } from "../stats/WaveTelemetryPane";

const mocks = vi.hoisted(() => ({
  retryConductorDocumentHydration: vi.fn(async () => true),
}));

vi.mock("@/features/settings/lib/distillStoreHydration", () => ({
  retryConductorDocumentHydration: mocks.retryConductorDocumentHydration,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.documents ? `${key}:${String(options.documents)}` : key,
  }),
}));

describe("WaveTelemetryPane durability warnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.retryConductorDocumentHydration.mockResolvedValue(true);
    resetPersistHealthForTests();
  });

  function renderPane() {
    return render(<WaveTelemetryPane telemetry={emptyWaveTelemetryState()} />);
  }

  it("says nothing while the folder is being read and written normally", () => {
    renderPane();

    expect(screen.queryByTestId("wave-telemetry-persist-warning")).toBeNull();
    expect(screen.queryByTestId("wave-telemetry-read-outage")).toBeNull();
  });

  it("keeps showing a document that could not be read, and offers the re-read", async () => {
    // A spent hydration retry disables the whole conductor for the session.
    // The transcript notice scrolls away; this is the standing surface, and the
    // button is the way out that does not involve restarting the app.
    const user = userEvent.setup();
    notePersistReadOutage("waves");
    renderPane();

    const banner = screen.getByTestId("wave-telemetry-read-outage");
    expect(banner.textContent).toContain("conductor/waves.json");
    // A refused write is a different, quieter condition and must not be
    // reported as one.
    expect(screen.queryByTestId("wave-telemetry-persist-warning")).toBeNull();

    await user.click(screen.getByRole("button", { name: /readOutageRetry$/ }));

    expect(mocks.retryConductorDocumentHydration).toHaveBeenCalledTimes(1);
  });

  it("says so when the re-read fails too", async () => {
    const user = userEvent.setup();
    mocks.retryConductorDocumentHydration.mockResolvedValue(false);
    notePersistReadOutage("graph");
    renderPane();

    await user.click(screen.getByRole("button", { name: /readOutageRetry$/ }));

    expect(
      screen.getByTestId("wave-telemetry-read-outage").textContent,
    ).toContain("readOutageRetryFailed");
  });

  it("still reports refused writes on their own line", () => {
    notePersistFailure("graph");
    renderPane();

    expect(
      screen.getByTestId("wave-telemetry-persist-warning"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("wave-telemetry-read-outage")).toBeNull();
  });
});
