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
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";

import type { MemoryEntry } from "../lib/memoryEntry";
import { searchMemories } from "../lib/memorySearch";
import { useMemoryStore } from "../stores/memoryStore";

/** The add form's scope select keeps "everywhere" apart from project ids. */
const GLOBAL_SCOPE_VALUE = "global";

interface MemoryGroup {
  key: string;
  title: string;
  entries: MemoryEntry[];
  /**
   * A project group whose project no longer exists. `parseEntry` keeps such
   * entries on purpose — dropping them at read time would be the app silently
   * deleting the operator's data — so the page names the situation and offers
   * the one deliberate way out: a button, behind a confirmation.
   */
  orphaned: boolean;
}

export function MemorySettings() {
  const { t } = useTranslation("memory");
  const entries = useMemoryStore((state) => state.entries);
  const remember = useMemoryStore((state) => state.remember);
  const replaceAll = useMemoryStore((state) => state.replaceAll);
  const projects = useProjectStore((state) => state.projects);
  // Until the backend list has actually been fetched, "no such project" may
  // just mean "not loaded yet" — no deletion is offered on that basis.
  const projectsSettled = useProjectStore((state) => state.hasFetchedProjects);

  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [draftScope, setDraftScope] = useState(GLOBAL_SCOPE_VALUE);
  const [forgettingProjectId, setForgettingProjectId] = useState<string | null>(
    null,
  );

  const groups = useMemo<MemoryGroup[]>(() => {
    const byAge = (left: MemoryEntry, right: MemoryEntry) =>
      right.createdAt - left.createdAt;
    const global = entries.filter((entry) => entry.scope === "global");
    const result: MemoryGroup[] = [
      {
        key: "global",
        title: t("groups.global"),
        entries: global.sort(byAge),
        orphaned: false,
      },
    ];
    const projectIds = [
      ...new Set(
        entries
          .filter((entry) => entry.scope === "project" && entry.projectId)
          .map((entry) => entry.projectId as string),
      ),
    ];
    for (const projectId of projectIds) {
      const name = projects.find((project) => project.id === projectId)?.name;
      result.push({
        key: projectId,
        title: name ?? t("groups.unknownProject"),
        entries: entries
          .filter((entry) => entry.projectId === projectId)
          .sort(byAge),
        orphaned: name === undefined,
      });
    }
    return result;
  }, [entries, projects, t]);

  // Searching the store, not the prompt block. The block is budgeted and
  // recency-ordered, so a fact that is still true but old is not in it — and
  // "what did we decide about X" is usually a question about exactly that
  // fact, quite possibly decided in another project (P32).
  const hits = useMemo(
    () => (query.trim() ? searchMemories(entries, query) : []),
    [entries, query],
  );
  const projectNameOf = (projectId: string | null) =>
    projectId
      ? (projects.find((project) => project.id === projectId)?.name ??
        t("groups.unknownProject"))
      : t("groups.global");

  return (
    <SettingsPage title={t("title")} description={t("description")}>
      <SettingsSections>
        <SettingsSection title={t("search.title")}>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
            data-testid="memory-search-input"
          />
          {query.trim() ? (
            hits.length === 0 ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="memory-search-empty"
              >
                {t("search.empty")}
              </p>
            ) : (
              <ul
                className="flex list-none flex-col gap-1"
                data-testid="memory-search-results"
              >
                {hits.map((hit) => (
                  <li
                    key={hit.entry.id}
                    data-testid="memory-search-result"
                    className="rounded-md bg-accent/50 px-2 py-1.5"
                  >
                    <p className="text-sm text-foreground">{hit.entry.text}</p>
                    {/* Where and when, because a fact that is true in one
                        project and stale in another is the whole reason
                        memories are scoped. */}
                    <p className="text-[11px] text-muted-foreground">
                      {t("search.provenance", {
                        scope: projectNameOf(hit.entry.projectId),
                        date: new Date(
                          hit.entry.createdAt,
                        ).toLocaleDateString(),
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </SettingsSection>

        <SettingsSection title={t("add.title")}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              remember(
                draftScope === GLOBAL_SCOPE_VALUE
                  ? { text, scope: "global" }
                  : { text, scope: "project", projectId: draftScope },
              );
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
            {/* The projects the sidebar knows are the ones a memory can be
                scoped to; "everywhere" stays the default so typing and
                pressing Enter behaves exactly as before. */}
            <select
              value={draftScope}
              onChange={(event) => setDraftScope(event.target.value)}
              aria-label={t("add.scope")}
              data-testid="memory-add-scope"
              className="shrink-0 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
            >
              <option value={GLOBAL_SCOPE_VALUE}>{t("groups.global")}</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
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
                    // Keyed by text as well as id: the row holds its draft in
                    // local state, so when an agent rewrites the entry while
                    // this page is open, remounting is what makes the change
                    // visible instead of the stale draft.
                    <MemoryRow
                      key={`${entry.id}:${entry.text}`}
                      entry={entry}
                    />
                  ))}
                </ul>
              )}
              {group.orphaned && projectsSettled ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  destructive
                  data-testid="memory-forget-project"
                  onClick={() => setForgettingProjectId(group.key)}
                >
                  {t("groups.forgetProject")}
                </Button>
              ) : null}
            </SettingsSection>
          ),
        )}
      </SettingsSections>

      {/* No automatic sweep: entries whose project is gone are still the
          operator's data, and the app deleting them quietly is exactly the
          kind of silent substitution this codebase forbids. Deletion happens
          only here, on an explicit click, behind a confirmation. */}
      <ConfirmDialog
        open={forgettingProjectId !== null}
        onOpenChange={(open) => {
          if (!open) setForgettingProjectId(null);
        }}
        title={t("groups.forgetProjectConfirmTitle")}
        description={t("groups.forgetProjectConfirmDescription")}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("groups.forgetProjectConfirm")}
        onConfirm={() => {
          if (forgettingProjectId === null) return;
          replaceAll(
            useMemoryStore
              .getState()
              .entries.filter(
                (entry) => entry.projectId !== forgettingProjectId,
              ),
          );
          setForgettingProjectId(null);
        }}
      />
    </SettingsPage>
  );
}

function MemoryRow({ entry }: { entry: MemoryEntry }) {
  const { t } = useTranslation("memory");
  const updateEntry = useMemoryStore((state) => state.updateEntry);
  const forget = useMemoryStore((state) => state.forget);
  const [text, setText] = useState(entry.text);
  const [confirmingForget, setConfirmingForget] = useState(false);

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
        onClick={() => setConfirmingForget(true)}
        aria-label={t("row.forget")}
      >
        <IconTrash />
      </Button>
      {/* Deleting is irreversible — there is no undo and no trash — so it
          gets the same confirmation every other destructive settings action
          has. */}
      <ConfirmDialog
        open={confirmingForget}
        onOpenChange={setConfirmingForget}
        title={t("row.forgetConfirmTitle")}
        description={t("row.forgetConfirmDescription", { text: entry.text })}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("row.forget")}
        onConfirm={() => {
          forget(entry.id);
          setConfirmingForget(false);
        }}
      />
    </li>
  );
}
