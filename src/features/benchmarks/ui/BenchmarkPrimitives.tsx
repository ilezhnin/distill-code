import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconFilter } from "@tabler/icons-react";
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
import { Progress } from "@/shared/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { stateLabel, stateTone } from "../lib/benchmarkLabels";

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
      className="h-1.5 bg-muted"
      indicatorClassName={leading ? undefined : "bg-foreground/35"}
    />
  );
}

/** Tiny bars, one per board, so a row's whole profile reads at a glance. */
export function AxisBars({
  items,
  muted = false,
}: {
  items: { id: string; label: string; share: number | null }[];
  muted?: boolean;
}) {
  return (
    <div
      className="flex h-5 items-end gap-0.5"
      role="img"
      aria-label={items.map((item) => item.label).join(", ")}
    >
      {items.map((item) => (
        <span
          key={item.id}
          title={item.label}
          className={cn(
            "w-1.5 rounded-xs",
            item.share == null
              ? "bg-muted"
              : muted
                ? "bg-foreground/20"
                : "bg-foreground/50",
          )}
          style={{
            height: item.share == null ? "100%" : `${Math.max(8, item.share)}%`,
          }}
        />
      ))}
    </div>
  );
}

/** Label over value, for the summary grid at the top of a report dialog. */
export function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-display text-base tabular-nums">{value}</dd>
    </div>
  );
}
