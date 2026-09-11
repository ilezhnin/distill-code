import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getMultiWorkspaceEnabled,
  MULTI_WORKSPACE_STORAGE_KEY,
  setMultiWorkspaceEnabled,
  useMultiWorkspacePreference,
} from "./multiWorkspacePreference";

describe("multiWorkspacePreference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to disabled and supports imperative reads and writes", () => {
    expect(getMultiWorkspaceEnabled()).toBe(false);

    setMultiWorkspaceEnabled(true);

    expect(getMultiWorkspaceEnabled()).toBe(true);
    expect(localStorage.getItem(MULTI_WORKSPACE_STORAGE_KEY)).toBe("true");
  });

  it("updates React subscribers after same-window changes", () => {
    const { result } = renderHook(() => useMultiWorkspacePreference());

    expect(result.current.enabled).toBe(false);

    act(() => result.current.setEnabled(true));

    expect(result.current.enabled).toBe(true);
  });

  it("updates React subscribers after cross-window changes", () => {
    const { result } = renderHook(() => useMultiWorkspacePreference());

    localStorage.setItem(MULTI_WORKSPACE_STORAGE_KEY, "true");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: MULTI_WORKSPACE_STORAGE_KEY }),
      );
    });

    expect(result.current.enabled).toBe(true);
  });
});
