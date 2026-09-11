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
  SHORTCUT_COMMANDS,
  SHORTCUT_PREFERENCES_STORAGE_KEY,
  shortcutScopesOverlap,
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

describe("shortcut command definitions", () => {
  it("ships no colliding default combos across overlapping scopes", () => {
    isDesignSystemExplorerEnabledMock.mockReturnValue(true);

    // Deliberate exceptions, both reconciled by ChatSearchBar stopping
    // propagation of consumed keys (Ctrl+N/Ctrl+P off macOS).
    const allowed = new Set([
      "chat.search.next|navigation.newConversation",
      "chat.search.previous|session.quickSwitch",
    ]);
    for (const platform of ["mac", "windows"] as const) {
      getPlatformMock.mockReturnValue(platform);
      const enabled = SHORTCUT_COMMANDS.filter(
        (command) => command.when?.() ?? true,
      );
      for (const a of enabled) {
        for (const b of enabled) {
          if (a.id >= b.id) continue;
          if (!shortcutScopesOverlap(a.scope, b.scope)) continue;
          if (allowed.has(`${a.id}|${b.id}`)) continue;
          const bCombos = new Set(
            getShortcutBindings(b.id).map((binding) => binding.shortcut),
          );
          for (const binding of getShortcutBindings(a.id)) {
            expect(
              bCombos.has(binding.shortcut),
              `${platform}: ${a.id} and ${b.id} share ${binding.shortcut}`,
            ).toBe(false);
          }
        }
      }
    }
  });
});

describe("reading stored preferences", () => {
  it("falls back to defaults for invalid JSON, wrong versions, and hostile overrides", () => {
    // Invalid JSON.
    storeRaw("{not json");
    expect(overridesById(), "invalid JSON").toEqual({});
    expect(getShortcutBindings("navigation.search"), "invalid JSON").toEqual([
      { shortcut: "meta+k" },
    ]);

    // Wrong version.
    storePreferences({ "navigation.search": "meta+y" }, 2);
    expect(overridesById(), "wrong version").toEqual({});
    expect(getShortcutBindings("navigation.search"), "wrong version").toEqual([
      { shortcut: "meta+k" },
    ]);

    // Unknown ids, non-configurable ids, and invalid combos.
    storePreferences({
      "nope.unknown": "meta+y",
      "chat.mention.confirm": "meta+y",
      "navigation.search": "shift+k",
      "navigation.newConversation": 42,
      "navigation.closeSession": "garbage+x",
    });
    expect(overridesById(), "hostile overrides").toEqual({});
    expect(getShortcutBindings("chat.mention.confirm")).toEqual([
      { shortcut: "enter" },
    ]);
    expect(
      getShortcutBindings("navigation.search"),
      "hostile overrides",
    ).toEqual([{ shortcut: "meta+k" }]);
  });

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
