import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatInput } from "./chatInputTestUtils";
import type { Persona } from "@/shared/types/agents";
import type { ChatInputComposerActions } from "../../types";
import { STREAMING_SHORTCUT_MODE_STORAGE_KEY } from "../../lib/streamingShortcutPreference";
import { MAX_PROMPT_ATTACHMENT_BYTES } from "../../lib/attachmentPayloadBudget";

// Deterministic shortcut modifiers across dev machines and CI: "mod"
// combos (e.g. chat.sendNow's Mod+Enter) resolve to Meta.
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: () => "mac",
}));

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose", "claude-acp", "codex-acp", "grok-acp"]),
    agentReadiness: new Map([
      ["goose", "ready"],
      ["claude-acp", "ready"],
      ["codex-acp", "ready"],
      ["grok-acp", "ready"],
    ]),
    loading: false,
    refresh: vi.fn(),
  }),
}));

function immediatelyResolved<T>(value: T): Promise<T> {
  return {
    // biome-ignore lint/suspicious/noThenProperty: this test helper intentionally resolves synchronously.
    then(onfulfilled) {
      return Promise.resolve(onfulfilled?.(value));
    },
  } as Promise<T>;
}

const mockSearchFilesForMentions = vi.fn<
  (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => Promise<unknown[]>
>(async () => []);
const mockInspectAttachmentPaths = vi.fn<
  (paths: string[]) => Promise<
    {
      name: string;
      path: string;
      kind: "file" | "directory";
      mimeType?: string | null;
    }[]
  >
>(async () => []);
const mockReadImageAttachment = vi.fn<
  (path: string) => Promise<{ base64: string; mimeType: string }>
>(async () => ({ base64: "abc", mimeType: "image/png" }));
vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn(() => immediatelyResolved("/Users/wesb")),
  searchFilesForMentions: (input: {
    roots: string[];
    query: string;
    maxResults?: number;
  }) => mockSearchFilesForMentions(input),
  inspectAttachmentPaths: (paths: string[]) =>
    mockInspectAttachmentPaths(paths),
  readImageAttachment: (path: string) => mockReadImageAttachment(path),
}));

vi.mock("@/features/skills/api/skills", () => ({
  listSkills: vi.fn(() => immediatelyResolved([])),
}));

vi.mock("@/features/skills/api/skillsQuery", () => ({
  fetchSkillsList: vi.fn(() => immediatelyResolved([])),
}));

const TEST_PERSONAS: Persona[] = [
  {
    id: "builtin-solo",
    displayName: "Solo",
    systemPrompt: "You are Solo.",
    isBuiltin: true,
    writable: false,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "reviewer",
    displayName: "Reviewer",
    systemPrompt: "You are Reviewer, a code review specialist.",
    isBuiltin: true,
    writable: false,
    createdAt: "",
    updatedAt: "",
  },
];

function basename(path: string) {
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? path
  );
}

function setViewportHeight(height: number) {
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: height,
  });
}

const DEFAULT_VIEWPORT_HEIGHT = window.innerHeight;

describe("ChatInput", () => {
  afterEach(cleanup);

  beforeEach(() => {
    setViewportHeight(DEFAULT_VIEWPORT_HEIGHT);
    localStorage.clear();
    mockSearchFilesForMentions.mockClear();
    mockSearchFilesForMentions.mockResolvedValue([]);
    mockInspectAttachmentPaths.mockClear();
    mockInspectAttachmentPaths.mockImplementation(async (paths) =>
      paths.map((path) => ({
        name: basename(path),
        path,
        kind: /\.[^\\/]+$/.test(path) ? "file" : "directory",
      })),
    );
    mockReadImageAttachment.mockClear();
    mockReadImageAttachment.mockResolvedValue({
      base64: "abc",
      mimeType: "image/png",
    });
  });

  // ---------------------------------------------------------------------------
  // Message queue & streaming behavior
  // ---------------------------------------------------------------------------

  it("stops streaming with Escape without sending or clearing a draft", async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<ChatInput onSend={onSend} onStop={onStop} isStreaming />);

    const input = screen.getByRole("textbox");
    await user.type(input, "follow up");
    await user.keyboard("{Escape}");

    expect(onStop).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("follow up");
  });

  it("steers queued message from the queue bar", async () => {
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        onStop={vi.fn()}
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    expect(screen.getByRole("button", { name: /steer/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /steer/i }));

    expect(onSteerQueuedMessage).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: /stop generation/i }),
    ).toBeInTheDocument();
  });

  it("pauses a tail record while editing and updates it in place", async () => {
    const onEditQueue = vi.fn(() => true);
    const onCancelQueueEdit = vi.fn(() => true);
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" }, text: "first" },
          },
          {
            recordId: "tail",
            payload: { persona: { kind: "none" }, text: "second" },
          },
        ]}
        onEditQueue={onEditQueue}
        onCancelQueueEdit={onCancelQueueEdit}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    const firstQueuedMessage = screen.getByText("first");
    const secondQueuedMessage = screen.getByText("second");
    expect(firstQueuedMessage).toBeInTheDocument();
    expect(secondQueuedMessage).toBeInTheDocument();
    const queuedMessageGroup =
      firstQueuedMessage.parentElement?.parentElement?.parentElement;
    expect(queuedMessageGroup).toBe(
      secondQueuedMessage.parentElement?.parentElement?.parentElement,
    );
    expect(queuedMessageGroup).toHaveAttribute(
      "data-slot",
      "queued-message-group",
    );
    expect(queuedMessageGroup).toHaveClass("rounded-xs");
    expect(queuedMessageGroup).not.toHaveClass("rounded-full");
    expect(screen.queryByText("1. first")).not.toBeInTheDocument();
    expect(screen.queryByText("2. second")).not.toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: "Edit queued message" })[1],
    );
    expect(onEditQueue).toHaveBeenCalledWith("tail");
    expect(screen.getByRole("textbox")).toHaveValue("second");

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "updated second");
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith("tail", {
      text: "updated second",
      persona: { kind: "none" },
      attachments: undefined,
      sendOptions: undefined,
    });
    expect(onCancelQueueEdit).not.toHaveBeenCalled();
  });

  it("does not stamp the live session target onto an edited queued message", async () => {
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        selectedProvider="goose"
        providers={[{ id: "goose", label: "Goose" }]}
        currentExecutionTarget={{
          harnessId: "goose",
          modelProviderId: "databricks_v2",
        }}
        queuedMessages={[
          {
            recordId: "queued",
            payload: { persona: { kind: "none" }, text: "continue" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).toHaveBeenCalledWith("queued", {
      text: "continue",
      persona: { kind: "none" },
      attachments: undefined,
      sendOptions: undefined,
    });
  });

  it("resumes an edited queued record when the composer unmounts", async () => {
    const onEditQueue = vi.fn(() => true);
    const onCancelQueueEdit = vi.fn(() => true);
    const user = userEvent.setup();
    const { unmount } = render(
      <ChatInput
        onSend={vi.fn()}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        onEditQueue={onEditQueue}
        onCancelQueueEdit={onCancelQueueEdit}
        onDismissQueue={vi.fn()}
        onUpdateQueue={vi.fn(() => true)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    expect(onEditQueue).toHaveBeenCalledWith("head");

    unmount();
    expect(onCancelQueueEdit).toHaveBeenCalledWith("head");
  });

  it("clears the composer edit state when the edited record leaves the queue", async () => {
    const onSend = vi.fn(() => true);
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();

    const queueProps = {
      onEditQueue: vi.fn(() => true),
      onCancelQueueEdit: vi.fn(() => true),
      onDismissQueue: vi.fn(),
      onUpdateQueue,
    };
    const { rerender } = render(
      <ChatInput
        onSend={onSend}
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        {...queueProps}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );

    // The record leaves the queue externally (for example the queue drains)
    // while its text is still in the composer.
    rerender(<ChatInput onSend={onSend} queuedMessages={[]} {...queueProps} />);

    // The edit must also be canceled in the store: if the record was only
    // filtered out of the prop (composer handoff), a lingering editing flag
    // would block the queue from draining it.
    expect(queueProps.onCancelQueueEdit).toHaveBeenCalledWith("head");

    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "new prompt");
    await user.keyboard("{Enter}");

    expect(onUpdateQueue).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("new prompt", null, undefined);
  });

  it("keeps tagged agents, skill send options, and attachments when editing a queued message", async () => {
    const onSend = vi.fn(() => true);
    const user = userEvent.setup();

    function EditableQueuedMessageInput() {
      const [selectedPersonaId, setSelectedPersonaId] = useState<string | null>(
        null,
      );
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "persona", id: "reviewer" },
        text: "@Reviewer check this diff",
        attachments: [
          {
            id: "file-1",
            kind: "file" as const,
            name: "notes.txt",
            path: "/tmp/notes.txt",
          },
        ],
        sendOptions: {
          assistantPrompt: "Use these skills for this request: code-review.",
          displayText: "@Reviewer check this diff",
          chips: [
            {
              id: "reviewer",
              label: "Reviewer",
              agentRole: "active" as const,
              type: "agent" as const,
            },
            { label: "code-review", type: "skill" as const },
          ],
        },
      });

      return (
        <ChatInput
          onSend={onSend}
          personas={TEST_PERSONAS}
          selectedPersonaId={selectedPersonaId}
          onPersonaChange={setSelectedPersonaId}
          onDismissQueue={() => setQueuedMessage(null)}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableQueuedMessageInput />);

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );

    expect(screen.getByRole("textbox")).toHaveValue(
      "@Reviewer check this diff",
    );
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();

    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith(
      "@Reviewer check this diff",
      "reviewer",
      [
        {
          id: "file-1",
          kind: "file",
          name: "notes.txt",
          path: "/tmp/notes.txt",
        },
      ],
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [
          {
            id: "reviewer",
            label: "Reviewer",
            agentRole: "active",
            type: "agent",
          },
          { label: "code-review", type: "skill" },
        ],
        displayText: "@Reviewer check this diff",
      },
    );
  });

  it("drops derived execution context when resending an edited message", async () => {
    const onSend = vi.fn(() => true);
    const onDismissQueue = vi.fn();
    const user = userEvent.setup();

    function EditableQueuedMessageInput() {
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "none" },
        text: "check this diff",
        sendOptions: {
          assistantPrompt: "Use these skills for this request: code-review.",
          chips: [{ label: "code-review", type: "skill" as const }],
          displayText: "check this diff",
          executionSystemPrompt: "stale queued context",
        },
      });

      return (
        <ChatInput
          onSend={onSend}
          onDismissQueue={() => {
            onDismissQueue();
            setQueuedMessage(null);
          }}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableQueuedMessageInput />);

    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(input);
    await user.type(input, "check this diff carefully");
    await user.keyboard("{Enter}");

    expect(onDismissQueue).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledWith(
      "check this diff carefully",
      null,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff carefully",
      },
    );
  });

  it("strips cross-session delivery metadata when resending an edited queued message", async () => {
    const onSend = vi.fn(() => true);
    const user = userEvent.setup();

    function EditableCrossSessionQueuedMessageInput() {
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "none" },
        text: "queued from another session",
        sendOptions: {
          acpPromptMetadata: {
            origin: "berdctl_cross_session",
            berdSenderLabel: "berd-monitor",
            berdDeliveryId: "event-1",
            threadId: "thread-1",
          },
          userMessageMetadata: {
            origin: "berdctl_cross_session",
            berdSenderLabel: "berd-monitor",
            berdDeliveryId: "event-1",
          },
        },
      });

      return (
        <ChatInput
          onSend={onSend}
          onDismissQueue={() => setQueuedMessage(null)}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableCrossSessionQueuedMessageInput />);

    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(input);
    await user.type(input, "now from me");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("now from me", null, undefined, {
      acpPromptMetadata: {
        threadId: "thread-1",
      },
    });
  });

  it("steers the queued message on enter with an empty composer", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not steer the queued message on enter when the session is idle", async () => {
    const onSend = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={onSend}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not steer the queued message while it is being edited", async () => {
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerQueuedMessage
        isStreaming
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" as const }, text: "queued msg" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={vi.fn(() => true)}
        onDismissQueue={vi.fn()}
        onUpdateQueue={vi.fn(() => true)}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");

    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
  });

  it("queues the current draft behind an existing head instead of steering it", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const onSteerQueuedMessage = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        onSteerQueuedMessage={onSteerQueuedMessage}
        canSteerMessage
        canSteerQueuedMessage
        isStreaming
        queuedMessage={{ persona: { kind: "none" }, text: "queued msg" }}
      />,
    );

    await user.type(screen.getByRole("textbox"), "new queued draft");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).not.toHaveBeenCalled();
    expect(onSteerQueuedMessage).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith("new queued draft", null, undefined);
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("updates an edited queued record instead of steering ahead of it", async () => {
    const onSend = vi.fn();
    const onSteerMessage = vi.fn();
    const onCancelQueueEdit = vi.fn(() => true);
    const onUpdateQueue = vi.fn(() => true);
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={onSend}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
        queuedMessages={[
          {
            recordId: "head",
            payload: { persona: { kind: "none" }, text: "queued draft" },
          },
        ]}
        onEditQueue={vi.fn(() => true)}
        onCancelQueueEdit={onCancelQueueEdit}
        onDismissQueue={vi.fn()}
        onUpdateQueue={onUpdateQueue}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "keep this queued");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(onUpdateQueue).toHaveBeenCalledWith("head", {
      text: "keep this queued",
      persona: { kind: "none" },
      attachments: undefined,
      sendOptions: undefined,
    });
    expect(onCancelQueueEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("preserves restored queued options when steering an edited message", async () => {
    const onSteerMessage = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");

    function EditableQueuedSteerInput() {
      const [queuedMessage, setQueuedMessage] = useState<
        ChatInputComposerActions["queuedMessage"]
      >({
        persona: { kind: "none" },
        text: "check this diff",
        sendOptions: {
          assistantPrompt: "Use these skills for this request: code-review.",
          chips: [{ label: "code-review", type: "skill" as const }],
          displayText: "check this diff",
        },
      });
      return (
        <ChatInput
          onSend={vi.fn()}
          onSteerMessage={onSteerMessage}
          canSteerMessage
          isStreaming
          onDismissQueue={() => setQueuedMessage(null)}
          queuedMessage={queuedMessage}
        />
      );
    }

    render(<EditableQueuedSteerInput />);
    const input = screen.getByRole("textbox");
    await user.click(
      screen.getByRole("button", { name: "Edit queued message" }),
    );
    await user.clear(input);
    await user.type(input, "check this diff carefully");
    await user.keyboard("{Enter}");

    expect(onSteerMessage).toHaveBeenCalledWith(
      "check this diff carefully",
      undefined,
      undefined,
      {
        assistantPrompt: "Use these skills for this request: code-review.",
        chips: [{ label: "code-review", type: "skill" }],
        displayText: "check this diff carefully",
      },
    );
    expect(input).toHaveValue("");
  });

  it("keeps an oversized steer draft in the composer instead of steering", async () => {
    // Discriminating test for the synchronous budget guard in
    // handleSteerCurrentMessage: steering is fire-and-forget (the draft
    // clears before acknowledgement), so without the guard an oversized
    // draft would be discarded even though nothing was sent (BOT-1463).
    const onSteerMessage = vi.fn();
    const onDraftAttachmentsChange = vi.fn();
    const user = userEvent.setup();
    localStorage.setItem(STREAMING_SHORTCUT_MODE_STORAGE_KEY, "enter-steers");
    render(
      <ChatInput
        onSend={vi.fn()}
        onSteerMessage={onSteerMessage}
        canSteerMessage
        isStreaming
        initialAttachments={[
          {
            id: "image-1",
            kind: "image",
            name: "huge.jpeg",
            mimeType: "image/jpeg",
            base64: "x".repeat(MAX_PROMPT_ATTACHMENT_BYTES + 1),
            previewUrl: "blob:huge",
          },
        ]}
        onDraftAttachmentsChange={onDraftAttachmentsChange}
      />,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "look at this");
    await user.keyboard("{Enter}");

    // Nothing steers and nothing clears: the draft survives for the user
    // to remove attachments and retry.
    expect(onSteerMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("look at this");
    expect(onDraftAttachmentsChange).not.toHaveBeenCalledWith([]);
  });
});
