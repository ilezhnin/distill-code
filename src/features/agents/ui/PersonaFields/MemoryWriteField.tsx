/**
 * Whether this agent carries the `memory_write` grant, as an editable field.
 *
 * Same three states as the spawn field, and the same reason to keep them
 * apart — but here the third state cannot be a checkbox at all: an unchecked
 * box would claim the operator refused the grant when in fact nobody has
 * said anything yet. So the control is a three-way choice whose first option
 * IS "not set", which is also how the operator clears an override.
 *
 * What the grant does is narrower than its name suggests, and the secondary
 * line says so rather than letting the operator infer a bigger promise: only
 * the orchestrator layer consults it. A conductor and an ordinary chat write
 * memory regardless, a worker and a wave child never do, and a grant on an
 * agent that never runs as an orchestrator changes nothing.
 */

import { useTranslation } from "react-i18next";

import { Label } from "@/shared/ui/label";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";

import { formatMemoryWriteDefaults } from "../../lib/personaAclCopy";

/** The three states, as the radio group's values. */
const INHERIT = "inherit";
const GRANTED = "granted";
const REFUSED = "refused";

export interface MemoryWriteFieldProps {
  /** The stored grant; `undefined` means no override is stored. */
  value: boolean | undefined;
  /**
   * Persisted as the `memory_write` property. `null` clears the override;
   * `false` is a real, stored refusal.
   */
  onChange: (next: boolean | null) => void;
  isReadOnly?: boolean;
  classes?: { fieldLabel?: string };
}

export function MemoryWriteField({
  value,
  onChange,
  isReadOnly = false,
  classes,
}: MemoryWriteFieldProps) {
  const { t } = useTranslation("agents");

  const selected = value === undefined ? INHERIT : value ? GRANTED : REFUSED;
  const options = [
    { value: INHERIT, label: t("acl.memoryWrite.optionInherit") },
    { value: GRANTED, label: t("acl.memoryWrite.optionGranted") },
    { value: REFUSED, label: t("acl.memoryWrite.optionRefused") },
  ];

  const stateText =
    value === undefined
      ? t("acl.memoryWrite.notSet", {
          defaults: formatMemoryWriteDefaults(t),
        })
      : value
        ? t("acl.memoryWrite.overrideGranted")
        : t("acl.memoryWrite.overrideRefused");

  return (
    <div className="flex flex-col gap-2" data-testid="agent-memory-write-field">
      <Label className={classes?.fieldLabel}>
        {t("acl.memoryWrite.label")}
      </Label>

      <RadioGroup
        className="flex flex-wrap items-center gap-x-4 gap-y-2"
        aria-label={t("acl.memoryWrite.groupAria")}
        value={selected}
        disabled={isReadOnly}
        onValueChange={(next) => {
          onChange(next === INHERIT ? null : next === GRANTED);
        }}
      >
        {options.map((option) => (
          <span key={option.value} className="flex items-center gap-2">
            <RadioGroupItem
              id={`agent-memory-write-${option.value}`}
              value={option.value}
              data-testid={`agent-memory-write-${option.value}`}
            />
            <label
              htmlFor={`agent-memory-write-${option.value}`}
              className="text-sm"
            >
              {option.label}
            </label>
          </span>
        ))}
      </RadioGroup>

      <p
        className="text-[11px] text-muted-foreground"
        data-testid="agent-memory-write-state"
      >
        {stateText}
      </p>
    </div>
  );
}
