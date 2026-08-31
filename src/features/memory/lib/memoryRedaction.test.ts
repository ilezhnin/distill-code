/**
 * Every shape memory refuses, and the ordinary sentences it must not.
 *
 * None of the values below is a credential: each is a known prefix followed
 * by a run of placeholder characters, built with `repeat` so it is obvious at
 * a glance that there is nothing here to leak. A fixture that looked like a
 * real key would be the same mistake the module exists to prevent — it would
 * live in the repository, in every clone of it, forever.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { MemoryFenceRequest } from "../lib/memoryFence";
import { useMemoryStore } from "../stores/memoryStore";
import { findSecret } from "./memoryRedaction";

/** A placeholder run of the given length, never a real value. */
function filler(length: number, char = "A"): string {
  return char.repeat(length);
}

describe("findSecret", () => {
  it("refuses a private key header", () => {
    expect(findSecret("Deploy key: -----BEGIN RSA PRIVATE KEY-----")).toBe(
      "private-key",
    );
    expect(findSecret("-----BEGIN PRIVATE KEY-----")).toBe("private-key");
  });

  it("refuses an AWS access key id", () => {
    expect(findSecret(`The account key is AKIA${filler(16, "Q")}`)).toBe(
      "aws-key",
    );
  });

  it("refuses both GitHub token shapes", () => {
    expect(findSecret(`ghp_${filler(36)}`)).toBe("github-token");
    expect(findSecret(`github_pat_${filler(24, "B")}`)).toBe("github-token");
  });

  it("refuses a Slack token", () => {
    expect(findSecret(`xoxb-${filler(12, "C")}`)).toBe("slack-token");
    expect(findSecret(`xoxp-${filler(12, "C")}`)).toBe("slack-token");
  });

  it("refuses a provider key", () => {
    expect(findSecret(`sk-${filler(24, "D")}`)).toBe("provider-key");
  });

  it("refuses a JWT", () => {
    expect(
      findSecret(`eyJ${filler(12, "E")}.${filler(12, "F")}.${filler(8, "G")}`),
    ).toBe("jwt");
  });

  it("refuses an assignment that carries a value", () => {
    expect(findSecret(`password: ${filler(12, "P")}`)).toBe(
      "password-assignment",
    );
    expect(findSecret(`API_KEY=${filler(12, "K")}`)).toBe(
      "password-assignment",
    );
    expect(findSecret(`pwd = "${filler(10, "W")}"`)).toBe(
      "password-assignment",
    );
  });

  it("refuses credentials inside a URL", () => {
    expect(
      findSecret(
        `Clone from https://operator:${filler(10, "U")}@git.internal/repo`,
      ),
    ).toBe("url-credentials");
  });

  it("refuses a long hex run", () => {
    expect(findSecret(`The digest is ${"a1".repeat(20)}`)).toBe("long-hex");
  });

  it("refuses a long base64 run", () => {
    // 64 characters of base64 alphabet that is not also hex, so this is the
    // base64 rule and not the hex one above it.
    expect(findSecret("Zm9vYmFy".repeat(8))).toBe("long-base64");
  });

  it("names the first shape that matches, not the widest", () => {
    // Both an assignment and a 40-character hex run; the assignment is
    // earlier in the list, so that is what the operator is told.
    expect(findSecret(`token: ${"a1".repeat(20)}`)).toBe("password-assignment");
  });

  describe("statements that are not secrets", () => {
    it.each([
      ["a token bucket", "The token bucket refills at 200 requests a minute"],
      ["a short hex", "The failing commit is deadbee"],
      ["the word password alone", "The password policy changed last quarter"],
      ["a short base64 run", `Fixture body is ${"Zm9vYmFy".repeat(5)}`],
      ["an ordinary fact", "Ivan reviews Rust changes himself"],
      ["a short sk- word", "The ticket is sk-14 in the tracker"],
      [
        "an https URL with no credentials",
        "Docs live at https://berd.dev/docs",
      ],
    ])("keeps %s", (_label, text) => {
      expect(findSecret(text)).toBeNull();
    });
  });
});

/**
 * The store's half of the same law, tested here because `memoryStore.test.ts`
 * belongs to another step's file zone. What matters is the refusal itself:
 * nothing stored, and nothing stored in an edited form either.
 */
describe("the store refuses a statement that carries a secret", () => {
  const NOW = new Date(2026, 7, 31, 9, 0).getTime();

  function request(overrides: Partial<MemoryFenceRequest> = {}) {
    return { remember: [], forget: [], ...overrides };
  }

  beforeEach(() => {
    window.localStorage.clear();
    useMemoryStore.setState({
      entries: [],
      archived: [],
      appliedMessageIds: [],
      hydrated: true,
    });
  });

  it("keeps nothing the operator types by hand", () => {
    const id = useMemoryStore
      .getState()
      .remember({ text: `AWS key AKIA${filler(16, "Q")}`, scope: "global" });

    expect(id).toBe("");
    expect(useMemoryStore.getState().entries).toHaveLength(0);
    expect(useMemoryStore.getState().archived).toHaveLength(0);
  });

  it("skips the refused item of a fence and keeps the safe one", () => {
    const result = useMemoryStore.getState().applyAgentRequest(
      "m-1",
      "s-1",
      "p-1",
      request({
        remember: [
          { text: `sk-${filler(24, "D")}`, scope: "global" },
          { text: "The release branch is release/2026.9", scope: "global" },
        ],
      }),
      NOW,
    );

    expect(result.remembered).toBe(1);
    const { entries } = useMemoryStore.getState();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("The release branch is release/2026.9");
  });

  it("stores no edited version of what it refused", () => {
    useMemoryStore.getState().applyAgentRequest(
      "m-1",
      "s-1",
      "p-1",
      request({
        remember: [
          { text: `The deploy token is ghp_${filler(36)}`, scope: "global" },
        ],
      }),
      NOW,
    );

    const state = useMemoryStore.getState();
    expect(state.entries).toHaveLength(0);
    expect(state.archived).toHaveLength(0);
    // Read once and done: a message whose only item was refused is still
    // tombstoned, or the scanner would re-refuse it on every store change.
    expect(state.appliedMessageIds).toContain("m-1");
  });

  it("keeps the line a refused correction was meant to replace", () => {
    useMemoryStore
      .getState()
      .remember({ text: "The old fact", scope: "global" }, NOW);

    useMemoryStore.getState().applyAgentRequest(
      "m-2",
      "s-1",
      "p-1",
      request({
        forget: ["The old fact"],
        remember: [{ text: `AKIA${filler(16, "Q")}`, scope: "global" }],
      }),
      NOW + 1,
    );

    // Refusing the secret must not cost the operator the fact it was offered
    // as a correction to: a correction is one statement restated, so the
    // retirement is refused with the replacement rather than left to run on
    // its own and take the line with it.
    const state = useMemoryStore.getState();
    expect(state.entries.map((e) => e.text)).toEqual(["The old fact"]);
    expect(state.archived).toEqual([]);
  });
});
