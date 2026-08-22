import { afterEach, describe, expect, it } from "vitest";
import { useArtifactViewerStore } from "../artifactViewerStore";

function reset() {
  useArtifactViewerStore.setState({
    tabsBySession: {},
    activePathBySession: {},
    openBySession: {},
    lastClosedPathBySession: {},
  });
}

describe("artifactViewerStore", () => {
  afterEach(reset);

  it("open/close tracks per-session state and records the closed path", () => {
    const { open, close } = useArtifactViewerStore.getState();
    open("s1", { resolvedPath: "/p/a.md", filename: "a.md" });
    expect(
      useArtifactViewerStore.getState().openBySession.s1?.resolvedPath,
    ).toBe("/p/a.md");

    close("s1");
    expect(useArtifactViewerStore.getState().openBySession.s1).toBeNull();
    expect(useArtifactViewerStore.getState().lastClosedPathBySession.s1).toBe(
      "/p/a.md",
    );
  });

  it("re-opening the same path bumps revision so the viewer re-reads", () => {
    const { open } = useArtifactViewerStore.getState();
    open("s1", { resolvedPath: "/p/a.md", filename: "a.md" });
    expect(useArtifactViewerStore.getState().openBySession.s1?.revision).toBe(
      0,
    );

    // Agent re-edits the open file: auto-open fires again with the same path.
    open("s1", { resolvedPath: "/p/a.md", filename: "a.md" });
    expect(useArtifactViewerStore.getState().openBySession.s1?.revision).toBe(
      1,
    );

    // A different path opens as its own tab and becomes active.
    open("s1", { resolvedPath: "/p/b.md", filename: "b.md" });
    expect(useArtifactViewerStore.getState().openBySession.s1?.revision).toBe(
      0,
    );
    expect(
      useArtifactViewerStore.getState().tabsBySession.s1?.map((tab) => tab.filename),
    ).toEqual(["a.md", "b.md"]);
  });

  it("keeps other tabs when the active tab is closed", () => {
    const { open, close, closeTab, activate } = useArtifactViewerStore.getState();
    open("s1", { resolvedPath: "/p/a.md", filename: "a.md" });
    open("s1", { resolvedPath: "/p/b.md", filename: "b.md" });
    open("s1", { resolvedPath: "/p/c.md", filename: "c.md" });

    closeTab("s1", "/p/b.md");
    expect(
      useArtifactViewerStore.getState().tabsBySession.s1?.map((tab) => tab.filename),
    ).toEqual(["a.md", "c.md"]);
    expect(useArtifactViewerStore.getState().openBySession.s1?.filename).toBe(
      "c.md",
    );

    activate("s1", "/p/a.md");
    close("s1");
    expect(useArtifactViewerStore.getState().openBySession.s1?.filename).toBe(
      "c.md",
    );
    expect(useArtifactViewerStore.getState().tabsBySession.s1).toHaveLength(1);
  });
});
