import { beforeEach, describe, expect, it } from "vitest";
import type {
  ProviderAccount,
  ProviderAccountModel,
} from "../api/providerAccounts";
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

function stored(
  providerId: string,
  accounts: ProviderAccount[],
): ProviderAccountModel {
  return {
    providerId,
    connection: "browser_or_api_key",
    accountLimit: null,
    reportsUsage: true,
    supportsSignOut: true,
    accounts,
    defaultAccountId: accounts[0]?.id ?? null,
    automaticSwitching: false,
  };
}

function cli(providerId: string, reportsUsage = true): ProviderAccountModel {
  return {
    providerId,
    connection: "cli",
    accountLimit: 1,
    reportsUsage,
    supportsSignOut: false,
    accounts: [{ ...account(providerId), id: `cli-login-${providerId}` }],
    defaultAccountId: `cli-login-${providerId}`,
    automaticSwitching: false,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("hasCompletedSignIn", () => {
  it("is false for a CLI an abandoned setup installed but never signed in", () => {
    // Doctor sees the installed CLI, but it was never ready here.
    recordReadyProviders(new Set(["grok-acp"]), 1);
    expect(hasCompletedSignIn("copilot-acp", cli("copilot-acp"))).toBe(false);
  });

  it("is true for a CLI that signed in here and has since signed out", () => {
    recordReadyProviders(new Set(["grok-acp"]), 1);
    recordReadyProviders(new Set(), 2);
    expect(hasCompletedSignIn("grok-acp", cli("grok-acp"))).toBe(true);
    // Before the model has loaded, the record alone decides.
    expect(hasCompletedSignIn("grok-acp", undefined)).toBe(true);
  });

  it("is false for a CLI signed in on the machine whose usage Flock cannot read", () => {
    // Copilot's CLI is ready, so it was noted as connected; Flock reads no
    // usage for it, so the usage bar has nothing of its own to show.
    recordReadyProviders(new Set(["copilot-acp"]), 1);
    expect(hasCompletedSignIn("copilot-acp", cli("copilot-acp", false))).toBe(
      false,
    );
    expect(hasCompletedSignIn("copilot-acp", undefined)).toBe(true);
  });

  it("is false for a saved account whose browser sign-in was abandoned", () => {
    // Adding an OAuth account saves it before the browser sign-in; an
    // abandoned sign-in leaves the account without ever being connected.
    expect(
      hasCompletedSignIn(
        "claude-acp",
        stored("claude-acp", [account("claude-acp")]),
      ),
    ).toBe(false);
  });

  it("needs a saved account for providers whose accounts Flock keeps", () => {
    recordReadyProviders(new Set(["claude-acp"]), 1);
    recordReadyProviders(new Set(), 2);
    expect(
      hasCompletedSignIn(
        "claude-acp",
        stored("claude-acp", [account("claude-acp")]),
      ),
    ).toBe(true);
    expect(hasCompletedSignIn("claude-acp", stored("claude-acp", []))).toBe(
      false,
    );
  });
});
