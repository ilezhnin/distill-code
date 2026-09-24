import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe("doctor API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never forwards a renderer-supplied command to run_doctor_fix", async () => {
    // Regression for finding 7: the wire contract carries only the typed
    // (checkId, fixType) identity. Even for an update fix — whose command used
    // to ride along as `commandOverride` — no command string may cross to the
    // backend, so a compromised renderer has no shell escape hatch.
    mockedInvoke.mockResolvedValue(undefined);

    const { runDoctorFix } = await import("../doctor");
    await runDoctorFix("ai-agent-claude", "updateMain");

    const payload = mockedInvoke.mock.calls.at(-1)?.[1] as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      checkId: "ai-agent-claude",
      fixType: "updateMain",
    });
    expect(payload).not.toHaveProperty("commandOverride");
    expect(payload).not.toHaveProperty("command");
  });
});
