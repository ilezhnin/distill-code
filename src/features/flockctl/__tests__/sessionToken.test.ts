import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetSessionTokenKeyForTests,
  sessionTokenFor,
  sessionTokensAvailable,
  verifySessionToken,
} from "@/features/flockctl/sessionToken";

beforeEach(() => {
  __resetSessionTokenKeyForTests();
});

describe("session tokens", () => {
  it("proves the session a token was made for, and no other", async () => {
    expect(await sessionTokensAvailable()).toBe(true);
    const token = await sessionTokenFor("20260913_4");
    expect(token).toMatch(/^20260913_4\.[0-9a-f]{16}$/);
    expect(await verifySessionToken(token)).toEqual({
      sessionId: "20260913_4",
    });
    // The same session is told the same token every time it asks.
    expect(await sessionTokenFor("20260913_4")).toBe(token);
    // Its digest does not carry over to another session's id.
    const digest = (token as string).slice("20260913_4".length);
    expect(await verifySessionToken(`20260913_5${digest}`)).toBeNull();
    expect(await sessionTokenFor("20260913_5")).not.toBe(`20260913_5${digest}`);
  });

  it("refuses what is not a token", async () => {
    const token = (await sessionTokenFor("conductor-1")) as string;
    for (const junk of [
      "",
      "   ",
      "conductor-1",
      "conductor-1.",
      "conductor-1.0000000000000000",
      `${token}0`,
      token.slice(0, -1),
      token.toUpperCase(),
      null,
      undefined,
    ]) {
      expect(await verifySessionToken(junk)).toBeNull();
    }
    // Padding around a real token is the caller's shell, not a forgery.
    expect(await verifySessionToken(`  ${token}\n`)).toEqual({
      sessionId: "conductor-1",
    });
  });

  it("reads an id that itself contains the separator", async () => {
    const token = await sessionTokenFor("a.b.c");
    expect(await verifySessionToken(token)).toEqual({ sessionId: "a.b.c" });
  });

  it("makes no token for no session", async () => {
    expect(await sessionTokenFor("")).toBeNull();
    expect(await sessionTokenFor("   ")).toBeNull();
  });

  it("stops accepting tokens made under another install's key", async () => {
    const token = await sessionTokenFor("conductor-1");
    __resetSessionTokenKeyForTests();
    expect(await verifySessionToken(token)).toBeNull();
    expect(await sessionTokenFor("conductor-1")).not.toBe(token);
  });
});
