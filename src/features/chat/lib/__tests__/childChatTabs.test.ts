import { describe, expect, it } from "vitest";

import {
  activeChildTabAfterClose,
  canOpenChildChatTab,
  MAX_CHILD_CHAT_TABS,
  openChildChatTabs,
  resolveActiveChildTab,
  resolveSidePanelSurface,
  type ChildChatTab,
} from "../childChatTabs";

function tab(sessionId: string, name = sessionId): ChildChatTab {
  return { sessionId, name };
}

describe("resolveSidePanelSurface", () => {
  it("leaves the region empty when neither surface has anything open", () => {
    expect(
      resolveSidePanelSurface({ hasChildChatTab: false, hasArtifact: false }),
    ).toBe("none");
  });

  it("gives the region to the artifact viewer when only it is open", () => {
    expect(
      resolveSidePanelSurface({ hasChildChatTab: false, hasArtifact: true }),
    ).toBe("artifact");
  });

  it("lets a child chat take the region from an open artifact", () => {
    expect(
      resolveSidePanelSurface({ hasChildChatTab: true, hasArtifact: true }),
    ).toBe("child-chat");
  });
});

describe("canOpenChildChatTab", () => {
  const childSessionIds = ["child-1", "child-2"];

  it("opens a tab for a known child of this conversation", () => {
    expect(
      canOpenChildChatTab({
        childSessionId: "child-1",
        hostSessionId: "host",
        childSessionIds,
      }),
    ).toBe(true);
  });

  it("refuses an id that is not a child of this conversation", () => {
    expect(
      canOpenChildChatTab({
        childSessionId: "stranger",
        hostSessionId: "host",
        childSessionIds,
      }),
    ).toBe(false);
  });

  it("refuses the host conversation itself", () => {
    expect(
      canOpenChildChatTab({
        childSessionId: "host",
        hostSessionId: "host",
        childSessionIds: ["host", ...childSessionIds],
      }),
    ).toBe(false);
  });

  it("refuses a chip with no session behind it", () => {
    expect(
      canOpenChildChatTab({
        childSessionId: null,
        hostSessionId: "host",
        childSessionIds,
      }),
    ).toBe(false);
    expect(
      canOpenChildChatTab({
        childSessionId: "",
        hostSessionId: "host",
        childSessionIds,
      }),
    ).toBe(false);
  });
});

describe("openChildChatTabs", () => {
  it("appends a new child in open order", () => {
    const tabs = openChildChatTabs(openChildChatTabs([], tab("a")), tab("b"));
    expect(tabs.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
  });

  it("keeps an already-open child in place and refreshes its label", () => {
    const tabs = openChildChatTabs(
      [tab("a", "Atlas"), tab("b", "Beacon")],
      tab("a", "Atlas (renamed)"),
    );
    expect(tabs.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
    expect(tabs[0]?.name).toBe("Atlas (renamed)");
  });

  it("drops the oldest tab once the cap is exceeded", () => {
    let tabs: ChildChatTab[] = [];
    for (let index = 0; index < MAX_CHILD_CHAT_TABS + 2; index += 1) {
      tabs = openChildChatTabs(tabs, tab(`c${index}`));
    }
    expect(tabs).toHaveLength(MAX_CHILD_CHAT_TABS);
    expect(tabs[0]?.sessionId).toBe("c2");
    expect(tabs.at(-1)?.sessionId).toBe(`c${MAX_CHILD_CHAT_TABS + 1}`);
  });

  it("re-opening an existing tab at the cap evicts nothing", () => {
    let tabs: ChildChatTab[] = [];
    for (let index = 0; index < MAX_CHILD_CHAT_TABS; index += 1) {
      tabs = openChildChatTabs(tabs, tab(`c${index}`));
    }
    const reopened = openChildChatTabs(tabs, tab("c0", "still here"));
    expect(reopened).toHaveLength(MAX_CHILD_CHAT_TABS);
    expect(reopened[0]?.sessionId).toBe("c0");
  });
});

describe("activeChildTabAfterClose", () => {
  const tabs = [tab("a"), tab("b"), tab("c")];

  it("lands on the right-hand neighbour when the active tab closes", () => {
    expect(activeChildTabAfterClose(tabs, "b", "b")).toBe("c");
  });

  it("falls back to the left when the last tab closes", () => {
    expect(activeChildTabAfterClose(tabs, "c", "c")).toBe("b");
  });

  it("leaves the operator where they are when a background tab closes", () => {
    expect(activeChildTabAfterClose(tabs, "a", "c")).toBe("a");
  });

  it("returns nothing when the only tab closes", () => {
    expect(activeChildTabAfterClose([tab("a")], "a", "a")).toBeNull();
  });
});

describe("resolveActiveChildTab", () => {
  it("falls back to the first tab when the active id is gone", () => {
    expect(
      resolveActiveChildTab([tab("a"), tab("b")], "vanished")?.sessionId,
    ).toBe("a");
  });

  it("has nothing to show when no tabs are open", () => {
    expect(resolveActiveChildTab([], "a")).toBeNull();
    expect(resolveActiveChildTab(undefined, "a")).toBeNull();
  });
});
