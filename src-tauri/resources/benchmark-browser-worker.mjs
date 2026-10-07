// The browser receives only the candidate artifact and public test inputs.
// Expected values and assertions remain in this controller process.
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_INPUT = 4 * 1024 * 1024;
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_INPUT)
    throw new Error("Worker input exceeds limit");
}
const request = JSON.parse(input);
const imported = await import(pathToFileURL(process.argv[2]).href);
const { chromium } = imported.chromium ? imported : imported.default;
const viewport = request.spec.viewport ?? { width: 1000, height: 700 };
if (
  ![viewport.width, viewport.height].every(
    (n) => Number.isInteger(n) && n >= 320 && n <= 1600,
  )
)
  throw new Error("Invalid viewport");
// An explicit, freshly allocated profile keeps Playwright's recursive cleanup
// retries outside the evaluation time budget. It is never reused by another run.
const profile = await mkdtemp(join(tmpdir(), "distill-benchmark-browser-"));
const launchOptions = {
  executablePath: process.argv[3],
  headless: true,
  chromiumSandbox: true,
  args: [
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ],
  viewport,
  serviceWorkers: "block",
  acceptDownloads: false,
  permissions: [],
};
let blockedRequests = 0;
const checks = [];
const csp =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
let context;
let result;
try {
  context = await chromium.launchPersistentContext(profile, launchOptions);
  await context.addInitScript(() => {
    for (const name of [
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "RTCDataChannel",
      "WebTransport",
    ]) {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    }
  });
  await context.route("**/*", (route) => {
    blockedRequests++;
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    blockedRequests++;
    socket.close();
  });
  context.on("page", (page) => {
    if (context.pages().length > 1) void page.close();
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(1500);
  const shell = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const quietShell =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">";
  await page.setContent(shell);
  const boundary = await page.evaluate(async () => ({
    node: typeof globalThis.process,
    require: typeof globalThis.require,
    tauri: typeof globalThis.__TAURI_INTERNALS__,
    network: await fetch("http://127.0.0.1:9/benchmark-boundary").then(
      () => true,
      () => false,
    ),
  }));
  if (
    boundary.node !== "undefined" ||
    boundary.require !== "undefined" ||
    boundary.tauri !== "undefined" ||
    boundary.network
  )
    throw new Error("Browser boundary verification failed");
  if (request.progressPath)
    await writeFile(request.progressPath, "candidate_started", { flag: "wx" });
  if (request.kind === "javascript") {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(request.spec.functionName))
      throw new Error("Invalid function name");
    if (
      !Array.isArray(request.spec.argsCases) ||
      request.spec.argsCases.length < 1 ||
      request.spec.argsCases.length > 100
    )
      throw new Error("Expected 1-100 protected cases");
    const immutableArgs = request.spec.immutableArgs ?? [];
    if (
      !Array.isArray(immutableArgs) ||
      immutableArgs.some((index) => !Number.isInteger(index) || index < 0)
    )
      throw new Error("Invalid immutable argument indices");
    for (const [index, test] of request.spec.argsCases.entries()) {
      if (immutableArgs.some((argument) => argument >= test.args.length))
        throw new Error("Immutable argument index is outside the case inputs");
      try {
        // No expected value crosses this boundary. Each case receives a fresh realm.
        await page.goto("about:blank");
        await page.setContent(shell);
        const actual = await page.evaluate(
          async ({ source, name, args }) => {
            const run = new Function(
              "args",
              `"use strict";\n${source}\n;return ${name}(...args);`,
            );
            // Retain the actual argument references in the controller closure;
            // the candidate supplies its result, never an immutability verdict.
            return { result: await run(args), args };
          },
          {
            source: request.output,
            name: request.spec.functionName,
            args: test.args,
          },
        );
        const outputMatches = isDeepStrictEqual(actual.result, test.expected);
        const inputsPreserved = immutableArgs.every((argument) =>
          isDeepStrictEqual(actual.args[argument], test.args[argument]),
        );
        checks.push({
          index,
          pass: outputMatches && inputsPreserved,
          outputMatches,
          inputsPreserved,
        });
      } catch {
        checks.push({ index, pass: false });
      }
    }
  } else if (request.kind === "browser") {
    if (
      !Array.isArray(request.spec.steps) ||
      request.spec.steps.length < 1 ||
      request.spec.steps.length > 100
    )
      throw new Error("Expected 1-100 protected interactions");
    await page.setContent(shell + request.output, {
      waitUntil: "domcontentloaded",
    });
    for (const [index, step] of request.spec.steps.entries()) {
      if (typeof step.selector !== "string" || step.selector.length > 1000)
        throw new Error("Invalid selector");
      const locator = page.locator(step.selector);
      try {
        if (step.action === "fill") await locator.fill(String(step.value));
        else if (step.action === "click") await locator.click();
        else if (step.action === "press")
          await locator.press(String(step.value));
        else if (step.action === "expectAccessibleName") {
          // Chromium computes the accessible name; candidate JavaScript cannot
          // replace an element getter to report a name the browser does not use.
          if ((await locator.count()) !== 1)
            throw new Error("Expected one named control");
          const client = await context.newCDPSession(page);
          try {
            const { root } = await client.send("DOM.getDocument");
            const { nodeId } = await client.send("DOM.querySelector", {
              nodeId: root.nodeId,
              selector: step.selector,
            });
            const { nodes } = await client.send(
              "Accessibility.getPartialAXTree",
              { nodeId, fetchRelatives: false },
            );
            if (
              !nodes.some(
                (node) =>
                  !node.ignored &&
                  typeof node.name?.value === "string" &&
                  node.name.value.trim(),
              )
            )
              throw new Error("Accessible name missing");
          } finally {
            await client.detach();
          }
        } else if (step.action === "expectText") {
          if ((await locator.textContent())?.trim() !== step.value)
            throw new Error("Text mismatch");
        } else if (step.action === "expectValue") {
          if ((await locator.inputValue()) !== step.value)
            throw new Error("Value mismatch");
        } else if (step.action === "expectCount") {
          if ((await locator.count()) !== step.value)
            throw new Error("Count mismatch");
        } else throw new Error("Unsupported interaction");
        checks.push({ index, pass: true });
      } catch {
        checks.push({ index, pass: false });
      }
    }
  } else if (request.kind === "render") {
    // A drawing or page for the judge panel: no scripts, no checks, one picture.
    await page.setContent(quietShell + request.output, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(400);
  } else throw new Error("Unsupported artifact evaluator");
  if (request.screenshotPath) {
    const screenshot = await page.screenshot({ type: "png", timeout: 3000 });
    if (screenshot.length > 2 * 1024 * 1024)
      throw new Error("Screenshot exceeds artifact cap");
    await writeFile(request.screenshotPath, screenshot, { flag: "wx" });
  }
  result = {
    pass: checks.every((check) => check.pass),
    checks,
    boundary,
    blockedRequests,
    browserVersion: context.browser().version(),
  };
} catch (error) {
  result = { error: String(error.message ?? error) };
  process.exitCode = 1;
} finally {
  await context?.close();
  // Only remove the exact profile returned by mkdtemp above. On Windows, Edge
  // profile files can deny deletion after the browser exits. Do not retry every
  // file recursively and turn a completed check into a candidate timeout.
  try {
    await rm(profile, { recursive: true, force: true, maxRetries: 0 });
  } catch (error) {
    result.cleanupWarning = { code: error.code, retainedProfile: profile };
  }
}
process.stdout.write(JSON.stringify(result));
