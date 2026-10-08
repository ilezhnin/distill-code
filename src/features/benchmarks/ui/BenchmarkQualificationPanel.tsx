import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";
import { benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkGovernanceApi as api } from "../api/benchmarkGovernance";
import type { QualificationRequest } from "../lib/benchmarkGovernance";
import type { BenchmarkVersion } from "../types";
import { BenchmarkAlert, Field } from "./BenchmarkPrimitives";

export function BenchmarkQualificationPanel({
  version,
}: {
  version: BenchmarkVersion;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reviewer, setReviewer] = useState("");
  const [reviews, setReviews] = useState({
    contractReview: "",
    alternativeReview: "",
    familyReview: "",
    exposureReview: "",
  });
  const [requirements, setRequirements] = useState("[]");
  const [controls, setControls] = useState("[]");
  const [submitted, setSubmitted] = useState<QualificationRequest | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const bindingsKey = ["benchmarks", "qualifications", version.id];
  const bindings = useQuery({
    queryKey: bindingsKey,
    queryFn: () => api.qualificationBindings(version.id),
    enabled: open,
    refetchInterval: (query) =>
      query.state.data?.some((b) => b.status === "reserved") ? 2000 : false,
  });
  const binding = bindings.data?.[0];
  const record = useQuery({
    queryKey: ["benchmarks", "qualification", binding?.id],
    queryFn: () => api.getQualification(binding?.id ?? ""),
    enabled: open && Boolean(binding),
    refetchInterval: (query) =>
      query.state.data?.status === "reserved" ? 2000 : false,
  });
  const eligible =
    ["train", "held_out"].includes(version.manifest.split) &&
    ["exact", "json", "javascript", "browser", "repository"].includes(
      version.manifest.evaluator.kind,
    );
  const qualify = async () => {
    if (inFlight.current) return;
    let request = submitted;
    if (!request) {
      try {
        const parsedRequirements: unknown = JSON.parse(requirements);
        const parsedControls: unknown = JSON.parse(controls);
        if (
          !Array.isArray(parsedRequirements) ||
          !parsedRequirements.length ||
          !Array.isArray(parsedControls) ||
          parsedControls.length < 4
        ) {
          setError(t("qualification.invalidPanel"));
          return;
        }
        // Native validation owns the full coverage and control contract.
        request = {
          requestKey: crypto.randomUUID(),
          versionId: version.id,
          contentHash: version.contentHash,
          evaluatorRevision: version.manifest.evaluator.revision,
          reviewer: reviewer.trim(),
          ...reviews,
          requirements: parsedRequirements,
          controls: parsedControls,
        };
      } catch (failure) {
        setError(benchmarkErrorMessage(failure));
        return;
      }
    }
    setSubmitted(request);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.qualifyVersion(request);
      client.setQueryData(["benchmarks", "qualification", saved.id], saved);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      await bindings.refetch();
      inFlight.current = false;
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!binding || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.revokeQualification(binding.id, reason.trim());
      await client.invalidateQueries({
        queryKey: ["benchmarks", "promotions"],
      });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      await bindings.refetch();
      inFlight.current = false;
      setBusy(false);
    }
  };
  const textField = (key: keyof typeof reviews) => (
    <Field key={key} label={t(`qualification.${key}`)}>
      {(id) => (
        <Textarea
          id={id}
          rows={3}
          value={reviews[key]}
          maxLength={16384}
          disabled={busy || Boolean(submitted)}
          onChange={(event) =>
            setReviews((previous) => ({
              ...previous,
              [key]: event.target.value,
            }))
          }
        />
      )}
    </Field>
  );
  return (
    <details
      className="w-full space-y-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm">
        {t("qualification.title")}
      </summary>
      {open ? (
        <div className="space-y-3 pb-3">
          <p className="text-xs text-muted-foreground">
            {t("qualification.notice")}
          </p>
          <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(
              {
                versionId: version.id,
                contentHash: version.contentHash,
                evaluatorKind: version.manifest.evaluator.kind,
                evaluatorRevision: version.manifest.evaluator.revision,
                split: version.manifest.split,
              },
              null,
              2,
            )}
          </pre>
          {[error, bindings.error, record.error]
            .filter(Boolean)
            .map((failure) => (
              <BenchmarkAlert key={benchmarkErrorMessage(failure)}>
                {benchmarkErrorMessage(failure)}
              </BenchmarkAlert>
            ))}
          {bindings.isPending ? (
            <p className="text-sm">{t("loading")}</p>
          ) : null}
          {binding ? (
            <>
              <p className="text-sm" role="status">
                {t(`qualification.states.${binding.status}`, {
                  defaultValue: binding.status,
                })}
              </p>
              <code className="block break-all text-xs">{binding.id}</code>
              {binding.revokedAt !== null ? (
                <BenchmarkAlert>
                  {t("qualification.revoked")}: {binding.revocationReason}
                </BenchmarkAlert>
              ) : null}
              {record.data ? (
                <>
                  {record.data.failure ? (
                    <BenchmarkAlert>{record.data.failure}</BenchmarkAlert>
                  ) : null}
                  <ul className="space-y-2 text-xs">
                    {record.data.request.controls.map((control) => {
                      const result = record.data?.controls.find(
                        (r) => r.controlId === control.id,
                      );
                      return (
                        <li key={control.id} className="border-t pt-2">
                          <code>{control.id}</code>
                          {" · "}
                          {t("qualification.expected", {
                            verdict: control.expected,
                          })}
                          {" · "}
                          {result?.evaluation
                            ? `${result.evaluation.verdict} (${result.evaluation.score ?? t("unknown")}) · ${result.evaluation.reason}`
                            : (result?.error ?? t("qualification.unrecorded"))}
                          {result ? (
                            <code className="block break-all text-muted-foreground">
                              {result.outputHash}
                            </code>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {record.data.limitations.map((limitation) => (
                    <p
                      key={limitation}
                      className="text-xs text-muted-foreground"
                    >
                      {limitation}
                    </p>
                  ))}
                  <details>
                    <summary className="cursor-pointer text-xs">
                      {t("qualification.record")}
                    </summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                      {JSON.stringify(
                        { binding, record: record.data },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </>
              ) : null}
              {binding.revokedAt === null ? (
                <div className="space-y-2">
                  <Field label={t("governance.revocationReason")}>
                    {(id) => (
                      <Textarea
                        id={id}
                        value={reason}
                        maxLength={16384}
                        disabled={busy}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    )}
                  </Field>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || !reason.trim()}
                    onClick={() => void revoke()}
                  >
                    {t("qualification.revoke")}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
          {!binding && bindings.data && eligible ? (
            <>
              <Field label={t("qualification.reviewer")}>
                {(id) => (
                  <Input
                    id={id}
                    value={reviewer}
                    maxLength={256}
                    disabled={busy || Boolean(submitted)}
                    onChange={(event) => setReviewer(event.target.value)}
                  />
                )}
              </Field>
              {Object.keys(reviews).map((key) =>
                textField(key as keyof typeof reviews),
              )}
              <Field
                label={t("qualification.requirements")}
                hint={t("qualification.requirementsHint")}
              >
                {(id) => (
                  <Textarea
                    id={id}
                    variant="code"
                    rows={6}
                    value={requirements}
                    disabled={busy || Boolean(submitted)}
                    onChange={(event) => setRequirements(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label={t("qualification.controls")}
                hint={t("qualification.controlsHint")}
              >
                {(id) => (
                  <Textarea
                    id={id}
                    variant="code"
                    rows={8}
                    value={controls}
                    disabled={busy || Boolean(submitted)}
                    onChange={(event) => setControls(event.target.value)}
                  />
                )}
              </Field>
              {submitted ? (
                <p className="text-xs">{t("qualification.immutableRetry")}</p>
              ) : null}
              {submitted && error && !bindings.error ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setSubmitted(null);
                    setError(null);
                  }}
                >
                  {t("governance.changeUnregistered")}
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={
                  busy ||
                  (!submitted &&
                    (!reviewer.trim() ||
                      Object.values(reviews).some((review) => !review.trim())))
                }
                onClick={() => void qualify()}
              >
                {t(submitted ? "qualification.retry" : "qualification.submit")}
              </Button>
            </>
          ) : null}
          {!eligible ? (
            <p className="text-xs">{t("qualification.unsupported")}</p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
