import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureReplayBuffer } from "@/features/chat/hooks/replayBuffer";
import {
  clearReplayAssistantTracking,
  ensureReplayAssistantMessage,
} from "@/features/chat/acp/acpReplayAssistant";
import { handleSessionInfoUpdate } from "@/features/chat/acp/acpSessionInfoUpdate";
import {
  loadSessionMessages,
  loadSessionMessagesAndPrepare,
} from "@/features/chat/lib/sessionActivation";
import { DEFAULT_CHAT_TITLE } from "@/features/chat/lib/sessionTitle";
import { interruptedTurnNoticeId } from "@/features/chat/lib/unansweredSend";
import { useChatStore } from "@/features/chat/stores/chatStore";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import type { ProjectInfo } from "@/features/projects/api/projects";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import {
  createUserMessage,
  type Message,
  type SystemNotificationContent,
} from "@/shared/types/messages";
import type { AcpSessionInfo } from "@/shared/api/acp";
import {
  acquireSessionDispatchTarget,
  resetSessionTargetCoordinatorsForTests,
} from "@/features/chat/lib/sessionTargetCoordinator";

const acpGetSessionInfo = vi.hoisted(() => vi.fn());
const acpLoadSession = vi.hoisted(() => vi.fn());
const acpPrepareSession = vi.hoisted(() => vi.fn());
const resolvePath = vi.hoisted(() => vi.fn());
const checkDirectoriesExist = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api/acp", () => ({
  acpGetSessionInfo: (...args: unknown[]) => acpGetSessionInfo(...args),
  acpLoadSession: (...args: unknown[]) => acpLoadSession(...args),
  acpPrepareSession: (...args: unknown[]) => acpPrepareSession(...args),
}));

vi.mock("@/shared/api/pathResolver", () => ({
  resolvePath: (...args: unknown[]) => resolvePath(...args),
  checkDirectoriesExist: (...args: unknown[]) => checkDirectoriesExist(...args),
}));

vi.mock("@/features/chat/acp/acpNotificationHandler", () => ({
  getReplayPerf: () => undefined,
  clearReplayPerf: vi.fn(),
}));

function replayUserMessage(id = "m1"): Message {
  return { ...createUserMessage("hello"), id };
}

interface SeedOptions {
  project?: ProjectInfo;
  workspacePath?: string;
  missingDir?: string;
  replay?: boolean;
}

function seedSession(
  overrides: Partial<ChatSession>,
  { project, workspacePath, missingDir, replay = true }: SeedOptions = {},
): ChatSession {
  const session: ChatSession = {
    id: "s1",
    title: DEFAULT_CHAT_TITLE,
    projectId: project?.id ?? null,
    executionTarget: { harnessId: "claude-acp" },
    workingDir: null,
    createdAt: "2026-06-09T00:00:00.000Z",
    updatedAt: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    ...overrides,
  };
  useChatSessionStore.setState({
    sessions: [session],
    ...(workspacePath
      ? {
          activeWorkspaceBySession: {
            [session.id]: { path: workspacePath, branch: null },
          },
        }
      : {}),
  });
  if (project) {
    useProjectStore.setState({ projects: [project] });
  }
  if (replay) {
    ensureReplayBuffer(session.id).push(replayUserMessage());
  }
  if (missingDir) {
    checkDirectoriesExist.mockResolvedValue([missingDir]);
  }
  return session;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function messagesFor(sessionId: string): Message[] {
  // The interrupted-turn notice is written by every load whose transcript
  // ends on the operator, which most of these fixtures do — they are about
  // cwd resolution and replay, not about that notice, and it has its own
  // cases below. Filtered here so each assertion still reads as what the
  // load produced for the thing it is testing.
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).filter(
    (message) => message.id !== interruptedTurnNoticeId(sessionId),
  );
}

function notificationFromLastMessage(
  sessionId: string,
): SystemNotificationContent {
  const last = messagesFor(sessionId).at(-1);
  expect(last?.role).toBe("system");
  const notification = last?.content[0];
  expect(notification?.type).toBe("systemNotification");
  return notification as SystemNotificationContent;
}

describe("loadSessionMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionTargetCoordinatorsForTests();
    clearReplayAssistantTracking();
    window.localStorage.clear();
    acpGetSessionInfo.mockResolvedValue(null);
    acpLoadSession.mockResolvedValue(undefined);
    acpPrepareSession.mockResolvedValue(undefined);
    resolvePath.mockImplementation(({ parts }: { parts: string[] }) =>
      Promise.resolve({ path: `/resolved${parts[0]}` }),
    );
    checkDirectoriesExist.mockResolvedValue([]);
    useChatStore.setState({
      messagesBySession: {},
      sessionStateById: {},
      loadingSessionIds: new Set(),
    });
    useChatSessionStore.setState({
      sessions: [],
      activeWorkspaceBySession: {},
    });
    useProjectStore.setState({ projects: [] });
  });

  it("uses the leased target when ACP load returns a divergent target", async () => {
    const targetA = {
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "a",
      modelName: "a",
    } as const;
    const targetB = {
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "b",
      modelName: "b",
    } as const;
    seedSession({
      id: "leased-load",
      executionTarget: targetA,
      executionTargetSource: "acp",
    });
    acpLoadSession.mockResolvedValue({
      providerId: "claude-acp",
      modelId: "b",
    });
    const lease = acquireSessionDispatchTarget("leased-load");

    await expect(loadSessionMessages("leased-load")).resolves.toBe(true);

    expect(acpPrepareSession).not.toHaveBeenCalled();
    expect(
      useChatSessionStore.getState().getSession("leased-load")?.executionTarget,
    ).toEqual(targetA);
    lease.release?.();
    expect(
      useChatSessionStore.getState().getSession("leased-load")?.executionTarget,
    ).toEqual(targetB);
  });

  it("preserves a populated transcript when a forced replay is invalid", async () => {
    seedSession(
      { id: "empty-forced-replay", messageCount: 2 },
      { replay: false },
    );
    useChatStore
      .getState()
      .setMessages("empty-forced-replay", [replayUserMessage("existing-1")]);
    ensureReplayBuffer("empty-forced-replay");

    await expect(
      loadSessionMessages("empty-forced-replay", { force: true }),
    ).resolves.toBe(false);

    expect(
      messagesFor("empty-forced-replay").map((message) => message.id),
    ).toEqual(["existing-1", "session-load-error:empty-forced-replay"]);
    expect(notificationFromLastMessage("empty-forced-replay")).toMatchObject({
      notificationType: "error",
      text: "Couldn't refresh this conversation. Your previous messages are still shown.",
    });
    expect(
      useChatSessionStore.getState().getSession("empty-forced-replay")
        ?.messageCount,
    ).toBe(2);
    expect(
      useChatStore.getState().loadingSessionIds.has("empty-forced-replay"),
    ).toBe(false);
  });

  it("rejects an empty cold replay when session metadata expects history", async () => {
    seedSession(
      { id: "cold-empty-replay", messageCount: 3 },
      { replay: false },
    );
    ensureReplayBuffer("cold-empty-replay");

    await expect(loadSessionMessages("cold-empty-replay")).resolves.toBe(false);

    expect(notificationFromLastMessage("cold-empty-replay")).toMatchObject({
      notificationType: "error",
    });
    expect(
      useChatSessionStore.getState().getSession("cold-empty-replay")
        ?.messageCount,
    ).toBe(3);
  });

  it("waits for an affirmative run boundary before completing replay", async () => {
    const sessionId = "active-replay";
    seedSession({ id: sessionId }, { replay: false });
    ensureReplayAssistantMessage(sessionId, "assistant-1").content.push({
      type: "text",
      text: "Still working",
    });

    await expect(loadSessionMessages(sessionId)).resolves.toBe(true);

    handleSessionInfoUpdate(sessionId, {
      sessionUpdate: "session_info_update",
      _meta: { activeRunId: "run-1" },
    } as never);
    expect(messagesFor(sessionId)[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "inProgress" },
    });

    handleSessionInfoUpdate(sessionId, {
      sessionUpdate: "session_info_update",
      _meta: { activeRunId: null },
    } as never);
    expect(messagesFor(sessionId)[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "completed" },
    });
  });

  // The listed value can be a refresh interval old; a run this renderer
  // started since then is the newer fact.
  it("keeps the reply in progress when the renderer's own run outranks the listed one", async () => {
    seedSession(
      { id: "listed-stale-replay", activeRunId: null },
      { replay: false },
    );
    useChatStore.getState().setActiveRunId("listed-stale-replay", "run-2");
    ensureReplayAssistantMessage(
      "listed-stale-replay",
      "assistant-1",
    ).content.push({ type: "text", text: "Still working" });

    await expect(loadSessionMessages("listed-stale-replay")).resolves.toBe(
      true,
    );

    expect(messagesFor("listed-stale-replay")[0]).toMatchObject({
      role: "assistant",
      metadata: { completionStatus: "inProgress" },
    });
  });

  it("reasserts a UI selection changed while cwd resolution delayed ACP load", async () => {
    const cwdCheck = deferred<string[]>();
    checkDirectoriesExist.mockReturnValueOnce(cwdCheck.promise);
    seedSession({
      id: "s-selection-race",
      executionTarget: {
        harnessId: "claude-acp",
        modelProviderId: "claude-acp",
        modelId: "goose-gpt-5-5",
        modelName: "GPT-5.5",
      },
      workingDir: "/existing/session",
    });

    const load = loadSessionMessagesAndPrepare("s-selection-race");
    await vi.waitFor(() => {
      expect(checkDirectoriesExist).toHaveBeenCalledTimes(1);
    });
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s-selection-race", {
        harnessId: "claude-acp",
        modelProviderId: "claude-acp",
        modelId: "goose-gpt-5-6-sol",
        modelName: "GPT-5.6 Sol",
      });
    expect(acpLoadSession).not.toHaveBeenCalled();

    cwdCheck.resolve([]);
    await expect(load).resolves.toBe(true);

    expect(acpLoadSession).toHaveBeenCalledWith(
      "s-selection-race",
      "/resolved/existing/session",
    );
    expect(acpPrepareSession).toHaveBeenCalledWith(
      "s-selection-race",
      "claude-acp",
      "/resolved/existing/session",
      { modelId: "goose-gpt-5-6-sol" },
    );
    expect(acpLoadSession.mock.invocationCallOrder[0]).toBeLessThan(
      acpPrepareSession.mock.invocationCallOrder[0],
    );
  });

  it("skips ACP load while optimistic session creation is pending", async () => {
    seedSession(
      {
        id: "draft-session",
        creationState: "pending",
        messageCount: 0,
      },
      { replay: false },
    );
    useChatStore.getState().setSessionLoading("draft-session", true);

    await expect(loadSessionMessages("draft-session")).resolves.toBe(true);

    expect(acpLoadSession).not.toHaveBeenCalled();
    expect(resolvePath).not.toHaveBeenCalled();
    expect(checkDirectoriesExist).not.toHaveBeenCalled();
    expect(useChatStore.getState().loadingSessionIds.has("draft-session")).toBe(
      false,
    );
  });

  it("missing workspace cwd falls back, warns, and clears the stale workspace entry", async () => {
    seedSession(
      { id: "s-ws", workingDir: "/saved/session" },
      {
        workspacePath: "/missing/worktree",
        missingDir: "/resolved/missing/worktree",
      },
    );

    await expect(loadSessionMessages("s-ws")).resolves.toBe(true);

    expect(checkDirectoriesExist).toHaveBeenCalledWith([
      "/resolved/missing/worktree",
    ]);
    expect(acpLoadSession).toHaveBeenCalledWith("s-ws", "~/.distill/artifacts");
    expect(
      useChatSessionStore.getState().activeWorkspaceBySession["s-ws"],
    ).toBeUndefined();
    expect(useChatSessionStore.getState().getSession("s-ws")?.workingDir).toBe(
      "~/.distill/artifacts",
    );
    const warning = notificationFromLastMessage("s-ws");
    expect(warning.text).toContain("/resolved/missing/worktree");
    expect(warning.action).toEqual({ type: "openContextPanel" });
  });

  it("rejects empty pinned replay when authoritative metadata refresh fails", async () => {
    acpGetSessionInfo.mockRejectedValue(new Error("metadata unavailable"));
    seedSession(
      {
        id: "s-pinned-unknown",
        messageCount: 0,
        pinnedLoadState: "loading",
      },
      { replay: false },
    );
    acpLoadSession.mockImplementation(async (sessionId: string) => {
      ensureReplayBuffer(sessionId);
    });

    await expect(loadSessionMessages("s-pinned-unknown")).resolves.toBe(false);
    await expect(loadSessionMessages("s-pinned-unknown")).resolves.toBe(false);

    expect(acpGetSessionInfo).toHaveBeenCalledTimes(2);
    expect(
      useChatSessionStore.getState().getSession("s-pinned-unknown")
        ?.pinnedLoadState,
    ).toBe("failed");
    expect(notificationFromLastMessage("s-pinned-unknown")).toMatchObject({
      notificationType: "error",
    });
  });

  it("does not let pinned metadata replace a newer UI model selection", async () => {
    const metadata = deferred<AcpSessionInfo>();
    const selectedTarget = {
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "goose-gpt-5-6-sol",
      modelName: "GPT-5.6 Sol",
    } as const;
    acpGetSessionInfo.mockReturnValue(metadata.promise);
    seedSession({
      id: "s-pinned-race",
      executionTarget: undefined,
      pinnedLoadState: "loading",
    });

    const load = loadSessionMessages("s-pinned-race");
    useChatSessionStore
      .getState()
      .replaceSessionExecutionTarget("s-pinned-race", selectedTarget);
    metadata.resolve({
      sessionId: "s-pinned-race",
      title: "Pinned race",
      updatedAt: "2026-06-25T00:45:04.000Z",
      createdAt: "2026-06-25T00:40:00.000Z",
      lastMessageAt: null,
      archivedAt: null,
      userSetName: false,
      messageCount: 1,
      subtitle: null,
      workingDir: "/tmp/project",
      projectId: null,
      providerId: "claude-acp",
      modelId: "goose-gpt-5-5",
      personaId: null,
    });

    await expect(load).resolves.toBe(true);

    expect(
      useChatSessionStore.getState().getSession("s-pinned-race")
        ?.executionTarget,
    ).toEqual(selectedTarget);
  });

  it("shares one replay load between concurrent callers", async () => {
    seedSession(
      { id: "s-concurrent", workingDir: "/existing/session" },
      { replay: false },
    );
    const replayLoad = deferred();
    acpLoadSession.mockReturnValueOnce(replayLoad.promise);

    const firstLoad = loadSessionMessages("s-concurrent");
    const secondLoad = loadSessionMessages("s-concurrent");

    await vi.waitFor(() => {
      expect(acpLoadSession).toHaveBeenCalledTimes(1);
    });
    expect(useChatStore.getState().loadingSessionIds.has("s-concurrent")).toBe(
      true,
    );

    ensureReplayBuffer("s-concurrent").push(replayUserMessage());
    replayLoad.resolve();

    await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([
      true,
      true,
    ]);
    expect(acpLoadSession).toHaveBeenCalledTimes(1);
    expect(messagesFor("s-concurrent").map((message) => message.id)).toEqual([
      "m1",
    ]);
    expect(useChatStore.getState().loadingSessionIds.has("s-concurrent")).toBe(
      false,
    );
  });

  it("retries the load after a failure and replaces the error notification on success", async () => {
    acpLoadSession.mockRejectedValueOnce(new Error("backend down"));
    seedSession(
      { id: "s5", workingDir: "/existing/session" },
      { replay: false },
    );

    await expect(loadSessionMessages("s5")).resolves.toBe(false);
    expect(notificationFromLastMessage("s5").notificationType).toBe("error");

    ensureReplayBuffer("s5").push(replayUserMessage());

    await expect(loadSessionMessages("s5")).resolves.toBe(true);

    expect(acpLoadSession).toHaveBeenCalledTimes(2);
    expect(messagesFor("s5").map((m) => m.role)).toEqual(["user"]);
  });
});
