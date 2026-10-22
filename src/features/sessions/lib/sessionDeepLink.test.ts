import { describe, expect, it } from "vitest";

import {
  SESSION_LINK_PROTOCOLS,
  createSessionDeepLink,
  parseSessionDeepLink,
} from "./sessionDeepLink";

describe("session deep links", () => {
  it("creates flock:// links", () => {
    expect(createSessionDeepLink("session-1")).toBe(
      "flock://session/session-1",
    );
    expect(createSessionDeepLink("id/with spaces?#%✓")).toBe(
      "flock://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93",
    );
  });

  it("accepts flock: first and the protocol earlier builds wrote as a second, distinct one", () => {
    // Compatibility pin: a rename sweep that rewrites the legacy protocol
    // leaves a single distinct protocol and fails here.
    expect(SESSION_LINK_PROTOCOLS[0]).toBe("flock:");
    expect(new Set(SESSION_LINK_PROTOCOLS).size).toBe(2);
    expect(
      SESSION_LINK_PROTOCOLS.filter((protocol) => !protocol.includes("flock")),
    ).toHaveLength(1);
  });

  describe.each(SESSION_LINK_PROTOCOLS)("%s links", (protocol) => {
    const scheme = protocol.slice(0, -1);

    it.each([
      [`${scheme}://session/session-1`, "session-1"],
      [`${scheme}:///session/session-1`, "session-1"],
      [
        `${scheme}://session/id%2Fwith%20spaces%3F%23%25%E2%9C%93`,
        "id/with spaces?#%✓",
      ],
      [`${scheme.toUpperCase()}://session/session-1`, "session-1"],
    ])("parses %s", (raw, sessionId) => {
      expect(parseSessionDeepLink(raw)).toBe(sessionId);
    });

    it.each([
      `${scheme}://connect-return`,
      `${scheme}:/session/session-1`,
      `${scheme}:session/session-1`,
      `${scheme}://session/`,
      `${scheme}:///session/`,
      `${scheme}://session/a/b`,
      `${scheme}://session/a//b`,
      `${scheme}://session/%FF`,
      `${scheme}://SESSION/session-1`,
      ` ${scheme}://session/session-1`,
    ])("rejects %s", (raw) => {
      expect(parseSessionDeepLink(raw)).toBeNull();
    });
  });

  it.each([
    "berd://session/session-1",
    "https://session/session-1",
    "flocks://session/session-1",
    "flock-dev://session/session-1",
  ])("rejects the foreign scheme of %s", (raw) => {
    expect(parseSessionDeepLink(raw)).toBeNull();
  });
});
