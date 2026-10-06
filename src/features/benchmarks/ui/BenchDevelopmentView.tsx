import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  IconArchive,
  IconArchiveOff,
  IconChevronLeft,
  IconCopy,
  IconDots,
  IconPlayerPlay,
  IconRefresh,
} from "@tabler/icons-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { SearchBar } from "@/shared/ui/SearchBar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import type {
  BenchmarkDefinition,
  BenchmarkVersion,
  CaseStats,
} from "../types";
import { BenchmarkAttemptList } from "./BenchmarkAttemptList";
import { BenchmarkEditor } from "./BenchmarkEditor";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  BenchmarkToolbar,
  FilterMenu,
} from "./BenchmarkPrimitives";

/** Family name when the definition carries a deterministic variant generator. */
function generatorFamily(draft: BenchmarkDefinition["draft"]): string | null {
  const environment = draft.environment;
  if (!environment || typeof environment !== "object") return null;
  const generator = (environment as { generator?: unknown }).generator;
  if (!generator || typeof generator !== "object") return null;
  const family = (generator as { family?: unknown }).family;
  return typeof family === "string" && family ? family : null;
}

function randomSeed(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000) + 1;
}

/** A column heading whose meaning shows after a held hover. */
function HintedHead({ label, hint }: { label: string; hint: string }) {
  return (
    <TableHead>
      <Tooltip delayDuration={TOOLTIP_DELAY.held}>
        <TooltipTrigger asChild>
          <span>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {hint}
        </TooltipContent>
      </Tooltip>
    </TableHead>
  );
}

export function BenchDevelopmentView({
  definitions,
  loading,
  benchmarkId,
  onEdit,
  onRun,
  onEvidence,
  actions,
}: {
  definitions: BenchmarkDefinition[];
  loading: boolean;
  benchmarkId?: string;
  onEdit: (id?: string) => void;
  onRun: (versionId: string, preview?: boolean) => void;
  onEvidence: (id: string) => void;
  /** The page actions, last in the first row. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation(["benchmarks", "settings"]);
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"active" | "all">("active");
  const [tab, setTab] = useState("editor");
  const [error, setError] = useState<string | null>(null);
  const definition = definitions.find((entry) => entry.id === benchmarkId);
  // How each pool case separates the models measured on it.
  const caseStats = useQuery({
    queryKey: [...benchmarkKeys, "case-stats"],
    queryFn: benchmarkApi.getCaseStats,
    enabled: !benchmarkId,
  });
  const statsOf = useMemo(
    () =>
      new Map<string, CaseStats>(
        (caseStats.data ?? []).map((entry) => [entry.definitionId, entry]),
      ),
    [caseStats.data],
  );
  const operate = async (operation: () => Promise<void>) => {
    setError(null);
    try {
      await operation();
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    }
  };
  if (benchmarkId) {
    if (benchmarkId !== "new" && !definition) {
      return (
        <div className="space-y-5">
          <BenchmarkToolbar actions={actions} />
          {loading ? (
            <BenchmarkEmpty title={t("benchmarks:loading")} compact />
          ) : (
            <BenchmarkEmpty title={t("benchmarks:editor.missing")} />
          )}
        </div>
      );
    }
    return (
      <div className="space-y-5">
        <BenchmarkToolbar
          actions={actions}
          trailing={
            <Tabs
              value={tab}
              onValueChange={(value) =>
                useBenchmarkViewStore
                  .getState()
                  .guardNavigation(() => setTab(value))
              }
            >
              <TabsList variant="weight">
                <TabsTrigger value="editor" variant="weight">
                  {t("benchmarks:editor.tab")}
                </TabsTrigger>
                <TabsTrigger value="results" variant="weight">
                  {t("benchmarks:editor.results")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          <Button
            type="button"
            variant="ghost"
            flush
            leftIcon={<IconChevronLeft />}
            onClick={() =>
              useBenchmarkViewStore.getState().guardNavigation(() => onEdit())
            }
          >
            {t("benchmarks:actions.back")}
          </Button>
        </BenchmarkToolbar>
        <Tabs value={tab}>
          <TabsContent value="editor">
            <BenchmarkEditor
              key={benchmarkId}
              definition={definition}
              onSaved={onEdit}
              onRun={(id) => onRun(id, true)}
            />
          </TabsContent>
          <TabsContent value="results">
            <BenchmarkResults
              key={benchmarkId}
              versions={definition?.versions ?? []}
              onEvidence={onEvidence}
            />
          </TabsContent>
        </Tabs>
      </div>
    );
  }
  const needle = query.trim().toLowerCase();
  const visible = definitions.filter(
    (entry) =>
      (scope === "all" || !entry.archived) &&
      [entry.draft.name, entry.draft.taskFamily, entry.draft.workClassId]
        .join(" ")
        .toLowerCase()
        .includes(needle),
  );
  return (
    <section className="space-y-4">
      <BenchmarkToolbar
        actions={actions}
        trailing={
          <FilterMenu
            label={t("benchmarks:filters.scope")}
            value={scope}
            onChange={(value) => setScope(value === "all" ? "all" : "active")}
            options={[
              { value: "active", label: t("benchmarks:filters.active") },
              { value: "all", label: t("benchmarks:filters.includeArchived") },
            ]}
          />
        }
      >
        <SearchBar
          size="pill-card"
          value={query}
          onChange={setQuery}
          placeholder={t("benchmarks:filters.search")}
          aria-label={t("benchmarks:filters.search")}
          className="w-64"
        />
      </BenchmarkToolbar>
      {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
      {loading ? (
        <BenchmarkEmpty title={t("benchmarks:loading")} compact />
      ) : visible.length === 0 ? (
        <BenchmarkEmpty
          title={
            definitions.length === 0
              ? t("benchmarks:library.empty")
              : t("benchmarks:library.noMatch")
          }
          description={
            definitions.length === 0
              ? t("benchmarks:library.emptyHint")
              : undefined
          }
          action={
            definitions.length === 0 ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => onEdit("new")}
              >
                {t("benchmarks:actions.new")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("benchmarks:fields.name")}</TableHead>
                <TableHead>{t("benchmarks:fields.workClass")}</TableHead>
                <TableHead>{t("benchmarks:fields.difficulty")}</TableHead>
                <TableHead>{t("benchmarks:fields.split")}</TableHead>
                <TableHead>{t("benchmarks:fields.versions")}</TableHead>
                <HintedHead
                  label={t("benchmarks:tracker.passedBy")}
                  hint={t("benchmarks:tracker.passedByHint")}
                />
                <HintedHead
                  label={t("benchmarks:tracker.spread")}
                  hint={t("benchmarks:tracker.spreadHint")}
                />
                <HintedHead
                  label={t("benchmarks:tracker.flaky")}
                  hint={t("benchmarks:tracker.flakyHint")}
                />
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-normal">
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto px-0 text-sm"
                      onClick={() => onEdit(entry.id)}
                    >
                      {entry.draft.name || t("benchmarks:editor.new")}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {entry.draft.taskFamily}
                      {entry.archived
                        ? ` · ${t("benchmarks:library.archivedTag")}`
                        : ""}
                      {statsOf.get(entry.id)?.smoke
                        ? ` · ${t("benchmarks:tracker.smoke")}`
                        : ""}
                    </p>
                  </TableCell>
                  <TableCell>
                    {t(`settings:routing.classes.${entry.draft.workClassId}`, {
                      defaultValue: entry.draft.workClassId,
                    })}
                  </TableCell>
                  <TableCell>
                    {t(
                      `benchmarks:difficulty.${entry.draft.facets.difficulty ?? "unspecified"}`,
                      { defaultValue: entry.draft.facets.difficulty ?? "" },
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {t(`benchmarks:split.${entry.draft.split}`, {
                        defaultValue: entry.draft.split,
                      })}
                    </Badge>
                  </TableCell>
                  <TableCell>{entry.versions.length}</TableCell>
                  <CaseStatsCells stats={statsOf.get(entry.id)} />
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("benchmarks:actions.rowMenu", {
                            name: entry.draft.name,
                          })}
                        >
                          <IconDots />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent variant="raised" align="end">
                        <DropdownMenuItem
                          disabled={!entry.versions.length || entry.archived}
                          onSelect={() => onRun(entry.versions[0].id)}
                        >
                          <IconPlayerPlay className="size-3.5" />
                          {t("benchmarks:actions.runLatest")}
                        </DropdownMenuItem>
                        {generatorFamily(entry.draft) ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              void operate(async () => {
                                const family = generatorFamily(entry.draft);
                                if (!family) return;
                                const variant =
                                  await benchmarkApi.generateVariant(
                                    family,
                                    randomSeed(),
                                  );
                                const created =
                                  await benchmarkApi.importDefinition(variant);
                                onEdit(created.id);
                              })
                            }
                          >
                            <IconRefresh className="size-3.5" />
                            {t("benchmarks:actions.newVariant")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          onSelect={() =>
                            void operate(async () => {
                              const copy =
                                await benchmarkApi.duplicateDefinition(
                                  entry.id,
                                );
                              onEdit(copy.id);
                            })
                          }
                        >
                          <IconCopy className="size-3.5" />
                          {t("benchmarks:actions.duplicate")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() =>
                            void operate(async () => {
                              await benchmarkApi.archiveDefinition(
                                entry.id,
                                !entry.archived,
                              );
                            })
                          }
                        >
                          {entry.archived ? (
                            <IconArchiveOff className="size-3.5" />
                          ) : (
                            <IconArchive className="size-3.5" />
                          )}
                          {t(
                            entry.archived
                              ? "benchmarks:actions.restore"
                              : "benchmarks:actions.archive",
                          )}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {visible.some((entry) =>
            entry.draft.taskFamily.startsWith("seed-"),
          ) ? (
            <p className="text-xs text-muted-foreground">
              {t("benchmarks:library.seedHint")}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** A pool case's discrimination and flakiness; dashes before any model is measured. */
function CaseStatsCells({ stats }: { stats: CaseStats | undefined }) {
  const { t } = useTranslation("benchmarks");
  if (!stats || stats.models === 0)
    return (
      <>
        <TableCell className="text-muted-foreground">-</TableCell>
        <TableCell className="text-muted-foreground">-</TableCell>
        <TableCell className="text-muted-foreground">-</TableCell>
      </>
    );
  return (
    <>
      <TableCell className="tabular-nums">
        {t("tracker.passedOf", { passed: stats.passed, models: stats.models })}
      </TableCell>
      <TableCell className="tabular-nums">
        {stats.spread == null ? "-" : `${Math.round(stats.spread * 100)}%`}
      </TableCell>
      <TableCell className="tabular-nums">
        {t("tracker.passedOf", { passed: stats.flaky, models: stats.models })}
      </TableCell>
    </>
  );
}

function BenchmarkResults({
  versions,
  onEvidence,
}: {
  versions: BenchmarkVersion[];
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  if (versions.length === 0)
    return <BenchmarkEmpty title={t("results.empty")} compact />;
  return (
    <BenchmarkAttemptList
      query={{ versionIds: versions.map((version) => version.id) }}
      versions={versions}
      showModel
      onEvidence={onEvidence}
    />
  );
}
