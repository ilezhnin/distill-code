/**
 * The planner, as the operator sees it.
 *
 * Four tabs over one list, the way the original Distill's planner reads:
 * Today is the working list (what is late and what is due), Scheduled is the
 * future, All is everything open in its own bucket, Completed is the archive.
 * Every decision about which task belongs where lives in `plannerTask` and is
 * tested there; this component renders that answer and nothing more.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconCheck,
  IconFlag,
  IconRepeat,
  IconTrash,
} from "@tabler/icons-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";

import {
  countForTab,
  groupTasksForTab,
  isComplete,
  isDoneForToday,
  startOfLocalDay,
  type PlannerRepeat,
  type PlannerTab,
  type PlannerTask,
  type Weekday,
} from "../lib/plannerTask";
import { usePlannerStore } from "../stores/plannerStore";

const TABS: readonly PlannerTab[] = ["today", "scheduled", "all", "completed"];
const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];

/** `<input type="date">` speaks YYYY-MM-DD in local time. */
function parseDateInput(value: string): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return startOfLocalDay(new Date(year, month - 1, day).getTime()).valueOf();
}

function formatDue(ms: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

export function PlannerPanel({ className }: { className?: string }) {
  const { t, i18n } = useTranslation("planner");
  const tasks = usePlannerStore((state) => state.tasks);
  const addTask = usePlannerStore((state) => state.addTask);
  const toggleComplete = usePlannerStore((state) => state.toggleComplete);
  const updateTask = usePlannerStore((state) => state.updateTask);
  const removeTask = usePlannerStore((state) => state.removeTask);

  const [tab, setTab] = useState<PlannerTab>("today");
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<"normal" | "high">("normal");
  const [repeatKind, setRepeatKind] = useState<"none" | "daily" | "weekly">(
    "none",
  );
  const [weekdays, setWeekdays] = useState<Weekday[]>([]);

  // One clock reading shared by every bucket decision, refreshed on a timer
  // rather than read per call: two tasks must never land in different buckets
  // because midnight passed between two reads, and a list left open across
  // midnight should re-bucket itself rather than lie until the next click.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const groups = useMemo(
    () => groupTasksForTab(tasks, tab, nowMs),
    [nowMs, tab, tasks],
  );

  const submit = useCallback(() => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const repeat: PlannerRepeat | null =
      repeatKind === "daily"
        ? { kind: "daily" }
        : repeatKind === "weekly"
          ? { kind: "weekly", days: weekdays }
          : null;
    addTask({
      title: trimmed,
      dueAt: parseDateInput(due),
      priority,
      repeat,
    });
    setTitle("");
    setDue("");
    setPriority("normal");
    setRepeatKind("none");
    setWeekdays([]);
  }, [addTask, due, priority, repeatKind, title, weekdays]);

  const toggleWeekday = useCallback((day: Weekday) => {
    setWeekdays((current) =>
      current.includes(day)
        ? current.filter((entry) => entry !== day)
        : [...current, day],
    );
  }, []);

  return (
    <section
      className={cn("flex w-full flex-col gap-3", className)}
      data-testid="planner"
      aria-label={t("title")}
    >
      <div className="flex flex-wrap items-center gap-1" role="tablist">
        {TABS.map((entry) => (
          <Button
            key={entry}
            type="button"
            role="tab"
            aria-selected={tab === entry}
            variant={tab === entry ? "subtle" : "ghost"}
            size="xs"
            onClick={() => setTab(entry)}
            data-testid={`planner-tab-${entry}`}
          >
            {t(`tabs.${entry}`)}
            <span className="tabular-nums opacity-60">
              {countForTab(tasks, entry, nowMs)}
            </span>
          </Button>
        ))}
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("add.placeholder")}
            aria-label={t("add.placeholder")}
            data-testid="planner-add-title"
          />
          <Button
            type="submit"
            variant="subtle"
            size="sm"
            disabled={!title.trim()}
          >
            {t("add.submit")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <input
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            aria-label={t("add.due")}
            data-testid="planner-add-due"
            className="rounded-md border border-input bg-background px-2 py-1 text-foreground"
          />
          <select
            value={repeatKind}
            onChange={(event) =>
              setRepeatKind(event.target.value as typeof repeatKind)
            }
            aria-label={t("add.repeat")}
            data-testid="planner-add-repeat"
            className="rounded-md border border-input bg-background px-2 py-1 text-foreground"
          >
            <option value="none">{t("repeat.none")}</option>
            <option value="daily">{t("repeat.daily")}</option>
            <option value="weekly">{t("repeat.weekly")}</option>
          </select>
          {repeatKind === "weekly" ? (
            <div
              className="flex flex-wrap gap-1"
              data-testid="planner-weekdays"
            >
              {WEEKDAYS.map((day) => (
                <Button
                  key={day}
                  type="button"
                  variant={weekdays.includes(day) ? "subtle" : "ghost"}
                  size="xxs"
                  aria-pressed={weekdays.includes(day)}
                  onClick={() => toggleWeekday(day)}
                >
                  {t(`weekdays.${day}`)}
                </Button>
              ))}
            </div>
          ) : null}
          <Button
            type="button"
            variant={priority === "high" ? "subtle" : "ghost"}
            size="xxs"
            aria-pressed={priority === "high"}
            onClick={() =>
              setPriority((current) => (current === "high" ? "normal" : "high"))
            }
            leftIcon={<IconFlag />}
            data-testid="planner-add-priority"
          >
            {t("add.priority")}
          </Button>
        </div>
      </form>

      {groups.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="planner-empty"
        >
          {t(`empty.${tab}`)}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div key={group.id} className="flex flex-col gap-1">
              {tab === "completed" ? null : (
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t(`groups.${group.id}`)}
                </h3>
              )}
              <ul className="flex list-none flex-col gap-1">
                {group.tasks.map((task) => (
                  <PlannerRow
                    key={task.id}
                    task={task}
                    nowMs={nowMs}
                    locale={i18n.language}
                    onToggle={() => toggleComplete(task.id)}
                    onTogglePriority={() =>
                      updateTask(task.id, {
                        priority: task.priority === "high" ? "normal" : "high",
                      })
                    }
                    onRemove={() => removeTask(task.id)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PlannerRow({
  task,
  nowMs,
  locale,
  onToggle,
  onTogglePriority,
  onRemove,
}: {
  task: PlannerTask;
  nowMs: number;
  locale: string;
  onToggle: () => void;
  onTogglePriority: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("planner");
  const done = isComplete(task);
  const rolledToday = isDoneForToday(task, nowMs);

  return (
    <li
      className="flex items-center gap-2 rounded-md bg-accent px-2 py-1.5"
      data-testid="planner-task"
      data-task-id={task.id}
      data-complete={done ? "true" : "false"}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onToggle}
        aria-label={done ? t("row.reopen") : t("row.complete")}
        aria-pressed={done}
      >
        <IconCheck className={cn(!done && !rolledToday && "opacity-25")} />
      </Button>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          done && "line-through opacity-60",
        )}
      >
        {task.title}
      </span>
      {task.priority === "high" ? (
        <span
          className="rounded-full bg-background px-1.5 py-0.5 text-[10px] font-medium"
          data-testid="planner-high"
        >
          {t("badges.high")}
        </span>
      ) : null}
      {task.repeat ? (
        <IconRepeat
          className="size-3.5 opacity-60"
          aria-label={t("badges.repeats")}
          data-testid="planner-repeats"
        />
      ) : null}
      {task.createdBySessionId ? (
        <span
          className="rounded-full bg-background px-1.5 py-0.5 text-[10px]"
          data-testid="planner-from-agent"
        >
          {t("badges.agent")}
        </span>
      ) : null}
      {task.dueAt !== null ? (
        <span className="shrink-0 text-[11px] tabular-nums opacity-70">
          {formatDue(task.dueAt, locale)}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onTogglePriority}
        aria-label={t("row.togglePriority")}
        aria-pressed={task.priority === "high"}
      >
        <IconFlag />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        destructive
        onClick={onRemove}
        aria-label={t("row.remove")}
      >
        <IconTrash />
      </Button>
    </li>
  );
}
