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

// Its pre-send twin, shown when the pin is refused while the session is being
// configured rather than when a message fails.
describe("harness-undeclared-model locale parity", () => {
  it("provides translated Spanish copy for the pre-send card", () => {
    expect(esChat.errors.harnessUndeclaredModel).toBeTruthy();
    expect(esChat.errors.harnessUndeclaredModel).not.toBe(
      enChat.errors.harnessUndeclaredModel,
    );
  });

  it("keeps every fact the operator needs in both locales", () => {
    for (const copy of [
      enChat.errors.harnessUndeclaredModel,
      esChat.errors.harnessUndeclaredModel,
    ]) {
      expect(copy).toContain("{{model}}");
      expect(copy).toContain("{{harness}}");
    }
  });

  // Two different situations: one says a message did not go out, the other
  // says a model was never applied. Reusing one string for both would tell the
  // operator their message was lost when nothing was sent yet.
  it("does not reuse the post-send wording", () => {
    expect(enChat.errors.harnessUndeclaredModel).not.toBe(
      enChat.errors.harnessRejectedModel,
    );
  });
});
