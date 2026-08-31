/**
 * What the agents remember, in the operator's hands.
 *
 * Memory that cannot be read and deleted is not a feature, it is a leak: the
 * whole point of writing facts into every future prompt is that the operator
 * agreed to them. So this page is the full list — global first, then per
 * project — every line editable, every line removable, and each one saying
 * whether a person or an agent put it there.
 *
 * And, at the bottom, the same thing for what left the list: a memory the cap
 * displaced or an agent retired is archived rather than destroyed, and an
 * archive with no surface is a store the operator can neither read nor empty
 * (LAWS/MEMORY.md, Sovereignty).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown, IconTrash } from "@tabler/icons-react";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { openSessionDeepLink } from "@/features/sessions/lib/openSessionDeepLink";
import { createSessionDeepLink } from "@/features/sessions/lib/sessionDeepLink";
import { readTextFile } from "@/shared/api/system";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { normalizeDialogSelection } from "@/shared/lib/dialogSelection";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { SettingsPage } from "@/shared/ui/SettingsPage";
import { SettingsRow } from "@/shared/ui/settings-row";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { Switch } from "@/shared/ui/switch";

import {
  isArchiveOverfull,
  MAX_ARCHIVED_ENTRIES,
  type ArchivedMemoryEntry,
  type MemoryArchiveReason,
  type MemoryEntry,
} from "../lib/memoryEntry";
import { scanMemoryImport, type MemoryImportScan } from "../lib/memoryImport";
import {
  setMemoryReadEnabled,
  setMemoryWriteEnabled,
  useMemoryPreferences,
} from "../lib/memoryPreferences";
import {
  MAX_MEMORY_PROMPT_CHARS,
  selectPromptEntries,
} from "../lib/memoryPrompt";
import {
  composeReviewMessage,
  startMemoryReviewChat,
} from "../lib/memoryReview";
import { searchMemories } from "../lib/memorySearch";
import { WikiGraph } from "./WikiGraph";
import {
  memoryRememberRefusal,
  supersededChain,
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
 * How many memories an area may hold and still open by itself.
 *
 * An area the operator can take in at a glance should be readable without a
 * click; past that the list stops being a card and starts being the page, and
 * the other areas below it become unreachable without scrolling past it. The
 * bound is a default, never a decision — one click reopens the area, and the
 * choice is remembered for as long as the page is.
 */
const AUTO_EXPANDED_ENTRY_LIMIT = 15;

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

/**
 * The same refusals, said where the act was "bring this back".
 *
 * Only the wording of the secret line differs, and it has to: the archived
 * row is still on screen after the click, so "it was not saved" would read as
 * a claim about a line the operator can see sitting right there.
 */
const ARCHIVE_REFUSAL_MESSAGE_KEY: Record<MemoryRefusal["reason"], string> = {
  ...REFUSAL_MESSAGE_KEY,
  secret: "archive.secretRefused",
};

/**
 * Why a line is in the archive rather than in the list above it.
 *
 * Said in every row, because the three are not the same event and the
 * operator's answer differs: a fact pushed out to make room is probably worth
 * restoring, one an agent retired probably is not, and one that was replaced
 * has a successor to be read against.
 */
const ARCHIVE_REASON_KEY: Record<MemoryArchiveReason, string> = {
  capacity: "archive.reason.capacity",
  forgotten: "archive.reason.forgotten",
  superseded: "archive.reason.superseded",
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
  /**
   * When this area last changed, as the newest `createdAt` or `reinforcedAt`
   * in it — null while it holds nothing.
   *
   * A restatement counts as a change on purpose: an agent saying a fact again
   * is the operator's evidence that it is still true, which is exactly what
   * "updated" is being asked about.
   */
  updatedAt: number | null;
}

/**
 * One area's worth of archive, in the same order the page reads live memory:
 * everywhere first, then a heading per project.
 */
interface ArchiveGroup {
  key: string;
  title: string;
  entries: ArchivedMemoryEntry[];
  /**
   * True when this project's whole trace is archived — no live card exists to
   * carry the sweep, so the sweep is offered here instead. Never both: one
   * project, one button, whichever half it is shown under.
   */
  sweepable: boolean;
}

/** The newest moment anything in the group was written down or restated. */
function lastTouchedAt(entries: MemoryEntry[]): number | null {
  let newest: number | null = null;
  for (const entry of entries) {
    const touched = Math.max(entry.createdAt, entry.reinforcedAt ?? 0);
    if (newest === null || touched > newest) newest = touched;
  }
  return newest;
}

export function MemorySettings() {
  const { t } = useTranslation("memory");
  const { formatRelativeTimeToNow } = useLocaleFormatting();
  const preferences = useMemoryPreferences();
  const entries = useMemoryStore((state) => state.entries);
  const archived = useMemoryStore((state) => state.archived);
  const remember = useMemoryStore((state) => state.remember);
  const forgetProject = useMemoryStore((state) => state.forgetProject);
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
  // The review is one click and then a session create over ACP, so the button
  // says it is working. Without that the operator clicks twice and gets two
  // review chats, each proposing edits to the same list.
  const [reviewStarting, setReviewStarting] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  // Only the areas the operator has actually opened or shut are recorded, so
  // an area they never touched keeps following the size default as memories
  // come and go. Nothing about which card is open belongs in the store — it is
  // how this page is being read right now, not something the agents carry.
  const [areaOpenState, setAreaOpenState] = useState<Record<string, boolean>>(
    {},
  );
  // Shut until asked for, however much is in it. The archive is history: it is
  // read when a specific question is being asked of it, and opening the page
  // on a list of things that are no longer being told to anyone would bury the
  // list that is.
  const [archiveOpen, setArchiveOpen] = useState(false);
  // An import in flight. It is a proposal until the last step: the file is
  // read, the parser offers, and nothing reaches the store until the operator
  // ticks lines and presses the button. `importScan !== null` is the dialog
  // being open, because a dialog with nothing to show is not a state this page
  // has.
  const [importScan, setImportScan] = useState<MemoryImportScan | null>(null);
  const [importFileName, setImportFileName] = useState("");
  const [importTruncated, setImportTruncated] = useState(false);
  const [importReading, setImportReading] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  // The live row a "what replaced it" link is on its way to. Kept as state
  // rather than scrolled at the click, because the row may be inside a folded
  // area — the click opens the area, and the node only exists to scroll to
  // after that render.
  const [revealingEntryId, setRevealingEntryId] = useState<string | null>(null);

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
        updatedAt: lastTouchedAt(global),
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
      const owned = entries
        .filter((entry) => entry.projectId === projectId)
        .sort(byAge);
      result.push({
        key: projectId,
        title: name ?? t("groups.unknownProject"),
        entries: owned,
        promptIds: budget.ids,
        usedChars: budget.usedChars,
        orphaned: name === undefined,
        updatedAt: lastTouchedAt(owned),
      });
    }
    return result;
  }, [entries, projects, t]);

  const archiveGroups = useMemo<ArchiveGroup[]>(() => {
    // Newest displacement first: the archive is read backwards from what just
    // left, not forwards from what left three hundred memories ago.
    const byArchivedAt = (
      left: ArchivedMemoryEntry,
      right: ArchivedMemoryEntry,
    ) => right.archivedAt - left.archivedAt;
    const global = archived
      .filter((entry) => entry.scope === "global")
      .sort(byArchivedAt);
    const result: ArchiveGroup[] = global.length
      ? [
          {
            key: "global",
            title: t("groups.global"),
            entries: global,
            sweepable: false,
          },
        ]
      : [];
    const projectIds = [
      ...new Set(
        archived
          .filter((entry) => entry.scope === "project" && entry.projectId)
          .map((entry) => entry.projectId as string),
      ),
    ];
    for (const projectId of projectIds) {
      const name = projects.find((project) => project.id === projectId)?.name;
      result.push({
        key: projectId,
        title: name ?? t("groups.unknownProject"),
        entries: archived
          .filter((entry) => entry.projectId === projectId)
          .sort(byArchivedAt),
        sweepable:
          name === undefined &&
          projectsSettled &&
          !entries.some((entry) => entry.projectId === projectId),
      });
    }
    return result;
  }, [archived, entries, projects, projectsSettled, t]);

  // Searching the store, not the prompt block. The block is budgeted and
  // recency-ordered, so a fact that is still true but old is not in it — and
  // "what did we decide about X" is usually a question about exactly that
  // fact, quite possibly decided in another project (P32). The archive is
  // searched with it and its hits say so: a displaced line is still the
  // operator's, and search is the only way back to one.
  const hits = useMemo(
    () => (query.trim() ? searchMemories(entries, query, { archived }) : []),
    [archived, entries, query],
  );

  useEffect(() => {
    if (revealingEntryId === null) return;
    setRevealingEntryId(null);
    const row = window.document.querySelector(
      `[data-entry-id="${revealingEntryId}"]`,
    );
    if (row instanceof HTMLElement) {
      row.scrollIntoView?.({ block: "center" });
    }
  }, [revealingEntryId]);

  /** Opens the area a live memory sits in and scrolls the page to its row. */
  const revealEntry = (id: string) => {
    const target = entries.find((entry) => entry.id === id);
    if (!target) return;
    const areaKey = target.scope === "global" ? "global" : target.projectId;
    if (areaKey)
      setAreaOpenState((previous) => ({ ...previous, [areaKey]: true }));
    setRevealingEntryId(id);
  };
  const isAreaOpen = (group: MemoryGroup) =>
    areaOpenState[group.key] ??
    group.entries.length <= AUTO_EXPANDED_ENTRY_LIMIT;
  const projectNameOf = (projectId: string | null) =>
    projectId
      ? (projects.find((project) => project.id === projectId)?.name ??
        t("groups.unknownProject"))
      : t("groups.global");

  /**
   * Picks a file and reads it. The app's own file picker and the app's own
   * text read — the two the rest of Settings already choose folders and open
   * documents with — rather than a hidden `<input type="file">` this page
   * would be alone in having.
   */
  const openImport = async () => {
    setImportFailed(false);
    setImportResult(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        directory: false,
        title: t("import.open"),
        filters: [
          { name: "Markdown", extensions: ["md", "markdown", "mdx", "txt"] },
        ],
      });
      const [path] = normalizeDialogSelection(selected);
      // Nothing was chosen. Not a failure, and saying so would turn every
      // cancelled picker into an error message.
      if (!path) return;
      setImportReading(true);
      const file = await readTextFile(path);
      setImportFileName(path.split(/[/\\]/).pop() ?? path);
      setImportTruncated(file.truncated);
      setImportScan(scanMemoryImport(file.contents));
    } catch (error) {
      console.error("[memory] the import file could not be read:", error);
      setImportFailed(true);
    } finally {
      setImportReading(false);
    }
  };

  /**
   * Writes what was ticked, through `remember` and nothing else.
   *
   * No `createdBySessionId`: these are the operator's lines. They came out of
   * a file the operator chose and were ticked one by one, so marking them as
   * an agent's would put a badge on the page pointing at a chat that never
   * existed — and provenance the operator cannot trust is worse than none
   * (LAWS/MEMORY.md, Sovereignty).
   *
   * `remember` answers with the id it kept, `""` when it kept nothing, and the
   * id of an existing line when the statement was already there. All three are
   * counted and all three are said: an import that reports "12 imported" over
   * four silent refusals is the panel lying about what it holds.
   */
  const runImport = (texts: readonly string[], scopeValue: string) => {
    const projectId = scopeValue === GLOBAL_SCOPE_VALUE ? null : scopeValue;
    const before = new Set(
      useMemoryStore.getState().entries.map((entry) => entry.id),
    );
    const result: ImportResult = {
      total: texts.length,
      added: 0,
      duplicate: 0,
      refused: 0,
    };
    for (const text of texts) {
      const id =
        projectId === null
          ? remember({ text, scope: "global" })
          : remember({ text, scope: "project", projectId });
      if (!id) result.refused += 1;
      else if (before.has(id)) result.duplicate += 1;
      else {
        result.added += 1;
        before.add(id);
      }
    }
    setImportResult(result);
    setImportScan(null);
  };

  // The record is composed at the click, not held in state: the list moves
  // while this page is open, and a review of the list as it stood ten minutes
  // ago proposes merges for lines that are no longer there.
  const runReview = () => {
    setReviewFailed(false);
    setReviewStarting(true);
    void startMemoryReviewChat(
      composeReviewMessage(entries, archived.length, projectNameOf),
    )
      .catch((error: unknown) => {
        console.error("[memory] could not start the review chat:", error);
        setReviewFailed(true);
      })
      .finally(() => setReviewStarting(false));
  };

  return (
    <SettingsPage title={t("title")} description={t("description")}>
      <SettingsSections>
        {/* First, above everything the switches govern: the page's other
            sections all describe memory that is travelling, and an operator
            who wants it to stop should not have to read past the list to
            find out that they can. Neither switch deletes anything — the
            entries below stay exactly where they are. */}
        <SettingsSection title={t("controls.title")}>
          <SettingsRow
            label={t("controls.write.label")}
            description={t("controls.write.description")}
            action={
              <Switch
                checked={preferences.write}
                onCheckedChange={setMemoryWriteEnabled}
                aria-label={t("controls.write.label")}
                data-testid="memory-write-switch"
              />
            }
          />
          <SettingsRow
            label={t("controls.read.label")}
            description={t("controls.read.description")}
            action={
              <Switch
                checked={preferences.read}
                onCheckedChange={setMemoryReadEnabled}
                aria-label={t("controls.read.label")}
                data-testid="memory-read-switch"
              />
            }
          />
        </SettingsSection>

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
                    key={`${hit.archived ? "archived" : "live"}:${hit.entry.id}`}
                    data-testid="memory-search-result"
                    data-archived={hit.archived ? "true" : "false"}
                    className="rounded-md bg-accent/50 px-2 py-1.5"
                  >
                    <p className="text-sm text-foreground">
                      {hit.entry.text}
                      {/* A hit the app has stopped standing behind. Handing it
                          back unmarked would read as current, which is the one
                          thing an archived line is not. */}
                      {hit.archived ? (
                        <span
                          className="ml-1.5 rounded-full border border-dashed border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          data-testid="memory-search-archived"
                        >
                          {t("search.archived")}
                        </span>
                      ) : null}
                    </p>
                    {/* Where and when, because a fact that is true in one
                        project and stale in another is the whole reason
                        memories are scoped — and who wrote it, because a
                        memory shown anywhere must say that much
                        (LAWS/MEMORY.md, Sovereignty). Search is a surface
                        like the list and the archive: a hit that arrives
                        without the badge reads as the operator's own words. */}
                    <div className="flex items-center gap-1.5">
                      <p className="text-[11px] text-muted-foreground">
                        {t("search.provenance", {
                          scope: projectNameOf(hit.entry.projectId),
                          date: new Date(
                            hit.entry.createdAt,
                          ).toLocaleDateString(),
                        })}
                      </p>
                      <AgentProvenanceBadge
                        sessionId={hit.entry.createdBySessionId}
                      />
                    </div>
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

        {/* The same act as the field above it, in bulk: an operator arriving
            with a CLAUDE.md or a Codex memories file already wrote these
            facts down once, and retyping thirty bullets is the reason they
            would not bring them. Markdown only, and a proposal only — the
            parser offers, the ticks are the decision, and the writing goes
            through `remember` with every check that path makes. */}
        <SettingsSection title={t("import.title")}>
          <p className="text-xs text-muted-foreground">
            {t("import.description")}
          </p>
          <Button
            type="button"
            variant="subtle"
            size="sm"
            className="w-fit"
            data-testid="memory-import-open"
            disabled={importReading}
            onClick={() => void openImport()}
          >
            {importReading ? t("import.reading") : t("import.open")}
          </Button>
          {importFailed ? (
            <p
              className="text-xs text-destructive"
              data-testid="memory-import-failed"
              role="alert"
            >
              {t("import.readFailed")}
            </p>
          ) : null}
          {importResult ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="memory-import-result"
            >
              {t("import.result", {
                total: importResult.total,
                added: importResult.added,
                duplicate: importResult.duplicate,
                refused: importResult.refused,
              })}
            </p>
          ) : null}
        </SettingsSection>

        {/* Consolidation, and deliberately not a background one. The store
            catches an exact duplicate; twins and contradictions it cannot see,
            and neither can a session, which is shown the prompt block and
            never the list. So the pass is the operator's: the whole record
            goes into an ordinary chat as a message, that chat proposes, and
            nothing changes until they say so — through the same
            `distill-memory` fence every other agent writes with. */}
        <SettingsSection title={t("review.title")}>
          <p className="text-xs text-muted-foreground">
            {t("review.description")}
          </p>
          <Button
            type="button"
            variant="subtle"
            size="sm"
            className="w-fit"
            data-testid="memory-review-run"
            disabled={entries.length === 0 || reviewStarting}
            onClick={runReview}
          >
            {reviewStarting ? t("review.starting") : t("review.run")}
          </Button>
          {reviewFailed ? (
            <p
              className="text-xs text-destructive"
              data-testid="memory-review-failed"
              role="alert"
            >
              {t("review.failed")}
            </p>
          ) : null}
        </SettingsSection>

        {/* One card per area, the way the operator thinks about their
            memory: everywhere first, then a card per project. The heading
            stays the area's name and nothing else — it is what the page is
            navigated by — so the size of the area and when it last changed
            go on their own line underneath it. */}
        {groups.map((group) =>
          group.entries.length === 0 && group.key !== "global" ? null : (
            <Collapsible
              key={group.key}
              className="group/area"
              open={isAreaOpen(group)}
              onOpenChange={(open) =>
                setAreaOpenState((previous) => ({
                  ...previous,
                  [group.key]: open,
                }))
              }
            >
              <SettingsSection
                title={
                  <CollapsibleTrigger
                    className="flex w-full items-center gap-2 text-left"
                    data-testid="memory-group-toggle"
                  >
                    <IconChevronDown
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/area:-rotate-90"
                    />
                    {group.title}
                  </CollapsibleTrigger>
                }
              >
                <div className="flex flex-col gap-1.5">
                  {/* How much is in here and how long since any of it moved.
                      A shut card still says both, because the reason to shut
                      one is that its contents are settled — and "settled" is
                      a claim about exactly these two numbers. */}
                  <p
                    className="text-[11px] text-muted-foreground"
                    data-testid="memory-group-meta"
                  >
                    {group.updatedAt === null
                      ? t("groups.count", { count: group.entries.length })
                      : `${t("groups.count", {
                          count: group.entries.length,
                        })} · ${t("groups.updated", {
                          time: formatRelativeTimeToNow(group.updatedAt),
                        })}`}
                  </p>
                  {/* What a session in this scope actually carries, against
                      the budget it is carried in. Outside the fold, beside
                      the count: a card past the auto-open size starts shut,
                      and that is exactly the card where lines are being
                      crowded out — so the one number that says so was hidden
                      precisely where it was needed. */}
                  {group.entries.length === 0 ? null : (
                    <p
                      className="text-[11px] text-muted-foreground"
                      data-testid="memory-group-budget"
                    >
                      {t("groups.budget", {
                        used: group.usedChars,
                        total: MAX_MEMORY_PROMPT_CHARS,
                      })}
                    </p>
                  )}
                  <CollapsibleContent className="flex flex-col gap-1.5">
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
                          // Keyed by text as well as id: the row holds its
                          // draft in local state, so when an agent rewrites
                          // the entry while this page is open, remounting is
                          // what makes the change visible instead of the
                          // stale draft.
                          <MemoryRow
                            key={`${entry.id}:${entry.text}`}
                            entry={entry}
                            scopeLabel={projectNameOf(entry.projectId)}
                            inPrompt={group.promptIds.has(entry.id)}
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
                        className="w-fit"
                        data-testid="memory-forget-project"
                        onClick={() => setForgettingProjectId(group.key)}
                      >
                        {t("groups.forgetProject")}
                      </Button>
                    ) : null}
                  </CollapsibleContent>
                </div>
              </SettingsSection>
            </Collapsible>
          ),
        )}

        {/* What the app stopped carrying but was never allowed to destroy.
            Last on the page and shut by default — it is history, not the
            record — but present, because an archive with no surface leaves
            the operator unable to read or delete part of their own memory
            (LAWS/MEMORY.md, Sovereignty), and the recall fence answers from
            it whether the panel shows it or not. */}
        {archived.length === 0 ? null : (
          <Collapsible
            className="group/archive"
            open={archiveOpen}
            onOpenChange={setArchiveOpen}
          >
            <SettingsSection
              title={
                <CollapsibleTrigger
                  className="flex w-full items-center gap-2 text-left"
                  data-testid="memory-archive-toggle"
                >
                  <IconChevronDown
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/archive:-rotate-90"
                  />
                  {t("archive.title", { total: archived.length })}
                </CollapsibleTrigger>
              }
            >
              <div className="flex flex-col gap-1.5">
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid="memory-archive-description"
                >
                  {t("archive.description")}
                </p>
                {/* The bound, said instead of enforced. The app used to drop
                    the oldest displacements here, which is a deletion no
                    operator asked for (LAWS/MEMORY.md, Sovereignty). It now
                    keeps every one of them and says the archive wants
                    clearing out — outside the fold, because the archive is
                    shut by default and a warning nobody opens is silence. */}
                {isArchiveOverfull(archived.length) ? (
                  <p
                    className="text-xs text-destructive"
                    data-testid="memory-archive-full"
                    role="alert"
                  >
                    {t("archive.full", {
                      total: archived.length,
                      max: MAX_ARCHIVED_ENTRIES,
                    })}
                  </p>
                ) : null}
                <CollapsibleContent className="flex flex-col gap-3">
                  {archiveGroups.map((group) => (
                    <div
                      key={group.key}
                      className="flex flex-col gap-1"
                      data-testid="memory-archive-group"
                      data-archive-group={group.key}
                    >
                      <p className="text-xs font-medium text-foreground">
                        {group.title}
                      </p>
                      <ul className="flex list-none flex-col gap-1">
                        {group.entries.map((entry) => (
                          <ArchivedMemoryRow
                            key={entry.id}
                            entry={entry}
                            scopeLabel={projectNameOf(entry.projectId)}
                            // Only offered when the successor is still on the
                            // page: a link to a row that has since been
                            // deleted or archived itself goes nowhere.
                            replacementId={
                              entry.replacedById !== undefined &&
                              entries.some(
                                (live) => live.id === entry.replacedById,
                              )
                                ? entry.replacedById
                                : null
                            }
                            onRevealReplacement={revealEntry}
                          />
                        ))}
                      </ul>
                      {group.sweepable ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          destructive
                          className="w-fit"
                          data-testid="memory-forget-project"
                          onClick={() => setForgettingProjectId(group.key)}
                        >
                          {t("groups.forgetProject")}
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </CollapsibleContent>
              </div>
            </SettingsSection>
          </Collapsible>
        )}

        {/* Last on the page, and only when a project actually has a wiki: what
            a project knows is not what the operator is remembered as saying,
            and the graph is a reading of another store entirely. Behind the
            `memory-wiki-graph` experiment. */}
        <WikiGraph />
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
        // The store's own sweep rather than a filter over the live list here:
        // that filter left the project's archived rows in the document for
        // good — unreachable by recall, unnamed by any panel, and still in
        // every backup the operator takes — while the dialog said the deletion
        // could not be undone (G2/F4).
        onConfirm={() => {
          if (forgettingProjectId === null) return;
          forgetProject(forgettingProjectId);
          setForgettingProjectId(null);
        }}
      />

      {importScan === null ? null : (
        <MemoryImportDialog
          scan={importScan}
          fileName={importFileName}
          truncated={importTruncated}
          onCancel={() => setImportScan(null)}
          onImport={runImport}
        />
      )}
    </SettingsPage>
  );
}

/** What one import actually did, counted so the panel can say all of it. */
interface ImportResult {
  total: number;
  added: number;
  duplicate: number;
  refused: number;
}

/**
 * The candidates a file offered, one checkbox each.
 *
 * Nothing is ticked to begin with. A memory is carried into every later
 * prompt and mirrored into project folders, so "import everything unless you
 * object" is the wrong default for a file the app has only guessed the shape
 * of — the operator says yes, line by line, and the one click that says yes to
 * all of it is right there when the file is a good one.
 *
 * Mounted only while a file is open, which is what resets the ticks: the
 * choices belong to this file and mean nothing about the next one.
 */
function MemoryImportDialog({
  scan,
  fileName,
  truncated,
  onCancel,
  onImport,
}: {
  scan: MemoryImportScan;
  fileName: string;
  truncated: boolean;
  onCancel: () => void;
  onImport: (texts: readonly string[], scope: string) => void;
}) {
  const { t } = useTranslation("memory");
  const projects = useProjectStore((state) => state.projects);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [scope, setScope] = useState(GLOBAL_SCOPE_VALUE);
  const allChecked =
    scan.candidates.length > 0 && checked.size === scan.candidates.length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        size="lg"
        closeLabel={t("common:actions.close")}
        data-testid="memory-import-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {t("import.dialogTitle", { file: fileName })}
          </DialogTitle>
          <DialogDescription>{t("import.dialogDescription")}</DialogDescription>
        </DialogHeader>

        {/* Said as a number and never as text. A refused line is refused
            because of what is in it, and repeating it here to explain the
            refusal would put the key on screen — which is the whole thing
            being avoided. */}
        {scan.refusedSecrets > 0 ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="memory-import-secrets"
          >
            {t("import.secretsDropped", { count: scan.refusedSecrets })}
          </p>
        ) : null}
        {truncated ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="memory-import-truncated"
          >
            {t("import.truncated")}
          </p>
        ) : null}

        {scan.candidates.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="memory-import-empty"
          >
            {t("import.empty")}
          </p>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit"
              data-testid="memory-import-select-all"
              onClick={() =>
                setChecked(allChecked ? new Set() : new Set(scan.candidates))
              }
            >
              {allChecked ? t("import.selectNone") : t("import.selectAll")}
            </Button>
            <ul
              className="flex max-h-72 list-none flex-col gap-1.5 overflow-y-auto"
              data-testid="memory-import-candidates"
            >
              {scan.candidates.map((candidate) => (
                <li
                  key={candidate}
                  className="flex items-start gap-2"
                  data-testid="memory-import-candidate"
                >
                  <Checkbox
                    className="mt-0.5"
                    aria-label={candidate}
                    checked={checked.has(candidate)}
                    onCheckedChange={(next) =>
                      setChecked((previous) => {
                        const updated = new Set(previous);
                        if (next === true) updated.add(candidate);
                        else updated.delete(candidate);
                        return updated;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 text-sm text-foreground">
                    {candidate}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <DialogFooter>
          {/* The same scope choice the add form makes, and made once for the
              file rather than per line: a file is one person's notes about one
              thing, and thirty selects would be thirty chances to misfile a
              fact. */}
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            aria-label={t("import.scope")}
            data-testid="memory-import-scope"
            className="mr-auto shrink-0 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
          >
            <option value={GLOBAL_SCOPE_VALUE}>{t("groups.global")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            destructive={false}
            data-testid="memory-import-confirm"
            disabled={checked.size === 0}
            onClick={() =>
              onImport(
                // In the file's own order, not the order they were ticked:
                // what is stored should read the way the file read.
                scan.candidates.filter((candidate) => checked.has(candidate)),
                scope,
              )
            }
          >
            {t("import.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  // Why the last edit was not written. The store decides it, the row says it
  // — the same shape the add form has, because a refusal the operator cannot
  // see is indistinguishable from the app quietly dropping what they typed.
  const [refusal, setRefusal] = useState<MemoryRefusal | null>(null);
  const [confirmingForget, setConfirmingForget] = useState(false);
  // The earlier wordings that go with this row when it is deleted. Counted
  // here so the dialog can say how many, rather than promising "this cannot be
  // undone" over a quiet cascade the operator never saw.
  const supersededCount = useMemoryStore(
    (state) => supersededChain(state.archived, entry.id).size,
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
          onChange={(event) => {
            setText(event.target.value);
            // The objection was to what was typed; it goes stale the moment
            // the text does.
            setRefusal(null);
          }}
          onBlur={() => {
            if (!text.trim() || text === entry.text) {
              setText(entry.text);
              setRefusal(null);
              return;
            }
            // The refused wording stays in the field: it is the sentence the
            // operator is about to rephrase, and clearing it would make them
            // retype the very line the app just objected to.
            setRefusal(updateEntry(entry.id, text));
          }}
          aria-label={t("row.edit")}
        />
        <AgentProvenanceBadge sessionId={entry.createdBySessionId} />
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
      {refusal ? (
        <p
          className="text-xs text-destructive"
          data-testid="memory-row-refusal"
          role="alert"
        >
          {t(REFUSAL_MESSAGE_KEY[refusal.reason])}
        </p>
      ) : null}
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
          has. When the line has earlier wordings in the archive they go with
          it, and the dialog counts them: a cascade the operator is told about
          is a choice, and one they are not told about is the app deciding. */}
      <ConfirmDialog
        open={confirmingForget}
        onOpenChange={setConfirmingForget}
        title={t("row.forgetConfirmTitle")}
        description={
          supersededCount === 0
            ? t("row.forgetConfirmDescription", { text: entry.text })
            : `${t("row.forgetConfirmDescription", {
                text: entry.text,
              })} ${t("row.forgetConfirmSuperseded", {
                count: supersededCount,
              })}`
        }
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

/**
 * Who wrote this line, and the way back into the chat that did.
 *
 * Shown by every surface that shows a memory, live or archived — the law asks
 * for provenance wherever a memory appears (LAWS/MEMORY.md, Sovereignty), and
 * a badge that only the live list carried would make the archive the one place
 * the operator cannot tell their own words from an agent's.
 */
function AgentProvenanceBadge({
  sessionId,
}: {
  sessionId: string | undefined;
}) {
  const { t } = useTranslation("memory");
  // "Not in the list" is not the same as "deleted": the sidebar loads sessions
  // a page at a time, so an old chat can simply not have been fetched. The
  // badge only stops being a way in once the app has the whole list and this
  // session is not in it — until then the operator keeps the affordance
  // (LAWS/WAVES.md, Transparency) and the deep link says so itself if the
  // chat turns out to be gone.
  const sessionGone = useChatSessionStore(
    (state) =>
      sessionId !== undefined &&
      state.hasHydratedSessions &&
      !state.hasMoreSessions &&
      !state.sessions.some((session) => session.id === sessionId),
  );

  if (sessionId === undefined) return null;
  if (sessionGone) {
    // Still says an agent wrote it — that much the operator must always see —
    // but there is no chat left to open, and a link that goes nowhere is worse
    // than a plain word.
    return (
      <span
        className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] text-muted-foreground"
        data-testid="memory-from-agent"
        title={t("row.sessionGone")}
      >
        {t("row.fromAgent")}
      </span>
    );
  }
  return (
    <a
      className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[10px] underline hover:text-foreground"
      data-testid="memory-from-agent"
      href={createSessionDeepLink(sessionId)}
      rel="noreferrer"
      aria-label={t("row.openAgentChat")}
      onClick={(event) => {
        event.preventDefault();
        void openSessionDeepLink(createSessionDeepLink(sessionId)).catch(
          (error: unknown) => {
            console.error("[memory] open writing session failed:", error);
          },
        );
      }}
    >
      {t("row.fromAgent")}
    </a>
  );
}

/**
 * One line the app no longer carries.
 *
 * Read-only, deliberately: editing a memory is a claim that it is true, and
 * the answer to "this archived line is wrong" is to restore it and correct it
 * where it will actually be read, or to delete it. The two buttons are the
 * two ends of the operator's sovereignty over it — bring it back, or destroy
 * it for good — and the second asks first, exactly as the live rows do.
 */
function ArchivedMemoryRow({
  entry,
  scopeLabel,
  replacementId,
  onRevealReplacement,
}: {
  entry: ArchivedMemoryEntry;
  scopeLabel: string;
  replacementId: string | null;
  onRevealReplacement: (id: string) => void;
}) {
  const { t } = useTranslation("memory");
  const { formatDate } = useLocaleFormatting();
  const restoreArchived = useMemoryStore((state) => state.restoreArchived);
  const deleteArchived = useMemoryStore((state) => state.deleteArchived);
  // A restore the store refused. Said here rather than left as a click that
  // does nothing: a button that silently declines is the app deciding for the
  // operator without telling them it did.
  const [refusal, setRefusal] = useState<MemoryRefusal | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <li
      className="flex flex-col gap-1 py-1"
      data-testid="memory-archive-entry"
      data-archived-id={entry.id}
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {entry.text}
        </p>
        <AgentProvenanceBadge sessionId={entry.createdBySessionId} />
        <Button
          type="button"
          variant="subtle"
          size="sm"
          className="shrink-0"
          data-testid="memory-archive-restore"
          onClick={() => setRefusal(restoreArchived(entry.id))}
        >
          {t("archive.restore")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          destructive
          onClick={() => setConfirmingDelete(true)}
          aria-label={t("archive.delete")}
        >
          <IconTrash />
        </Button>
      </div>
      {refusal ? (
        <p
          className="text-xs text-destructive"
          data-testid="memory-archive-refusal"
          role="alert"
        >
          {t(ARCHIVE_REFUSAL_MESSAGE_KEY[refusal.reason])}
        </p>
      ) : null}
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="memory-archive-meta"
      >
        {t("archive.meta", {
          reason: t(ARCHIVE_REASON_KEY[entry.archiveReason]),
          scope: scopeLabel,
          date: formatDate(entry.archivedAt, MEMORY_DATE_OPTIONS),
        })}
      </p>
      {/* A replaced line is only half a fact on its own: the question it
          raises is what it was replaced *with*, and that row is somewhere
          above on this same page. */}
      {replacementId === null ? null : (
        <button
          type="button"
          className="w-fit text-[11px] text-muted-foreground underline hover:text-foreground"
          data-testid="memory-archive-replacement"
          onClick={() => onRevealReplacement(replacementId)}
        >
          {t("archive.showReplacement")}
        </button>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t("archive.deleteConfirmTitle")}
        description={t("archive.deleteConfirmDescription", {
          text: entry.text,
        })}
        cancelLabel={t("common:actions.cancel")}
        confirmLabel={t("archive.delete")}
        onConfirm={() => {
          deleteArchived(entry.id);
          setConfirmingDelete(false);
        }}
      />
    </li>
  );
}
