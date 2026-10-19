import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cn } from "@/shared/lib/cn";
import {
  previewDocument,
  type RenderableMarkup,
} from "../lib/benchmarkPreview";

/**
 * A rendering filling its box: the stored image the judges scored, else a
 * drawing as an image or a page in a scaled, script-free frame.
 */
export function DesignRendering({
  rendering,
  markup,
  fallback,
  scale = "thumbnail",
}: {
  rendering: string | null;
  markup: RenderableMarkup | null;
  fallback: ReactNode;
  scale?: "thumbnail" | "full";
}) {
  const { t } = useTranslation("benchmarks");
  // A stored image that no longer loads gives way to the markup.
  const [missing, setMissing] = useState<string | null>(null);
  if (rendering && missing !== rendering) {
    return (
      <img
        src={convertFileSrc(rendering)}
        alt=""
        onError={() => setMissing(rendering)}
        className="h-full w-full object-contain"
      />
    );
  }
  if (!markup) return <>{fallback}</>;
  if (markup.kind === "svg") {
    const body = markup.body.includes("xmlns=")
      ? markup.body
      : markup.body.replace(
          /<svg\b/i,
          '<svg xmlns="http://www.w3.org/2000/svg"',
        );
    return (
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(body)}`}
        alt=""
        className="h-full w-full object-contain"
      />
    );
  }
  return (
    <iframe
      sandbox=""
      srcDoc={previewDocument(markup.body, "html") ?? ""}
      title={t("evidence.preview")}
      tabIndex={-1}
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-0 top-0",
        scale === "thumbnail"
          ? "h-[300%] w-[300%] origin-top-left scale-[0.3333]"
          : "h-full w-full",
      )}
    />
  );
}
