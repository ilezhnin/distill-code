import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconChevronDown } from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { Label } from "@/shared/ui/label";
import { SearchBar } from "@/shared/ui/SearchBar";
import { shortId } from "../lib/benchmarkLabels";
import type { BenchmarkVersionSummary } from "../types";

const SPLITS = ["train", "held_out", "development"] as const;

/** Keep historical authoring annotations in the tooltip, not every list row. */
function taskName(name: string) {
  return name.replace(/\s+\(selector evaluation v\d+\)$/i, "");
}

export function BenchmarkTestPicker({
  versions,
  selectedIds,
  disabled,
  onChange,
}: {
  versions: BenchmarkVersionSummary[];
  selectedIds: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string[]>(() => {
    const selected = versions.filter((v) => selectedIds.includes(v.id));
    return selected.length
      ? [...new Set(selected.map((v) => v.manifest.split))]
      : [
          SPLITS.find((split) =>
            versions.some((v) => v.manifest.split === split),
          ) ?? "train",
        ];
  });
  const search = query.trim().toLowerCase();
  const visible = versions.filter((v) =>
    `${v.manifest.name} ${v.contentHash}`.toLowerCase().includes(search),
  );
  const select = (ids: string[], checked: boolean) =>
    onChange(
      checked
        ? [...new Set([...selectedIds, ...ids])]
        : selectedIds.filter((id) => !ids.includes(id)),
    );
  return (
    <div className="space-y-3">
      <SearchBar
        value={query}
        onChange={setQuery}
        placeholder={t("filters.search")}
        aria-label={t("filters.search")}
      />
      {!versions.length ? (
        <p className="text-xs text-muted-foreground">{t("run.noPublished")}</p>
      ) : null}
      {versions.length > 0 && !visible.length ? (
        <p className="text-xs text-muted-foreground">
          {t("run.noMatchingTests")}
        </p>
      ) : null}
      <div className="divide-y">
        {SPLITS.map((split) => {
          const group = visible.filter((v) => v.manifest.split === split);
          if (!group.length) return null;
          const selected = group.filter((v) =>
            selectedIds.includes(v.id),
          ).length;
          const label = t(`split.${split}`);
          return (
            <Collapsible
              key={split}
              open={Boolean(search) || open.includes(split)}
              onOpenChange={(expanded) =>
                setOpen((current) =>
                  expanded
                    ? [...current, split]
                    : current.filter((value) => value !== split),
                )
              }
            >
              <div className="flex items-center gap-2 py-2">
                <Checkbox
                  disabled={disabled}
                  aria-label={t("run.selectGroup", { group: label })}
                  checked={
                    selected === group.length
                      ? true
                      : selected
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(checked) =>
                    select(
                      group.map((v) => v.id),
                      checked === true,
                    )
                  }
                />
                <CollapsibleTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="group min-w-0 flex-1 justify-between"
                  >
                    <span>{label}</span>
                    <span className="ml-auto tabular-nums">
                      {selected} / {group.length}
                    </span>
                    <IconChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
                  </Button>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent className="space-y-1 pb-3">
                <p className="pb-2 pl-6 text-xs text-muted-foreground">
                  {t(`run.splitHints.${split}`)}
                </p>
                {group.map((version) => {
                  const name = taskName(version.manifest.name);
                  const peers = versions
                    .filter(
                      (v) =>
                        v.manifest.split === split &&
                        taskName(v.manifest.name) === name,
                    )
                    .sort(
                      (a, b) =>
                        a.publishedAt - b.publishedAt ||
                        a.id.localeCompare(b.id),
                    );
                  return (
                    <Label
                      key={version.id}
                      className="flex items-start gap-2 py-1.5 pl-6 text-sm"
                      title={t("run.testDetails", {
                        name: version.manifest.name,
                        split: label,
                        hash: version.contentHash,
                      })}
                    >
                      <Checkbox
                        disabled={disabled}
                        checked={selectedIds.includes(version.id)}
                        onCheckedChange={(checked) =>
                          select([version.id], checked === true)
                        }
                      />
                      <span className="min-w-0 flex-1 break-words">{name}</span>
                      {peers.length > 1 ? (
                        <span
                          className="shrink-0 text-xs text-muted-foreground"
                          title={shortId(version.contentHash)}
                        >
                          {t("run.version", {
                            number:
                              peers.findIndex((v) => v.id === version.id) + 1,
                          })}
                        </span>
                      ) : null}
                    </Label>
                  );
                })}
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}
