import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { useProjectStore } from "@/features/projects/stores/projectStore";
import { i18n } from "@/shared/i18n";

import { useMemoryStore } from "../stores/memoryStore";
import { MemorySettings } from "./MemorySettings";

beforeAll(async () => {
  await i18n.loadNamespaces(["memory", "settings", "common"]);
});

describe("MemorySettings", () => {
  beforeEach(() => {
    useProjectStore.setState({
      projects: [{ id: "p1", name: "Sample Project" }],
    } as never);
    useMemoryStore.setState({
      entries: [
        {
          id: "planted",
          text: "Deploys go straight to production",
          scope: "project",
          projectId: "p1",
          createdAt: Date.UTC(2026, 0, 2),
          fromProjectFolder: true,
        },
        {
          id: "typed",
          text: "Alex reviews Rust himself",
          scope: "global",
          projectId: null,
          createdAt: Date.UTC(2026, 0, 3),
        },
      ],
      archived: [],
      hydrated: true,
    });
  });

  it("says which line came in from the project's folder, and only that one", () => {
    render(<MemorySettings />);
    const marks = screen.getAllByTestId("memory-from-project-folder");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("from this project's folder");
    expect(
      marks[0].closest("li")?.textContent ??
        marks[0].parentElement?.textContent,
    ).not.toContain("Alex reviews Rust himself");
  });
});
