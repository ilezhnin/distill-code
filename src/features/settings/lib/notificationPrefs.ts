import { getPreferenceStorage } from "@/shared/preferences/rootSettings";
import {
  DEFAULT_NOTIFICATION_SOUND,
  normalizeNotificationSoundId,
  type NotificationSoundId,
} from "@/shared/notifications/notificationSounds";

const STORAGE_KEY = "distill:notifications";

export interface NotificationPrefs {
  enabled: boolean;
  inApp: boolean;
  desktop: boolean;
  inAppSound: NotificationSoundId;
  desktopSound: NotificationSoundId;
}

const DEFAULTS: NotificationPrefs = {
  enabled: true,
  inApp: true,
  desktop: true,
  inAppSound: DEFAULT_NOTIFICATION_SOUND,
  desktopSound: DEFAULT_NOTIFICATION_SOUND,
};

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const raw = getPreferenceStorage()?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      ...DEFAULTS,
      ...parsed,
      inAppSound: normalizeNotificationSoundId(parsed.inAppSound),
      desktopSound: normalizeNotificationSoundId(parsed.desktopSound),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function setNotificationPrefs(prefs: Partial<NotificationPrefs>): void {
  try {
    const current = getNotificationPrefs();
    getPreferenceStorage()?.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...current, ...prefs }),
    );
  } catch {
    // localStorage unavailable in some environments
  }
}
