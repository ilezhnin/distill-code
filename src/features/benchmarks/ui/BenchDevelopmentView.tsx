import { Label } from "@/shared/ui/label";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import type { BenchmarkDefinition } from "../types";
import { BenchmarkEditor } from "./BenchmarkEditor";
import { BenchmarkNotice } from "./BenchmarkFields";

export function BenchDevelopmentView({
  definitions,
  benchmarkId,
  onEdit,
  onRun,
  onEvidence,
}: {
  definitions: BenchmarkDefinition[];
  benchmarkId?: string;
  onEdit: (id?: string) => void;
  onRun: (versionId: string, preview?: boolean) => void;
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState("editor");
  const [error, setError] = useState<string | null>(null);
  const definition = definitions.find((entry) => entry.id === benchmarkId);
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
    if (benchmarkId !== "new" && !definition)
      return <BenchmarkNotice>{t("editor.missing")}</BenchmarkNotice>;
    return (
      <div className="space-y-5">
        <div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onEdit()}
          >
            {t("actions.backToLibrary")}
          </Button>
        </div>
        <Tabs
          value={tab}
          onValueChange={(value) =>
            useBenchmarkViewStore
              .getState()
              .guardNavigation(() => setTab(value))
          }
        >
          <TabsList>
            <TabsTrigger value="editor">{t("editor.title")}</TabsTrigger>
            <TabsTrigger value="results">{t("editor.results")}</TabsTrigger>
          </TabsList>
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
              versionIds={
                definition?.versions.map((version) => version.id) ?? []
              }
              onEvidence={onEvidence}
            />
          </TabsContent>
        </Tabs>
      </div>
    );
  }
  const visible = definitions.filter(
    (entry) =>
      (showArchived || !entry.archived) &&
      [entry.draft.name, entry.draft.taskFamily, entry.draft.category]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <section className="space-y-4">
      {error && <BenchmarkNotice error>{error}</BenchmarkNotice>}
      <div className="flex flex-wrap items-center gap-4">
        <Input
          aria-label={t("library.search")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="max-w-sm"
        />
        <Label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={showArchived}
            onCheckedChange={(checked) => setShowArchived(checked === true)}
          />
          {t("library.archived")}
        </Label>
      </div>
      {visible.length === 0 ? (
        <BenchmarkNotice>{t("library.empty")}</BenchmarkNotice>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {["name", "category", "split", "versions"].map((key) => (
                <TableHead key={key}>{t(`fields.${key}`)}</TableHead>
              ))}
              <TableHead>{t("actions.title")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={() => onEdit(entry.id)}
                  >
                    {entry.draft.name}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {entry.draft.taskFamily}
                  </p>
                </TableCell>
                <TableCell>{entry.draft.category}</TableCell>
                <TableCell>
                  {t(`split.${entry.draft.split}`, {
                    defaultValue: entry.draft.split,
                  })}
                </TableCell>
                <TableCell>{entry.versions.length}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={!entry.versions.length || entry.archived}
                      onClick={() => onRun(entry.versions[0].id)}
                    >
                      {t("actions.run")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void operate(async () => {
                          const copy = await benchmarkApi.duplicateDefinition(
                            entry.id,
                          );
                          onEdit(copy.id);
                        })
                      }
                    >
                      {t("actions.duplicate")}
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void operate(async () => {
                          await benchmarkApi.archiveDefinition(
                            entry.id,
                            !entry.archived,
                          );
                        })
                      }
                    >
                      {t(
                        entry.archived ? "actions.restore" : "actions.archive",
                      )}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function BenchmarkResults({
  versionIds,
  onEvidence,
}: {
  versionIds: string[];
  onEvidence: (id: string) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const [page, setPage] = useState(0);
  const query = { versionIds, offset: page * 50, limit: 50 };
  const attempts = useQuery({
    queryKey: [...benchmarkKeys, "attempts", query],
    queryFn: () => benchmarkApi.listAttempts(query),
    enabled: versionIds.length > 0,
  });
  const rows = attempts.data ?? [];
  return (
    <div className="space-y-2">
      {attempts.isFetching && <BenchmarkNotice>{t("loading")}</BenchmarkNotice>}
      {attempts.error && (
        <BenchmarkNotice error>
          {benchmarkErrorMessage(attempts.error)}
        </BenchmarkNotice>
      )}
      {!attempts.isFetching && rows.length === 0 && (
        <BenchmarkNotice>{t("leaderboard.empty")}</BenchmarkNotice>
      )}
      {rows.map((attempt) => (
        <div
          key={attempt.id}
          className="flex justify-between gap-3 border-b border-border py-3"
        >
          <span>{attempt.modelId}</span>
          <span>
            {t(`states.${attempt.outcome ?? attempt.phase}`, {
              defaultValue: attempt.outcome ?? attempt.phase,
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onEvidence(attempt.id)}
          >
            {t("actions.inspect")}
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={page === 0 || attempts.isFetching}
          onClick={() => setPage((current) => current - 1)}
        >
          {t("actions.previous")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={rows.length < 50 || attempts.isFetching}
          onClick={() => setPage((current) => current + 1)}
        >
          {t("actions.next")}
        </Button>
      </div>
    </div>
  );
}
