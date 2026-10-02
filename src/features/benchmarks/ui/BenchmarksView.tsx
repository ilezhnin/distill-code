import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  IconCoin,
  IconDots,
  IconFileExport,
  IconFileImport,
  IconHistory,
  IconPlayerPlay,
  IconPlus,
  IconRepeat,
  IconRoute,
} from "@tabler/icons-react";
import type { AppNavigationUpdateOptions } from "@/app/types/appNavigation";
import { useLocaleFormatting } from "@/shared/i18n";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { PageShell } from "@/shared/ui/page-shell";
import { PageToolbarButton } from "@/shared/ui/page-toolbar-button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import {
  benchmarkKeys,
  useBenchmarkDefinitions,
  useBenchmarkRuns,
} from "../hooks/useBenchmarks";
import { shortId } from "../lib/benchmarkLabels";
import {
  BENCHMARK_SECTIONS,
  type BenchmarkLocation,
  type BenchmarkSection,
} from "../lib/benchmarkNavigation";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import { BenchDevelopmentView } from "./BenchDevelopmentView";
import { BenchmarkCatalogDialog } from "./BenchmarkCatalogDialog";
import { BenchmarkEvidenceView } from "./BenchmarkEvidenceView";
import {
  BenchmarkBaselineDialog,
  BenchmarkExportDialog,
  BenchmarkImportDialog,
  BenchmarkSchedulesDialog,
} from "./BenchmarkManagementDialogs";
import { BenchmarkAlert, type Option } from "./BenchmarkPrimitives";
import { BenchmarkRoutingDialog } from "./BenchmarkRoutingDialog";
import { BenchmarkRunDialog } from "./BenchmarkRunDialog";
import { BenchmarkRunDrawer } from "./BenchmarkRunDrawer";
import { BenchmarkRunsDialog } from "./BenchmarkRunsDialog";
import { LeaderboardView } from "./LeaderboardView";
import { NerfBenchView } from "./NerfBenchView";
import { UsageBenchView } from "./UsageBenchView";

const PAGE_SIZE = 50;

export interface ResultScope {
  versionId: string;
  runId: string;
}

interface Props {
  location: BenchmarkLocation;
  onNavigate: (
    location: BenchmarkLocation,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onSelectSession: (id: string) => void;
}

type DialogKind =
  | "runs"
  | "import"
  | "export"
  | "baseline"
  | "schedules"
  | "routing"
  | "catalog";

export function BenchmarksView({
  location,
  onNavigate,
  onSelectSession,
}: Props) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const definitions = useBenchmarkDefinitions();
  const runs = useBenchmarkRuns();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [runSelection, setRunSelection] = useState<{
    versions: string[];
    preview: boolean;
  } | null>(null);
  const [scope, setScope] = useState<ResultScope>({
    versionId: "all",
    runId: "all",
  });
  const [baselineId, setBaselineId] = useState("none");
  const [page, setPage] = useState(0);
  const pendingNavigation = useBenchmarkViewStore((state) => state.pending);
  const versions = useMemo(
    () => definitions.data?.flatMap((definition) => definition.versions) ?? [],
    [definitions.data],
  );
  const query = useMemo(
    () => ({
      runId: scope.runId === "all" ? null : scope.runId,
      versionIds: scope.versionId === "all" ? null : [scope.versionId],
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [scope, page],
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
  const guarded = (action: () => void) =>
    useBenchmarkViewStore.getState().guardNavigation(action);
  const openEvidence = (attemptId: string) =>
    onNavigate({ ...location, attemptId });
  const openRun = (id: string) => {
    setDialog(null);
    setRunSelection(null);
    onNavigate({ ...location, runId: id, attemptId: undefined });
  };
  const openRunDialog = (version?: string, preview = false) =>
    guarded(() =>
      setRunSelection({ versions: version ? [version] : [], preview }),
    );
  const changeScope = (next: ResultScope) => {
    setScope(next);
    setPage(0);
  };
  const errors = [
    ...new Set(
      [
        definitions.error,
        runs.error,
        leaderboard.error,
        usage.error,
        baselines.error,
        comparisons.error,
        usageComparisons.error,
      ]
        .filter(Boolean)
        .map(benchmarkErrorMessage),
    ),
  ];
  const suiteOptions: Option[] = [
    { value: "all", label: t("filters.allSuites") },
    ...versions.map((version) => ({
      value: version.id,
      label: t("editor.versionLabel", {
        name: version.manifest.name,
        hash: shortId(version.contentHash),
      }),
    })),
  ];
  const runOptions: Option[] = [
    { value: "all", label: t("filters.allRuns") },
    ...(runs.data ?? [])
      .filter((run) => !run.request.preview)
      .map((run) => ({
        value: run.id,
        label: t("filters.runLabel", {
          date: formatDate(run.createdAt, {
            dateStyle: "short",
            timeStyle: "short",
          }),
          id: shortId(run.id),
        }),
      })),
  ];
  const baseline =
    baselines.data?.find((entry) => entry.id === baselineId) ?? null;
  const baselineOptions: Option[] = [
    { value: "none", label: t("filters.noBaseline") },
    ...(baselines.data ?? []).map((baseline) => ({
      value: baseline.id,
      label: baseline.name,
    })),
  ];
  const menuItems: { kind: DialogKind; label: string; icon: ReactNode }[] = [
    { kind: "runs", label: t("toolbar.runs"), icon: <IconHistory /> },
    { kind: "import", label: t("toolbar.import"), icon: <IconFileImport /> },
    { kind: "export", label: t("toolbar.export"), icon: <IconFileExport /> },
    { kind: "schedules", label: t("toolbar.schedules"), icon: <IconRepeat /> },
    { kind: "routing", label: t("toolbar.routing"), icon: <IconRoute /> },
    { kind: "catalog", label: t("toolbar.catalog"), icon: <IconCoin /> },
  ];
  return (
    <PageShell contentWidth="full">
      <section
        aria-label={t("title")}
        className="mx-auto flex w-full max-w-[70rem] flex-col gap-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs
            value={location.section}
            onValueChange={(section) => {
              setPage(0);
              onNavigate({ section: section as BenchmarkSection });
            }}
          >
            <TabsList variant="weight">
              {BENCHMARK_SECTIONS.map((section) => (
                <TabsTrigger key={section} value={section} variant="weight">
                  {t(`sections.${section}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <PageToolbarButton
              type="button"
              size="icon-xs"
              aria-label={t("actions.run")}
              tooltip={t("actions.run")}
              onClick={() => openRunDialog()}
            >
              <IconPlayerPlay className="!size-4" />
            </PageToolbarButton>
            <PageToolbarButton
              type="button"
              size="icon-xs"
              aria-label={t("actions.new")}
              tooltip={t("actions.new")}
              onClick={() =>
                onNavigate({ section: "development", benchmarkId: "new" })
              }
            >
              <IconPlus className="!size-4" />
            </PageToolbarButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PageToolbarButton
                  type="button"
                  size="icon-xs"
                  aria-label={t("actions.more")}
                >
                  <IconDots className="!size-4" />
                </PageToolbarButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {menuItems.map((item, index) => (
                  <Fragment key={item.kind}>
                    {index === 1 || index === 3 ? (
                      <DropdownMenuSeparator />
                    ) : null}
                    <DropdownMenuItem
                      onSelect={() => guarded(() => setDialog(item.kind))}
                    >
                      {item.icon}
                      {item.label}
                    </DropdownMenuItem>
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {errors.map((error) => (
          <BenchmarkAlert key={error}>{error}</BenchmarkAlert>
        ))}
        {location.section === "development" ? (
          <BenchDevelopmentView
            definitions={definitions.data ?? []}
            loading={definitions.isPending}
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
        ) : null}
        {location.section === "leaderboard" ? (
          <LeaderboardView
            report={leaderboard.data}
            loading={leaderboard.isPending}
            scope={scope}
            onScopeChange={changeScope}
            suiteOptions={suiteOptions}
            runOptions={runOptions}
            versions={versions}
            runs={runs.data ?? []}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            onEvidence={openEvidence}
          />
        ) : null}
        {location.section === "nerf" ? (
          <NerfBenchView
            comparisons={comparisons.data ?? []}
            loading={baselineId !== "none" && comparisons.isPending}
            scope={scope}
            onScopeChange={changeScope}
            suiteOptions={suiteOptions}
            runOptions={runOptions}
            baseline={baseline}
            baselineId={baselineId}
            baselineOptions={baselineOptions}
            onBaselineChange={setBaselineId}
            onCreateBaseline={() => setDialog("baseline")}
            versions={versions}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            onEvidence={openEvidence}
          />
        ) : null}
        {location.section === "usage" ? (
          <UsageBenchView
            comparisons={usageComparisons.data ?? []}
            samples={usage.data ?? []}
            loading={usage.isPending}
            scope={scope}
            onScopeChange={changeScope}
            runOptions={runOptions}
            baseline={baseline}
            baselineId={baselineId}
            baselineOptions={baselineOptions}
            onBaselineChange={setBaselineId}
            onCreateBaseline={() => setDialog("baseline")}
            versions={versions}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            onEvidence={openEvidence}
          />
        ) : null}
      </section>
      {runSelection ? (
        <BenchmarkRunDialog
          definitions={definitions.data ?? []}
          selectedVersionIds={runSelection.versions}
          previewOnly={runSelection.preview}
          onClose={() => setRunSelection(null)}
          onStarted={openRun}
        />
      ) : null}
      {location.runId && !location.attemptId ? (
        <BenchmarkRunDrawer
          runId={location.runId}
          onClose={() => onNavigate({ ...location, runId: undefined })}
          onEvidence={openEvidence}
        />
      ) : null}
      {location.attemptId ? (
        <BenchmarkEvidenceView
          attemptId={location.attemptId}
          onSelectAttempt={openEvidence}
          onClose={() => onNavigate({ ...location, attemptId: undefined })}
          onSelectSession={onSelectSession}
        />
      ) : null}
      {dialog === "runs" ? (
        <BenchmarkRunsDialog
          runs={runs.data ?? []}
          onClose={() => setDialog(null)}
          onOpenRun={openRun}
        />
      ) : null}
      {dialog === "import" ? (
        <BenchmarkImportDialog
          onClose={() => setDialog(null)}
          onImported={(id) => {
            setDialog(null);
            onNavigate(
              id
                ? { section: "development", benchmarkId: id }
                : { section: "development" },
            );
          }}
        />
      ) : null}
      {dialog === "export" ? (
        <BenchmarkExportDialog onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "catalog" ? (
        <BenchmarkCatalogDialog onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "baseline" ? (
        <BenchmarkBaselineDialog
          runs={runs.data ?? []}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            setBaselineId(id);
            setDialog(null);
          }}
        />
      ) : null}
      {dialog === "schedules" ? (
        <BenchmarkSchedulesDialog
          runs={runs.data ?? []}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "routing" ? (
        <BenchmarkRoutingDialog
          versions={versions}
          runs={runs.data ?? []}
          onClose={() => setDialog(null)}
          onEvidence={(id) => {
            setDialog(null);
            onNavigate({ ...location, attemptId: id });
          }}
        />
      ) : null}
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
