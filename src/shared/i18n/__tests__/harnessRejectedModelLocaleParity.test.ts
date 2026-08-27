import { describe, expect, it } from "vitest";
import enChat from "../locales/en/chat.json";
import esChat from "../locales/es/chat.json";

describe("harness-rejected-model locale parity", () => {
  it("provides translated Spanish copy for the recovery card", () => {
    expect(esChat.errors.harnessRejectedModel).toBeTruthy();
    expect(esChat.errors.harnessRejectedModel).not.toBe(
      enChat.errors.harnessRejectedModel,
    );
  });

  // The card is the only thing standing between the operator and a chat that
  // fails forever, so it has to carry the model that was refused, the harness
  // that refused it, and where to choose another one.
  it("keeps every fact the operator needs in both locales", () => {
    for (const copy of [
      enChat.errors.harnessRejectedModel,
      esChat.errors.harnessRejectedModel,
    ]) {
      expect(copy).toContain("{{model}}");
      expect(copy).toContain("{{harness}}");
    }
  });
});
