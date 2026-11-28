import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useProviderModelCacheStore } from "../stores/providerModelCacheStore";

const models = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({ host: { providersSupportedModelsList: models } }),
}));
import { useAccountModels } from "./useAccountModels";

describe("account model inventories", () => {
  it("drops cached and pending inventories when the same CLI account signs in again", async () => {
    const providerId = "antigravity-acp";
    const accountId = "cli-login-antigravity-acp";
    const inventory = (id: string) => ({ models: [{ id, name: id }] });
    const forget = () =>
      useProviderModelCacheStore
        .getState()
        .invalidateProvider(providerId, { forget: true });
    models.mockResolvedValueOnce(inventory("old"));
    const { result } = renderHook(() =>
      useAccountModels(providerId, accountId, 0, true),
    );
    await waitFor(() => expect(result.current.models?.[0]?.id).toBe("old"));
    let finish: (value: unknown) => void = () => {};
    models.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    act(forget);
    expect(result.current.models).toEqual([]);
    await waitFor(() => expect(models).toHaveBeenCalledTimes(2));
    models.mockResolvedValueOnce(inventory("current"));
    act(forget);
    await waitFor(() => expect(result.current.models?.[0]?.id).toBe("current"));
    await act(async () => finish(inventory("obsolete")));
    expect(result.current.models?.[0]?.id).toBe("current");
  });
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
