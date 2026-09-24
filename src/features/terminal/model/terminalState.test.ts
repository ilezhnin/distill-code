import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_STATE, validateTerminalState } from "./terminalState";

describe("terminal state", () => {
  it("deduplicates equivalent Windows paths during legacy migration", () => {
    expect(
      validateTerminalState(
        {
          paths: [String.raw`C:\Repo`, "c:/repo/", "/Repo", "/repo"],
          expandedPath: "c:/REPO",
        },
        DEFAULT_TERMINAL_STATE,
      ),
    ).toMatchObject({
      tabs: [{ cwd: String.raw`C:\Repo` }, { cwd: "/Repo" }, { cwd: "/repo" }],
      activeTabId: expect.stringContaining("legacy-0-"),
      expanded: true,
    });
  });
});
