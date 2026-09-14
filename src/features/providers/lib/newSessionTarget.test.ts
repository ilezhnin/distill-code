import { describe, expect, it } from "vitest";
import { resolveNewSessionTarget } from "./newSessionTarget";

const snapshot = {
  readyAgentIds: new Set(["codex-acp"]),
  catalogAgentIds: ["codex-acp"],
};

describe("resolveNewSessionTarget", () => {
  it("names an explicitly requested model by its id while the id names only a model", () => {
    expect(
      resolveNewSessionTarget(snapshot, {
        providerId: "codex-acp",
        modelId: "gpt-5.6-sol",
      }),
    ).toEqual({
      status: "ready",
      provenance: "explicit",
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol",
      modelName: "gpt-5.6-sol",
    });
  });

  it("does not present a legacy folded id as the model's name", () => {
    const result = resolveNewSessionTarget(snapshot, {
      providerId: "codex-acp",
      modelId: "gpt-5.6-sol[xhigh]",
    });

    expect(result).toMatchObject({
      status: "ready",
      modelId: "gpt-5.6-sol[xhigh]",
    });
    expect(result).not.toHaveProperty("modelName");
  });
});
