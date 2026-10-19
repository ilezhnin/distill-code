import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowLeft, IconClock, IconCoin } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { SearchBar } from "@/shared/ui/SearchBar";
import {
  modelNameKey,
  useModelCatalog,
  useModelNames,
} from "../hooks/useBenchmarks";
import {
  formatElapsed,
  formatSpend,
  modelDisplayName,
  providerVendor,
} from "../lib/benchmarkLabels";
import { renderable } from "../lib/benchmarkPreview";
import { explicitEffort } from "../lib/benchmarkEffort";
import { resolveCatalogEntry } from "../lib/modelCatalog";
import type { DesignEntry } from "../types";
import {
  BenchmarkEmpty,
  BenchmarkToolbar,
  ModelIdentity,
  SectionHeading,
  StateBadge,
} from "./BenchmarkPrimitives";
import { DesignDetailDialog } from "./DesignDetailDialog";
import { DesignRendering } from "./DesignRendering";

interface Brief {
  versionId: string;
  name: string;
  entries: DesignEntry[];
  /** The highest-scoring design, the newest among equals. */
  best: DesignEntry;
}

interface Identity {
  name: string;
  vendor: string;
}

const points = (score: number | null) =>
  score == null ? null : Math.round(score * 1000);

const recency = (entry: DesignEntry) => entry.finishedAt ?? entry.runCreatedAt;

/** Scored designs first, highest score first, the newest among equals. */
export function byScore(a: DesignEntry, b: DesignEntry): number {
  if (a.score != null || b.score != null) {
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    if (a.score !== b.score) return b.score - a.score;
  }
  return recency(b) - recency(a);
}

/**
 * The design gallery: one card per brief with its best rendering as the
 * cover; a brief opens its models' designs by score, and a design opens
 * every scored rendering behind it.
 */
export function DesignBenchView({
  entries,
  loading,
  onEvidence,
  actions,
}: {
  entries: DesignEntry[];
  loading: boolean;
  onEvidence: (id: string) => void;
  /** The page actions, last in the toolbar row. */
  actions?: ReactNode;
}) {
  const { t } = useTranslation("benchmarks");
  const names = useModelNames();
  const catalog = useModelCatalog();
  const [openBrief, setOpenBrief] = useState<string | null>(null);
  const [openDesign, setOpenDesign] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const briefs = useMemo(() => {
    const groups = new Map<string, DesignEntry[]>();
    for (const entry of entries) {
      groups.set(entry.versionId, [
        ...(groups.get(entry.versionId) ?? []),
        entry,
      ]);
    }
    return [...groups.values()]
      .map((group): Brief => {
        const sorted = [...group].sort(byScore);
        return {
          versionId: sorted[0].versionId,
          name: sorted[0].name,
          entries: sorted,
          best: sorted[0],
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entries]);
  const identity = (entry: DesignEntry): Identity => {
    const modelName =
      entry.configuration.modelName ??
      names.get(modelNameKey(entry.configuration));
    const fact = resolveCatalogEntry(
      catalog,
      entry.configuration,
      modelName,
      entry.finishedAt ?? entry.runCreatedAt,
    );
    return {
      name:
        fact?.displayName ?? modelDisplayName(entry.configuration, modelName),
      vendor: fact?.vendor ?? providerVendor(entry.configuration.providerId),
    };
  };
  const brief = briefs.find((group) => group.versionId === openBrief) ?? null;
  const design =
    brief?.entries.find((entry) => entry.attemptId === openDesign) ?? null;
  const close = () => {
    setOpenBrief(null);
    setOpenDesign(null);
    setFilter("");
  };
  if (loading || entries.length === 0 || !brief) {
    return (
      <section className="space-y-6">
        <BenchmarkToolbar actions={actions} />
        {loading ? (
          <BenchmarkEmpty title={t("loading")} compact />
        ) : entries.length === 0 ? (
          <BenchmarkEmpty
            title={t("design.empty")}
            description={t("design.emptyHint")}
          />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {briefs.map((group) => (
              <BriefCard
                key={group.versionId}
                brief={group}
                onOpen={() => setOpenBrief(group.versionId)}
              />
            ))}
          </ul>
        )}
      </section>
    );
  }
  const query = filter.trim().toLowerCase();
  const shown = brief.entries
    .map((entry) => ({ entry, identity: identity(entry) }))
    .filter(
      ({ entry, identity }) =>
        !query ||
        identity.name.toLowerCase().includes(query) ||
        entry.configuration.modelId.toLowerCase().includes(query),
    );
  const best = points(brief.best.score);
  return (
    <section className="space-y-6">
      <BenchmarkToolbar actions={actions}>
        <nav className="flex min-w-0 items-center gap-2 text-sm">
          <Button
            type="button"
            variant="ghost"
            flush
            leftIcon={<IconArrowLeft />}
            onClick={close}
          >
            {t("design.gallery")}
          </Button>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="truncate">{brief.name}</span>
        </nav>
      </BenchmarkToolbar>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <SectionHeading
          title={brief.name}
          description={
            best == null
              ? t("design.designs", { count: brief.entries.length })
              : t("design.summary", { count: brief.entries.length, best })
          }
        />
        <SearchBar
          size="small"
          className="sm:w-64"
          value={filter}
          onChange={setFilter}
          placeholder={t("design.filter")}
          aria-label={t("design.filter")}
        />
      </div>
      {shown.length === 0 ? (
        <BenchmarkEmpty title={t("design.noMatch")} compact />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {shown.map(({ entry, identity }) => (
            <DesignCard
              key={entry.attemptId}
              entry={entry}
              name={identity.name}
              vendor={identity.vendor}
              onOpen={() => setOpenDesign(entry.attemptId)}
            />
          ))}
        </ul>
      )}
      {design ? (
        <DesignDetailDialog
          entry={design}
          {...identity(design)}
          onClose={() => setOpenDesign(null)}
          onEvidence={(id) => {
            setOpenDesign(null);
            onEvidence(id);
          }}
        />
      ) : null}
    </section>
  );
}

function BriefCard({ brief, onOpen }: { brief: Brief; onOpen: () => void }) {
  const { t } = useTranslation("benchmarks");
  const count = t("design.designs", { count: brief.entries.length });
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("design.openBrief", { name: brief.name, count })}
        className="group w-full overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative aspect-[16/10] w-full overflow-hidden bg-white">
          <DesignImage entry={brief.best} />
        </div>
        <div className="space-y-0.5 p-3">
          <div className="truncate font-medium">{brief.name}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {count}
          </div>
        </div>
      </button>
    </li>
  );
}

function DesignCard({
  entry,
  name,
  vendor,
  onOpen,
}: {
  entry: DesignEntry;
  name: string;
  vendor: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const score = points(entry.score);
  // Only a rendering a panel still owes a verdict is waiting for one.
  const state =
    entry.phase === "terminal"
      ? (entry.outcome ?? "pending_review")
      : entry.phase;
  const awaitingPanel =
    entry.phase === "awaiting_judges" ||
    (entry.phase === "terminal"
      ? state === "pending_review"
      : entry.outcome === "pending_review");
  const effort = explicitEffort(entry.configuration.effort);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={t("design.open", {
          model: effort ? `${name} · ${effort}` : name,
        })}
        className="group w-full overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-white">
          <DesignImage entry={entry} />
        </div>
        <div className="flex items-center justify-between gap-3 p-3">
          <ModelIdentity
            configuration={entry.configuration}
            name={name}
            vendor={vendor}
          >
            {awaitingPanel ? (
              <p className="text-xs text-muted-foreground">
                {t("design.awaitingReview")}
              </p>
            ) : null}
          </ModelIdentity>
          <div className="shrink-0 text-right">
            <div
              className={cn(
                "font-display text-xl font-semibold tabular-nums",
                score == null && "text-muted-foreground",
              )}
            >
              {score ?? "–"}
            </div>
            {entry.judges.length > 0 ? (
              <div className="text-xs text-muted-foreground">
                {t("design.judges", { count: entry.judges.length })}
              </div>
            ) : null}
          </div>
        </div>
        <dl className="flex items-center gap-4 px-3 pb-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <dt>
              <IconCoin className="size-3.5" aria-label={t("fields.cost")} />
            </dt>
            <dd className="tabular-nums">
              {formatSpend(t, entry.cost, entry.outputTokens)}
            </dd>
          </div>
          <div className="flex items-center gap-1">
            <dt>
              <IconClock
                className="size-3.5"
                aria-label={t("fields.elapsed")}
              />
            </dt>
            <dd className="tabular-nums">
              {formatElapsed(t, entry.durationMs)}
            </dd>
          </div>
        </dl>
      </button>
    </li>
  );
}

/** A design's card image: what the judges saw, else its own markup. */
function DesignImage({ entry }: { entry: DesignEntry }) {
  const state =
    entry.phase === "terminal"
      ? (entry.outcome ?? "pending_review")
      : entry.phase;
  return (
    <DesignRendering
      rendering={entry.rendering ?? null}
      markup={renderable(entry.output, entry.outputFormat)}
      fallback={
        <div className="flex h-full items-center justify-center bg-muted">
          <StateBadge state={state} />
        </div>
      }
    />
  );
}
