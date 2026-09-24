import { beforeEach, expect, it, vi } from "vitest";

const session = vi.hoisted(() => vi.fn());
const effective = vi.hoisted(() => vi.fn());
vi.mock("@/features/chat/stores/chatSessionStore", () => ({
  useChatSessionStore: { getState: () => ({ getSession: session }) },
}));
vi.mock("@/features/projects/stores/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [
        { id: "a", workingDirs: ["C:/project-a"] },
        { id: "b", workingDirs: ["C:/project-b"] },
      ],
      activeProjectId: "b",
    }),
  },
}));
vi.mock("@/shared/preferences/rootSettings", () => ({
  readEffectiveSettings: effective,
}));
vi.mock("@/shared/preferences/styleGuidelinesPreference", () => ({
  getStyleGuidelinesPrompt: () => "Default style",
}));
import { sessionStyleGuidelinesPrompt } from "./sessionSettings";

beforeEach(() => {
  vi.clearAllMocks();
  effective.mockResolvedValue({
    "style-guidelines": { prompt: "Project style" },
  });
});

it("loads settings for the target chat's project, not the project selected in the sidebar", async () => {
  session.mockReturnValue({ projectId: "a" });
  expect(await sessionStyleGuidelinesPrompt("chat")).toBe("Project style");
  expect(effective).toHaveBeenCalledWith("C:/project-a");
});

it("uses only global settings for a general chat", async () => {
  session.mockReturnValue({ projectId: null });
  effective.mockResolvedValue({});
  expect(await sessionStyleGuidelinesPrompt("chat")).toBe("Default style");
  expect(effective).toHaveBeenCalledWith(undefined);
});

it("honors an explicitly empty project style", async () => {
  session.mockReturnValue({ projectId: "a" });
  effective.mockResolvedValue({ "style-guidelines": { prompt: "" } });
  expect(await sessionStyleGuidelinesPrompt("chat")).toBe("");
});
