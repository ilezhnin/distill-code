import { afterEach, describe, expect, it } from "vitest";

import { useChildChatTabsStore } from "../childChatTabsStore";

function reset() {
  useChildChatTabsStore.setState({
    tabsBySession: {},
    activeChildIdBySession: {},
    openBySession: {},
  });
}

function state() {
  return useChildChatTabsStore.getState();
}

describe("childChatTabsStore", () => {
  afterEach(reset);

  it("opens a child as a tab and makes it the active one", () => {
    state().open("host", { sessionId: "child-1", name: "Atlas" });

    expect(state().openBySession.host?.sessionId).toBe("child-1");
    expect(state().activeChildIdBySession.host).toBe("child-1");
    expect(state().tabsBySession.host).toHaveLength(1);
  });

  it("keeps each conversation's tabs to itself", () => {
    state().open("host-a", { sessionId: "child-1", name: "Atlas" });
    state().open("host-b", { sessionId: "child-2", name: "Beacon" });

    expect(
      state().tabsBySession["host-a"]?.map((tab) => tab.sessionId),
    ).toEqual(["child-1"]);
    expect(
      state().tabsBySession["host-b"]?.map((tab) => tab.sessionId),
    ).toEqual(["child-2"]);
  });

  it("re-opening an open child activates it without duplicating the tab", () => {
    state().open("host", { sessionId: "child-1", name: "Atlas" });
    state().open("host", { sessionId: "child-2", name: "Beacon" });
    state().open("host", { sessionId: "child-1", name: "Atlas" });

    expect(state().tabsBySession.host?.map((tab) => tab.sessionId)).toEqual([
      "child-1",
      "child-2",
    ]);
    expect(state().activeChildIdBySession.host).toBe("child-1");
  });

  it("activate ignores a child that is not open", () => {
    state().open("host", { sessionId: "child-1", name: "Atlas" });
    state().activate("host", "never-opened");

    expect(state().activeChildIdBySession.host).toBe("child-1");
  });

  it("closing the active tab moves to its neighbour and keeps the rest", () => {
    state().open("host", { sessionId: "child-1", name: "Atlas" });
    state().open("host", { sessionId: "child-2", name: "Beacon" });
    state().closeTab("host", "child-2");

    expect(state().tabsBySession.host?.map((tab) => tab.sessionId)).toEqual([
      "child-1",
    ]);
    expect(state().openBySession.host?.sessionId).toBe("child-1");
  });

  it("closing a background tab leaves the operator on the active one", () => {
    state().open("host", { sessionId: "child-1", name: "Atlas" });
    state().open("host", { sessionId: "child-2", name: "Beacon" });
    state().activate("host", "child-2");
    state().closeTab("host", "child-1");

    expect(state().openBySession.host?.sessionId).toBe("child-2");
  });

  it("closing the last tab empties the panel", () => {
    state().open("host", { sessionId: "child-1", name: "Atlas" });
    state().closeTab("host", "child-1");

    expect(state().openBySession.host).toBeNull();
    expect(state().tabsBySession.host).toEqual([]);
  });

  it("closeAll clears one conversation's strip", () => {
    state().open("host", { sessionId: "child-1", name: "Atlas" });
    state().open("host", { sessionId: "child-2", name: "Beacon" });
    state().closeAll("host");

    expect(state().tabsBySession.host).toEqual([]);
    expect(state().openBySession.host).toBeNull();
  });
});
