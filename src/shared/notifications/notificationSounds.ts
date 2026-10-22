export const SILENT_NOTIFICATION_SOUND = "silent";
export const DEFAULT_NOTIFICATION_SOUND = "flock-sounds-4.mp3";

export const NOTIFICATION_SOUNDS = [
  {
    id: DEFAULT_NOTIFICATION_SOUND,
    labelKey: "notifications.sounds.politeHonk",
    resource: "flock-sounds-4.mp3",
    url: new URL("../../../resources/flock-sounds-4.mp3", import.meta.url).href,
  },
  {
    id: "flock-sounds-0.mp3",
    labelKey: "notifications.sounds.quickPeep",
    resource: "flock-sounds-0.mp3",
    url: new URL("../../../resources/flock-sounds-0.mp3", import.meta.url).href,
  },
  {
    id: "flock-sounds-1.mp3",
    labelKey: "notifications.sounds.twinkle",
    resource: "flock-sounds-1.mp3",
    url: new URL("../../../resources/flock-sounds-1.mp3", import.meta.url).href,
  },
  {
    id: "flock-sounds-2.mp3",
    labelKey: "notifications.sounds.dingDong",
    resource: "flock-sounds-2.mp3",
    url: new URL("../../../resources/flock-sounds-2.mp3", import.meta.url).href,
  },
  {
    id: "flock-sounds-3.mp3",
    labelKey: "notifications.sounds.paidInBread",
    resource: "flock-sounds-3.mp3",
    url: new URL("../../../resources/flock-sounds-3.mp3", import.meta.url).href,
  },
  {
    id: "flock-sounds-5.mp3",
    labelKey: "notifications.sounds.beakYeah",
    resource: "flock-sounds-5.mp3",
    url: new URL("../../../resources/flock-sounds-5.mp3", import.meta.url).href,
  },
  {
    id: "flock-sounds-6.mp3",
    labelKey: "notifications.sounds.badNewsBird",
    resource: "flock-sounds-6.mp3",
    url: new URL("../../../resources/flock-sounds-6.mp3", import.meta.url).href,
  },
] as const;

export type NotificationSoundId =
  | typeof SILENT_NOTIFICATION_SOUND
  | (typeof NOTIFICATION_SOUNDS)[number]["id"];

export function isNotificationSoundId(
  sound: unknown,
): sound is NotificationSoundId {
  return (
    sound === SILENT_NOTIFICATION_SOUND ||
    NOTIFICATION_SOUNDS.some((item) => item.id === sound)
  );
}

/** Prefix every bundled sound id shares (`flock-sounds-<n>.mp3`). */
const SOUND_ID_PREFIX = "flock-sounds-";
/**
 * Prefix of the sound ids that builds before the Levocat Flock rename saved
 * in the notification preferences. The sound files were renamed with the
 * product, so a saved id that still names the old file is read as the
 * renamed one instead of being reset to the default sound. The left spelling
 * is a read-only compatibility literal; its unit test fails if a rename sweep
 * rewrites it.
 */
const LEGACY_SOUND_ID_PREFIX = "distill-sounds-";

export function normalizeNotificationSoundId(
  sound: unknown,
): NotificationSoundId {
  if (isNotificationSoundId(sound)) return sound;
  if (typeof sound === "string" && sound.startsWith(LEGACY_SOUND_ID_PREFIX)) {
    const renamed = `${SOUND_ID_PREFIX}${sound.slice(LEGACY_SOUND_ID_PREFIX.length)}`;
    if (isNotificationSoundId(renamed)) return renamed;
  }
  return DEFAULT_NOTIFICATION_SOUND;
}

export function getNotificationSoundResource(
  sound: NotificationSoundId,
): string | undefined {
  if (sound === SILENT_NOTIFICATION_SOUND) return undefined;
  return NOTIFICATION_SOUNDS.find((item) => item.id === sound)?.resource;
}

export function playNotificationSound(sound: NotificationSoundId): void {
  if (sound === SILENT_NOTIFICATION_SOUND || typeof Audio === "undefined") {
    return;
  }

  const url = NOTIFICATION_SOUNDS.find((item) => item.id === sound)?.url;
  if (!url) return;

  void new Audio(url).play().catch(() => {});
}
