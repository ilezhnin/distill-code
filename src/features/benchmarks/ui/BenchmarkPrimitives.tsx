import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  IconBolt,
  IconBraces,
  IconCode,
  IconCoin,
  IconFeather,
  IconFilter,
  IconLayout,
  IconMessage,
  IconNotebook,
  IconPalette,
  IconRoute,
  IconShieldCheck,
  IconSparkles,
  IconTarget,
  IconTestPipe,
  IconTrophy,
} from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Alert, AlertDescription } from "@/shared/ui/alert";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Label } from "@/shared/ui/label";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/shared/ui/hover-card";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { Progress } from "@/shared/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { explicitEffort } from "../lib/benchmarkEffort";
import { shortId, stateLabel, stateTone } from "../lib/benchmarkLabels";
import type { Configuration } from "../types";

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Label plus one control; the render prop receives the generated id. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SelectField({
  id,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Quiet single-value filter: a ghost button that opens a radio menu. */
export function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          leftIcon={<IconFilter />}
          className="min-w-0"
          aria-label={label}
        >
          <span className="truncate">{current?.label ?? label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              indicatorSide="end"
              disabled={option.disabled}
            >
              <span className="truncate">{option.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A section's first row: its own controls on the left, then its trailing
 * controls and the page actions on the right. The row owns the actions, so
 * it wraps only when everything in it overflows, and the right-hand group
 * stays on the right when it does.
 */
export function BenchmarkToolbar({
  children,
  trailing,
  actions,
}: {
  children?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
}) {
  if (!children && !trailing && !actions) return null;
  return (
    <div
      data-testid="benchmark-toolbar"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      {children}
      {trailing || actions ? (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {trailing}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function BenchmarkAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="whitespace-pre-wrap">
        {children}
      </AlertDescription>
    </Alert>
  );
}

/** Centered quiet block for empty and loading states. */
export function BenchmarkEmpty({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center gap-2 text-center",
        compact ? "py-8" : "py-16",
      )}
    >
      <p className="text-sm text-foreground">{title}</p>
      {description ? (
        <p className="max-w-md text-xs text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function BenchmarkPager({
  page,
  pageSize,
  count,
  busy = false,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  count: number;
  busy?: boolean;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation("benchmarks");
  if (page === 0 && count < pageSize) return null;
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={busy || page === 0}
        onClick={() => onPageChange(page - 1)}
      >
        {t("actions.previous")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={busy || count < pageSize}
        onClick={() => onPageChange(page + 1)}
      >
        {t("actions.next")}
      </Button>
    </div>
  );
}

export function StateBadge({ state }: { state: string | null | undefined }) {
  const { t } = useTranslation("benchmarks");
  const tone = stateTone(state);
  return (
    <Badge
      variant={
        tone === "negative"
          ? "destructive"
          : tone === "positive"
            ? "secondary"
            : "outline"
      }
    >
      {stateLabel(t, state)}
    </Badge>
  );
}

/** Section heading inside the editor and dialogs; matches settings sections. */
export function SectionHeading({
  title,
  description,
  id,
}: {
  title: string;
  description?: string;
  id?: string;
}) {
  return (
    <div className="space-y-1">
      <h2
        id={id}
        className="font-display text-base font-medium tracking-tight text-foreground"
      >
        {title}
      </h2>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

/** One board value as a bar: the leader fills it, the others follow in a quieter tone. */
export function ScoreBar({
  share,
  leading,
  label,
}: {
  share: number;
  leading: boolean;
  label: string;
}) {
  return (
    <Progress
      value={share}
      aria-label={label}
      className="h-2 bg-muted"
      indicatorClassName={leading ? "bg-chart-1" : "bg-foreground/30"}
    />
  );
}

/** Tiny bars, one per board; hovering lists every board with its points. */
export function AxisBars({
  items,
  muted = false,
  activeId,
}: {
  items: { id: string; label: string; points: number | null }[];
  muted?: boolean;
  /** The board on screen: its bar carries the accent. */
  activeId?: string;
}) {
  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <div
          className="flex h-5 w-fit cursor-default items-end gap-0.5"
          role="img"
          aria-label={items
            .map((item) => `${item.label}: ${item.points ?? "–"}`)
            .join(", ")}
        >
          {items.map((item) => (
            <span
              key={item.id}
              className={cn(
                "w-1.5 rounded-xs",
                item.points == null
                  ? "bg-muted"
                  : item.id === activeId
                    ? "bg-chart-1"
                    : muted
                      ? "bg-foreground/20"
                      : "bg-foreground/50",
              )}
              style={{
                height:
                  item.points == null
                    ? "100%"
                    : `${Math.max(8, item.points / 10)}%`,
              }}
            />
          ))}
        </div>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-56 p-3">
        <dl className="space-y-1 text-xs">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-baseline justify-between gap-3"
            >
              <dt
                className={cn(
                  "text-muted-foreground",
                  item.id === activeId && "text-chart-1",
                )}
              >
                {item.label}
              </dt>
              <dd
                className={cn(
                  "text-right font-semibold tabular-nums",
                  item.id === activeId && "text-chart-1",
                )}
              >
                {item.points ?? "–"}
              </dd>
            </div>
          ))}
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

/** Label over value, for the summary grid at the top of a report dialog. */
const BOARD_ICONS: Record<string, typeof IconTrophy> = {
  overall: IconTrophy,
  efficiency: IconFeather,
  speed: IconBolt,
  cost: IconCoin,
  "frontend-ui": IconLayout,
  creative: IconPalette,
  "coding-simple": IconCode,
  "coding-complex": IconBraces,
  "one-shot": IconTarget,
  planning: IconRoute,
  "general-light": IconMessage,
  "general-medium": IconNotebook,
  "testing-light": IconTestPipe,
  "testing-heavy": IconShieldCheck,
};

/** The glyph a board goes by wherever it is named: a work class or a shared measurement. */
export function BoardIcon({
  board,
  className,
}: {
  board: { id: string; workClass: string | null };
  className?: string;
}) {
  const Icon = BOARD_ICONS[board.workClass ?? board.id] ?? IconSparkles;
  return <Icon className={className} aria-hidden />;
}

export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-base tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * A model the way the reference names one: vendor icon beside both lines,
 * display name with its effort level and fast mode as chips, and the vendor
 * underneath. A model without an effort control shows no effort chip, and
 * the CLI's "default" is never named as one: it is no level, and a row
 * measured at it is left out of every board.
 */
export function ModelIdentity({
  configuration,
  name,
  vendor,
  showRuntime = false,
  children,
}: {
  configuration: Configuration;
  name: string;
  vendor: string;
  showRuntime?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation("benchmarks");
  const effort = explicitEffort(configuration.effort);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="shrink-0">
        {getProviderIcon(configuration.providerId, "size-6")}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{name}</span>
          {effort ? <Badge variant="outline">{effort}</Badge> : null}
          {configuration.fastMode ? (
            <Badge variant="outline">{t("fastMode")}</Badge>
          ) : null}
          {showRuntime && configuration.inventoryRevision ? (
            <Badge variant="outline" className="text-muted-foreground">
              {t("leaderboard.runtime", {
                id: shortId(configuration.inventoryRevision),
              })}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">{vendor}</p>
        {children}
      </div>
    </div>
  );
}
