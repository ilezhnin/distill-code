/**
 * Drives the ZIP worker that packages a share card. Kept out of
 * AgentShareDialog.tsx so that file exports only its component: react-refresh
 * gives up on a module that mixes the two, and every open surface then loses
 * its state on an edit instead of hot-reloading.
 */

export const AGENT_ZIP_TIMEOUT_MS = 15_000;

export function createAgentZip(
  pngFilename: string,
  contents: Uint8Array,
  signal?: AbortSignal,
  timeoutMs = AGENT_ZIP_TIMEOUT_MS,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./agentZip.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error("ZIP worker timed out")));
    }, timeoutMs);
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
      operation();
    };
    const handleAbort = () =>
      finish(() => reject(new DOMException("Aborted", "AbortError")));
    worker.onmessage = (
      event: MessageEvent<{ archive?: Uint8Array; error?: string }>,
    ) => {
      const { archive, error } = event.data;
      if (error) finish(() => reject(new Error(error)));
      else if (archive) finish(() => resolve(archive));
      else finish(() => reject(new Error("ZIP worker returned no archive")));
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "ZIP worker failed")));
    };
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });
    // Copy before transfer so the portable PNG remains available to the caller.
    const workerContents = new Uint8Array(contents);
    worker.postMessage({ pngFilename, contents: workerContents }, [
      workerContents.buffer,
    ]);
  });
}
