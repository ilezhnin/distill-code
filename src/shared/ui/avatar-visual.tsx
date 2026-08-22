import type { ReactNode } from "react";
import { useAvatarImage, useAvatarMedia } from "@/shared/hooks/useAvatarSrc";
import type { Avatar } from "@/shared/types/agents";
import { AvatarMedia } from "@/shared/ui/avatar-media";

interface AvatarVisualProps {
  avatar: Avatar | null | undefined;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
}

/**
 * Renders every supported avatar representation through one still-image
 * surface. Catalog videos keep their poster when that is all Distill has.
 */
export function AvatarVisual({
  avatar,
  alt = "",
  className,
  fallback = null,
}: AvatarVisualProps) {
  const image = useAvatarImage(avatar);
  const media = useAvatarMedia(avatar);

  const staticImage = image ?? media?.posterSrc;
  if (staticImage) {
    return (
      <img
        src={staticImage}
        alt={alt}
        className={className}
        data-avatar-visual="image"
      />
    );
  }

  if (media) {
    return <AvatarMedia media={media} alt={alt} className={className} />;
  }

  return <>{fallback}</>;
}
