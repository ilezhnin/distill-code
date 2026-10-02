import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { cn } from "@/shared/lib/cn";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { formatTokens, formatUsd, shortId } from "../lib/benchmarkLabels";
import { formatContext } from "../lib/modelCatalog";
import type { BenchmarkVersion, CatalogEntry, LeaderboardRow } from "../types";
import { BenchmarkAttemptsDialog } from "./BenchmarkAttemptsDialog";
import { ScoreBar, SectionHeading, StateBadge } from "./BenchmarkPrimitives";

/** One board as it stands for the opened configuration. */
export interface BoardStanding {
  id: string;
  label: string;
  description: string;
  points: number | null;
  rank: number | null;
  /** Ranked configurations on that board. */
  of: number;
  share: number | null;
}

function money(value: number | null | undefined): string {
  return value == null ? "–" : `$${Number(value.toPrecision(3)).toString()}`;
}

/**
 * A model page in a dialog: rank and overall rating in the header, every
 * board with its place and points, the facts behind the row, the vendor's
 * list prices, then the attempts as evidence.
 */
export function BenchmarkConfigurationDialog({
  row,
  name,
  vendor,
  fact,
  standings,
  versions,
  onEvidence,
  onClose,
}: {
  row: LeaderboardRow;
  name: string;
  vendor: string;
  fact: CatalogEntry | null;
  standings: BoardStanding[];
  versions: BenchmarkVersion[];
  onEvidence: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const overall = standings.find((board) => board.id === "overall");
  const axes = standings.filter((board) => board.id !== "overall");
  const place = (board: BoardStanding | undefined) =>
    board?.rank == null
      ? t("configuration.notRanked")
      : t("configuration.rank", { rank: board.rank, of: board.of });
  const specs: [string, string][] = [
    [t("configuration.apiModelId"), row.configuration.modelId],
    [t("fields.provider"), row.configuration.providerId],
    [t("fields.effort"), row.configuration.effort ?? t("unknown")],
    [
      t("fields.fastMode"),
      row.configuration.fastMode == null
        ? t("unknown")
        : row.configuration.fastMode
          ? t("enabled")
          : t("disabled"),
    ],
    [
      t("configuration.runtime"),
      row.configuration.inventoryRevision
        ? shortId(row.configuration.inventoryRevision)
        : t("unknown"),
    ],
    [
      t("configuration.context"),
      formatContext(fact?.contextTokens) ?? t("unknown"),
    ],
    [t("configuration.cases"), `${row.scored} / ${row.planned}`],
    [
      t("configuration.measured"),
      row.measuredAt == null
        ? t("unknown")
        : formatDate(row.measuredAt, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
    ],
    [t("configuration.spend"), formatUsd(t, row.cost)],
    [t("configuration.outputTokens"), formatTokens(t, row.medianOutputTokens)],
  ];
  return (
    <BenchmarkAttemptsDialog
      title={name}
      description={vendor}
      icon={getProviderIcon(row.configuration.providerId, "size-6")}
      aside={
        <dl className="flex shrink-0 gap-8 text-right">
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("configuration.rankLabel")}
            </dt>
            <dd className="font-display text-2xl tabular-nums">
              {overall?.rank == null ? (
                <span className="text-muted-foreground">–</span>
              ) : (
                <>
                  <span className={cn(overall.rank === 1 && "text-chart-1")}>
                    {overall.rank}
                  </span>
                  <span className="ml-1 text-sm text-muted-foreground">
                    {t("configuration.of", { of: overall.of })}
                  </span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {t("configuration.ratingLabel")}
            </dt>
            <dd className="font-display text-2xl tabular-nums">
              {overall?.points ?? "–"}
            </dd>
          </div>
        </dl>
      }
      attemptIds={row.attemptIds}
      versions={versions}
      onEvidence={onEvidence}
      onClose={onClose}
    >
      {row.status !== "comparable" ? (
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={row.status} />
          <span className="text-xs text-muted-foreground">{row.reason}</span>
        </div>
      ) : null}
      <div className="grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <SectionHeading title={t("configuration.ratings")} />
            <span className="text-xs text-muted-foreground">
              {t("configuration.higherIsBetter")}
            </span>
          </div>
          <ul className="divide-y divide-border">
            {axes.map((board) => (
              <li key={board.id} className="space-y-1.5 py-3">
                <div className="flex items-center gap-4">
                  <div className="w-44 shrink-0">
                    <span className="font-medium">{board.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {place(board)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    {board.share != null ? (
                      <ScoreBar
                        share={board.share}
                        leading={board.rank === 1}
                        label={`${board.label}: ${board.points ?? "–"}`}
                      />
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      "w-14 shrink-0 text-right font-display text-lg font-semibold tabular-nums",
                      board.rank === 1 && "text-chart-1",
                      board.points == null && "text-muted-foreground",
                    )}
                  >
                    {board.points ?? "–"}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {board.description}
                </p>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-4">
          <SectionHeading title={t("configuration.specs")} />
          <dl className="divide-y divide-border text-sm">
            {specs.map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-4 py-2"
              >
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      {fact?.inputPerMillion != null || fact?.outputPerMillion != null ? (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between gap-4">
            <SectionHeading title={t("configuration.pricing")} />
            <span className="text-xs text-muted-foreground">
              {t("configuration.perMillion")}
            </span>
          </div>
          <dl className="grid grid-cols-3 gap-6">
            {[
              [t("configuration.input"), fact?.inputPerMillion],
              [t("configuration.cachedInput"), fact?.cacheReadPerMillion],
              [t("configuration.output"), fact?.outputPerMillion],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {label}
                </dt>
                <dd className="font-display text-2xl tabular-nums">
                  {money(value as number | null | undefined)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {fact?.cacheWritePerMillion != null
              ? `${t("configuration.cacheWrites", { price: money(fact.cacheWritePerMillion) })} · `
              : ""}
            {t("configuration.source", {
              source: fact?.source || t("unknown"),
              date: formatDate(fact?.checkedAt ?? 0, { dateStyle: "medium" }),
            })}
          </p>
        </section>
      ) : null}
    </BenchmarkAttemptsDialog>
  );
}
