import { beforeEach, describe, expect, it, vi } from "vitest";
import { executorSelection } from "@/features/benchmarks/lib/executorSelection";
import type { Persona } from "@/shared/types/agents";
import { previewChatExecutor } from "./chatExecutorSuggestion";

vi.mock("@/features/benchmarks/lib/executorSelection", () => ({
  executorSelection: { select: vi.fn(async () => null) },
}));
beforeEach(() => vi.clearAllMocks());

function input(): Parameters<typeof previewChatExecutor>[0] {
  return {
    contextId: "example-chat",
    prompt: "Inspect this example.",
    pinned: false,
    persona: {
      id: "example-role",
      displayName: "Example",
      systemPrompt: "Check the supplied facts.",
      isBuiltin: false,
      writable: true,
      modelRanking: JSON.stringify({
        version: 1,
        entries: [
          {
            platform: "claude-acp",
            modelId: "alpha",
            label: "Alpha",
            effort: "high",
          },
          {
            platform: "codex-acp",
            modelId: "beta",
            label: "Beta",
            effort: "low",
          },
        ],
      }),
    } satisfies Persona,
    current: {
      target: {
        harnessId: "codex-acp",
        modelProviderId: "codex-acp",
        modelId: "beta",
        modelName: "Beta",
      },
      runSettings: { effort: "low", fast: false },
    },
    context: {
      providers: [{ id: "claude-acp" }, { id: "codex-acp" }],
      rateLimits: [],
      getModelsForHarness: (id) => [
        {
          id: id === "claude-acp" ? "alpha" : "beta",
          providerId: id,
          efforts: [
            { id: "high", name: "High" },
            { id: "low", name: "Low" },
          ],
        },
      ],
    },
  };
}

describe("chat executor preview", () => {
  it("uses the same native selection boundary read-only with draft and role features", async () => {
    await previewChatExecutor(input());
    expect(executorSelection.select).toHaveBeenCalledOnce();
    const [request, record] = vi.mocked(executorSelection.select).mock.calls[0];
    expect(record).toBe(false);
    expect(request).toMatchObject({
      surface: "chat",
      contextId: "example-chat",
      hardCandidateId: null,
      task: {
        prompt: "Inspect this example.",
        roleId: "example-role",
        rolePrompt: "Check the supplied facts.",
        executionProfile: "interactive_acp",
      },
    });
    expect(
      request.candidates.map((row) => [
        row.configuration.modelId,
        row.configuration.effort,
      ]),
    ).toEqual([
      ["alpha", "high"],
      ["beta", "low"],
    ]);
    expect(request.priorIds).toEqual(
      request.candidates.map((row) => row.configuration.id),
    );
  });

  it("keeps a pin even when its model is absent, without promoting a different prior", async () => {
    const request = input();
    request.pinned = true;
    request.context.getModelsForHarness = (id) =>
      id === "claude-acp" ? [{ id: "alpha", providerId: id }] : [];
    await previewChatExecutor(request);
    const [native] = vi.mocked(executorSelection.select).mock.calls[0];
    expect(native.candidates[0]).toMatchObject({
      available: false,
      configuration: { modelId: "beta", effort: "low", fastMode: false },
    });
    expect(native.hardCandidateId).toBe(native.candidates[0].configuration.id);
    expect(
      native.candidates.some(
        (row) => row.available && row.configuration.modelId === "alpha",
      ),
    ).toBe(true);
  });

  it("uses the selected account inventory instead of another account's cached menu", async () => {
    await previewChatExecutor({
      ...input(),
      pinned: true,
      inventory: {
        harnessId: "codex-acp",
        accountId: "example-account",
        models: [],
      },
    });
    const [native] = vi.mocked(executorSelection.select).mock.calls[0];
    expect(native.candidates[0]).toMatchObject({
      available: false,
      configuration: { accountId: "example-account", modelId: "beta" },
    });
  });

  it("does not infer a pin for a different provider with the same model id", async () => {
    const request = input();
    request.pinned = true;
    request.inventory = {
      harnessId: "codex-acp",
      accountId: "example-account",
      models: [{ id: "beta", name: "Beta", providerId: "different-provider" }],
    };
    await previewChatExecutor(request);
    expect(
      vi.mocked(executorSelection.select).mock.calls[0][0].candidates[0]
        .available,
    ).toBe(false);
  });

  it("does not query on an empty draft or substitute another model for a provider-only pin", async () => {
    expect(await previewChatExecutor({ ...input(), prompt: " " })).toBeNull();
    expect(
      await previewChatExecutor({
        ...input(),
        pinned: true,
        current: { target: { harnessId: "codex-acp" } },
      }),
    ).toBeNull();
    expect(executorSelection.select).not.toHaveBeenCalled();
  });

  it("returns service errors without applying a local replacement decision", async () => {
    vi.mocked(executorSelection.select).mockRejectedValueOnce(
      new Error("local store unavailable"),
    );
    await expect(previewChatExecutor(input())).rejects.toThrow(
      "local store unavailable",
    );
    expect(executorSelection.select).toHaveBeenCalledOnce();
  });
});
