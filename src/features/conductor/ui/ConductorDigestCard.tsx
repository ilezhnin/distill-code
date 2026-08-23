import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

/**
 * A wave/brigade digest, rendered as a compact system card.
 *
 * The digest is a genuine user message — that is the whole mechanism, it is
 * what wakes the parent's model — but it is not something the operator typed,
 * and rendering a wall of machine-facing report JSON as a chat bubble makes the
 * conversation unreadable. Contract 3 of the combined plan says card, so: one
 * line of chrome, the report body folded away behind it.
 *
 * Collapsed by default and expandable, rather than truncated: the reports are
 * the only record of what the brigade actually said, and a digest whose content
 * could not be read back would defeat the point of publishing it at all.
 */
export function ConductorDigestCard({
  body,
  className,
}: {
  body: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-accent p-2 text-xs text-muted-foreground",
        className,
      )}
      data-testid="conductor-digest-card"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate font-medium">
          {t("conductor.wave.digest.cardTitle")}
        </span>
        {body ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded
              ? t("conductor.wave.digest.collapse")
              : t("conductor.wave.digest.expand")}
          </Button>
        ) : null}
      </div>
      {expanded && body ? (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans">
          {body}
        </pre>
      ) : null}
    </div>
  );
}
