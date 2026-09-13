import { Fragment, memo, useMemo } from "react";
import { linkifyText } from "@/shared/lib/linkify";
import { cn } from "@/shared/lib/cn";
import { useLinkSafetyGate } from "@/shared/ui/ai-elements/link-safety-modal";

export interface LinkifiedTextProps {
  /** Raw text that may contain bare http(s) URLs. */
  text: string;
  /**
   * Render only this prefix while still parsing URLs against the full text.
   * A URL crossing the boundary is emitted as plain text rather than as a
   * clickable link with a truncated destination.
   */
  endOffset?: number;
  className?: string;
}

/**
 * Renders plain text while turning bare http(s) URLs into real links.
 *
 * Used for the text of "user" messages — which are not necessarily written by
 * the local operator: a `berdctl session send` from another agent and a
 * conductor-generated wave prompt both render as user bubbles with only a
 * `from` label. So a click goes through the same link-safety gate as an agent
 * Markdown link: a trusted domain opens straight away, anything else is
 * confirmed first.
 */
export const LinkifiedText = memo(function LinkifiedText({
  text,
  endOffset = text.length,
  className,
}: LinkifiedTextProps) {
  const segments = useMemo(() => {
    const visibleSegments = [];
    let consumed = 0;

    for (const segment of linkifyText(text)) {
      if (consumed >= endOffset) break;
      const visibleLength = Math.min(
        segment.value.length,
        endOffset - consumed,
      );
      if (visibleLength <= 0) break;
      const value = segment.value.slice(0, visibleLength);
      visibleSegments.push(
        segment.type === "link" && visibleLength === segment.value.length
          ? { ...segment, value }
          : { type: "text" as const, value },
      );
      consumed += segment.value.length;
    }

    return visibleSegments;
  }, [endOffset, text]);

  const { openExternalUrl, linkSafetyModal } = useLinkSafetyGate();

  return (
    <>
      <p className={cn("whitespace-pre-wrap wrap-anywhere", className)}>
        {segments.map((segment, index) => {
          if (segment.type === "link") {
            return (
              <a
                key={`link-${index}`}
                className="wrap-anywhere font-medium text-primary underline"
                href={segment.href}
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  openExternalUrl(segment.href);
                }}
              >
                {segment.value}
              </a>
            );
          }
          return <Fragment key={`text-${index}`}>{segment.value}</Fragment>;
        })}
      </p>
      {linkSafetyModal}
    </>
  );
});
