import type { CompactionUpdate, ContentBlock } from "@agentclientprotocol/sdk";
import { useTranslation } from "react-i18next";
import { Reasoning, ReasoningTrigger } from "@/shared/ui/ai-elements/reasoning";
import { CollapsibleContent } from "@/shared/ui/collapsible";
import { MessageResponse } from "@/shared/ui/ai-elements/message";
import { ClickableImage } from "./ClickableImage";
import { resolveImageContentSrc } from "./resolveImageContentSrc";

function SummaryBlock({ block }: { block: ContentBlock }) {
  if (block.type === "text")
    return <MessageResponse>{block.text}</MessageResponse>;
  if (block.type === "image") {
    const src = resolveImageContentSrc(block, () => false);
    return src ? <ClickableImage src={src} alt={block.mimeType} /> : null;
  }
  if (block.type === "resource" && "text" in block.resource) {
    return <MessageResponse>{block.resource.text}</MessageResponse>;
  }
  // Keep opaque content identifiable without treating arbitrary resource URIs as executable links.
  return (
    <span className="text-xs text-muted-foreground">
      {block.type === "resource_link"
        ? (block.title ?? block.name)
        : block.type === "resource"
          ? block.resource.uri
          : block.mimeType}
    </span>
  );
}

export function CompactionNotice({
  compaction,
}: {
  compaction: CompactionUpdate;
}) {
  const { t } = useTranslation("chat");
  const label =
    compaction.status === "in_progress"
      ? t("loading.compacting")
      : compaction.status === "completed"
        ? t("notifications.compactionComplete")
        : compaction.status === "failed"
          ? t("notifications.compactionFailed")
          : compaction.status === "cancelled"
            ? t("notifications.compactionCancelled")
            : t("notifications.compactionStatus", {
                status: compaction.status,
              });
  return (
    <Reasoning
      defaultOpen={false}
      isStreaming={compaction.status === "in_progress"}
      stateKey={`compaction:${compaction.compactionId}`}
    >
      <ReasoningTrigger getThinkingMessage={() => label} />
      <CollapsibleContent className="space-y-2 text-sm">
        {compaction.error ? (
          <p className="text-destructive">{compaction.error}</p>
        ) : null}
        {compaction.summary?.map((block, index) => (
          // Blocks form an append-only stream until a complete replacement arrives.
          // biome-ignore lint/suspicious/noArrayIndexKey: ACP content blocks have no identity.
          <SummaryBlock key={index} block={block} />
        ))}
      </CollapsibleContent>
    </Reasoning>
  );
}
