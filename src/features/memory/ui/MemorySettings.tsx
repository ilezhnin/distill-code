/**
 * What the agents remember, in the operator's hands.
 *
 * Memory that cannot be read and deleted is not a feature, it is a leak: the
 * whole point of writing facts into every future prompt is that the operator
 * agreed to them. So this page is the full list — global first, then per
 * project — every line editable, every line removable, and each one saying
 * whether a person or an agent put it there.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconTrash } from "@tabler/icons-react";

import { useProjectStore } from "@/features/projects/stores/projectStore";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";

import type { MemoryEntry } from "../lib/memoryEntry";
import { useMemoryStore } from "../stores/memoryStore";

interface MemoryGroup {
  key: string;
  title: string;
  entries: MemoryEntry[];
}

export function MemorySettings() {
  const { t } = useTranslation("memory");
  const entries = useMemoryStore((state) => state.entries);
  const remember = useMemoryStore((state) => state.remember);
  const projects = useProjectStore((state) => state.projects);

  const [draft, setDraft] = useState("");

  const groups = useMemo<MemoryGroup[]>(() => {
    const byAge = (left: MemoryEntry, right: MemoryEntry) =>
      right.createdAt - left.createdAt;
    const global = entries.filter((entry) => entry.scope === "global");
    const result: MemoryGroup[] = [
      { key: "global", title: t("groups.global"), entries: global.sort(byAge) },
    ];
    const projectIds = [
      ...new Set(
        entries
          .filter((entry) => entry.scope === "project" && entry.projectId)
          .map((entry) => entry.projectId as string),
      ),
    ];
    for (const projectId of projectIds) {
      const name =
        projects.find((project) => project.id === projectId)?.name ??
        t("groups.unknownProject");
      result.push({
        key: projectId,
        title: name,
        entries: entries
          .filter((entry) => entry.projectId === projectId)
          .sort(byAge),
      });
    }
    return result;
  }, [entries, projects, t]);

  return (
    <SettingsPage title={t("title")} description={t("description")}>
      <SettingsSections>
        <SettingsSection title={t("add.title")}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              // Only global can be typed here: a project memory has to be
              // written where the project is known, and this page is not.
              remember({ text, scope: "global" });
              setDraft("");
            }}
          >
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("add.placeholder")}
              aria-label={t("add.placeholder")}
              data-testid="memory-add-input"
            />
            <Button
              type="submit"
              variant="subtle"
              size="sm"
              disabled={!draft.trim()}
            >
              {t("add.submit")}
            </Button>
          </form>
        </SettingsSection>

        {groups.map((group) =>
          group.entries.length === 0 && group.key !== "global" ? null : (
            <SettingsSection key={group.key} title={group.title}>
              {group.entries.length === 0 ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="memory-empty"
                >
                  {t("empty")}
                </p>
              ) : (
                <ul className="flex list-none flex-col gap-1">
                  {group.entries.map((entry) => (
                    <MemoryRow key={entry.id} entry={entry} />
                  ))}
                </ul>
              )}
            </SettingsSection>
          ),
        )}
      </SettingsSections>
    </SettingsPage>
  );
}

function MemoryRow({ entry }: { entry: MemoryEntry }) {
  const { t } = useTranslation("memory");
  const updateEntry = useMemoryStore((state) => state.updateEntry);
  const forget = useMemoryStore((state) => state.forget);
  const [text, setText] = useState(entry.text);

  return (
    <li
      className="flex items-center gap-2"
      data-testid="memory-entry"
      data-entry-id={entry.id}
    >
      <Input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text.trim() && text !== entry.text) updateEntry(entry.id, text);
          else setText(entry.text);
        }}
        aria-label={t("row.edit")}
      />
      {entry.createdBySessionId ? (
        <span
          className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px]"
          data-testid="memory-from-agent"
        >
          {t("row.fromAgent")}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        destructive
        onClick={() => forget(entry.id)}
        aria-label={t("row.forget")}
      >
        <IconTrash />
      </Button>
    </li>
  );
}
