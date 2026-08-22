import { memo, type ReactEventHandler } from "react";
import type { ResolvedAvatarMedia } from "@/shared/avatars/catalog";
import { cn } from "@/shared/lib/cn";

interface AvatarMediaProps {
  media: ResolvedAvatarMedia;
  alt?: string;
  className?: string;
  lazy?: boolean;
  poster?: string;
  onError?: ReactEventHandler<HTMLImageElement>;
  onReady?: () => void;
}

export function avatarImageSrc(
  media: ResolvedAvatarMedia,
  poster?: string,
): string | undefined {
  if (media.mediaType === "image") {
    return media.src;
  }
  return poster ?? media.posterSrc;
}

export const AvatarMedia = memo(function AvatarMedia({
  media,
  alt = "",
  className,
  lazy = false,
  poster,
  onError,
  onReady,
}: AvatarMediaProps) {
  const src = avatarImageSrc(media, poster);
  if (!src) {
    return null;
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={lazy ? "lazy" : "eager"}
      decoding="async"
      className={cn("aspect-square size-full object-cover", className)}
      onError={onError}
      onLoad={onReady}
    />
  );
});
