import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AppNavigationUpdateOptions } from "@/app/types/appNavigation";
import { Button } from "@/shared/ui/button";
import { PageHeader, PageShell } from "@/shared/ui/page-shell";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import {
  benchmarkKeys,
  useBenchmarkDefinitions,
  useBenchmarkRuns,
} from "../hooks/useBenchmarks";
import {
  BENCHMARK_SECTIONS,
  type BenchmarkLocation,
  type BenchmarkSection,
} from "../lib/benchmarkNavigation";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import { BenchDevelopmentView } from "./BenchDevelopmentView";
import { BenchmarkEvidenceView } from "./BenchmarkEvidenceView";
import { BenchmarkRoutingDialog } from "./BenchmarkRoutingDialog";
import {
  BenchmarkField,
  BenchmarkNotice,
  BenchmarkSelect,
} from "./BenchmarkFields";
import {
  BenchmarkBaselineDialog,
  BenchmarkExportDialog,
  BenchmarkImportDialog,
  BenchmarkSchedulesDialog,
} from "./BenchmarkManagementDialogs";
import { BenchmarkRunDialog } from "./BenchmarkRunDialog";
import { BenchmarkRunDrawer } from "./BenchmarkRunDrawer";
import { LeaderboardView } from "./LeaderboardView";
import { NerfBenchView } from "./NerfBenchView";
import { UsageBenchView } from "./UsageBenchView";

interface Props {
  location: BenchmarkLocation;
  onNavigate: (
    location: BenchmarkLocation,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onSelectSession: (id: string) => void;
}

export function BenchmarksView({
  location,
  onNavigate,
  onSelectSession,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const definitions = useBenchmarkDefinitions();
  const runs = useBenchmarkRuns();
  const [dialog, setDialog] = useState<
    | "history"
    | "import"
    | "export"
    | "baseline"
    | "schedules"
    | "routing"
    | null
  >(null);
  const [runSelection, setRunSelection] = useState<{
    versions: string[];
    preview: boolean;
  } | null>(null);
  const [versionId, setVersionId] = useState("all");
  const [runFilter, setRunFilter] = useState("all");
  const [baselineId, setBaselineId] = useState("none");
  const [page, setPage] = useState(0);
  const pendingNavigation = useBenchmarkViewStore((state) => state.pending);
  const versions =
    definitions.data?.flatMap((definition) => definition.versions) ?? [];
  const query = useMemo(
    () => ({
      runId: runFilter === "all" ? null : runFilter,
      versionIds: versionId === "all" ? null : [versionId],
      offset: page * 50,
      limit: 50,
    }),
    [runFilter, versionId, page],
  );
  const leaderboard = useQuery({
    queryKey: [...benchmarkKeys, "leaderboard", query],
    queryFn: () => benchmarkApi.getLeaderboard(query),
    enabled: location.section === "leaderboard",
  });
  const usage = useQuery({
    queryKey: [...benchmarkKeys, "usage", query],
    queryFn: () => benchmarkApi.getUsageSeries(query),
    enabled: location.section === "usage",
  });
  const baselines = useQuery({
    queryKey: [...benchmarkKeys, "baselines"],
    queryFn: benchmarkApi.listBaselines,
    enabled: location.section === "nerf" || location.section === "usage",
  });
  const comparisons = useQuery({
    queryKey: [...benchmarkKeys, "comparisons", baselineId, query],
    queryFn: () => benchmarkApi.getComparisons(baselineId, query),
    enabled: location.section === "nerf" && baselineId !== "none",
  });
  const usageComparisons = useQuery({
    queryKey: [...benchmarkKeys, "usageComparisons", baselineId],
    queryFn: () => benchmarkApi.getUsageComparisons(baselineId),
    enabled: location.section === "usage" && baselineId !== "none",
  });
  const openEvidence = (attemptId: string) =>
    onNavigate({ ...location, attemptId });
  const openRun = (id: string) => {
    setDialog(null);
    setRunSelection(null);
    onNavigate({ ...location, runId: id, attemptId: undefined });
  };
  const openRunDialog = (version?: string, preview = false) => {
    setRunSelection({ versions: version ? [version] : [], preview });
  };
  const guarded = (action: () => void) =>
    useBenchmarkViewStore.getState().guardNavigation(action);
  const errors = [
    definitions.error,
    runs.error,
    leaderboard.error,
    usage.error,
    baselines.error,
    comparisons.error,
    usageComparisons.error,
  ].filter(Boolean);
  const rowsLength =
    location.section === "leaderboard"
      ? leaderboard.data?.length
      : location.section === "usage"
        ? usage.data?.length
        : comparisons.data?.length;
  return (
    <PageShell contentWidth="full">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => guarded(() => setDialog("history"))}
            >
              {t("runs.title")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onNavigate({ section: "development", benchmarkId: "new" })
              }
            >
              {t("actions.new")}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => guarded(() => openRunDialog())}
            >
              {t("actions.run")}
            </Button>
          </>
        }
      />
      <Tabs
        value={location.section}
        onValueChange={(section) => {
          setPage(0);
          onNavigate({ section: section as BenchmarkSection });
        }}
      >
        <TabsList variant="weight">
          {BENCHMARK_SECTIONS.map((section) => (
            <TabsTrigger key={section} value={section}>
              {t(`sections.${section}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => guarded(() => setDialog("import"))}
        >
          {t("actions.import")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => guarded(() => setDialog("export"))}
        >
          {t("actions.export")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => guarded(() => setDialog("schedules"))}
        >
          {t("schedules.title")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => guarded(() => setDialog("routing"))}
        >
          {t("routing.title")}
        </Button>
      </div>
      {[...new Set(errors.map(benchmarkErrorMessage))].map((error) => (
        <BenchmarkNotice key={error} error>
          {benchmarkErrorMessage(error)}
        </BenchmarkNotice>
      ))}
      {definitions.isPending && (
        <BenchmarkNotice>{t("loading")}</BenchmarkNotice>
      )}
      {location.section !== "development" && (
        <div className="grid gap-3 md:grid-cols-2">
          <BenchmarkField label={t("fields.version")}>
            {(id) => (
              <BenchmarkSelect
                id={id}
                value={versionId}
                onChange={(value) => {
                  setVersionId(value);
                  setPage(0);
                }}
                options={[
                  { value: "all", label: t("allVersions") },
                  ...versions.map((version) => ({
                    value: version.id,
                    label: `${version.manifest.name} / ${version.contentHash.slice(0, 8)}`,
                  })),
                ]}
              />
            )}
          </BenchmarkField>
          <BenchmarkField label={t("fields.run")}>
            {(id) => (
              <BenchmarkSelect
                id={id}
                value={runFilter}
                onChange={(value) => {
                  setRunFilter(value);
                  setPage(0);
                }}
                options={[
                  { value: "all", label: t("allRuns") },
                  ...(runs.data ?? [])
                    .filter((run) => !run.request.preview)
                    .map((run) => ({
                      value: run.id,
                      label: `${new Date(run.createdAt).toLocaleString()} / ${run.id.slice(0, 8)}`,
                    })),
                ]}
              />
            )}
          </BenchmarkField>
        </div>
      )}
      {(location.section === "nerf" || location.section === "usage") && (
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <BenchmarkField label={t("baseline.title")}>
              {(id) => (
                <BenchmarkSelect
                  id={id}
                  value={baselineId}
                  onChange={setBaselineId}
                  options={[
                    { value: "none", label: t("baseline.choose") },
                    ...(baselines.data ?? []).map((baseline) => ({
                      value: baseline.id,
                      label: baseline.name,
                    })),
                  ]}
                />
              )}
            </BenchmarkField>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setDialog("baseline")}
          >
            {t("baseline.create")}
          </Button>
        </div>
      )}
      {location.section === "development" && definitions.data && (
        <BenchDevelopmentView
          definitions={definitions.data}
          benchmarkId={location.benchmarkId}
          onEdit={(id) =>
            onNavigate(
              { section: "development", benchmarkId: id },
              { replace: location.benchmarkId === "new" && id !== "new" },
            )
          }
          onRun={openRunDialog}
          onEvidence={openEvidence}
        />
      )}
      {location.section === "leaderboard" && (
        <LeaderboardView
          rows={leaderboard.data ?? []}
          onEvidence={openEvidence}
        />
      )}
      {location.section === "nerf" && (
        <NerfBenchView
          comparisons={comparisons.data ?? []}
          onEvidence={openEvidence}
        />
      )}
      {location.section === "usage" && (
        <UsageBenchView
          comparisons={usageComparisons.data ?? []}
          samples={usage.data ?? []}
          onEvidence={openEvidence}
        />
      )}
      {location.section !== "development" && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={page === 0}
            onClick={() => setPage((current) => current - 1)}
          >
            {t("actions.previous")}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={(rowsLength ?? 0) < 50}
            onClick={() => setPage((current) => current + 1)}
          >
            {t("actions.next")}
          </Button>
        </div>
      )}
      {runSelection && (
        <BenchmarkRunDialog
          definitions={definitions.data ?? []}
          selectedVersionIds={runSelection.versions}
          previewOnly={runSelection.preview}
          onClose={() => setRunSelection(null)}
          onStarted={openRun}
        />
      )}
      {location.runId && !location.attemptId && (
        <BenchmarkRunDrawer
          runId={location.runId}
          onClose={() => onNavigate({ ...location, runId: undefined })}
          onEvidence={openEvidence}
        />
      )}
      {location.attemptId && (
        <BenchmarkEvidenceView
          attemptId={location.attemptId}
          onSelectAttempt={openEvidence}
          onClose={() => onNavigate({ ...location, attemptId: undefined })}
          onSelectSession={onSelectSession}
        />
      )}
      {dialog === "import" && (
        <BenchmarkImportDialog
          onClose={() => setDialog(null)}
          onImported={(id) => {
            setDialog(null);
            onNavigate({ section: "development", benchmarkId: id });
          }}
        />
      )}
      {dialog === "export" && (
        <BenchmarkExportDialog onClose={() => setDialog(null)} />
      )}
      {dialog === "baseline" && (
        <BenchmarkBaselineDialog
          runs={runs.data ?? []}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setBaselineId(id);
            setDialog(null);
          }}
        />
      )}
      {dialog === "schedules" && (
        <BenchmarkSchedulesDialog
          runs={runs.data ?? []}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "routing" && (
        <BenchmarkRoutingDialog
          versions={versions}
          runs={runs.data ?? []}
          onClose={() => setDialog(null)}
          onEvidence={(id) => {
            setDialog(null);
            onNavigate({ ...location, attemptId: id });
          }}
        />
      )}
      {dialog === "history" && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        >
          <DialogContent size="xl">
            <DialogHeader>
              <DialogTitle>{t("runs.title")}</DialogTitle>
              <DialogDescription>{t("runs.description")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-2">
              {runs.data?.length === 0 && (
                <BenchmarkNotice>{t("runs.empty")}</BenchmarkNotice>
              )}
              {runs.data?.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center justify-between gap-3 border-b border-border py-3"
                >
                  <div>
                    <p className="text-sm">
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(`states.${run.state}`, { defaultValue: run.state })}
                      {run.request.preview ? ` / ${t("runs.preview")}` : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => openRun(run.id)}
                  >
                    {t("actions.inspect")}
                  </Button>
                </div>
              ))}
            </DialogBody>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialog(null)}
              >
                {t("actions.close")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <ConfirmDialog
        open={Boolean(pendingNavigation)}
        onOpenChange={(open) => {
          if (!open) useBenchmarkViewStore.getState().resolveNavigation(false);
        }}
        title={t("editor.leaveTitle")}
        description={t("editor.leaveDescription")}
        cancelLabel={t("editor.keepEditing")}
        confirmLabel={t("editor.discard")}
        onConfirm={() =>
          useBenchmarkViewStore.getState().resolveNavigation(true)
        }
      />
    </PageShell>
  );
}
