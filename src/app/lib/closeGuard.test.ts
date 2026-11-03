import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  onCloseRequested: vi.fn(),
  invoke: vi.fn(),
  ask: vi.fn(),
  activeChats: 0,
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
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask }));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));
vi.mock("@/shared/api/flockStore", () => ({ isDesktopRuntime: () => true }));
vi.mock("@/shared/lib/flockDocument", () => ({
  flushFlockDocuments: mocks.documents,
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
  mocks.activeChats = 0;
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "active_agent_host_chats" ? mocks.activeChats : undefined,
  );
  document.body.innerHTML = '<div id="root"></div>';
});

function shutdownCalls() {
  return mocks.invoke.mock.calls.filter(
    ([command]) => command === "prepare_agent_host_shutdown",
  );
}

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
  await vi.waitFor(() =>
    expect(document.getElementById("root")?.inert).toBe(true),
  );
  expect(shutdownCalls()).toHaveLength(0);
  saved();
  await closing;
  expect(mocks.ask).not.toHaveBeenCalled();
  expect(shutdownCalls()).toEqual([
    ["prepare_agent_host_shutdown", { prepared: true, stopChats: false }],
  ]);
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it("stops the active chats and closes once the operator confirms", async () => {
  mocks.activeChats = 2;
  mocks.ask.mockResolvedValue(true);
  await installCloseGuard();
  const event = { preventDefault: vi.fn() };
  await mocks.onCloseRequested.mock.calls[0][0](event);
  expect(mocks.ask).toHaveBeenCalledOnce();
  expect(shutdownCalls()).toEqual([
    ["prepare_agent_host_shutdown", { prepared: true, stopChats: true }],
  ]);
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it("keeps the window and its chats when the operator declines", async () => {
  mocks.activeChats = 1;
  mocks.ask.mockResolvedValue(false);
  await installCloseGuard();
  const callback = mocks.onCloseRequested.mock.calls[0][0];
  const event = { preventDefault: vi.fn() };
  await callback(event);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(shutdownCalls()).toHaveLength(0);
  expect(mocks.documents).not.toHaveBeenCalled();
  expect(document.getElementById("root")?.inert).not.toBe(true);

  mocks.ask.mockResolvedValue(true);
  const retry = { preventDefault: vi.fn() };
  await callback(retry);
  expect(retry.preventDefault).not.toHaveBeenCalled();
  expect(shutdownCalls()).toHaveLength(1);
});

it.each([
  "documents",
  "queues",
  "settings",
  "memory",
  "invoke",
] as const)("keeps the window open when %s fails and permits retry", async (kind) => {
  if (kind === "invoke") {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "active_agent_host_chats") return 0;
      if (shutdownCalls().length === 1) throw new Error("save failed");
    });
  } else {
    mocks[kind].mockRejectedValueOnce(new Error("save failed"));
  }
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
