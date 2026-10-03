import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

export interface ModelOption {
  key: string;
  name: string;
  vendor: string;
  /** Extra words the search should find, such as the API model id. */
  terms?: string;
}

/**
 * The one filter a board needs: every model is shown until some are chosen,
 * and the chosen ones stand side by side.
 */
export function ModelFilter({
  options,
  selected,
  onChange,
}: {
  options: ModelOption[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const [open, setOpen] = useState(false);
  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          rightIcon={<IconChevronDown />}
          aria-label={t("filters.models")}
        >
          {t("filters.models")}
          <span className="rounded-sm bg-muted px-1.5 font-mono text-xs">
            {selected.size === 0 ? t("filters.allModels") : selected.size}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 pt-3 pb-1">
          <span className="text-sm font-medium">{t("filters.showModels")}</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={selected.size === 0}
            onClick={() => onChange(new Set())}
          >
            {t("filters.showAll")}
          </Button>
        </div>
        <Command>
          <CommandInput placeholder={t("filters.modelOrProvider")} />
          <CommandList>
            <CommandEmpty>{t("leaderboard.empty")}</CommandEmpty>
            {options.map((option) => {
              const checked = selected.has(option.key);
              return (
                <CommandItem
                  key={option.key}
                  value={`${option.name} ${option.vendor} ${option.terms ?? ""}`}
                  onSelect={() => toggle(option.key)}
                  aria-checked={checked}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-xs border border-border",
                      checked && "border-chart-1 bg-chart-1 text-background",
                    )}
                  >
                    {checked ? <IconCheck className="size-3" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {option.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {option.vendor}
                    </span>
                  </span>
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
