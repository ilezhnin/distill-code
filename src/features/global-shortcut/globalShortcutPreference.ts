import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY =
  "distill:global-shortcut-enabled";
export const GLOBAL_SHORTCUT_ENABLED_CHANGED_EVENT =
  "distill:global-shortcut-enabled-changed";

const globalShortcutEnabledPreference = createBooleanLocalStoragePreference({
  storageKey: GLOBAL_SHORTCUT_ENABLED_STORAGE_KEY,
  changedEvent: GLOBAL_SHORTCUT_ENABLED_CHANGED_EVENT,
  defaultValue: false,
});

export const getGlobalShortcutEnabled = globalShortcutEnabledPreference.get;
export const setGlobalShortcutEnabled = globalShortcutEnabledPreference.set;
export const useGlobalShortcutPreference =
  globalShortcutEnabledPreference.useValue;
