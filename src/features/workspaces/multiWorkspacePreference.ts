import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const MULTI_WORKSPACE_STORAGE_KEY = "flock:multi-workspace-enabled";
const MULTI_WORKSPACE_CHANGED_EVENT = "flock:multi-workspace-changed";

const multiWorkspacePreference = createBooleanLocalStoragePreference({
  storageKey: MULTI_WORKSPACE_STORAGE_KEY,
  changedEvent: MULTI_WORKSPACE_CHANGED_EVENT,
  defaultValue: false,
});

export function getMultiWorkspaceEnabled(): boolean {
  return multiWorkspacePreference.get();
}

export const setMultiWorkspaceEnabled = multiWorkspacePreference.set;

export function useMultiWorkspacePreference() {
  return multiWorkspacePreference.useValue();
}
