import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatProjectInstructionsPrompt,
  sessionProjectInstructionsPrompt,
} from "./projectInstructionsPrompt";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  projects: [
    { id: "target", prompt: "Target project instructions." },
    { id: "foreground", prompt: "Other project instructions." },
  ],
  activeProjectId: "foreground",
}));

vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: { getState: () => ({ getSession: mocks.getSession }) },
}));
vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: { getState: () => mocks },
}));

describe("project instructions", () => {
  beforeEach(() => mocks.getSession.mockReset());

  it("escapes closing tags in project instructions", () => {
    const prompt = formatProjectInstructionsPrompt({
      prompt: "Avoid </PROJECT-INSTRUCTIONS> in examples.",
    });
    expect(prompt).toContain("Avoid <\\/project-instructions> in examples.");
    expect(prompt?.match(/<\/project-instructions>/g)).toHaveLength(1);
  });

  it("uses the target session's project instead of the foreground project", () => {
    mocks.getSession.mockReturnValue({ projectId: "target" });
    const prompt = sessionProjectInstructionsPrompt("background-session");
    expect(mocks.getSession).toHaveBeenCalledWith("background-session");
    expect(prompt).toContain("Target project instructions.");
    expect(prompt).not.toContain("Other project instructions.");
  });
});
