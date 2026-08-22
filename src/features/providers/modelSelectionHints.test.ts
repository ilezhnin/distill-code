import { describe, expect, it } from "vitest";
import { getProviderModelSelectionHint } from "./modelSelectionHints";

describe("getProviderModelSelectionHint", () => {
  it("does not send Grok users to the CLI for model selection", () => {
    expect(getProviderModelSelectionHint("grok-acp")).toBeNull();
  });

  it("keeps Amp on its CLI-managed model hint", () => {
    expect(getProviderModelSelectionHint("amp-acp")).toBe(
      "Use the Amp CLI to configure the model.",
    );
  });
});
