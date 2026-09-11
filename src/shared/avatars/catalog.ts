export const APP_AVATAR_REF_PREFIX = "app-avatar:" as const;
export const USER_AVATAR_REF_PREFIX = "user-avatar:" as const;
export const AGENT_AVATAR_REF_PREFIX = "agent-avatar:" as const;

export type AvatarMediaType = "image" | "video";
export type AvatarAlphaMode = "stacked";

export interface ResolvedAvatarMedia {
  src: string;
  mediaType: AvatarMediaType;
  alphaMode?: AvatarAlphaMode;
  posterSrc?: string;
}

export interface CachedAvatarAsset {
  id: string;
  path: string;
  mimeType: string;
  alphaMode?: AvatarAlphaMode;
  posterPath?: string;
}

export interface CachedAvatar {
  catalogVersion: string;
  collectionId: string;
  asset: CachedAvatarAsset;
}

const APP_AVATAR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * `app-avatar:<id>` refs pointed into the avatar library earlier builds
 * downloaded from Block's CDN. That library is gone, but personas saved back
 * then still carry the refs; they stay recognised so they are kept as-is and
 * render as a missing avatar instead of being mistaken for a URL.
 */
export function parseAvatarRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(APP_AVATAR_REF_PREFIX)) {
    return undefined;
  }

  const id = trimmed.slice(APP_AVATAR_REF_PREFIX.length);
  return APP_AVATAR_ID_PATTERN.test(id) ? id : undefined;
}

export function isAppAvatarRef(value: string): boolean {
  return parseAvatarRef(value) !== undefined;
}

export function userAvatarRef(id: string): string {
  return `${USER_AVATAR_REF_PREFIX}${id}`;
}

export function parseUserAvatarRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(USER_AVATAR_REF_PREFIX)) {
    return undefined;
  }

  const id = trimmed.slice(USER_AVATAR_REF_PREFIX.length);
  return APP_AVATAR_ID_PATTERN.test(id) ? id : undefined;
}

export function isUserAvatarRef(value: string): boolean {
  return parseUserAvatarRef(value) !== undefined;
}

export function agentAvatarRef(id: string): string {
  return `${AGENT_AVATAR_REF_PREFIX}${id}`;
}

export function parseAgentAvatarRef(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(AGENT_AVATAR_REF_PREFIX)) {
    return undefined;
  }

  const id = trimmed.slice(AGENT_AVATAR_REF_PREFIX.length);
  return APP_AVATAR_ID_PATTERN.test(id) ? id : undefined;
}

export function isAgentAvatarRef(value: string): boolean {
  return parseAgentAvatarRef(value) !== undefined;
}

export function mediaTypeFromMimeType(mimeType: string): AvatarMediaType {
  return mimeType.toLowerCase().startsWith("video/") ? "video" : "image";
}
