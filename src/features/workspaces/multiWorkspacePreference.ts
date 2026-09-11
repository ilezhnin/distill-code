import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const MULTI_WORKSPACE_STORAGE_KEY = "distill:multi-workspace-enabled";
const MULTI_WORKSPACE_CHANGED_EVENT = "distill:multi-workspace-changed";

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
