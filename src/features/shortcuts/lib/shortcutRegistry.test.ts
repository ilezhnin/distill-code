import { beforeEach, describe, expect, it, vi } from "vitest";

const getPlatformMock = vi.hoisted(() => vi.fn(() => "mac"));
vi.mock("@/shared/lib/platform", () => ({
  getPlatform: getPlatformMock,
}));

const isDesignSystemExplorerEnabledMock = vi.hoisted(() => vi.fn());
vi.mock("@/features/design-system/lib/designSystemEnabled", () => ({
  isDesignSystemExplorerEnabled: isDesignSystemExplorerEnabledMock,
}));

import {
  eventMatchesShortcutCommand,
  getShortcutBindings,
  resolveShortcutCommands,
  SHORTCUT_PREFERENCES_STORAGE_KEY,
} from "./shortcutRegistry";

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

function storeRaw(raw: string) {
  localStorage.setItem(SHORTCUT_PREFERENCES_STORAGE_KEY, raw);
}

function storePreferences(overrides: Record<string, unknown>, version = 1) {
  storeRaw(JSON.stringify({ version, overrides }));
}

function overridesById(): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const command of resolveShortcutCommands()) {
    if (command.override) overrides[command.id] = command.override;
  }
  return overrides;
}

beforeEach(() => {
  localStorage.clear();
  getPlatformMock.mockReturnValue("mac");
  isDesignSystemExplorerEnabledMock.mockReturnValue(false);
});

describe("reading stored preferences", () => {
  it("resolves cascading collisions to a fixpoint with no live duplicates", () => {
    // newConversation's candidate loses to closeSession's and revives its
    // meta+n default — which must then invalidate search's already-walked
    // claim on meta+n. A single pass would leave both live.
    storePreferences({
      "navigation.search": "meta+n",
      "navigation.newConversation": "meta+q",
      "navigation.closeSession": "meta+q",
    });
    expect(overridesById()).toEqual({
      "navigation.closeSession": "meta+q",
    });
    expect(getShortcutBindings("navigation.search")).toEqual([
      { shortcut: "meta+k" },
    ]);
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "n", metaKey: true }),
        "navigation.search",
      ),
      "meta+n must match exactly one command",
    ).toBe(false);
    expect(
      eventMatchesShortcutCommand(
        keyEvent({ key: "n", metaKey: true }),
        "navigation.newConversation",
      ),
    ).toBe(true);
  });
});
