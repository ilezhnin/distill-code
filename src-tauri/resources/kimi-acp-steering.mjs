// Loaded by Flock, through NODE_OPTIONS, into the Kimi Code CLI a chat runs
// (`kimi acp`), before @moonshot-ai/kimi-code's dist/main.mjs.
//
// Kimi's ACP server refuses a message while a turn runs (`turn.agent_busy`),
// although its engine can take one into the running turn, as Kimi's own
// terminal does. The edits below give the server the `_session/steering`
// request Flock steers Claude Code with. A steered message joins the turn of
// the prompt under way at the turn's next step: after the tool calls of the
// current step, a subagent's included. With no prompt's turn running the
// request answers `promptRequired`, and the message goes out as a prompt of
// its own.
//
// Installed files stay intact: only the copy Node loads is edited. Every edit
// must find its anchor exactly once, and every name the edits rely on must be
// there, or nothing is edited. The server then advertises no steering, and
// Flock queues a message until the turn ends, as it did before.
import { readFileSync, realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Only Kimi's own process loads this. What it starts inherits the
// environment without it.
const own = `--import=${import.meta.url}`;
const options = (process.env.NODE_OPTIONS ?? "").split(own).join("").trim();
if (options === "") delete process.env.NODE_OPTIONS;
else process.env.NODE_OPTIONS = options;

const note = (message) =>
  process.stderr.write(`[flock] Kimi steering: ${message}\n`);

/** Kimi Code's entrypoint as a module URL, or `undefined` for any other script. */
function kimiEntrypoint() {
  const script = process.argv[1];
  if (typeof script !== "string" || !script.endsWith("main.mjs")) {
    return undefined;
  }
  try {
    const path = realpathSync(script);
    const manifest = JSON.parse(
      readFileSync(join(dirname(path), "..", "package.json"), "utf8"),
    );
    if (manifest.name !== "@moonshot-ai/kimi-code") return undefined;
    return { url: pathToFileURL(path).href, version: manifest.version };
  } catch {
    return undefined;
  }
}

const lines = (...body) => body.join("\n");

// How Kimi refuses a session it does not know, which the steering request
// repeats: bundle source, not a template of this file.
const unknownSession =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Kimi bundle source text
  "\t\t\tif (!acpSession) throw RequestError$1.invalidParams(void 0, `Unknown sessionId: ${params.sessionId}`);";

const edits = [
  {
    // The request, beside the other methods the server registers itself.
    name: "steering request",
    anchor:
      ".onRequest(SET_SESSION_MODEL_METHOD, parseSetSessionModelParams, (ctx) => getServer().setSessionModel(ctx.params));",
    replacement:
      '.onRequest(SET_SESSION_MODEL_METHOD, parseSetSessionModelParams, (ctx) => getServer().setSessionModel(ctx.params)).onRequest("_session/steering", flockSteeringParams, (ctx) => getServer().flockSteer(ctx.params));',
  },
  {
    // Advertised as Claude Code's adapter advertises it.
    name: "steering capability",
    anchor:
      "\t\t\t\t...this.agentInfo ? { agentInfo: this.agentInfo } : {}\n\t\t\t};",
    replacement: lines(
      "\t\t\t\t...this.agentInfo ? { agentInfo: this.agentInfo } : {},",
      "\t\t\t\t_meta: { steering: { supported: true } }",
      "\t\t\t};",
    ),
  },
  {
    name: "server steering",
    anchor: lines(
      "\t\tasync prompt(params, signal) {",
      "\t\t\tconst acpSession = this.sessions.get(params.sessionId);",
      unknownSession,
      "",
    ),
    prepend: lines(
      "\t\tasync flockSteer(params) {",
      "\t\t\tconst acpSession = this.sessions.get(params.sessionId);",
      unknownSession,
      "\t\t\treturn acpSession.flockSteer(params.prompt);",
      "\t\t}",
      "",
    ),
  },
  {
    // A prompt's turn is the driver's until the driver settles. The engine
    // steers into the turn it runs for a prompt, or else starts a turn for
    // the message: that happens only when the turn ended in between, and the
    // answer says so (`startedNewTurn`).
    name: "session steering",
    anchor: lines(
      "\t\tdriveTurn(input) {",
      "\t\t\tthis.assertNoActiveTurn();",
      "\t\t\treturn this.driveLaunch(this.agent.prompt({ input }));",
      "\t\t}",
      "",
    ),
    prepend: lines(
      "\t\tasync flockSteer(blocks) {",
      "\t\t\tconst driver = this.driver;",
      "\t\t\tconst turnId = driver?.turnId;",
      "\t\t\tconst running = () => this.driver === driver && driver !== void 0 && !driver.settled && driver.cancelRequested !== true && turnId !== void 0;",
      '\t\t\tif (!running()) return { outcome: "promptRequired", reason: "noRunningTurn" };',
      "\t\t\tconst input = await this.preparePromptContent(blocks);",
      '\t\t\tif (input === void 0 || !running()) return { outcome: "promptRequired", reason: "noRunningTurn" };',
      "\t\t\tconst launched = await this.agent.steer({ input });",
      '\t\t\treturn launched?.turn_id === turnId ? { outcome: "injected" } : { outcome: "startedNewTurn" };',
      "\t\t}",
      "",
    ),
  },
];

// What the edits rely on beyond their anchors.
const requirements = [
  // The engine's steer, the one Kimi's terminal sends.
  'steer: (input) => call(scope, "agentPromptService", "submitSteer", [input]),',
  // A prompt's driver learns its turn here, and settles once.
  "driver.turnId = launched.turn_id;",
  "if (driver.cancelRequested === true)",
  "async preparePromptContent(blocks) {",
  // A message steered into a turn's last step keeps the turn going.
  "if (this.hasLiveNudge()) return;",
];

// Appended to the bundle, beside the server's own parser of
// `session/set_model`.
const helper = `
function flockSteeringParams(params) {
	const { sessionId, prompt, _meta } = params ?? {};
	if (typeof sessionId !== "string" || sessionId.length === 0 || !Array.isArray(prompt) || prompt.length === 0) throw RequestError$1.invalidParams(void 0, "_session/steering expects { sessionId: string, prompt: ContentBlock[] } with a non-empty prompt");
	const idleBehavior = _meta?.steering?.idleBehavior;
	if (idleBehavior !== void 0 && idleBehavior !== "promptRequired") throw RequestError$1.invalidParams(void 0, "unsupported steering idleBehavior");
	return { sessionId, prompt };
}
`;

/** `source` with steering, or why it cannot have it. */
export function addSteering(source) {
  for (const requirement of requirements) {
    if (!source.includes(requirement)) return { missing: requirement };
  }
  for (const { name, anchor, replacement, prepend } of edits) {
    const parts = source.split(anchor);
    if (parts.length !== 2) return { missing: name };
    source = parts.join(replacement ?? `${prepend}${anchor}`);
  }
  return { source: `${source}\n${helper}` };
}

const entry = kimiEntrypoint();
// Kimi Code needs a Node with synchronous loader hooks (22.15 or later); an
// older one starts it unedited rather than not at all.
if (entry !== undefined && typeof nodeModule.registerHooks !== "function") {
  note(`not added: Node ${process.version} has no module.registerHooks`);
} else if (entry !== undefined) {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (url !== entry.url) return loaded;
      const source =
        typeof loaded.source === "string"
          ? loaded.source
          : Buffer.from(loaded.source).toString("utf8");
      const steered = addSteering(source);
      if (steered.source === undefined) {
        note(
          `not added: Kimi Code ${entry.version} has no ${JSON.stringify(steered.missing)}`,
        );
        return loaded;
      }
      return { ...loaded, source: steered.source };
    },
  });
}
