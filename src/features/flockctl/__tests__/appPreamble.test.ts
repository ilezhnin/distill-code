import { beforeEach, describe, expect, it, vi } from "vitest";

import cliSurface from "../../../../src-tauri/crates/flockctl/cli-surface.json";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

import {
  FLOCKCTL_PREAMBLE,
  formatFlockctlPreamble,
  getFlockctlPreamble,
  __resetFlockctlPreambleForTests,
} from "@/features/flockctl/appPreamble";
import {
  sessionTokenFor,
  verifySessionToken,
} from "@/features/flockctl/sessionToken";

const SESSION_ID = "20260913_4";
const SESSION_PREAMBLE = formatFlockctlPreamble(SESSION_ID);

describe("getFlockctlPreamble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetFlockctlPreambleForTests();
    window.__TAURI_INTERNALS__ = {};
  });

  it("goes inert after a plugin-unavailable rejection (no repeat IPC)", async () => {
    mocks.invoke.mockRejectedValue(
      new Error(
        "flockctl.status not allowed. Permissions associated with this command: flockctl:default",
      ),
    );

    await expect(getFlockctlPreamble(SESSION_ID)).resolves.toBeNull();
    await expect(getFlockctlPreamble(SESSION_ID)).resolves.toBeNull();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns null on a transient status failure but retries next call", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.invoke.mockRejectedValueOnce(new Error("ipc glitch"));
    await expect(getFlockctlPreamble(SESSION_ID)).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    mocks.invoke.mockResolvedValueOnce({ running: true });
    await expect(getFlockctlPreamble(SESSION_ID)).resolves.toBe(
      formatFlockctlPreamble(
        SESSION_ID,
        true,
        await sessionTokenFor(SESSION_ID),
      ),
    );
  });

  it("tells a session that may start others the token that proves its calls", async () => {
    mocks.invoke.mockResolvedValue({ running: true });
    const preamble = (await getFlockctlPreamble(SESSION_ID)) as string;
    const token = /--session-token (\S+)`/.exec(preamble)?.[1];
    expect(await verifySessionToken(token)).toEqual({
      sessionId: SESSION_ID,
    });
    expect(preamble).toContain(
      `pass \`--parent-session-id ${SESSION_ID} --session-token ${token}\` to \`flockctl session create\``,
    );
  });
});

describe("formatFlockctlPreamble", () => {
  it("invites a session that may start others to name itself as their parent", () => {
    expect(SESSION_PREAMBLE).toContain(
      `pass \`--parent-session-id ${SESSION_ID}\` to \`flockctl session create\``,
    );
  });

  it("tells a session that starts nobody so, and how to ask for more hands", () => {
    const worker = formatFlockctlPreamble(SESSION_ID, false);
    // Its own id is still the one thing nothing else tells it.
    expect(worker).toContain(`Your own session id is ${SESSION_ID}.`);
    // The line that invited it to spawn is gone: it contradicted the spawn
    // rule the same session reads, and the worker learned which one held
    // from a refusal.
    expect(worker).not.toContain("--parent-session-id");
    // Nor is it given a token: it has no call to prove.
    expect(worker).not.toContain("--session-token");
    expect(formatFlockctlPreamble(SESSION_ID, false, "x.y")).not.toContain(
      "--session-token",
    );
    expect(worker).toContain("This session starts no other sessions");
    expect(worker).toContain("`needsOperator`, `nextSuggestedTask`");
  });
});

describe("FLOCKCTL_PREAMBLE content", () => {
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
    const listedLines = FLOCKCTL_PREAMBLE.split("\n").filter((line) =>
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
