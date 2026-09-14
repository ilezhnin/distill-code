import { useState, useCallback } from "react";
import { useArtifactActionsContext } from "@/features/chat/hooks/ArtifactPolicyContext";
import type { OpenLocalMarkdownLink } from "@/shared/ui/ai-elements/local-link-context";

/**
 * Opens local Markdown destinations for one message bubble, reporting a
 * failure ("File not found: …") inside that bubble rather than as a toast.
 *
 * The routing itself lives in `MarkdownLink`, which cancels the click and calls
 * the nearest `LocalMarkdownLinkProvider` — so external links, Berd deep links
 * and raw-HTML anchors are all classified in one place, and every Markdown
 * surface is covered rather than only the ones that wrap their content in a
 * delegated container handler. The bubble supplies this handler through that
 * provider, narrowing the chat-wide one from `ArtifactPolicyProvider`.
 */
export function useArtifactLinkHandler() {
  const { resolveMarkdownHref, openResolvedPath } = useArtifactActionsContext();
  const [pathNotice, setPathNotice] = useState<string | null>(null);

  const openLocalLink = useCallback<OpenLocalMarkdownLink>(
    (href) => {
      const resolved = resolveMarkdownHref(href);
      if (!resolved) return;

      setPathNotice(null);
      void openResolvedPath(resolved.resolvedPath).catch((err) => {
        setPathNotice(err instanceof Error ? err.message : String(err));
      });
    },
    [resolveMarkdownHref, openResolvedPath],
  );

  return { openLocalLink, pathNotice };
}
