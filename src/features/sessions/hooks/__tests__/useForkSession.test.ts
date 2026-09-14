import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AcpSessionInfo } from "@/shared/api/acpApi";
import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import { useForkSession } from "../useForkSession";

const mocks = vi.hoisted(() => ({
  acpDuplicateSession: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/shared/api/acp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/acp")>()),
  acpDuplicateSession: (...args: unknown[]) =>
    mocks.acpDuplicateSession(...args),
}));

function sourceSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "source-1",
    title: "Refactor",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    messageCount: 4,
    workingDir: "C:/repo",
    executionTarget: {
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.6-sol",
      modelName: "GPT-5.6 Sol",
    },
    executionTargetSource: "ui",
    desiredRunSettings: { effort: "xhigh", fast: true },
    ...overrides,
  };
}

/** What the host answers a fork with: provider and model id, nothing more. */
function forkedInfo(modelId: string | null): AcpSessionInfo {
  return {
    sessionId: "fork-1",
    title: "Copy of Refactor",
    updatedAt: null,
    createdAt: null,
    lastMessageAt: null,
    archivedAt: null,
    userSetName: false,
    messageCount: 4,
    subtitle: null,
    workingDir: "C:/repo",
    projectId: null,
    providerId: "codex-acp",
    modelId,
    personaId: null,
  };
}

async function fork(): Promise<ChatSession | undefined> {
  const { result } = renderHook(() => useForkSession());
  await act(async () => {
    await result.current("source-1");
  });
  return useChatSessionStore.getState().getSession("fork-1");
}

describe("useForkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useChatSessionStore.setState({ sessions: [sourceSession()] });
  });

  it("opens the fork on the model, effort and fast mode its source was running", async () => {
    mocks.acpDuplicateSession.mockResolvedValue(forkedInfo("gpt-5.6-sol"));

    const forked = await fork();

    expect(forked?.executionTarget).toEqual({
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.6-sol",
      modelName: "GPT-5.6 Sol",
    });
    expect(forked?.desiredRunSettings).toEqual({ effort: "xhigh", fast: true });
  });

  it("keeps the host's model when the fork did not open on the source's", async () => {
    mocks.acpDuplicateSession.mockResolvedValue(forkedInfo("gpt-5.6-luna"));

    const forked = await fork();

    expect(forked?.executionTarget).toEqual({
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.6-luna",
      modelName: "gpt-5.6-luna",
    });
    // The intent still follows: the reconciler notices if this model refuses it.
    expect(forked?.desiredRunSettings).toEqual({ effort: "xhigh", fast: true });
  });

  it("gives the fork no run-settings intent when its source had none", async () => {
    useChatSessionStore.setState({
      sessions: [sourceSession({ desiredRunSettings: undefined })],
    });
    mocks.acpDuplicateSession.mockResolvedValue(forkedInfo("gpt-5.6-sol"));

    const forked = await fork();

    expect(forked).toBeDefined();
    expect(forked).not.toHaveProperty("desiredRunSettings");
  });
});
