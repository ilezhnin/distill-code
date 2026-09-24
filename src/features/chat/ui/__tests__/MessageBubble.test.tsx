import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessageBubble } from "../MessageBubble";
import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderCatalogStore } from "@/features/providers/stores/providerCatalogStore";
import type { Message } from "@/shared/types/messages";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
const mockPathExists = vi.hoisted(() =>
  vi.fn<(path: string) => Promise<boolean>>(),
);
const mockWriteText = vi.fn().mockResolvedValue(undefined);
const mockToastError = vi.hoisted(() => vi.fn());

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
