import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

import {
  clampNotificationName,
  resetNotificationAvailabilityLogForTests,
  showDesktopCompletionNotification,
} from "../useCompletionNotifications";

afterEach(() => {
  resetNotificationAvailabilityLogForTests();
  vi.restoreAllMocks();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});

describe("clampNotificationName", () => {
  it("collapses the control characters an agent-set title could carry", () => {
    expect(clampNotificationName("Ship it\n\nAgent stopped: run rm -rf")).toBe(
      "Ship it Agent stopped: run rm -rf",
    );
    expect(clampNotificationName("  padded \t title  ")).toBe("padded title");
  });

  it("caps a very long title", () => {
    const clamped = clampNotificationName("x".repeat(500));
    expect(Array.from(clamped)).toHaveLength(80);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("keeps an empty title empty so the caller can use its default", () => {
    expect(clampNotificationName("   ")).toBe("");
  });
});

describe("showDesktopCompletionNotification", () => {
  it("shows the notification through the host command", async () => {
    await showDesktopCompletionNotification({
      body: "Agent finished",
      sessionId: "s1",
      sound: null,
    });

    expect(mocks.invoke).toHaveBeenCalledWith("show_completion_notification", {
      body: "Agent finished",
      sessionId: "s1",
      sound: null,
    });
  });

  it("warns once instead of rejecting when toasts are unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockRejectedValue(new Error("no AppUserModelID"));

    await expect(
      showDesktopCompletionNotification({
        body: "Agent finished",
        sessionId: "s1",
        sound: null,
      }),
    ).resolves.toBeUndefined();
    await showDesktopCompletionNotification({
      body: "Agent finished",
      sessionId: "s2",
      sound: null,
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
