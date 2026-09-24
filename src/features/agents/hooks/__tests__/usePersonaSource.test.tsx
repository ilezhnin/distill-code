import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const readSourceMock = vi.fn();
const updateMock = vi.fn();
const createMock = vi.fn();

vi.mock("@/shared/api/agents", () => ({
  createPersonaSource: (request: unknown) => createMock(request),
  listPersonaSources: () => listMock(),
  readAgentSourceFile: (path: string, fallback: unknown) =>
    readSourceMock(path, fallback),
  updatePersonaSource: (path: string, patch: unknown) =>
    updateMock(path, patch),
}));

import { resetAgentBuilderSourceLifecycleForTests } from "@/features/agents/lib/agentBuilderSourceLifecycle";
import { usePersonaSource } from "../usePersonaSource";

const path = "/Users/x/.agents/agents/draft-1.md";

const sourceV1 = {
  type: "agent",
  path,
  name: "Untitled agent",
  description: "Draft",
  content: "Draft in progress.",
  properties: { draft: true },
  writable: true,
};

const sessionPlaceholderSource = {
  ...sourceV1,
  name: "Untitled agent sess-1",
  properties: { draft: true, builderSessionId: "sess-1" },
};

let documentHasFocus = true;
let hasFocusSpy: ReturnType<typeof vi.spyOn> | null = null;

function setDocumentVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("usePersonaSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    documentHasFocus = true;
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockImplementation(() => {
      return documentHasFocus;
    });
    setDocumentVisibility("visible");
    listMock.mockReset();
    readSourceMock.mockReset();
    readSourceMock.mockImplementation(
      async (_path: string, fallback: unknown) => fallback,
    );
    updateMock.mockReset();
    createMock.mockReset();
    resetAgentBuilderSourceLifecycleForTests();
  });

  afterEach(() => {
    hasFocusSpy?.mockRestore();
    hasFocusSpy = null;
    vi.useRealTimers();
  });

  it("does not auto-save existing agent builder edits before saveNow", async () => {
    const existingSource = {
      ...sourceV1,
      name: "Code Reviewer",
      content: "Review code carefully.",
      properties: {},
    };
    listMock.mockResolvedValue([existingSource]);
    updateMock.mockResolvedValue({
      ...existingSource,
      name: "Code Reviewer Deluxe",
    });
    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => result.current.update({ name: "Code Reviewer Deluxe" }));
    expect(result.current.data?.name).toBe("Code Reviewer Deluxe");

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.saveNow();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(path, {
      name: "Code Reviewer Deluxe",
    });
  });

  it("drops a pending debounced save when the source path changes", async () => {
    const secondPath = "/Users/x/.agents/agents/draft-2.md";
    const sourceB = { ...sourceV1, path: secondPath, name: "Second" };
    listMock.mockResolvedValue([sourceV1, sourceB]);

    const { result, rerender } = renderHook(
      ({ sourcePath }) => usePersonaSource(sourcePath),
      { initialProps: { sourcePath: path } },
    );
    await flushPromises();

    act(() => result.current.update({ name: "Unsaved" }));
    rerender({ sourcePath: secondPath });

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateMock).not.toHaveBeenCalled();
    expect(result.current.data?.path).toBe(secondPath);
  });

  it("keeps newer local edits when an older save completes", async () => {
    const firstSave = deferred<typeof sourceV1>();
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockReturnValueOnce(firstSave.promise);
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    act(() => result.current.update({ name: "Sna" }));
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    act(() => result.current.update({ name: "Snark" }));
    expect(result.current.data?.name).toBe("Snark");

    await act(async () => {
      firstSave.resolve({ ...sourceV1, name: "Sna" });
      await firstSave.promise;
    });

    expect(result.current.data?.name).toBe("Snark");
    expect(result.current.saveStatus).toBe("unsaved");
  });

  it("uses the on-disk draft contents when source listing is stale", async () => {
    const diskSource = {
      ...sourceV1,
      name: "Constructive Critic",
      description: "Challenges assumptions.",
      content: "Push back constructively.",
      properties: { draft: true, builderSessionId: "sess-1" },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(diskSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(readSourceMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ name: "Untitled agent sess-1" }),
    );
    expect(result.current.data?.name).toBe("Constructive Critic");
    expect(result.current.data?.content).toBe("Push back constructively.");
  });

  it("keeps a newer avatar choice when an older avatar save reaches disk", async () => {
    const firstSave = deferred<typeof sourceV1>();
    const defaultAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-1",
      },
    };
    const selectedAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-2",
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(selectedAvatarSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-1" },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(updateMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-2" },
      });
    });
    expect(result.current.data?.properties?.avatar).toBe(
      "app-avatar:gloopies-2",
    );

    listMock.mockResolvedValue([defaultAvatarSource]);
    readSourceMock.mockResolvedValue(defaultAvatarSource);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(result.current.data?.properties?.avatar).toBe(
      "app-avatar:gloopies-2",
    );

    await act(async () => {
      firstSave.resolve(defaultAvatarSource);
      await firstSave.promise;
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining({
          avatar: "app-avatar:gloopies-2",
        }),
      }),
    );
  });

  it("saveNow waits for queued avatar changes before returning", async () => {
    const firstSave = deferred<typeof sourceV1>();
    const defaultAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-1",
      },
    };
    const selectedAvatarSource = {
      ...sessionPlaceholderSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        avatar: "app-avatar:gloopies-2",
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(selectedAvatarSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-1" },
      });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    act(() => {
      result.current.update({
        properties: { avatar: "app-avatar:gloopies-2" },
      });
    });

    let saveResolved = false;
    let savePromise!: Promise<void>;
    await act(async () => {
      savePromise = result.current.saveNow().then(() => {
        saveResolved = true;
      });
      await Promise.resolve();
    });

    expect(saveResolved).toBe(false);
    expect(updateMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve(defaultAvatarSource);
      await firstSave.promise;
      await savePromise;
    });

    expect(saveResolved).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining({
          avatar: "app-avatar:gloopies-2",
        }),
      }),
    );
    expect(result.current.data?.properties?.avatar).toBe(
      "app-avatar:gloopies-2",
    );
  });

  it("saveNow returns false and keeps edits queued when the flush fails", async () => {
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockRejectedValue(new Error("write failed"));
    const { result } = renderHook(() => usePersonaSource(path));
    await flushPromises();

    act(() => {
      result.current.update({ name: "Snark" });
    });

    let saved = true;
    await act(async () => {
      saved = await result.current.saveNow();
    });

    expect(saved).toBe(false);
    expect(result.current.saveStatus).toBe("error");
    expect(result.current.data?.name).toBe("Snark");
  });

  it("contains a throwing onWritePersisted observer without re-queuing the persisted write", async () => {
    const persistedSource = { ...sourceV1, name: "Snark" };
    listMock.mockResolvedValue([sourceV1]);
    updateMock.mockResolvedValue(persistedSource);
    const onWritePersisted = vi.fn(() => {
      throw new Error("observer exploded");
    });

    const { result } = renderHook(() =>
      usePersonaSource(path, { onWritePersisted }),
    );
    await flushPromises();

    act(() => result.current.update({ name: "Snark" }));

    let saved = false;
    await act(async () => {
      saved = await result.current.saveNow();
    });

    expect(saved).toBe(true);
    expect(onWritePersisted).toHaveBeenCalledTimes(1);
    expect(result.current.saveStatus).toBe("saved");
    expect(updateMock).toHaveBeenCalledTimes(1);

    // Nothing was merged back into the pending patch: a follow-up flush
    // finds no work, so the durable write is not repeated (and the observer
    // does not hear a second persisted edit).
    await act(async () => {
      saved = await result.current.saveNow();
    });
    expect(saved).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(onWritePersisted).toHaveBeenCalledTimes(1);
  });

  it("preserves local model and avatar choices when the agent updates text fields", async () => {
    const firstSave = deferred<unknown>();
    const localChoices = {
      provider: "goose",
      model: "databricks-gpt-5-2-codex",
      avatar: "app-avatar:gloopies-15",
    };
    const externalSource = {
      ...sourceV1,
      name: "Project Manager",
      content: "Keep projects clear and moving.",
      properties: { draft: true, builderSessionId: "sess-1" },
    };
    const savedChoicesSource = {
      ...externalSource,
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        ...localChoices,
      },
    };
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockResolvedValue(sessionPlaceholderSource);
    updateMock
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce(savedChoicesSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    act(() => {
      result.current.update({ properties: localChoices });
    });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    expect(updateMock).toHaveBeenCalledTimes(1);

    listMock.mockResolvedValue([externalSource]);
    readSourceMock.mockResolvedValue(externalSource);
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Untitled agent sess-1");
    expect(result.current.data?.properties).toEqual(
      expect.objectContaining(localChoices),
    );

    await act(async () => {
      firstSave.resolve({
        ...sessionPlaceholderSource,
        properties: {
          draft: true,
          builderSessionId: "sess-1",
          ...localChoices,
        },
      });
      await firstSave.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.data?.name).toBe("Project Manager");
    expect(result.current.data?.content).toBe(
      "Keep projects clear and moving.",
    );
    expect(result.current.data?.properties).toEqual(
      expect.objectContaining(localChoices),
    );

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock).toHaveBeenLastCalledWith(
      path,
      expect.objectContaining({
        properties: expect.objectContaining(localChoices),
      }),
    );
    expect(result.current.data?.name).toBe("Project Manager");
    expect(result.current.data?.properties).toEqual(
      expect.objectContaining(localChoices),
    );
  });

  it("uses the exact draft file when source listing omits a duplicate-name draft", async () => {
    const diskSource = {
      ...sourceV1,
      name: "Constructive Critic",
      description: "Challenges assumptions.",
      content: "Push back constructively.",
      properties: { draft: true, builderSessionId: "sess-1" },
    };
    listMock.mockResolvedValue([]);
    readSourceMock.mockResolvedValue(diskSource);

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(readSourceMock).toHaveBeenCalledWith(path, undefined);
    expect(result.current.data?.name).toBe("Constructive Critic");
    expect(result.current.data?.description).toBe("Challenges assumptions.");
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it("keeps the listed draft when the fresh draft file read fails", async () => {
    listMock.mockResolvedValue([sessionPlaceholderSource]);
    readSourceMock.mockRejectedValue(new Error("command unavailable"));

    const { result } = renderHook(() =>
      usePersonaSource(path, { builderSessionId: "sess-1" }),
    );
    await flushPromises();

    expect(readSourceMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ name: "Untitled agent sess-1" }),
    );
    expect(result.current.error).toBeNull();
    expect(result.current.data).toMatchObject({
      path,
      name: "Untitled agent sess-1",
    });
  });
});
