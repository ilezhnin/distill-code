import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const WORKING_INDICATOR_ANIMATION_STORAGE_KEY =
  "flock:working-indicator-animation-enabled";
export const WORKING_INDICATOR_ANIMATION_CHANGED_EVENT =
  "flock:working-indicator-animation-changed";

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
