import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Persona } from "@/shared/types/agents";
import { useProjectPersonas } from "./useProjectPersonas";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/agents", () => ({ listPersonas: list }));
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

it("keeps project personas scoped to the requesting chat", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  const global = [{ id: "global", displayName: "Worker" }] as Persona[];
  const local = [{ id: "local", displayName: "Worker" }] as Persona[];
  list.mockResolvedValue(local);
  const project = renderHook(() => useProjectPersonas("E:/project", global));
  const general = renderHook(() => useProjectPersonas(undefined, global));
  await waitFor(() => expect(project.result.current.ready).toBe(true));
  expect(project.result.current.personas).toBe(local);
  expect(general.result.current.personas).toBe(global);
  expect(list).toHaveBeenCalledExactlyOnceWith("E:/project");
});

it("does not expose the previous project's personas while switching projects", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  const global = [] as Persona[];
  const local = [{ id: "project-a" }] as Persona[];
  list
    .mockResolvedValueOnce(local)
    .mockImplementationOnce(() => new Promise(() => {}));
  const hook = renderHook(({ root }) => useProjectPersonas(root, global), {
    initialProps: { root: "A" },
  });
  await waitFor(() => expect(hook.result.current.personas).toBe(local));
  hook.rerender({ root: "B" });
  expect(hook.result.current.ready).toBe(false);
  expect(hook.result.current.personas).toBe(global);
});
