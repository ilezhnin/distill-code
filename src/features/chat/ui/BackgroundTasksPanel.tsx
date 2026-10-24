import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle } from "lucide-react";
import { getClient } from "@/shared/api/acpConnection";
import { Button } from "@/shared/ui/button";
import {
  EMPTY_BACKGROUND_TASKS,
  useBackgroundTasksStore,
} from "../stores/backgroundTasksStore";

/** Session work outlives an individual answer and its collapsed step group. */
export function BackgroundTasksPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const tasks = useBackgroundTasksStore(
    (state) => state.bySession[sessionId] ?? EMPTY_BACKGROUND_TASKS,
  );
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState(false);
  if (tasks.length === 0) return null;
  const active = tasks.filter(
    (task) => task.state === "running" || task.state === "paused",
  );
  const stop = async (id: string) => {
    setStopping(id);
    setError(false);
    try {
      const client = await getClient();
      await client.extMethod("_session/async_task/stop", {
        sessionId,
        asyncTaskId: id,
      });
    } catch {
      setError(true);
    } finally {
      setStopping(null);
    }
  };
  return (
    <details
      key={`${sessionId}:${active.length > 0}`}
      open={active.length > 0}
      className="mb-2 rounded-lg border border-border px-3 py-2 text-sm"
      data-role="background-tasks"
    >
      <summary className="cursor-pointer">
        {active.length > 0
          ? t("backgroundTasks.active", { count: active.length })
          : t("backgroundTasks.history")}
      </summary>
      <div
        className="mt-2 max-h-48 space-y-2 overflow-y-auto"
        aria-live="polite"
      >
        {tasks.map((task) => {
          const working = task.state === "running" || task.state === "paused";
          return (
            <div key={task.id} className="flex items-start gap-2">
              {working && (
                <LoaderCircle
                  className="mt-0.5 size-4 shrink-0 animate-spin"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="break-words">
                  {task.description ?? task.name ?? t("backgroundTasks.task")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t(`backgroundTasks.${task.state}`)}
                </p>
                {task.summary && (
                  <p className="whitespace-pre-wrap break-words text-xs">
                    {task.summary}
                  </p>
                )}
              </div>
              {working && task.canStop && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={stopping !== null}
                  onClick={() => void stop(task.id)}
                >
                  {t("backgroundTasks.stop")}
                </Button>
              )}
            </div>
          );
        })}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {t("backgroundTasks.stopFailed")}
          </p>
        )}
      </div>
    </details>
  );
}
