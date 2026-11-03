import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MessageBubble } from "../MessageBubble";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import type { Message } from "@/shared/types/messages";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { ArtifactPolicyProvider } from "@/features/chat/hooks/ArtifactPolicyContext";
import { ConductorTranscriptProvider } from "@/features/conductor/ConductorTranscriptContext";
import type { SessionNode } from "@/features/conductor/types";
const mockPathExists = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<boolean>>(),
);
const mockWriteText = vi.fn().mockResolvedValue(undefined);
const mockToastError = vi.hoisted(() => vi.fn());
const mockReveal = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: mockReveal,
}));

const providerCatalogEntries: ProviderCatalogEntry[] = [
  {
    id: "claude-acp",
    displayName: "Claude Code",
    category: "agent",
    description: "Anthropic's agentic coding tool",
    setupMethod: "cli_auth",
    binaryName: "claude-agent-acp",
    group: "default",
    aliases: ["claude-acp", "claude_code", "claude"],
  },
  {
    id: "codex-acp",
    displayName: "Codex",
    category: "agent",
    description: "OpenAI's coding agent",
    setupMethod: "cli_auth",
    binaryName: "codex-acp",
    group: "default",
    aliases: ["codex-acp", "codex_cli", "codex"],
  },
];

vi.mock("@mcp-ui/client", () => ({
  UI_EXTENSION_CONFIG: { mimeTypes: ["text/html;profile=mcp-app"] },
  AppRenderer: (props: { toolName?: string }) => (
    <div data-testid="mock-app-renderer">
      {props.toolName ?? "app-renderer"}
    </div>
  ),
}));

vi.mock("@/shared/api/gooseServeHost", () => ({
  getGooseServeHostInfo: vi.fn().mockResolvedValue({
    httpBaseUrl: "http://127.0.0.1:4242",
    secretKey: "test-secret",
  }),
}));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("@/shared/hooks/useAvatarSrc", () => ({
  useAvatarImage: vi.fn((avatar: unknown) => {
    if (avatar === "app-avatar:builder") return "asset:///avatars/builder.png";
    return typeof avatar === "string" && avatar.startsWith("http")
      ? avatar
      : undefined;
  }),
  useAvatarMedia: vi.fn((avatar: unknown) =>
    avatar === "user-avatar:custom"
      ? {
          src: "asset:///avatars/custom.webm",
          mediaType: "video",
          posterSrc: "asset:///avatars/custom.png",
        }
      : undefined,
  ),
}));

vi.mock("@/shared/api/system", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/system")>();
  return {
    ...actual,
    pathExists: (path: string) => mockPathExists(path),
    allowAssetDirectories: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme?: string) =>
    `${scheme ?? "asset"}://${path}`,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: mockToastError, message: vi.fn(), success: vi.fn() },
}));

function userMessage(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: "u1",
    role: "user",
    created: Date.now(),
    content: [{ type: "text", text }],
    ...overrides,
  };
}

function assistantMessage(
  content: Message["content"],
  overrides: Partial<Message> = {},
): Message {
  return {
    id: "a1",
    role: "assistant",
    created: Date.now(),
    content,
    ...overrides,
  };
}

/**
 * jsdom has no layout, so `scrollHeight` is always 0 and the clamp would never
 * see overflow. Stub the clamp content element's scrollHeight to drive the
 * overflow branch deterministically.
 */
function withUserMessageScrollHeight(scrollHeight: number) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.dataset.role === "user-message-clamp-content"
        ? scrollHeight
        : 0;
    },
  });
  scrollHeightDescriptors.push(descriptor);
}

const scrollHeightDescriptors: (PropertyDescriptor | undefined)[] = [];

function restoreScrollHeight() {
  while (scrollHeightDescriptors.length > 0) {
    const descriptor = scrollHeightDescriptors.pop();
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
    }
  }
}

describe("MessageBubble", () => {
  beforeEach(() => {
    useAgentStore.setState({ personas: [] });
    useProviderCatalogStore.getState().setEntries(providerCatalogEntries);
    vi.mocked(openPath).mockClear();
    vi.mocked(openUrl).mockClear();
    mockPathExists.mockReset();
    mockPathExists.mockResolvedValue(false);
    mockWriteText.mockClear();
    mockToastError.mockClear();
    mockReveal.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: mockWriteText,
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    restoreScrollHeight();
    useProviderCatalogStore.getState().reset();
  });

  it("reveals executable attachments through the shared file policy", async () => {
    mockPathExists.mockResolvedValue(true);
    const message = userMessage("Review this attachment", {
      metadata: {
        attachments: [
          { type: "file", name: "tool.cmd", path: "E:/work/tool.cmd" },
        ],
      },
    });
    const { container } = render(
      <ArtifactPolicyProvider messages={[message]} sessionCwd="E:/work">
        <MessageBubble message={message} />
      </ArtifactPolicyProvider>,
    );
    await userEvent
      .setup()
      .click(
        container.querySelector(
          '[data-role="message-attachment-tile"]',
        ) as HTMLElement,
      );
    expect(mockReveal).toHaveBeenCalledWith("E:/work/tool.cmd");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("asks before opening an untrusted attachment URL", async () => {
    const message = userMessage("Review this link", {
      metadata: {
        attachments: [
          {
            type: "url",
            name: "report",
            url: "https://attachment.example.test/report",
          },
        ],
      },
    });
    const { container } = render(<MessageBubble message={message} />);
    await userEvent
      .setup()
      .click(
        container.querySelector(
          '[data-role="message-attachment-tile"]',
        ) as HTMLElement,
      );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("preserves interleaved user content block order", () => {
    withUserMessageScrollHeight(80);

    const { container } = render(
      <MessageBubble
        message={userMessage("first", {
          content: [
            { type: "text", text: "first" },
            { type: "image", data: "abc123", mimeType: "image/png" },
            { type: "text", text: "last" },
          ],
        })}
      />,
    );

    const bubble = container.querySelector<HTMLElement>(".bg-message-user-bg");
    const paragraphs = container.querySelectorAll<HTMLElement>(
      ".bg-message-user-bg p",
    );
    const first = paragraphs[0];
    const image = screen.getByRole("button", { name: "View Attached" });
    const last = paragraphs[1];
    expect(first.compareDocumentPosition(image)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(image.compareDocumentPosition(last)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(bubble).not.toBeNull();
    expect(bubble).toContainElement(first);
    expect(bubble).toContainElement(last);
  });

  it("uses an explicit original message id for projected-row actions", async () => {
    const user = userEvent.setup();
    const onForkFromMessage = vi.fn();
    render(
      <MessageBubble
        message={{
          ...assistantMessage([{ type: "text", text: "response" }]),
          id: "a1:companion-mcpApp-tool-1",
        }}
        actionMessageId="a1"
        onForkFromMessage={onForkFromMessage}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Fork session from here" }),
    );

    expect(onForkFromMessage).toHaveBeenCalledWith("a1");
  });

  it("renders standalone tool responses without dropping surrounding text", () => {
    const msg = assistantMessage([
      { type: "text", text: "Working on it." },
      {
        type: "toolResponse",
        id: "tool-result-1",
        name: "readFile",
        result: "file contents here",
        isError: false,
      },
      { type: "text", text: "Done." },
    ]);

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Working on it.")).toBeInTheDocument();
    expect(screen.getByText(/readfile/i)).toBeInTheDocument();
    expect(screen.getByText("Done.")).toBeInTheDocument();
  });

  it("merges matched tool requests and responses into one tool card", () => {
    const msg = assistantMessage([
      { type: "text", text: "Checking that now." },
      {
        type: "toolRequest",
        id: "tool-1",
        name: "readFile",
        arguments: { path: "/tmp/demo.txt" },
        status: "in_progress",
      },
      {
        type: "toolResponse",
        id: "tool-1",
        name: "readFile",
        result: "done",
        isError: false,
      },
    ]);

    render(<MessageBubble message={msg} />);

    expect(screen.getByText("Checking that now.")).toBeInTheDocument();
    expect(screen.getAllByText(/readfile/i)).toHaveLength(1);
  });
});

describe("MessageBubble over a worker's brief", () => {
  const worker: SessionNode = {
    sessionId: "worker-1",
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: "run-1",
    harnessId: "claude-acp",
    modelId: "claude-sonnet-5-5",
    effort: "high",
    roleId: "scout",
    displayName: "Scout · waveEngine",
    status: "running",
  };
  const conductor: SessionNode = {
    ...worker,
    sessionId: "conductor-1",
    role: "conductor",
    parentSessionId: null,
    roleId: undefined,
    displayName: "Producer",
  };
  const brief = userMessage(
    "Read the wave engine and report what the tick does.",
    {
      metadata: { origin: "distillctl_cross_session" },
    },
  );

  it("puts the worker's header over the brief in place of the cross-session label", () => {
    const onOpenParent = vi.fn();
    render(
      <ConductorTranscriptProvider
        value={{
          enabled: false,
          children: [],
          reportsByRunId: {},
          brigadeNodesByMessageId: new Map(),
          wavePlanStepsByMessageId: new Map(),
          workerBrief: {
            messageId: brief.id,
            node: worker,
            parent: conductor,
            onOpenParent,
          },
        }}
      >
        <MessageBubble message={brief} />
      </ConductorTranscriptProvider>,
    );
    expect(screen.getByText("Scout · waveEngine")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Started by Producer" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Sent by Flock from another session"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Read the wave engine and report what the tick does."),
    ).toBeInTheDocument();
  });

  it("keeps the plain label on a cross-session message that is not the brief", () => {
    render(
      <ConductorTranscriptProvider
        value={{
          enabled: false,
          children: [],
          reportsByRunId: {},
          brigadeNodesByMessageId: new Map(),
          wavePlanStepsByMessageId: new Map(),
          workerBrief: {
            messageId: "another",
            node: worker,
            parent: conductor,
          },
        }}
      >
        <MessageBubble message={brief} />
      </ConductorTranscriptProvider>,
    );
    expect(
      screen.getByText("Sent by Flock from another session"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Started by Producer")).not.toBeInTheDocument();
  });
});

describe("MessageBubble in an ordinary chat that started agents", () => {
  const reply = assistantMessage([
    { type: "text", text: "Started two workers." },
  ]);
  const child = (sessionId: string, status: SessionNode["status"]) =>
    ({
      sessionId,
      projectId: "project",
      role: "worker",
      managedBy: "agent-cli",
      parentSessionId: "plain-chat-1",
      harnessId: "grok-acp",
      displayName: `Worker ${sessionId}`,
      status,
      anchorMessageId: reply.id,
    }) as SessionNode;
  const running = child("child-running", "starting");
  const done = child("child-done", "completed");
  const renderInChat = (bubble: ReactNode, onStopChild = vi.fn()) =>
    render(
      <ConductorTranscriptProvider
        value={{
          enabled: true,
          hostSessionId: "plain-chat-1",
          children: [running, done],
          reportsByRunId: {},
          brigadeNodesByMessageId: new Map([[reply.id, [running, done]]]),
          wavePlanStepsByMessageId: new Map(),
          onOpenChild: vi.fn(),
          onStopChild,
        }}
      >
        {bubble}
      </ConductorTranscriptProvider>,
    );

  it("shows each child as a chip and offers Stop on the one still working", async () => {
    const onStopChild = vi.fn();
    renderInChat(<MessageBubble message={reply} />, onStopChild);
    expect(screen.getAllByTestId("conductor-agent-chip")).toHaveLength(2);
    const [stopControl, ...others] = screen.getAllByTestId(
      "conductor-agent-stop",
    );
    expect(others).toHaveLength(0);
    await userEvent.click(stopControl);
    expect(onStopChild).toHaveBeenCalledWith("child-running");
  });

  // A turn that spawned its agents from a tool call is drawn as work rows
  // and an answer row with a derived id; the chips belong to the turn.
  it("hangs the turn's children under its answer row", () => {
    renderInChat(
      <MessageBubble
        message={{ ...reply, id: `${reply.id}:answer` }}
        actionMessageId={reply.id}
      />,
    );
    expect(screen.getAllByTestId("conductor-agent-chip")).toHaveLength(2);
    expect(screen.getAllByTestId("conductor-agent-stop")).toHaveLength(1);
  });

  it("does not repeat them on a companion block of the same turn", () => {
    renderInChat(
      <MessageBubble
        message={{
          ...reply,
          id: `${reply.id}:companion-image`,
          content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        }}
        actionMessageId={reply.id}
      />,
    );
    expect(
      screen.queryByTestId("conductor-agent-chip"),
    ).not.toBeInTheDocument();
  });
});
