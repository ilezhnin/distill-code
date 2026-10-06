// Loaded only by an isolated repository Kimi Code bridge, before
// @moonshot-ai/kimi-code's dist/main.mjs. Kimi's ACP server takes no session
// policy, but it runs its engine in this process, so the controls below edit
// the bundle as Node loads it. Installed files stay intact, and only the
// pinned build is edited.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The `kimi.runtime.files.entrypoint` pin of benchmark-native-policies.json.
const pinned =
  "6f801a114b5a5d708d9fec1ea0002ac42ec19841c088a96aecd7e6117b8b1d59";
// The `systemPrompt` of benchmark-native-policies.json.
const systemPrompt =
  "Complete the supplied repository task in /workspace. Use tools to inspect and change files. Do not delegate to other agents. Finish when the requested change is ready.";
const entrypoint = join(dirname(process.argv[1]), "main.mjs");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (digest(readFileSync(entrypoint)) !== pinned) {
  throw new Error(
    "capability_missing: pinned Kimi benchmark adapter source changed",
  );
}

// Each control is an exact edit with the number of places it must apply.
const controls = [
  {
    // Login provisions the OAuth provider and its model catalog as well as
    // credentials. Copy only those settings into the attempt's private home
    // before the engine reads them; session writes never reach the account.
    name: "account model configuration",
    anchor: "const homeDir = resolveKimiHome(input.homeDir, env, osHomeDir);",
    replacement:
      'const homeDir = resolveKimiHome(input.homeDir, env, osHomeDir);\n\tdistillBenchmarkAccountConfig(input.configPath ?? join$4(homeDir, "config.toml"));',
    count: 1,
  },
  {
    // OAuth alone uses the selected account; all session storage is private.
    name: "account credentials",
    anchor:
      'const credentialsDir = options.credentialsDir ?? join(this.homeDir, "credentials");',
    replacement: 'const credentialsDir = "/tmp/provider/credentials";',
    count: 1,
  },
  {
    // Keep only local repository tools, the fixed prompt and no subagents.
    // Tool disclosure cannot expand the tool list.
    name: "agent profile",
    anchor: "function normalizeAgentProfile(input) {",
    replacement: `function normalizeAgentProfile(input) {\n\tinput = { ...input, tools: ["Read", "Write", "Edit", "Grep", "Glob", "Bash", "TaskList", "TaskOutput", "TaskStop", "WaitFor"], disallowedTools: ["select_tools"], subagents: [], promptPrefix: void 0, systemPrompt: void 0, renderSystemPrompt: (context) => ({ text: ${JSON.stringify(systemPrompt)}, environment: { cwd: context?.cwd ?? "" } }) };`,
    count: 1,
  },
  {
    // Kimi's home, the OS home's .agents and the project's AGENTS.md files.
    name: "AGENTS.md",
    anchor: "async function loadAgentsMdForRoots(deps, brandHome, workDirs) {",
    replacement:
      'async function loadAgentsMdForRoots(deps, brandHome, workDirs) {\n\treturn { content: "", warning: void 0, paths: [] };',
    count: 1,
  },
  {
    // Configured and plugin hooks; a SessionStart hook adds context.
    name: "hooks",
    anchor: "this.byEvent = indexHooks([...configured ?? [], ...pluginHooks]);",
    replacement: "this.byEvent = indexHooks([]);",
    count: 1,
  },
  {
    // System reminders are user messages beside the task: the date, the
    // permission mode, plugin session starts, AGENTS.md discoveries and the
    // rest. Registered ones are appended here, notices below.
    name: "reminders",
    anchor: "function appendResult(runtime, entry, content) {",
    replacement: "function appendResult(runtime, entry, content) {\n\treturn;",
    count: 1,
  },
  {
    name: "reminder notices",
    anchor: "function appendReminder$1(runtime, content, notification) {",
    replacement:
      "function appendReminder$1(runtime, content, notification) {\n\treturn;",
    count: 1,
  },
  {
    // The user, project and plugin MCP servers: with no tool active they
    // would still start their processes.
    name: "MCP servers",
    anchor:
      "\t\t\t\t...Object.fromEntries(this.pluginServers),\n\t\t\t\t...Object.fromEntries(this.fileServers)\n",
    replacement: "",
    count: 1,
  },
  {
    // A title is a request of its own, outside the turn.
    name: "title",
    anchor: "\t\tasync generateTitle(opts) {",
    replacement: "\t\tasync generateTitle(opts) {\n\t\t\treturn void 0;",
    count: 1,
  },
  {
    // The prompt response carries no usage of its own. The engine's is read
    // before the response is written, so it reaches the host inside the
    // turn; see `distillBenchmarkTurnUsage` below.
    name: "prompt usage",
    anchor:
      "driver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error) });",
    replacement:
      "distillBenchmarkTurnUsage(this.agent).then((usage) => driver.resolve({ stopReason: turnEndReasonToStopReason(event.reason, error), ...usage }));",
    count: 1,
  },
];

// Appended to the bundle. An owned session runs one turn, so the session's
// usage is the turn's: `usage` as ACP spells it, uncached input apart from
// the cache, and each model under `_meta.quota.model_usage`. Usage that does
// not come within five seconds is left out rather than holding the answer.
const usageHelper = `
import { mkdirSync as distillBenchmarkMkdir, writeFileSync as distillBenchmarkWriteFile } from "node:fs";
function distillBenchmarkAccountConfig(configPath) {
\tconst account = parse$8(readFileSync("/tmp/provider/config.toml", "utf8"));
\tconst config = Object.fromEntries(
\t\t["default_provider", "default_model", "providers", "models"]
\t\t\t.filter((key) => account[key] !== undefined)
\t\t\t.map((key) => [key, account[key]])
\t);
\tdistillBenchmarkMkdir(dirname(configPath), { recursive: true, mode: 0o700 });
\tdistillBenchmarkWriteFile(configPath, stringify$1(config), { mode: 0o600 });
}

async function distillBenchmarkTurnUsage(agent) {
	let timer;
	try {
		const status = await Promise.race([
			agent.getUsage(),
			new Promise((resolve) => { timer = setTimeout(resolve, 5000); })
		]);
		if (status?.total === void 0) return {};
		const counts = (usage) => ({
			inputTokens: usage.inputOther,
			outputTokens: usage.output,
			cachedReadTokens: usage.inputCacheRead,
			cachedWriteTokens: usage.inputCacheCreation,
			totalTokens: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation + usage.output
		});
		const model_usage = Object.entries(status.byModel ?? {}).map(([model, usage]) => {
			const { cachedReadTokens, ...token_count } = counts(usage);
			return { model, token_count: { ...token_count, cachedInputTokens: cachedReadTokens } };
		});
		return { usage: counts(status.total), _meta: { quota: { model_usage } } };
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
	}
}
`;

const entrypointUrl = pathToFileURL(entrypoint).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== entrypointUrl) return loaded;
    let source =
      typeof loaded.source === "string"
        ? loaded.source
        : Buffer.from(loaded.source).toString("utf8");
    if (digest(source) !== pinned) {
      throw new Error(
        "capability_missing: Kimi bundle source changed while loading",
      );
    }
    for (const { name, anchor, replacement, count } of controls) {
      const parts = source.split(anchor);
      if (parts.length !== count + 1) {
        throw new Error(
          `capability_missing: Kimi ${name} control is unavailable`,
        );
      }
      source = parts.join(replacement);
    }
    return { ...loaded, source: `${source}\n${usageHelper}` };
  },
});
