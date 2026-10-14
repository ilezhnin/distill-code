import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { Field, SelectField } from "./BenchmarkPrimitives";

type Spec = Record<string, unknown>;
type Validity = (id: string, invalid: boolean) => void;

function rowKey(keys: string[], index: number): string {
  keys[index] ??= crypto.randomUUID();
  return keys[index];
}

function object(value: unknown): Spec {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Spec)
    : {};
}

function JsonValue({
  label,
  value,
  onChange,
  validity,
  array = false,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  validity: Validity;
  array?: boolean;
}) {
  const { t } = useTranslation("benchmarks");
  const id = useId();
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  const lastValue = useRef(serialized);
  const [text, setText] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (serialized !== lastValue.current) {
      lastValue.current = serialized;
      setText(serialized);
      setInvalid(false);
    }
  }, [serialized]);
  useEffect(() => {
    validity(id, invalid);
    return () => validity(id, false);
  }, [id, invalid, validity]);
  return (
    <Field
      label={label}
      hint={invalid ? t("authoring.invalidValue") : undefined}
    >
      {(fieldId) => (
        <Textarea
          id={fieldId}
          variant="code"
          rows={2}
          value={text}
          aria-invalid={invalid}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            try {
              const parsed: unknown = JSON.parse(next);
              if (array && !Array.isArray(parsed))
                throw new Error("array required");
              lastValue.current = JSON.stringify(parsed, null, 2);
              setInvalid(false);
              onChange(parsed);
            } catch {
              setInvalid(true);
            }
          }}
        />
      )}
    </Field>
  );
}

function FileFields({
  files,
  onChange,
}: {
  files: Spec[];
  onChange: (files: Spec[]) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const keys = useRef<string[]>([]);
  return (
    <div className="space-y-3">
      {files.map((file, index) => (
        <div key={rowKey(keys.current, index)} className="space-y-2">
          <div className="flex items-end gap-2">
            <Field label={t("fields.fixturePath")} className="flex-1">
              {(id) => (
                <Input
                  id={id}
                  value={String(file.path ?? "")}
                  placeholder="checks.py"
                  onChange={(event) =>
                    onChange(
                      files.map((row, position) =>
                        position === index
                          ? { ...row, path: event.target.value }
                          : row,
                      ),
                    )
                  }
                />
              )}
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("actions.remove")}
              onClick={() => {
                keys.current.splice(index, 1);
                onChange(files.filter((_, position) => position !== index));
              }}
            >
              <IconTrash />
            </Button>
          </div>
          <Field label={t("fields.fixtureContent")}>
            {(id) => (
              <Textarea
                id={id}
                variant="code"
                rows={5}
                value={String(file.content ?? "")}
                onChange={(event) =>
                  onChange(
                    files.map((row, position) =>
                      position === index
                        ? { ...row, content: event.target.value }
                        : row,
                    ),
                  )
                }
              />
            )}
          </Field>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        flush
        leftIcon={<IconPlus />}
        onClick={() => onChange([...files, { path: "", content: "" }])}
      >
        {t("editor.addFixture")}
      </Button>
    </div>
  );
}

const BROWSER_ACTIONS = [
  "click",
  "fill",
  "selectOption",
  "press",
  "expectText",
  "expectValue",
  "expectCount",
  "expectAccessibleName",
  "expectAccessibleDescription",
  "expectAccessibleError",
  "expectSize",
  "expectBounds",
];

/** Edits the existing checker contract without exposing its envelope or losing imported fields. */
export function BenchmarkCheckSetup({
  kind,
  value,
  onChange,
  onInvalidChange,
}: {
  kind: string;
  value: string;
  onChange: (value: string) => void;
  onInvalidChange: (invalid: boolean) => void;
}) {
  const { t } = useTranslation("benchmarks");
  const keys = useRef<string[]>([]);
  const [invalidFields, setInvalidFields] = useState<Record<string, boolean>>(
    {},
  );
  const validity = useCallback<Validity>((id, invalid) => {
    setInvalidFields((previous) =>
      previous[id] === invalid ? previous : { ...previous, [id]: invalid },
    );
  }, []);
  let spec: Spec = {};
  let invalidSpec = false;
  try {
    const parsed: unknown = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("object required");
    spec = object(parsed);
  } catch {
    invalidSpec = true;
  }
  const invalid = invalidSpec || Object.values(invalidFields).some(Boolean);
  useEffect(() => {
    onInvalidChange(invalid);
    return () => onInvalidChange(false);
  }, [invalid, onInvalidChange]);
  const patch = (key: string, next: unknown) =>
    onChange(JSON.stringify({ ...spec, [key]: next }, null, 2));
  const input = (
    label: string,
    current: string,
    change: (next: string) => void,
    placeholder?: string,
  ) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          value={current}
          placeholder={placeholder}
          onChange={(event) => change(event.target.value)}
        />
      )}
    </Field>
  );
  const commandFields = (
    target: Spec,
    update: (next: Spec) => void,
    label = t("authoring.program"),
  ) => {
    const command = Array.isArray(target.command)
      ? target.command.map(String)
      : [];
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {input(
          label,
          command[0] ?? "",
          (program) =>
            update({ ...target, command: [program, ...command.slice(1)] }),
          "python3",
        )}
        <Field
          label={t("authoring.arguments")}
          hint={t("authoring.argumentsHint")}
        >
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              value={command.slice(1).join("\n")}
              onChange={(event) =>
                update({
                  ...target,
                  command: [
                    command[0] ?? "",
                    ...event.target.value.split("\n"),
                  ],
                })
              }
            />
          )}
        </Field>
      </div>
    );
  };
  return (
    <div className="space-y-4">
      {!invalidSpec && kind === "javascript" ? (
        <>
          {input(
            t("authoring.function"),
            String(spec.functionName ?? ""),
            (next) => patch("functionName", next),
            "solve",
          )}
          {(Array.isArray(spec.argsCases) ? spec.argsCases : []).map(
            (entry: unknown, index: number) => {
              const row = object(entry);
              const cases = spec.argsCases as unknown[];
              const change = (key: string, next: unknown) =>
                patch(
                  "argsCases",
                  cases.map((item, position) =>
                    position === index ? { ...row, [key]: next } : item,
                  ),
                );
              return (
                <div
                  key={rowKey(keys.current, index)}
                  className="grid items-start gap-3 md:grid-cols-[1fr_1fr_auto]"
                >
                  <JsonValue
                    label={t("authoring.inputs")}
                    value={row.args ?? []}
                    array
                    validity={validity}
                    onChange={(next) => change("args", next)}
                  />
                  <JsonValue
                    label={t("fields.expected")}
                    value={row.expected}
                    validity={validity}
                    onChange={(next) => change("expected", next)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("actions.remove")}
                    onClick={() => {
                      keys.current.splice(index, 1);
                      patch(
                        "argsCases",
                        cases.filter((_, position) => position !== index),
                      );
                    }}
                  >
                    <IconTrash />
                  </Button>
                </div>
              );
            },
          )}
          <Button
            type="button"
            variant="ghost"
            flush
            leftIcon={<IconPlus />}
            onClick={() =>
              patch("argsCases", [
                ...(Array.isArray(spec.argsCases) ? spec.argsCases : []),
                { args: [], expected: null },
              ])
            }
          >
            {t("authoring.addCase")}
          </Button>
        </>
      ) : null}
      {!invalidSpec && kind === "browser" ? (
        <>
          {(Array.isArray(spec.steps) ? spec.steps : []).map(
            (entry: unknown, index: number) => {
              const row = object(entry);
              const steps = spec.steps as unknown[];
              const action = String(row.action ?? "click");
              const change = (key: string, next: unknown) =>
                patch(
                  "steps",
                  steps.map((item, position) =>
                    position === index ? { ...row, [key]: next } : item,
                  ),
                );
              return (
                <div
                  key={rowKey(keys.current, index)}
                  className="space-y-3 border-b border-border pb-4"
                >
                  <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_auto]">
                    <Field label={t("authoring.action")}>
                      {(id) => (
                        <SelectField
                          id={id}
                          value={action}
                          onChange={(next) => change("action", next)}
                          options={BROWSER_ACTIONS.map((item) => ({
                            value: item,
                            label: t(`authoring.browserActions.${item}`),
                          }))}
                        />
                      )}
                    </Field>
                    {input(
                      t("authoring.element"),
                      String(row.selector ?? ""),
                      (next) => change("selector", next),
                      "#submit",
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("actions.remove")}
                      onClick={() => {
                        keys.current.splice(index, 1);
                        patch(
                          "steps",
                          steps.filter((_, position) => position !== index),
                        );
                      }}
                    >
                      <IconTrash />
                    </Button>
                  </div>
                  {action === "expectCount" ||
                  action === "expectSize" ||
                  action === "expectBounds" ? (
                    <JsonValue
                      label={t("authoring.value")}
                      value={row.value ?? (action === "expectCount" ? 1 : {})}
                      onChange={(next) => change("value", next)}
                      validity={validity}
                    />
                  ) : action !== "click" ? (
                    input(
                      t("authoring.value"),
                      String(row.value ?? ""),
                      (next) => change("value", next),
                    )
                  ) : null}
                </div>
              );
            },
          )}
          <Button
            type="button"
            variant="ghost"
            flush
            leftIcon={<IconPlus />}
            onClick={() =>
              patch("steps", [
                ...(Array.isArray(spec.steps) ? spec.steps : []),
                { action: "click", selector: "" },
              ])
            }
          >
            {t("authoring.addStep")}
          </Button>
        </>
      ) : null}
      {!invalidSpec && kind === "repository" ? (
        <>
          {commandFields(spec, (next) =>
            onChange(JSON.stringify(next, null, 2)),
          )}
          <Field label={t("authoring.checkTimeout")}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                value={Number(spec.timeoutSeconds ?? 600)}
                onChange={(event) =>
                  patch("timeoutSeconds", Number(event.target.value))
                }
              />
            )}
          </Field>
          <details>
            <summary className="cursor-pointer text-sm">
              {t("authoring.checkFiles")}
            </summary>
            <div className="pt-3">
              <FileFields
                files={Array.isArray(spec.files) ? spec.files.map(object) : []}
                onChange={(files) => patch("files", files)}
              />
            </div>
          </details>
          {spec.probe ? (
            <details>
              <summary className="cursor-pointer text-sm">
                {t("authoring.probe")}
              </summary>
              <div className="space-y-4 pt-3">
                {commandFields(
                  object(spec.probe),
                  (next) => patch("probe", next),
                  t("authoring.probe"),
                )}
                <FileFields
                  files={
                    Array.isArray(object(spec.probe).files)
                      ? (object(spec.probe).files as unknown[]).map(object)
                      : []
                  }
                  onChange={(files) =>
                    patch("probe", { ...object(spec.probe), files })
                  }
                />
              </div>
            </details>
          ) : null}
        </>
      ) : null}
      <details open={invalidSpec || undefined}>
        <summary className="cursor-pointer text-sm">
          {t("authoring.advancedCheck")}
        </summary>
        <Field
          label={t("authoring.checkDefinition")}
          className="pt-3"
          hint={invalidSpec ? t("authoring.invalidValue") : undefined}
        >
          {(id) => (
            <Textarea
              id={id}
              variant="code"
              rows={6}
              value={value}
              aria-invalid={invalidSpec}
              onChange={(event) => {
                keys.current = [];
                setInvalidFields({});
                onChange(event.target.value);
              }}
            />
          )}
        </Field>
      </details>
    </div>
  );
}
