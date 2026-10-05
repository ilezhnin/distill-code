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
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import {
  benchmarkKeys,
  useBenchmarkDefinitions,
  useBenchmarkRuns,
} from "../hooks/useBenchmarks";
import { shortId } from "../lib/benchmarkLabels";
import type { LeaderboardRow } from "../types";
import type { BenchmarkLocation } from "../lib/benchmarkNavigation";
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
import { Button } from "@/shared/ui/button";
import { rowKey } from "../lib/benchmarkBoards";
import { BenchmarkActivity } from "./BenchmarkActivity";
import { BenchmarkConfigurationPage } from "./BenchmarkConfigurationPage";
import { DesignBenchView } from "./DesignBenchView";
import {
  BenchmarkAlert,
  BenchmarkEmpty,
  BenchmarkToolbar,
  type Option,
} from "./BenchmarkPrimitives";
import { BenchmarkRoutingDialog } from "./BenchmarkRoutingDialog";
import { BenchmarkModelRunDialog } from "./BenchmarkModelRunDialog";
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
  // A model page's run: its leaderboard row, and the run measuring it now.
  const [modelRun, setModelRun] = useState<{
    row: LeaderboardRow;
    runId: string | null;
  } | null>(null);
  const [scope, setScope] = useState<ResultScope>({
    versionId: "all",
    runId: "all",
  });
  const [baselineId, setBaselineId] = useState("none");
  const [page, setPage] = useState(0);
  // Every section opens on its first page, whoever switched to it.
  const [pageSection, setPageSection] = useState(location.section);
  if (pageSection !== location.section) {
    setPageSection(location.section);
    setPage(0);
  }
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
  // Ranks, places and the model filter need every row; the board pages its
  // own rendered list. 500 is the service's cap.
  const leaderboardQuery = useMemo(
    () => ({ runId: null, versionIds: null, offset: 0, limit: 500 }),
    [],
  );
  const leaderboard = useQuery({
    queryKey: [...benchmarkKeys, "leaderboard", leaderboardQuery],
    queryFn: () => benchmarkApi.getLeaderboard(leaderboardQuery),
    enabled: location.section === "leaderboard",
  });
  const usage = useQuery({
    queryKey: [...benchmarkKeys, "usage", query],
    queryFn: () => benchmarkApi.getUsageSeries(query),
    enabled: location.section === "usage",
  });
  const designs = useQuery({
    queryKey: [...benchmarkKeys, "designs", query.runId],
    queryFn: () =>
      benchmarkApi.listDesigns({ runId: query.runId, versionIds: null }),
    enabled: location.section === "design",
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
  const openedRow = location.configurationId
    ? (leaderboard.data?.rows.find(
        (row) => rowKey(row) === location.configurationId,
      ) ?? null)
    : null;
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
        designs.error,
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
  // The sections live in the sidebar, so each section's first row carries
  // the page actions on its right.
  const actions = (
    <>
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
              {index === 1 || index === 3 ? <DropdownMenuSeparator /> : null}
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
    </>
  );
  return (
    <PageShell contentWidth="full">
      <section aria-label={t("title")} className="flex w-full flex-col gap-6">
        {errors.map((error) => (
          <BenchmarkAlert key={error}>{error}</BenchmarkAlert>
        ))}
        <BenchmarkActivity runs={runs.data ?? []} onOpenRun={openRun} />
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
            actions={actions}
          />
        ) : null}
        {location.section === "leaderboard" && location.configurationId ? (
          openedRow && leaderboard.data ? (
            <BenchmarkConfigurationPage
              key={location.configurationId}
              row={openedRow}
              report={leaderboard.data}
              runs={runs.data ?? []}
              versions={versions}
              onEvidence={openEvidence}
              onRun={(runId) =>
                guarded(() =>
                  setModelRun({
                    row: openedRow,
                    runId,
                  }),
                )
              }
              onOpenRun={openRun}
              onBack={() => onNavigate({ section: "leaderboard" })}
              actions={actions}
            />
          ) : (
            <>
              <BenchmarkToolbar actions={actions} />
              {leaderboard.isPending ? (
                <BenchmarkEmpty title={t("loading")} compact />
              ) : (
                <BenchmarkEmpty
                  title={t("configuration.missing")}
                  action={
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => onNavigate({ section: "leaderboard" })}
                    >
                      {t("configuration.back")}
                    </Button>
                  }
                />
              )}
            </>
          )
        ) : null}
        {location.section === "design" ? (
          <DesignBenchView
            entries={designs.data ?? []}
            loading={designs.isPending}
            onEvidence={openEvidence}
            actions={actions}
          />
        ) : null}
        {location.section === "leaderboard" && !location.configurationId ? (
          <LeaderboardView
            report={leaderboard.data}
            runs={runs.data ?? []}
            loading={leaderboard.isPending}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            onOpen={(key) =>
              onNavigate({ section: "leaderboard", configurationId: key })
            }
            actions={actions}
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
            actions={actions}
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
            actions={actions}
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
      {modelRun ? (
        <BenchmarkModelRunDialog
          row={
            leaderboard.data?.rows.find(
              (row) => rowKey(row) === rowKey(modelRun.row),
            ) ?? modelRun.row
          }
          definitions={definitions.data ?? []}
          runId={modelRun.runId}
          onClose={() => setModelRun(null)}
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
