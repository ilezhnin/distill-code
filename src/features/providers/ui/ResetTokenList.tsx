import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import type { ResetTokenRow } from "../lib/resetTokens";

/**
 * A reset token's name and, where the name alone would read as more than the
 * reset does, what it refills.
 */
export function resetTokenText(
  t: TFunction<"settings">,
  row: ResetTokenRow,
): { name: string; hint: string | null } {
  return {
    // A provider's own name stands where Flock has none for the kind.
    name:
      row.kind === "usage" && row.title
        ? row.title
        : t(`accounts.resetTypes.${row.kind}`),
    hint: row.kind === "fable" ? t("accounts.resetHints.fable") : null,
  };
}

/**
 * An account's reset tokens, the same rows for every provider: what a reset
 * refills, how many are left, when it expires, and Use where one can be used
 * now.
 */
export function ResetTokenList({
  rows,
  onUse,
  disabled = false,
}: {
  rows: ResetTokenRow[];
  /** Offers Use on the rows that can be used now. */
  onUse?: (row: ResetTokenRow) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { formatDate } = useLocaleFormatting();
  if (!rows.length) return null;
  const title = t("accounts.resetTokensTitle");
  return (
    <div className="space-y-1">
      <div className="font-medium text-foreground">{title}</div>
      <ul
        aria-label={title}
        className="divide-y divide-border border-t border-border"
      >
        {rows.map((row) => {
          const { name, hint } = resetTokenText(t, row);
          // Why a reset is not offered stands where its hint would.
          const note =
            row.state === "available"
              ? hint
              : row.blocked
                ? t(`accounts.resetBlocks.${row.blocked}`)
                : t(`accounts.resetStates.${row.state}`);
          return (
            <li
              key={row.kind}
              className="flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5"
            >
              <div className="min-w-0">
                <p className="text-foreground">
                  <span title={row.description ?? undefined}>{name}</span>
                  {row.count > 1 ? (
                    <span className="ml-1.5 text-muted-foreground">
                      {t("accounts.resetCount", { value: row.count })}
                    </span>
                  ) : null}
                </p>
                {note ? <p className="text-muted-foreground">{note}</p> : null}
              </div>
              <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                {row.expiresAt != null ? (
                  <time
                    className="text-muted-foreground"
                    dateTime={new Date(row.expiresAt).toISOString()}
                  >
                    {t("accounts.expiresAt", {
                      date: formatDate(row.expiresAt, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })}
                  </time>
                ) : null}
                {onUse && row.state === "available" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={disabled}
                    aria-label={t("accounts.useNamedReset", { name })}
                    onClick={() => onUse(row)}
                  >
                    {t("accounts.use")}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
