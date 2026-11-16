import { useTranslation } from "react-i18next";
import { mutationShare } from "../lib/benchmarkMutation";

/**
 * The counts behind a share-scored suite evaluation: correct implementations
 * accepted and defects caught, with the ones the suite got wrong.
 */
export function MutationShare({
  details,
}: {
  details: Record<string, unknown> | null | undefined;
}) {
  const { t } = useTranslation("benchmarks");
  const share = mutationShare(details);
  if (!share) return null;
  const rows: [string, string][] = [
    [
      t("evidence.mutationCorrect"),
      `${share.correctAccepted}/${share.correctTotal}`,
    ],
    [
      t("evidence.mutationDefects"),
      `${share.defectsCaught}/${share.defectTotal}`,
    ],
  ];
  if (share.refused.length > 0)
    rows.push([t("evidence.mutationRefused"), share.refused.join(", ")]);
  if (share.missed.length > 0)
    rows.push([t("evidence.mutationMissed"), share.missed.join(", ")]);
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="inline">{label}</dt>
          <dd className="inline tabular-nums"> {value}</dd>
        </div>
      ))}
    </dl>
  );
}
