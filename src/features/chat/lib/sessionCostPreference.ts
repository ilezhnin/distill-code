import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const SESSION_COST_STORAGE_KEY = "distill:session-cost-enabled";
export const SESSION_COST_CHANGED_EVENT = "distill:session-cost-changed";

const sessionCostPreference = createBooleanLocalStoragePreference({
  storageKey: SESSION_COST_STORAGE_KEY,
  changedEvent: SESSION_COST_CHANGED_EVENT,
});

export const useSessionCostPreference = sessionCostPreference.useValue;
