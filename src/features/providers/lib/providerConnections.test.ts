import { beforeEach, describe, expect, it } from "vitest";
import {
  mostRecentlyConnectedProvider,
  recordReadyProviders,
} from "./providerConnections";

const ids = (...providerIds: string[]) => new Set(providerIds);

describe("providerConnections", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps the default while every ready provider was first seen together", () => {
    recordReadyProviders(ids("codex-acp", "claude-acp", "grok-acp"), 1_000);

    expect(
      mostRecentlyConnectedProvider(
        ids("codex-acp", "claude-acp", "grok-acp"),
        "claude-acp",
      ),
    ).toBe("claude-acp");
  });

  it("starts on the account connected last", () => {
    recordReadyProviders(ids("claude-acp"), 1_000);
    recordReadyProviders(ids("claude-acp", "grok-acp"), 2_000);

    expect(
      mostRecentlyConnectedProvider(
        ids("claude-acp", "grok-acp"),
        "claude-acp",
      ),
    ).toBe("grok-acp");
  });

  it("counts a provider that just became ready before it is noted", () => {
    recordReadyProviders(ids("claude-acp"), 1_000);

    expect(
      mostRecentlyConnectedProvider(
        ids("claude-acp", "codex-acp"),
        "claude-acp",
      ),
    ).toBe("codex-acp");
  });

  it("treats signing in again as connecting again", () => {
    recordReadyProviders(ids("claude-acp", "codex-acp"), 1_000);
    recordReadyProviders(ids("codex-acp"), 2_000);
    recordReadyProviders(ids("claude-acp", "codex-acp"), 3_000);

    expect(
      mostRecentlyConnectedProvider(
        ids("claude-acp", "codex-acp"),
        "codex-acp",
      ),
    ).toBe("claude-acp");
  });

  it("falls back when nothing is ready, and ranks a tie by the catalog", () => {
    expect(mostRecentlyConnectedProvider(ids(), "claude-acp")).toBe(
      "claude-acp",
    );
    expect(
      mostRecentlyConnectedProvider(ids("grok-acp", "codex-acp"), "claude-acp"),
    ).toBe("codex-acp");
  });
});
