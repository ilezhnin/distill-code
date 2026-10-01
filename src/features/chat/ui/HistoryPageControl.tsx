import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { useChatHistoryStore } from "../stores/chatHistoryStore";

export function HistoryPageControl({
  sessionId,
  visible,
}: {
  sessionId: string;
  visible: boolean;
}) {
  const { t } = useTranslation("chat");
  const page = useChatHistoryStore((state) => state.pages[sessionId]);
  if (!page?.cursor || !visible) return null;
  return (
    <div className="absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={page.loading}
        onClick={() => void useChatHistoryStore.getState().loadOlder(sessionId)}
      >
        {page.loading ? t("history.loading") : t("history.loadOlder")}
      </Button>
      {page.error ? (
        <span
          role="alert"
          className="rounded bg-card px-2 text-xs text-destructive"
        >
          {t("history.failed")}
        </span>
      ) : null}
    </div>
  );
}
