import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderAccount } from "../api/providerAccounts";
import {
  hasCompletedSignIn,
  recordReadyProviders,
} from "./providerConnections";

function account(providerId: string): ProviderAccount {
  return {
    id: `${providerId}-account`,
    providerId,
    label: "someone@example.test",
    authMethod: "oauth",
    enabled: true,
    autoSwitch: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("hasCompletedSignIn", () => {
  it("is false for a CLI an abandoned setup installed but never signed in", () => {
    // Doctor sees the installed CLI, but it was never ready here.
    recordReadyProviders(new Set(["grok-acp"]), 1);
    expect(hasCompletedSignIn("copilot-acp", [])).toBe(false);
  });

  it("is true for a CLI that signed in here and has since signed out", () => {
    recordReadyProviders(new Set(["grok-acp"]), 1);
    recordReadyProviders(new Set(), 2);
    expect(hasCompletedSignIn("grok-acp", [])).toBe(true);
  });

  it("is false for a saved account whose browser sign-in was abandoned", () => {
    // Adding an OAuth account saves it before the browser sign-in; an
    // abandoned sign-in leaves the account without ever being connected.
    expect(hasCompletedSignIn("claude-acp", [account("claude-acp")])).toBe(
      false,
    );
  });

  it("needs a saved account for providers whose accounts Flock keeps", () => {
    recordReadyProviders(new Set(["claude-acp"]), 1);
    recordReadyProviders(new Set(), 2);
    expect(hasCompletedSignIn("claude-acp", [account("claude-acp")])).toBe(
      true,
    );
    expect(hasCompletedSignIn("claude-acp", [account("codex-acp")])).toBe(
      false,
    );
  });
});
