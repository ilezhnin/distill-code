import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const WORKING_INDICATOR_ANIMATION_STORAGE_KEY =
  "distill:working-indicator-animation-enabled";
export const WORKING_INDICATOR_ANIMATION_CHANGED_EVENT =
  "distill:working-indicator-animation-changed";

const workingIndicatorAnimationPreference = createBooleanLocalStoragePreference(
  {
    storageKey: WORKING_INDICATOR_ANIMATION_STORAGE_KEY,
    changedEvent: WORKING_INDICATOR_ANIMATION_CHANGED_EVENT,
  },
);

export const setWorkingIndicatorAnimationEnabled =
  workingIndicatorAnimationPreference.set;
export const useWorkingIndicatorAnimationPreference =
  workingIndicatorAnimationPreference.useValue;
