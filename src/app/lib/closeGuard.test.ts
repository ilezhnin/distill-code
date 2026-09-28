import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  invoke: vi.fn(),
  toast: vi.fn(),
  documents: vi.fn(),
  queues: vi.fn(),
  settings: vi.fn(),
  memory: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));
vi.mock("@/shared/api/distillStore", () => ({ isDesktopRuntime: () => true }));
vi.mock("@/shared/lib/distillDocument", () => ({
  flushDistillDocuments: mocks.documents,
}));
vi.mock("@/features/chat/stores/queuePersistence", () => ({
  flushMessageQueues: mocks.queues,
}));
vi.mock("@/features/stats/lib/usageLedger", () => ({
  flushUsageLedger: mocks.usage,
}));
vi.mock("@/features/memory/stores/memoryStore", () => ({
  flushMemoryWrites: mocks.memory,
}));
vi.mock("@/shared/preferences/rootSettings", () => ({
  flushRootSettings: mocks.settings,
}));
import { installCloseGuard } from "./closeGuard";

beforeEach(() => {
  vi.resetAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
});

it("waits for renderer saves before asking the host to finish shutdown", async () => {
  let saved: () => void = () => {};
  mocks.documents.mockReturnValue(
    new Promise<void>((resolve) => {
      saved = resolve;
    }),
  );
  await installCloseGuard();
  const event = { preventDefault: vi.fn() };
  const closing = mocks.onCloseRequested.mock.calls[0][0](event);
  await Promise.resolve();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(document.getElementById("root")?.inert).toBe(true);
  saved();
  await closing;
  expect(mocks.invoke).toHaveBeenCalledWith("prepare_agent_host_shutdown", {
    prepared: true,
  });
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it.each([
  "documents",
  "queues",
  "settings",
  "memory",
  "invoke",
] as const)("keeps the window open when %s fails and permits retry", async (kind) => {
  mocks[kind].mockRejectedValueOnce(new Error("save failed"));
  await installCloseGuard();
  const callback = mocks.onCloseRequested.mock.calls[0][0];
  const first = { preventDefault: vi.fn() };
  await callback(first);
  expect(first.preventDefault).toHaveBeenCalled();
  expect(document.getElementById("root")?.inert).toBe(false);
  expect(mocks.toast).toHaveBeenCalled();
  const retry = { preventDefault: vi.fn() };
  await callback(retry);
  expect(retry.preventDefault).not.toHaveBeenCalled();
});
