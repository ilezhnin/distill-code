/**
 * A notice from the app, as one line in the transcript.
 *
 * The app speaks in a chat when something about the run itself matters — a
 * step running on a fallback model, a wave that stopped, a request it could
 * not carry out. Those notices used to be coloured boxes of paragraphs, and a
 * wave that ended badly stacked four of them: the chat read as alarms rather
 * than as a conversation. A notice is now one line with its kind on an icon;
 * its first paragraph is the line, the rest is one click away, and an action
 * it offers stays a button under it.
 */

import { useState } from "react";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconInfoCircle,
} from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { DisclosureLine } from "@/shared/ui/ai-elements/disclosure-line";

export interface SystemNoticeLineProps {
  kind: "error" | "warning" | "info";
  text: string;
  action?: { label?: string; onClick: () => void } | null;
}

/** The notice's first paragraph, and what follows it. */
export function splitNotice(text: string): {
  headline: string;
  detail: string;
} {
  const [headline = "", ...rest] = text.trim().split(/\n\s*\n/);
  return { headline: headline.trim(), detail: rest.join("\n\n").trim() };
}

export function SystemNoticeLine({
  kind,
  text,
  action,
}: SystemNoticeLineProps) {
  const [open, setOpen] = useState(false);
  const { headline, detail } = splitNotice(text);
  const Icon =
    kind === "error"
      ? IconAlertCircle
      : kind === "warning"
        ? IconAlertTriangle
        : IconInfoCircle;
  const icon = (
    <Icon
      aria-hidden
      className={cn(
        "size-3.5 shrink-0",
        kind === "error"
          ? "text-destructive"
          : kind === "warning"
            ? "text-warning"
            : "text-muted-foreground",
      )}
    />
  );
  return (
    <div
      role={kind === "info" ? "status" : "alert"}
      data-notice-kind={kind}
      className={cn(
        "min-w-0 text-left text-sm",
        kind === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {detail ? (
        <DisclosureLine
          icon={icon}
          label={headline}
          open={open}
          onOpenChange={setOpen}
        >
          <p className="pt-1 pl-5 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {detail}
          </p>
        </DisclosureLine>
      ) : (
        <p className="flex min-w-0 items-start gap-1.5">
          <span className="flex h-5 items-center">{icon}</span>
          <span className="min-w-0 [overflow-wrap:anywhere]">{headline}</span>
        </p>
      )}
      {action?.label ? (
        <div className="pt-1 pl-5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
