import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import {
  IconArchive,
  IconArchiveOff,
  IconChevronLeft,
  IconCopy,
  IconDots,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { PageToolbarButton } from "@/shared/ui/page-toolbar-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { hasDifficulty } from "../lib/benchmarkReleases";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import type { BenchmarkDefinition, BenchmarkVersion } from "../types";
import { BenchmarkAttemptList } from "./BenchmarkAttemptList";
import { BenchmarkEditor } from "./BenchmarkEditor";
import { BenchmarkQualificationPanel } from "./BenchmarkQualificationPanel";
import { BenchmarkToolbar } from "./BenchmarkPrimitives";

export function BenchmarkDetail({
  definition,
  initialWorkClassId,
  onSaved,
  onRun,
  onEvidence,
  onBack,
  onDuplicate,
  onArchive,
}: {
  definition?: BenchmarkDefinition;
  initialWorkClassId: string;
  onSaved: (id: string) => void;
  onRun: (id: string) => void;
  onEvidence: (id: string) => void;
  onBack?: () => void;
  onDuplicate?: () => void;
  onArchive?: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const versions = [...(definition?.versions ?? [])].sort(
    (a, b) => b.publishedAt - a.publishedAt,
  );
  const [selection, setSelection] = useState(versions[0]?.id ?? "draft");
  const [tab, setTab] = useState("test");
  const selected = versions.find((version) => version.id === selection);
  const archived = Boolean(
    definition?.archived || (selected && selected.id !== versions[0]?.id),
  );
  const guarded = (action: () => void) =>
    useBenchmarkViewStore.getState().guardNavigation(action);
  const picker = versions.length ? (
    <div className="max-w-full overflow-x-auto">
      <TabsList aria-label={t("detail.versions")} variant="buttons">
        {versions.map((version, index) => (
          <TabsTrigger key={version.id} value={version.id} variant="buttons">
            {t("detail.version", { number: versions.length - index })}
          </TabsTrigger>
        ))}
        <TabsTrigger value="draft" variant="buttons">
          {t("detail.draft")}
        </TabsTrigger>
      </TabsList>
    </div>
  ) : null;
  return (
    <Tabs
      value={selection}
      onValueChange={(value) =>
        useBenchmarkViewStore
          .getState()
          .guardNavigation(() => setSelection(value))
      }
      className="gap-5"
    >
      <BenchmarkToolbar
        actions={
          <>
            <PageToolbarButton
              type="button"
              size="icon-xs"
              aria-label={t("authoring.runTest")}
              tooltip={t("authoring.runTest")}
              disabled={
                !selected ||
                archived ||
                !hasDifficulty(selected.manifest.facets.difficulty)
              }
              onClick={() => {
                if (selected && !archived) guarded(() => onRun(selected.id));
              }}
            >
              <IconPlayerPlay />
            </PageToolbarButton>
            {definition && onDuplicate && onArchive ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <PageToolbarButton
                    type="button"
                    size="icon-xs"
                    aria-label={t("actions.more")}
                  >
                    <IconDots />
                  </PageToolbarButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => guarded(onDuplicate)}>
                    <IconCopy />
                    {t("actions.duplicate")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => guarded(onArchive)}>
                    {definition.archived ? <IconArchiveOff /> : <IconArchive />}
                    {t(
                      definition.archived
                        ? "actions.restore"
                        : "actions.archive",
                    )}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      >
        {onBack ? (
          <Button
            type="button"
            variant="ghost"
            flush
            leftIcon={<IconChevronLeft />}
            onClick={() => guarded(onBack)}
          >
            {t("actions.back")}
          </Button>
        ) : null}
      </BenchmarkToolbar>
      <TabsContent value="draft">
        <BenchmarkEditor
          definition={definition}
          initialWorkClassId={initialWorkClassId}
          onSaved={onSaved}
          versionPicker={picker}
        />
      </TabsContent>
      {selected ? (
        <TabsContent
          key={selected.id}
          value={selected.id}
          className="space-y-5"
        >
          <VersionHeader
            version={selected}
            archived={archived}
            picker={picker}
          />
          <Tabs value={tab} onValueChange={setTab} className="gap-4">
            <TabsList variant="weight" aria-label={t("detail.view")}>
              <TabsTrigger value="test" variant="weight">
                {t("editor.sections.test")}
              </TabsTrigger>
              <TabsTrigger value="results" variant="weight">
                {t("editor.results")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="test">
              <VersionContent version={selected} archived={archived} />
            </TabsContent>
            <TabsContent value="results">
              <Card>
                <CardContent>
                  <BenchmarkAttemptList
                    key={selected.id}
                    query={{ versionIds: [selected.id] }}
                    versions={[selected]}
                    showModel
                    onEvidence={onEvidence}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

function VersionHeader({
  version,
  archived,
  picker,
}: {
  version: BenchmarkVersion;
  archived: boolean;
  picker: ReactNode;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-2">
        <h1 className="text-xl tracking-tight">{version.manifest.name}</h1>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline">
            {t(archived ? "library.archivedTag" : "detail.current")}
          </Badge>
          <span>
            {formatDate(version.publishedAt, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        </div>
      </div>
      {picker}
    </div>
  );
}

function Value({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm">{children}</dd>
    </div>
  );
}

function Text({ children }: { children: string }) {
  return (
    <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm font-sans">
      {children}
    </pre>
  );
}

function VersionContent({
  version,
  archived,
}: {
  version: BenchmarkVersion;
  archived: boolean;
}) {
  const { t } = useTranslation(["benchmarks", "settings"]);
  const draft = version.manifest;
  const details = {
    taskFamily: draft.taskFamily,
    source: draft.source,
    license: draft.license,
    evaluatorRevision: draft.evaluator.revision,
    maxTurns: draft.limits.maxTurns,
    maxArtifactBytes: draft.limits.maxArtifactBytes,
    permissions: draft.permissions,
    environment: draft.environment,
    ...(draft.roleId || draft.rolePrompt
      ? {
          roleId: draft.roleId,
          rolePrompt: draft.rolePrompt,
          roleContextHash: draft.roleContextHash,
        }
      : {}),
    ...(draft.entryState ? { entryState: draft.entryState } : {}),
    ...(draft.workflow ? { workflow: draft.workflow } : {}),
    contentHash: version.contentHash,
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("detail.settings")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Value label={t("detail.type")}>
              {t(`settings:routing.classes.${draft.workClassId}`, {
                defaultValue: draft.workClassId,
              })}
            </Value>
            <Value label={t("fields.difficulty")}>
              {draft.facets.difficulty
                ? t(`difficulty.${draft.facets.difficulty}`, {
                    defaultValue: draft.facets.difficulty,
                  })
                : "—"}
            </Value>
            <Value label={t("fields.split")}>{t(`split.${draft.split}`)}</Value>
            <Value label={t("fields.executionProfile")}>
              {t(`profiles.${draft.executionProfile}`, {
                defaultValue: draft.executionProfile,
              })}
            </Value>
            <Value label={t("fields.timeoutSeconds")}>
              {draft.limits.timeoutSeconds}
            </Value>
            <Value label={t("fields.repetitions")}>{draft.repetitions}</Value>
            {draft.facets.language ? (
              <Value label={t("editor.language")}>
                {draft.facets.language}
              </Value>
            ) : null}
            {draft.facets.domain ? (
              <Value label={t("editor.domain")}>{draft.facets.domain}</Value>
            ) : null}
            {draft.facets.outputFormat ? (
              <Value label={t("editor.outputFormat")}>
                {draft.facets.outputFormat}
              </Value>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("editor.sections.task")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {draft.description ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {draft.description}
            </p>
          ) : null}
          <Text>{draft.prompt}</Text>
          {draft.fixtures.length ? (
            <div className="divide-y divide-border">
              {draft.fixtures.map((fixture) => (
                <details key={fixture.path} className="py-3">
                  <summary className="cursor-pointer text-sm">
                    {fixture.path}
                  </summary>
                  <div className="pt-3">
                    <Text>{fixture.content}</Text>
                  </div>
                </details>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-4">
          <details>
            <summary className="cursor-pointer text-sm">
              {t("editor.sections.evaluation")}
            </summary>
            <div className="space-y-4 pt-4">
              <p className="text-sm">
                {t(`evaluators.${draft.evaluator.kind}`, {
                  defaultValue: draft.evaluator.kind,
                })}
              </p>
              {(["expected", "rubric", "knownGood", "knownBad"] as const)
                .filter((key) => draft.evaluator[key])
                .map((key) => (
                  <div key={key} className="space-y-2">
                    <h3 className="text-xs text-muted-foreground">
                      {t(
                        key === "expected" &&
                          ["javascript", "browser", "repository"].includes(
                            draft.evaluator.kind,
                          )
                          ? "fields.protectedChecks"
                          : `fields.${key}`,
                      )}
                    </h3>
                    <Text>{draft.evaluator[key]}</Text>
                  </div>
                ))}
            </div>
          </details>
          <BenchmarkQualificationPanel version={version} archived={archived} />
          <details>
            <summary className="cursor-pointer text-sm">
              {t("detail.technical")}
            </summary>
            <pre className="mt-4 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(details, null, 2)}
            </pre>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}
