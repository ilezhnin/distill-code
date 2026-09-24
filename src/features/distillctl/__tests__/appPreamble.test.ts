import { beforeEach, describe, expect, it, vi } from "vitest";

import cliSurface from "../../../../src-tauri/crates/distillctl/cli-surface.json";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

import {
  DISTILLCTL_PREAMBLE,
  formatDistillctlPreamble,
  getDistillctlPreamble,
  __resetDistillctlPreambleForTests,
} from "@/features/distillctl/appPreamble";

const SESSION_ID = "20260913_4";
const SESSION_PREAMBLE = formatDistillctlPreamble(SESSION_ID);

describe("getDistillctlPreamble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDistillctlPreambleForTests();
    window.__TAURI_INTERNALS__ = {};
  });

  it("goes inert after a plugin-unavailable rejection (no repeat IPC)", async () => {
    mocks.invoke.mockRejectedValue(
      new Error(
        "distillctl.status not allowed. Permissions associated with this command: distillctl:default",
      ),
    );

    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBeNull();
    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns null on a transient status failure but retries next call", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockRejectedValueOnce(new Error("ipc glitch"));
    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    mocks.invoke.mockResolvedValueOnce({ running: true });
    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBe(
      SESSION_PREAMBLE,
    );
  });
});

describe("DISTILLCTL_PREAMBLE content", () => {
  /**
   * Drift protection: every noun and verb the preamble names must exist in
   * the generated CLI surface. The listing is intentionally non-exhaustive
   * (niche verbs are omitted to save tokens), so new verbs never fail this
   * test — only renames and removals do.
   */
  it("only names nouns and verbs that exist in cli-surface.json", () => {
    const nouns = cliSurface.nouns as Record<
      string,
      { verbs: Record<string, unknown> }
    >;
    const listedLines = DISTILLCTL_PREAMBLE.split("\n").filter((line) =>
      line.startsWith("- "),
    );
    expect(listedLines.length).toBeGreaterThan(0);

    for (const line of listedLines) {
      const match = line.match(/^- (\S+): (.+)$/);
      expect(match, `unparseable preamble line: ${line}`).not.toBeNull();
      const [, noun, verbList] = match as RegExpMatchArray;
      expect(
        nouns[noun],
        `preamble names unknown noun "${noun}"`,
      ).toBeDefined();
      for (const verb of verbList.split(", ")) {
        expect(
          nouns[noun].verbs[verb],
          `preamble names unknown verb "${noun} ${verb}"`,
        ).toBeDefined();
      }
    }
  });
});
