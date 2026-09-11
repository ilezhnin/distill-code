import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ChatInput } from "./chatInputTestUtils";
import type { ChatSkillDraft } from "../../types";
import { useRuntimeConfigStore } from "@/shared/runtime-config/runtimeConfigStore";
import {
  DEFAULT_RUNTIME_CONFIG,
  type RuntimeConfig,
} from "@/shared/runtime-config/schema";

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

vi.mock("@/features/providers/hooks/useAgentProviderStatus", () => ({
  useAgentProviderStatus: () => ({
    readyAgentIds: new Set(["goose", "claude-acp", "codex-acp"]),
    agentReadiness: new Map([
      ["goose", "ready"],
      ["claude-acp", "ready"],
      ["codex-acp", "ready"],
    ]),
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/shared/api/system", () => ({
  getHomeDir: vi.fn().mockResolvedValue("/Users/wesb"),
  searchFilesForMentions: vi.fn().mockResolvedValue([]),
}));

type SkillMentionFixture = {
  id: string;
  name: string;
  description: string;
  sourceLabel: string;
};
const mockListSkills = vi.fn<
  (projectDirs?: string[]) => Promise<SkillMentionFixture[]>
>(async () => []);
vi.mock("@/features/skills/api/skills", () => ({
  listSkills: (projectDirs?: string[]) => mockListSkills(projectDirs),
}));

const CODE_REVIEW_SKILL = {
  id: "global:/skills/code-review",
  name: "code-review",
  description: "Reviews code",
  sourceLabel: "Personal",
};

function setReadyRuntimeConfig(config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG) {
  useRuntimeConfigStore.setState({
    loaded: true,
    result: {
      status: "ready",
      source: "fakeEndpoint",
      config,
    },
    config,
  });
}

describe("ChatInput skill mentions", () => {
  beforeEach(() => {
    localStorage.clear();
    mockListSkills.mockClear();
    mockListSkills.mockResolvedValue([]);
    setReadyRuntimeConfig({
      ...DEFAULT_RUNTIME_CONFIG,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not show skills in @mention results", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "@code");

    expect(screen.getByRole("tab", { name: "Agents" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(
      screen.queryByRole("option", { name: /code-review/i }),
    ).not.toBeInTheDocument();
  });

  it("shows skills in slash results, preserves the command text, and creates a skill chip", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    expect(await screen.findByText("Skills")).toBeInTheDocument();

    await user.click(
      await screen.findByRole("option", { name: /code-review/i }),
    );

    expect(input).toHaveValue("/code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("pressing Tab accepts the highlighted skill suggestion", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    expect(
      await screen.findByRole("option", { name: /code-review/i }),
    ).toBeInTheDocument();

    await user.keyboard("{Tab}");

    expect(input).toHaveValue("/code-review ");
    expect(input).toHaveFocus();
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("preserves slash command text when selecting a skill later in the prompt", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "do a /code");

    await user.click(
      await screen.findByRole("option", { name: /code-review/i }),
    );

    expect(input).toHaveValue("do a /code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("dedupes slash skill results by skill name", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      CODE_REVIEW_SKILL,
      {
        id: "project:/repo/.agents/skills/code-review",
        name: "code-review",
        description: "Reviews code",
        sourceLabel: "Goose2",
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    const options = await screen.findAllByRole("option", {
      name: /code-review/i,
    });
    expect(options).toHaveLength(1);

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("/code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
  });

  it("selects skill name matches before earlier description matches", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/release-notes",
        name: "release-notes",
        description: "write code status summaries",
        sourceLabel: "Personal",
      },
      {
        id: "global:/skills/code-review",
        name: "code-review",
        description: "reviews diffs",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");

    const options = await screen.findAllByRole("option");
    expect(options[0]).toHaveTextContent("code-review");

    await user.keyboard("{Enter}");

    expect(input).toHaveValue("/code-review ");
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.queryByText("release-notes")).not.toBeInTheDocument();
  });

  it("does not show all skills for an empty slash later in the prompt", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "please use /");

    expect(input).toHaveValue("please use /");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /code-review/i }),
    ).not.toBeInTheDocument();
  });

  it("shows skills for slash queries later in the prompt", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "please use /code");

    expect(input).toHaveValue("please use /code");
    expect(
      await screen.findByRole("option", { name: /code-review/i }),
    ).toBeInTheDocument();
  });

  it("keeps the skill chip selected without reopening references when typing a URL", async () => {
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([CODE_REVIEW_SKILL]);

    render(<ChatInput onSend={vi.fn()} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code");
    await user.click(
      await screen.findByRole("option", { name: /code-review/i }),
    );

    await user.type(input, "https://example.com/path");

    expect(input).toHaveValue("/code-review https://example.com/path");
    expect(screen.getByText("code-review")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("expands selected skill chips before sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();

    render(
      <ChatInput
        onSend={onSend}
        selectedSkills={[
          {
            id: "global:/skills/code-review",
            name: "code-review",
            description: "Reviews code",
            sourceLabel: "Personal",
          },
        ]}
        onSkillsChange={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox"), "check this diff");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("check this diff", null, undefined, {
      assistantPrompt: "Use these skills for this request: code-review.",
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "check this diff",
    });
  });

  it("clears selected skill chips when the session controller clears the draft during send", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();

    function ControlledProjectChatInput() {
      const [draft, setDraft] = useState("");
      const [skills, setSkills] = useState<ChatSkillDraft[]>([
        CODE_REVIEW_SKILL,
      ]);

      return (
        <ChatInput
          initialValue={draft}
          onDraftChange={setDraft}
          selectedSkills={skills}
          onSkillsChange={setSkills}
          onSend={async (...args) => {
            onSend(...args);
            setDraft("");
            return true;
          }}
        />
      );
    }

    render(<ControlledProjectChatInput />);

    expect(screen.getByText("code-review")).toBeInTheDocument();

    const input = screen.getByRole("textbox");
    await user.type(input, "check this diff");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("check this diff", null, undefined, {
      assistantPrompt: "Use these skills for this request: code-review.",
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "check this diff",
    });

    await waitFor(() => {
      expect(screen.queryByText("code-review")).not.toBeInTheDocument();
    });
    expect(input).toHaveValue("");
  });

  it("expands direct slash skill commands before sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/code-review",
        name: "code-review",
        description: "Reviews code",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={onSend} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/code-review check this diff");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("check this diff", null, undefined, {
      assistantPrompt: "Use these skills for this request: code-review.",
      chips: [{ label: "code-review", type: "skill" }],
      displayText: "check this diff",
    });
  });

  it("expands colon-qualified slash skill commands before sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/github",
        name: "github:github",
        description: "Works with GitHub",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={onSend} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/github:github triage this PR");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("triage this PR", null, undefined, {
      assistantPrompt: "Use these skills for this request: github:github.",
      chips: [{ label: "github:github", type: "skill" }],
      displayText: "triage this PR",
    });
  });

  it("does not expand reserved slash commands as skills", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    mockListSkills.mockResolvedValue([
      {
        id: "global:/skills/compact",
        name: "compact",
        description: "A compacting skill",
        sourceLabel: "Personal",
      },
    ]);

    render(<ChatInput onSend={onSend} />);

    await waitFor(() => {
      expect(mockListSkills).toHaveBeenCalled();
    });

    const input = screen.getByRole("textbox");
    await user.type(input, "/compact");
    await user.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("/compact", null, undefined);
  });
});
