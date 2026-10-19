import { IconChevronDown } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/** The marks a render records on a panel that sits close to the candidate. */
export const JUDGE_FLAGS = ["sameVendor", "ownModel", "authorModel"] as const;
export type JudgeFlag = (typeof JUDGE_FLAGS)[number];

/**
 * Which judged scores a board shows: a panel that seated a judge of the
 * candidate's lab, the candidate's own model or the case author's model
 * marks its scores, and each mark can be left out. Every score shows by
 * default.
 */
export function JudgeFlagFilter({
  hidden,
  onChange,
}: {
  hidden: readonly JudgeFlag[];
  onChange: (hidden: JudgeFlag[]) => void;
}) {
  const { t } = useTranslation("benchmarks");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          rightIcon={<IconChevronDown />}
          aria-label={t("judgeFlags.label")}
        >
          {t("judgeFlags.label")}
          <span className="rounded-sm bg-muted px-1.5 font-mono text-xs">
            {hidden.length === 0
              ? t("judgeFlags.all")
              : t("judgeFlags.hidden", { count: hidden.length })}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t("judgeFlags.heading")}</DropdownMenuLabel>
        {JUDGE_FLAGS.map((flag) => (
          <DropdownMenuCheckboxItem
            key={flag}
            checked={!hidden.includes(flag)}
            onCheckedChange={(shown) =>
              onChange(
                shown
                  ? hidden.filter((entry) => entry !== flag)
                  : [...hidden, flag],
              )
            }
            onSelect={(event) => event.preventDefault()}
          >
            {t(`judgeFlags.flags.${flag}`)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
