import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startSetup: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock("@/features/providers/stores/agentSetupStore", () => ({
  useAgentSetupStore: {
    getState: () => ({ startSetup: mocks.startSetup }),
  },
}));

vi.mock("@/features/settings/lib/settingsEvents", () => ({
  requestOpenSettings: mocks.openSettings,
}));

import {
  connectAgentPlatform,
  connectAllAgentPlatforms,
  openProviderAccounts,
  openUsageDetails,
} from "../connectPlatforms";

describe("connectPlatforms", () => {
  beforeEach(() => {
    mocks.startSetup.mockReset().mockResolvedValue(undefined);
    mocks.openSettings.mockReset();
  });

  it("routes usage details to stats and accounts to providers", () => {
    openUsageDetails();
    openProviderAccounts();
    expect(mocks.openSettings).toHaveBeenCalledWith("stats");
    expect(mocks.openSettings).toHaveBeenCalledWith("providers");
  });

  it("starts auth for an installed unauthenticated Claude platform", async () => {
    await connectAgentPlatform("claude-acp", "not_ready");
    expect(mocks.openSettings).toHaveBeenCalledWith("providers");
    expect(mocks.startSetup).toHaveBeenCalledWith(
      "claude-acp",
      "auth",
      expect.objectContaining({ bundledBridge: true }),
    );
  });

  it("starts install for a missing Grok CLI", async () => {
    await connectAgentPlatform("grok-acp", "not_installed");
    expect(mocks.startSetup).toHaveBeenCalledWith(
      "grok-acp",
      "install",
      expect.objectContaining({ installFixType: "command" }),
    );
  });

  it("connects every unready tracked platform", async () => {
    await connectAllAgentPlatforms(
      new Map([
        ["claude-acp", "not_ready"],
        ["grok-acp", "not_installed"],
        ["codex-acp", "ready"],
      ]),
    );
    expect(mocks.startSetup).toHaveBeenCalledTimes(2);
  });
});
