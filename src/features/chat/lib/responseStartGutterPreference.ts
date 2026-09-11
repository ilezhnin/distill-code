import { createBooleanLocalStoragePreference } from "@/shared/preferences/createBooleanLocalStoragePreference";

export const RESPONSE_START_GUTTER_STORAGE_KEY =
  "distill:response-start-gutter-enabled";
export const RESPONSE_START_GUTTER_CHANGED_EVENT =
  "distill:response-start-gutter-changed";

const responseStartGutterPreference = createBooleanLocalStoragePreference({
  storageKey: RESPONSE_START_GUTTER_STORAGE_KEY,
  changedEvent: RESPONSE_START_GUTTER_CHANGED_EVENT,
  defaultValue: false,
});

export const useResponseStartGutterPreference =
  responseStartGutterPreference.useValue;
