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

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { openSessionDeepLink } from "@/features/sessions/lib/openSessionDeepLink";
import { createSessionDeepLink } from "@/features/sessions/lib/sessionDeepLink";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";

import type { MemoryEntry } from "../lib/memoryEntry";
import {
  MAX_MEMORY_PROMPT_CHARS,
  selectPromptEntries,
} from "../lib/memoryPrompt";
import { searchMemories } from "../lib/memorySearch";
import {
  memoryRememberRefusal,
  useMemoryStore,
  type MemoryRefusal,
} from "../stores/memoryStore";

/** The add form's scope select keeps "everywhere" apart from project ids. */
const GLOBAL_SCOPE_VALUE = "global";

/**
 * Dates on this page read as dates, not as timestamps: the operator asks
 * "when did we decide this", not "at which minute". Same options the other
 * settings surfaces use, through the shared formatter so the app's language
 * decides the locale rather than the browser's.
 */
const MEMORY_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};

/**
 * What the operator is told when the store refuses their draft.
 *
 * One line per reason the store can give, so a refusal never reaches them as
 * silence — a typed line that simply fails to appear is the app losing an
 * action the operator took, which is worse than saying no.
 */
const REFUSAL_MESSAGE_KEY: Record<MemoryRefusal["reason"], string> = {
  secret: "add.secretRefused",
  "no-project": "add.noProjectRefused",
  blank: "add.blankRefused",
};

interface MemoryGroup {
  key: string;
  title: string;
  entries: MemoryEntry[];
  /**
   * The ids this group's entries would have in a session's prompt block, and
   * what that block costs.
   *
   * Each group is measured with its own project's reach, and the global group
   * with `null`. That is an approximation, and deliberately the optimistic
   * one: inside a project the global lines compete with that project's, so a
   * global memory shown here as carried may still be crowded out in a project
   * session. The panel says the best case rather than inventing a project to
   * judge it in — and the honest badge for the other direction ("crowded
   * out") is never shown to something that is in fact carried.
   */
  promptIds: Set<string>;
  usedChars: number;
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
  const [refusal, setRefusal] = useState<MemoryRefusal | null>(null);
  const [forgettingProjectId, setForgettingProjectId] = useState<string | null>(
    null,
  );

  const groups = useMemo<MemoryGroup[]>(() => {
    const byAge = (left: MemoryEntry, right: MemoryEntry) =>
      right.createdAt - left.createdAt;
    const global = entries.filter((entry) => entry.scope === "global");
    const globalBudget = selectPromptEntries(entries, null);
    const result: MemoryGroup[] = [
      {
        key: "global",
        title: t("groups.global"),
        entries: global.sort(byAge),
        promptIds: globalBudget.ids,
        usedChars: globalBudget.usedChars,
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
      const budget = selectPromptEntries(entries, projectId);
      result.push({
        key: projectId,
        title: name ?? t("groups.unknownProject"),
        entries: entries
          .filter((entry) => entry.projectId === projectId)
          .sort(byAge),
        promptIds: budget.ids,
        usedChars: budget.usedChars,
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

        {/* Who is allowed to write here at all (P35). The rule lives in
            `memoryWriteAccess` and was enforced everywhere and stated
            nowhere — so the operator could see facts appear and had no way to
            know which agents could have put them there. */}
        <SettingsSection title={t("access.title")}>
          <ul
            className="flex list-none flex-col gap-0.5 text-xs text-muted-foreground"
            data-testid="memory-access-summary"
          >
            <li>{t("access.operator")}</li>
            <li>{t("access.conductor")}</li>
            <li>{t("access.orchestrator")}</li>
            <li>{t("access.worker")}</li>
          </ul>
        </SettingsSection>

        <SettingsSection title={t("add.title")}>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              const scope =
                draftScope === GLOBAL_SCOPE_VALUE ? "global" : "project";
              const projectId = scope === "project" ? draftScope : null;
              // The store's own verdict, asked before the write rather than
              // guessed at here: a refusal decided twice, in two places,
              // drifts, and the operator is the one who pays for the drift.
              const verdict = memoryRememberRefusal({ text, scope }, projectId);
              if (verdict) {
                // The draft stays in the field. A refused statement is one the
                // operator will want to rephrase, and clearing it would make
                // them retype the very sentence the app just objected to.
                setRefusal(verdict);
                return;
              }
              remember(
                projectId === null
                  ? { text, scope: "global" }
                  : { text, scope: "project", projectId },
              );
              setRefusal(null);
              setDraft("");
            }}
          >
            <Input
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                // The objection was to what was typed; the moment it changes,
                // the objection is stale.
                setRefusal(null);
              }}
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
          {refusal ? (
            <p
              className="text-xs text-destructive"
              data-testid="memory-add-refusal"
              role="alert"
            >
              {t(REFUSAL_MESSAGE_KEY[refusal.reason])}
            </p>
          ) : null}
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
                <div className="flex flex-col gap-1.5">
                  {/* What a session in this scope actually carries, against
                      the budget it is carried in. Without it a long list
                      reads as a long prompt. It sits under the heading
                      rather than in it: the heading names the group, and a
                      number that changes with every edit is not its name. */}
                  <p
                    className="text-[11px] text-muted-foreground"
                    data-testid="memory-group-budget"
                  >
                    {t("groups.budget", {
                      used: group.usedChars,
                      total: MAX_MEMORY_PROMPT_CHARS,
                    })}
                  </p>
                  <ul className="flex list-none flex-col gap-1">
                    {group.entries.map((entry) => (
                      // Keyed by text as well as id: the row holds its draft in
                      // local state, so when an agent rewrites the entry while
                      // this page is open, remounting is what makes the change
                      // visible instead of the stale draft.
                      <MemoryRow
                        key={`${entry.id}:${entry.text}`}
                        entry={entry}
                        scopeLabel={projectNameOf(entry.projectId)}
                        inPrompt={group.promptIds.has(entry.id)}
                      />
                    ))}
                  </ul>
                </div>
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

function MemoryRow({
  entry,
  scopeLabel,
  inPrompt,
}: {
  entry: MemoryEntry;
  scopeLabel: string;
  inPrompt: boolean;
}) {
  const { t } = useTranslation("memory");
  const { formatDate } = useLocaleFormatting();
  const updateEntry = useMemoryStore((state) => state.updateEntry);
  const forget = useMemoryStore((state) => state.forget);
  const [text, setText] = useState(entry.text);
  const [confirmingForget, setConfirmingForget] = useState(false);

  const agentSessionId = entry.createdBySessionId;
  // "Not in the list" is not the same as "deleted": the sidebar loads sessions
  // a page at a time, so an old chat can simply not have been fetched. The
  // badge only stops being a way in once the app has the whole list and this
  // session is not in it — until then the operator keeps the affordance
  // (LAWS/WAVES.md, Transparency) and the deep link says so itself if the
  // chat turns out to be gone.
  const sessionGone = useChatSessionStore(
    (state) =>
      agentSessionId !== undefined &&
      state.hasHydratedSessions &&
      !state.hasMoreSessions &&
      !state.sessions.some((session) => session.id === agentSessionId),
  );

  return (
    <li
      className="flex flex-col gap-1 py-1"
      data-testid="memory-entry"
      data-entry-id={entry.id}
    >
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (text.trim() && text !== entry.text) updateEntry(entry.id, text);
            else setText(entry.text);
          }}
          aria-label={t("row.edit")}
        />
        {agentSessionId === undefined ? null : sessionGone ? (
          // Still says an agent wrote it — that much the operator must always
          // see (LAWS/MEMORY.md, Sovereignty) — but there is no chat left to
          // open, and a link that goes nowhere is worse than a plain word.
          <span
            className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground"
            data-testid="memory-from-agent"
            title={t("row.sessionGone")}
          >
            {t("row.fromAgent")}
          </span>
        ) : (
          <a
            className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] underline hover:text-foreground"
            data-testid="memory-from-agent"
            href={createSessionDeepLink(agentSessionId)}
            rel="noreferrer"
            aria-label={t("row.openAgentChat")}
            onClick={(event) => {
              event.preventDefault();
              void openSessionDeepLink(
                createSessionDeepLink(agentSessionId),
              ).catch((error: unknown) => {
                console.error("[memory] open writing session failed:", error);
              });
            }}
          >
            {t("row.fromAgent")}
          </a>
        )}
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
      </div>
      {/* Kept or crowded out. A memory the operator wrote down and the block
          cannot carry is the app's most confusing state — "I told you this"
          against an agent that never saw it — so the row says which it is,
          and says the same thing the prompt does because both read the one
          selection. Crowded out is not lost: search finds it here, and a
          session can ask for it through the recall fence. */}
      <span
        className={cn(
          "w-fit shrink-0 rounded-full px-1.5 py-0.5 text-[10px]",
          inPrompt
            ? "bg-accent text-muted-foreground"
            : "border border-dashed border-border text-muted-foreground",
        )}
        data-testid="memory-prompt-state"
        data-in-prompt={inPrompt}
      >
        {inPrompt ? t("row.inPrompt") : t("row.crowdedOut")}
      </span>
      {/* Where it applies and when it was last true. A memory with no date
          reads as timeless, and the operator's first question about a fact
          they no longer recognise is when it was written down. */}
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="memory-entry-meta"
      >
        {entry.reinforcedAt
          ? t("row.metaReinforced", {
              scope: scopeLabel,
              created: formatDate(entry.createdAt, MEMORY_DATE_OPTIONS),
              reinforced: formatDate(entry.reinforcedAt, MEMORY_DATE_OPTIONS),
            })
          : t("row.meta", {
              scope: scopeLabel,
              created: formatDate(entry.createdAt, MEMORY_DATE_OPTIONS),
            })}
      </p>
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
