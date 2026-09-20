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

  it("returns the preamble when the plugin reports the broker running", async () => {
    mocks.invoke.mockResolvedValue({ running: true });

    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBe(
      SESSION_PREAMBLE,
    );
    expect(mocks.invoke).toHaveBeenCalledWith("plugin:distillctl|status");
  });

  it("returns null when the plugin reports the broker stopped", async () => {
    mocks.invoke.mockResolvedValue({ running: false });

    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBeNull();
  });

  it("asks the plugin per call so availability changes are picked up", async () => {
    // The discriminating case for the popped-out-window bug: availability is
    // an app-global fact owned by the plugin, so it must be queried, not
    // cached renderer-locally where only one window would ever update it.
    mocks.invoke.mockResolvedValueOnce({ running: false });
    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBeNull();

    mocks.invoke.mockResolvedValueOnce({ running: true });
    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBe(
      SESSION_PREAMBLE,
    );
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("returns null outside the Tauri webview without invoking", async () => {
    window.__TAURI_INTERNALS__ = undefined;

    await expect(getDistillctlPreamble(SESSION_ID)).resolves.toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
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

describe("formatDistillctlPreamble", () => {
  it("tells each session its own id and how to pass it", () => {
    // Nothing else identifies the caller: the host cannot export
    // AGENT_SESSION_ID per session (one bridge process per harness), and
    // `info context` reports the chat the user is viewing, not the caller.
    const text = formatDistillctlPreamble(SESSION_ID);
    expect(text.startsWith(DISTILLCTL_PREAMBLE)).toBe(true);
    expect(text).toContain(`Your own session id is ${SESSION_ID}.`);
    expect(text).toContain(`\`--session-id ${SESSION_ID}\``);
    expect(text).toContain("distill-monitor");
    expect(text).toContain("`distillctl info context`");
    expect(text).not.toContain("AGENT_SESSION_ID");
  });

  it("gives two sessions different preambles", () => {
    expect(formatDistillctlPreamble("session-a")).not.toBe(
      formatDistillctlPreamble("session-b"),
    );
  });

  it("falls back to the shared text when the id is blank", () => {
    expect(formatDistillctlPreamble("   ")).toBe(DISTILLCTL_PREAMBLE);
  });
});

describe("DISTILLCTL_PREAMBLE content", () => {
  it("teaches the CLI name and --help discovery", () => {
    expect(DISTILLCTL_PREAMBLE).toContain("`distillctl`");
    expect(DISTILLCTL_PREAMBLE).toContain("--help");
  });

  it("routes switching to replace, selection/retention to set-cwd, and additions to attach", () => {
    expect(DISTILLCTL_PREAMBLE).toContain(
      "switch or move this chat to a new worktree/folder",
    );
    expect(DISTILLCTL_PREAMBLE).toContain("use `folder replace`");
    expect(DISTILLCTL_PREAMBLE).toContain(
      "Use `folder set-cwd` to select an already attached folder",
    );
    expect(DISTILLCTL_PREAMBLE).toContain(
      "Use `folder attach` only to add context without changing cwd",
    );
    expect(DISTILLCTL_PREAMBLE).not.toContain("set-worktree");
  });

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
