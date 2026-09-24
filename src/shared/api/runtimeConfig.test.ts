import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";
import { refreshRuntimeConfig } from "./runtimeConfig";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

const validConfig = DEFAULT_RUNTIME_CONFIG satisfies RuntimeConfig;

describe("runtime config api", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  describe("transient startup retries", () => {
    // The framework-level rejection Tauri raises when a command reads managed
    // state that has not been `app.manage(...)`-d yet. It arrives as a bare
    // string while the webview races ahead of the still-running `setup()`.
    const stateNotManagedError =
      "state not managed for field `state` on command `refresh_runtime_config`. You must call `.manage()` before using this command";

    const readyResult = {
      status: "ready",
      source: "bundledFile",
      config: validConfig,
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-retries a transient "state not managed" rejection and ultimately succeeds', async () => {
      mockInvoke
        .mockRejectedValueOnce(stateNotManagedError)
        .mockResolvedValueOnce(readyResult);

      const promise = refreshRuntimeConfig();
      await vi.runAllTimersAsync();

      await expect(promise).resolves.toEqual(readyResult);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });

    it("propagates a genuine error immediately without retrying", async () => {
      const failure = new Error("runtime config endpoint exploded");
      mockInvoke.mockRejectedValue(failure);

      await expect(refreshRuntimeConfig()).rejects.toBe(failure);
      expect(mockInvoke).toHaveBeenCalledTimes(1);
    });

    it("gives up after a bounded number of transient retries", async () => {
      mockInvoke.mockRejectedValue(stateNotManagedError);

      const promise = refreshRuntimeConfig();
      // Swallow the eventual rejection so draining the backoff timers below
      // doesn't surface an unhandled rejection.
      promise.catch(() => {});
      await vi.runAllTimersAsync();

      await expect(promise).rejects.toBe(stateNotManagedError);
      // The initial attempt plus the five bounded retries.
      expect(mockInvoke).toHaveBeenCalledTimes(6);
    });
  });
});
