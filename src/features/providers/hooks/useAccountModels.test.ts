import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const models = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({ host: { providersSupportedModelsList: models } }),
}));
import { useAccountModels } from "./useAccountModels";

describe("account model inventories", () => {
  it("never lends the previous account's models to the newly selected account", async () => {
    models.mockResolvedValueOnce({
      models: [{ id: "first-model", name: "First" }],
    });
    const { result, rerender } = renderHook(
      ({ id }) => useAccountModels("codex-acp", id, 1, true),
      { initialProps: { id: "account-model-test-first" } },
    );
    await waitFor(() =>
      expect(result.current.models?.[0]?.id).toBe("first-model"),
    );
    let resolve: (value: unknown) => void = () => {};
    models.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    rerender({ id: "account-model-test-second" });
    expect(result.current.models).toEqual([]);
    resolve({ models: [{ id: "second-model", name: "Second" }] });
    await waitFor(() =>
      expect(result.current.models?.[0]?.id).toBe("second-model"),
    );
    expect(models).toHaveBeenLastCalledWith({
      providerId: "codex-acp",
      accountId: "account-model-test-second",
    });
  });
});
