import { convertFileSrc } from "@tauri-apps/api/core";
import { type ComponentProps, memo, useEffect, useState } from "react";
import { useArtifactActionsContext } from "@/features/chat/hooks/ArtifactPolicyContext";
import { ClickableImage } from "./ClickableImage";
import { assetUrlToPath } from "./resolveImageContentSrc";

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

function isRemoteOrDataSrc(src: string): boolean {
  // Remote (http/https) and inline (data:/blob:) sources are handled by the
  // browser/CSP directly — this override only rescues LOCAL file paths.
  return /^(https?:|data:|blob:)/i.test(src.trim());
}

/**
 * Renders a Markdown image whose `src` points at a local file in the session
 * working directory by routing it through the Tauri `asset:` scheme (the same
 * mechanism avatars/artifacts use), so `![alt](./photo.jpg)` renders inline
 * instead of a broken image. Scoped to the session working directory via
 * `ArtifactPolicyContext`; remote http(s) images are left to the
 * (CSP-blocking) default renderer.
 *
 * Lives in `features/chat` (not `shared/ui`) because it depends on the chat
 * artifact-policy machinery; it is injected into the shared `MessageResponse`
 * via the `imageRenderer` prop so `shared/ui` stays free of chat-feature
 * imports.
 */
export const MarkdownImage = memo(
  ({
    src,
    alt,
    node: _node,
    ...rest
  }: ComponentProps<"img"> & { node?: unknown }) => {
    const { resolveMarkdownHref, pathExists, isPathWithinTrustedRoots } =
      useArtifactActionsContext();
    const [assetSrc, setAssetSrc] = useState<string | null>(null);

    const rawSrc = typeof src === "string" ? src : "";
    // `http://asset.localhost/<encoded path>` names a local file while looking
    // like a remote URL, and Markdown can spell one directly. Left to the
    // "remote" branch it would render straight from the asset scope ($HOME/**),
    // sidestepping the cwd scoping this component exists to apply — so it is
    // treated as a local candidate and checked like one.
    const assetPath = rawSrc.length > 0 ? assetUrlToPath(rawSrc) : null;
    const isLocalCandidate =
      rawSrc.length > 0 && (assetPath !== null || !isRemoteOrDataSrc(rawSrc));

    useEffect(() => {
      if (!isLocalCandidate) {
        setAssetSrc(null);
        return;
      }
      let cancelled = false;
      // Clear any previously resolved image immediately so switching between
      // two valid local images never shows the stale one while the new
      // existence check is in flight.
      setAssetSrc(null);
      // An asset URL already carries an absolute path, so it is scoped against
      // the chat's folders directly. A Markdown destination goes through
      // resolveMarkdownHref, which returns null for blocked schemes and
      // resolves relative paths against the session cwd; the resolved path must
      // be contained within that cwd, so absolute paths (`/abs/private.png`)
      // and `..`-escapes (`../../private.png`) are rejected rather than
      // rendered from outside the working directory.
      let resolvedPath: string | null = null;
      if (assetPath !== null) {
        resolvedPath = isPathWithinTrustedRoots(assetPath) ? assetPath : null;
      } else {
        const candidate = resolveMarkdownHref(rawSrc);
        resolvedPath = candidate?.isWithinSessionCwd
          ? candidate.resolvedPath
          : null;
      }
      if (!resolvedPath || !IMAGE_EXTENSION_RE.test(resolvedPath)) {
        return;
      }
      const targetPath = resolvedPath;
      void pathExists(targetPath)
        .then((exists) => {
          if (cancelled) return;
          setAssetSrc(exists ? convertFileSrc(targetPath, "asset") : null);
        })
        .catch(() => {
          // A failed existence check must not leave a stale image rendered or
          // surface as an unhandled rejection — fall back to the default <img>.
          if (!cancelled) setAssetSrc(null);
        });
      return () => {
        cancelled = true;
      };
    }, [
      isLocalCandidate,
      assetPath,
      rawSrc,
      resolveMarkdownHref,
      pathExists,
      isPathWithinTrustedRoots,
    ]);

    if (assetSrc) {
      return <ClickableImage src={assetSrc} alt={alt ?? ""} />;
    }

    // An asset URL that did not survive the check must not be handed to the
    // browser: the webview would fetch it happily and render the very file the
    // check rejected. Nothing is shown instead.
    if (assetPath !== null) {
      return null;
    }

    // Fall back to the default rendering for remote images and local files
    // that are missing, unsupported, or outside the session working directory.
    return <img src={src} alt={alt ?? ""} {...rest} />;
  },
);
MarkdownImage.displayName = "MarkdownImage";
