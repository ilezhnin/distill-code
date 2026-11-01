import { afterEach, describe, expect, it } from "vitest";

import { buildWaveResumePreamble } from "./wavePrompts";
import {
  MAX_RESUME_MESSAGE_CHARS,
  loadWaveResumeContext,
  resetWaveResumeIoForTests,
  setWaveResumeIoForTests,
  statusFilePathIn,
} from "./waveResume";

afterEach(() => {
  resetWaveResumeIoForTests();
});

describe("statusFilePathIn", () => {
  it("resolves a relative status file against the working folder", () => {
    expect(
      statusFilePathIn(
        "Progress is tracked in docs/STATUS.md, see there.",
        "E:\\games\\mod",
      ),
    ).toBe("E:\\games\\mod\\docs/STATUS.md");
  });

  it("keeps an absolute path and reads nothing without a folder", () => {
    expect(
      statusFilePathIn("Wrote C:\\work\\STATUS.md with the plan", undefined),
    ).toBe("C:\\work\\STATUS.md");
    expect(statusFilePathIn("see STATUS.md", undefined)).toBeUndefined();
    expect(statusFilePathIn("no file named here", "/w")).toBeUndefined();
  });
});

describe("loadWaveResumeContext", () => {
  it("quotes the previous session's last assistant message and the status file it named", async () => {
    const reads: string[] = [];
    setWaveResumeIoForTests({
      lastMessages: async () => [
        { role: "user", text: "do the thing" },
        { role: "assistant", text: "Half done; state is in ./STATUS.md" },
        { role: "user", text: "operator poke" },
      ],
      readText: async (path) => {
        reads.push(path);
        return "# Status\n- cache: 40%";
      },
    });
    const context = await loadWaveResumeContext({
      previousSessionId: "dead",
      workingDir: "/work/mod",
    });
    expect(context.lastMessage).toBe("Half done; state is in ./STATUS.md");
    expect(reads).toEqual(["/work/mod/STATUS.md"]);
    expect(context.statusFile).toEqual({
      path: "/work/mod/STATUS.md",
      contents: "# Status\n- cache: 40%",
    });
    const preamble = buildWaveResumePreamble({
      previousSessionId: "dead",
      stepIndex: 2,
      at: Date.UTC(2026, 10, 1, 12, 0, 0),
      context,
    });
    expect(preamble).toContain(
      "RESUMED after app restart at 2026-11-01T12:00:00.000Z",
    );
    expect(preamble).toContain("step 3 of this wave");
    expect(preamble).toContain("Half done; state is in ./STATUS.md");
    expect(preamble).toContain("- cache: 40%");
  });

  it("survives a transcript that cannot be read and a file that cannot", async () => {
    setWaveResumeIoForTests({
      lastMessages: async () => {
        throw new Error("host gone");
      },
    });
    expect(await loadWaveResumeContext({ previousSessionId: "dead" })).toEqual(
      {},
    );

    setWaveResumeIoForTests({
      lastMessages: async () => [
        {
          role: "assistant",
          text: `${"x".repeat(MAX_RESUME_MESSAGE_CHARS + 50)} STATUS.md`,
        },
      ],
      readText: async () => {
        throw new Error("no such file");
      },
    });
    const context = await loadWaveResumeContext({
      previousSessionId: "dead",
      workingDir: "/w",
    });
    expect(context.statusFile).toBeUndefined();
    expect(context.lastMessage).toContain("[…truncated by the app]");
    const blind = buildWaveResumePreamble({
      previousSessionId: "dead",
      stepIndex: 0,
      at: 0,
      context: {},
    });
    expect(blind).toContain("had said nothing yet");
  });
});
