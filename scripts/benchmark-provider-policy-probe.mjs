// Runs an installed provider ACP bridge against a loopback model stub, once
// under the benchmark policy Distill ships (src-tauri/resources/
// benchmark-native-policies.json and the provider's adapter) and once without
// it as a positive control. No real credentials or provider inference are
// used, and nothing outside the temporary directory this script creates is
// written or removed. For Codex it also mentions the skills in the user's own
// `~/.agents/skills` in one restricted turn, which codex.exe reads whatever
// its environment says; what that adds reaches only the loopback stub, and
// the report keeps only counts. Every fixture location carries a marker of
// its own, so each control shows which homes the CLI read.
//
//   node scripts/benchmark-provider-policy-probe.mjs codex <codex-acp package dir>
//   node scripts/benchmark-provider-policy-probe.mjs grok <grok executable>
//   node scripts/benchmark-provider-policy-probe.mjs kimi <kimi-code package dir>
//
// For Codex the package dir is the installed @agentclientprotocol/codex-acp
// (package.json, dist/index.js); the @openai/codex it depends on supplies the
// CLI, as in Distill, and the model list it ships stands in for the one an
// account home caches. For Grok it is the grok binary chats run (for example
// ~/.grok/bin/grok.exe); every endpoint it knows is pointed at the stub and
// its sign-in is a fabricated document. For Kimi it is the installed
// @moonshot-ai/kimi-code (package.json, dist/main.mjs) that the `kimi` npm
// shim runs; its home names an API-key provider on the stub. Run it with the
// Node Distill manages, which owned Kimi bridges run on. Re-run it, and update
// the resource pins, whenever the pinned runtime changes.
//
// A passing run prints the `verified` block the provider's resource entry
// records: the date, the runtime it passed on and the sha256 of the entry and
// adapter it exercised. Distill admits a provider only while that block
// matches the entry and adapter it ships (NativeProvider::admission_issue), so
// any change to either keeps the provider unavailable until the probe passes
// again.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import zlib from "node:zlib";

const [provider, installedArgument] = process.argv.slice(2);
assert(
  provider && installedArgument,
  "Usage: benchmark-provider-policy-probe.mjs <codex|grok|kimi> <installed package dir or executable>",
);
const installed = resolve(installedArgument);
const repo = (path) => new URL(`../${path}`, import.meta.url);
const policies = JSON.parse(
  await readFile(
    repo("src-tauri/resources/benchmark-native-policies.json"),
    "utf8",
  ),
);
const secret = "DISTILL_HIDDEN_CONTEXT_927413";
/** The text a fixture at `location` carries. Each location has its own, so a
 * control shows which ones the CLI read; every one contains `secret`, which
 * no restricted request may hold. */
const contextMarker = (location) => `${secret}-${location}`;
/** A skill fixture named `name` whose description and body are `text`. */
const skillFixture = (name, text) =>
  `---\nname: ${name}\ndescription: ${text}\n---\n${text}`;
/** The context markers among `locations` that `requests` hold. */
const markersIn = (requests, locations) =>
  locations.filter((location) =>
    textOf(requests).includes(contextMarker(location)),
  );
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** JSON with every object's keys sorted and no whitespace, as Rust's
 * `canonical_json` writes it, so both hash a resource entry alike. */
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);

/** The variables every child keeps; the rest is set per run. */
function baseEnv() {
  const env = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** Records every request the CLI makes; `answer` writes each response. As a
 * proxy (`HTTPS_PROXY`) it refuses every tunnel and records where it was
 * going in `tunnels`. */
async function loopback(answer) {
  const requests = [];
  const tunnels = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let raw = Buffer.concat(chunks);
    const encoding = request.headers["content-encoding"];
    if (encoding === "zstd") raw = zlib.zstdDecompressSync(raw);
    else if (encoding === "gzip") raw = zlib.gunzipSync(raw);
    else if (encoding === "br") raw = zlib.brotliDecompressSync(raw);
    else if (encoding === "deflate") raw = zlib.inflateSync(raw);
    let body = {};
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      body = { unparsed: raw.toString("utf8") };
    }
    const entry = {
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization ?? null,
      headers: request.headers,
      body,
    };
    requests.push(entry);
    answer(entry, response);
  });
  server.on("connect", (request, socket) => {
    tunnels.push(request.url);
    socket.destroy();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    requests,
    tunnels,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

/** An ACP client on a bridge's stdio. Every request the agent makes is
 * refused, as an owned benchmark session refuses it. */
function acp(child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  const notifications = [];
  const agentRequests = [];
  // How many notifications had arrived when the last response to each
  // method did: what a turn reported before its prompt was answered.
  const marks = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value.id !== undefined && !value.method) {
      const request = pending.get(value.id);
      if (request) {
        pending.delete(value.id);
        marks.set(request.method, notifications.length);
        value.error
          ? request.reject(new Error(JSON.stringify(value.error)))
          : request.resolve(value.result);
      }
    } else if (value.id !== undefined) {
      agentRequests.push(value);
      const reply =
        value.method === "session/request_permission"
          ? { result: { outcome: { outcome: "cancelled" } } }
          : { error: { code: -32601, message: "refused by the policy probe" } };
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: value.id, ...reply })}\n`,
      );
    } else notifications.push(value);
  });
  const call = (method, params, timeout = 60000) =>
    new Promise((done, fail) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error(`${method} timed out: ${stderr.slice(-3000)}`));
      }, timeout);
      pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          done(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  return {
    call,
    notifications,
    agentRequests,
    marks,
    stderr: () => stderr,
    initialize: () =>
      call("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "distill-policy-probe", version: "1" },
      }),
  };
}

/** Runs `node [--import adapter] <entrypoint> [args]` and returns its ACP
 * client. */
function startBridge(children, entrypoint, adapter, env, cwd, args = []) {
  const child = spawn(
    process.execPath,
    [
      ...(adapter
        ? [
            "--import",
            `data:text/javascript;base64,${adapter.toString("base64")}`,
          ]
        : []),
      entrypoint,
      ...args,
    ],
    { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.push(child);
  return acp(child);
}

/** Runs a native ACP bridge and returns its ACP client. */
function startNative(children, program, args, env, cwd) {
  const child = spawn(program, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return acp(child);
}

/** Runs a script under the adapter that must refuse it before it executes. */
function refusedUnderAdapter(entrypoint, adapter, env) {
  return new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript;base64,${adapter.toString("base64")}`,
        entrypoint,
      ],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", fail);
    child.on("exit", (code) => done({ code, stdout, errors }));
  });
}

const toml = (value) => JSON.stringify(value);
const textOf = (value) => JSON.stringify(value);

/** Runs `node <script> args` and returns its standard output. */
function runNode(script, args, env, cwd) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      errors = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0
        ? done(stdout)
        : fail(
            new Error(`${script} ${args.join(" ")} exited ${code}: ${errors}`),
          ),
    );
  });
}

/** The names of the skills in the folder `dir` (each `<name>/SKILL.md`, by
 * the name its front matter gives, else its folder's); none when it is
 * missing. A report keeps only how many there are. */
async function skillNames(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = [];
  for (const entry of entries.filter((entry) => entry.isDirectory())) {
    const text = await readFile(
      join(dir, entry.name, "SKILL.md"),
      "utf8",
    ).catch(() => null);
    if (text === null) continue;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    names.push(/^name:\s*(\S+)\s*$/m.exec(front)?.[1] ?? entry.name);
  }
  return names;
}

/** The text of a Responses message item. */
const messageText = (item) =>
  (item?.content ?? []).map((part) => part.text ?? "").join("");

/** What a Codex Responses request shows the model, in either wire shape the
 * pinned CLI uses. The classic shape carries `instructions` and `tools`;
 * Responses Lite (models whose catalog entry sets `use_responses_lite`)
 * leads `input` with an `additional_tools` item and the base instructions
 * as a developer message, and sends neither field. */
function codexWire(entry) {
  const { body } = entry;
  const lite =
    entry.headers["x-openai-internal-codex-responses-lite"] === "true";
  const input = [...(body.input ?? [])];
  if (!lite) {
    return {
      lite,
      instructions: body.instructions,
      tools: body.tools ?? [],
      input,
    };
  }
  assert.equal(
    body.instructions,
    undefined,
    "Lite sends no instructions field",
  );
  assert.equal(body.tools, undefined, "Lite sends no tools field");
  const [tools, instructions, ...rest] = input;
  assert.equal(tools?.type, "additional_tools", textOf(input[0]));
  assert.equal(
    input.filter((item) => item.type === "additional_tools").length,
    1,
    "Lite lists its tools once",
  );
  assert.equal(instructions?.role, "developer", textOf(instructions));
  return {
    lite,
    instructions: messageText(instructions),
    tools: tools.tools ?? [],
    input: rest,
  };
}

async function probeCodex(root, children) {
  const policy = policies.codex;
  const packageInfo = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  const entrypoint = join(installed, "dist", "index.js");
  assert.equal(
    sha256(await readFile(entrypoint)),
    policy.runtime.files.entrypoint,
    "The installed codex-acp is not the pinned build",
  );
  // The CLI codex-acp starts, resolved the way it resolves it, and the
  // native binary that launcher runs (Distill is built for Windows x64).
  const cli = createRequire(entrypoint).resolve("@openai/codex/bin/codex.js");
  const cliVersion = JSON.parse(
    await readFile(join(dirname(cli), "..", "package.json"), "utf8"),
  ).version;
  const nativeCli = join(
    dirname(createRequire(cli).resolve("@openai/codex-win32-x64/package.json")),
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  const nativeHash = createHash("sha256");
  for await (const chunk of createReadStream(nativeCli))
    nativeHash.update(chunk);
  assert.equal(
    nativeHash.digest("hex"),
    policy.runtime.files.nativeCli,
    "The installed Codex CLI is not the pinned build",
  );
  const adapter = await readFile(
    repo("src-tauri/resources/benchmark-codex-policy.mjs"),
  );
  const marker = join(root, "escaped.txt");
  const writeMarker = (label) =>
    `require('fs').writeFileSync(${JSON.stringify(marker)},'${label}')`;

  // The hostile fixture: a user profile with personal skills, a provider home
  // with global instructions, a skill and an MCP server, and a workspace
  // with project instructions, a Claude-style MCP file and a Codex project
  // layer. The clean home is what the account preflight admits: the
  // credential store setting, the bundled skills every account home has
  // (`skills/.system`, which the policy turns off) and the model list the
  // CLI caches there.
  const userHome = join(root, "user-home");
  const hostileHome = join(root, "codex-home-hostile");
  const cleanHome = join(root, "codex-home-clean");
  const runtimeDir = join(root, "runtime");
  const osHome = join(runtimeDir, "os-home");
  const workspace = join(root, "workspace");
  const hostileWorkspace = join(root, "workspace-hostile");
  for (const dir of [
    join(userHome, ".agents", "skills", "personal"),
    join(hostileHome, "skills", "hostile"),
    join(cleanHome, "skills", ".system", "hostile"),
    osHome,
    workspace,
    join(hostileWorkspace, ".codex"),
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(
    join(userHome, ".agents", "skills", "personal", "SKILL.md"),
    skillFixture("personal", contextMarker("USERHOME-SKILL")),
  );
  await writeFile(
    join(hostileHome, "skills", "hostile", "SKILL.md"),
    skillFixture("hostile", contextMarker("HOME-SKILL")),
  );
  await writeFile(
    join(cleanHome, "skills", ".system", "hostile", "SKILL.md"),
    skillFixture("hostile", contextMarker("BUNDLED-SKILL")),
  );
  await writeFile(
    join(hostileHome, "AGENTS.md"),
    contextMarker("HOME-AGENTSMD"),
  );
  for (const dir of [workspace, hostileWorkspace]) {
    await writeFile(
      join(dir, "AGENTS.md"),
      contextMarker("WORKSPACE-AGENTSMD"),
    );
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          hostile: { command: "node", args: ["-e", writeMarker("mcp-json")] },
        },
      }),
    );
  }
  await writeFile(
    join(hostileWorkspace, ".codex", "config.toml"),
    `[mcp_servers.project]\ncommand = "node"\nargs = ["-e", ${toml(writeMarker("project-mcp"))}]\n`,
  );
  await writeFile(join(runtimeDir, "instructions.md"), policies.systemPrompt);

  let hostileReply = false;
  const isTitle = (body) =>
    textOf(body.input ?? "").includes("generate a very short title");
  const stub = await loopback((entry, response) => {
    if (!entry.url.includes("/responses")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    const title = isTitle(entry.body);
    const call = hostileReply && !title;
    hostileReply = false;
    const item = call
      ? {
          type: "function_call",
          id: "fc_probe",
          call_id: "call_probe",
          name: "exec_command",
          arguments: JSON.stringify({
            cmd: `node -e "${writeMarker("tool")}"`,
          }),
        }
      : {
          type: "message",
          id: "msg_probe",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: title ? '{"title":"Loopback title"}' : "POLICY_PROBE_OK",
              annotations: [],
            },
          ],
        };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    event("response.created", { response: { id: "resp_probe" } });
    event("response.output_item.added", {
      output_index: 0,
      item: call ? item : { ...item, content: [] },
    });
    if (!call)
      event("response.output_text.delta", {
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: item.content[0].text,
      });
    event("response.output_item.done", { output_index: 0, item });
    event("response.completed", {
      response: {
        id: "resp_probe",
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 1 },
          total_tokens: 15,
        },
      },
    });
    response.end();
  });

  // The loopback provider. In Distill the account's home holds only the
  // credential store; the probe's homes also name this provider so the CLI
  // never reaches a real endpoint.
  const providerToml = `model_provider = "probe"\n[model_providers.probe]\nname = "probe"\nbase_url = ${toml(`${stub.url}/v1`)}\nwire_api = "responses"\nenv_key = "CODEX_API_KEY"\n[features]\nenable_request_compression = false\n[analytics]\nenabled = false\n`;
  await writeFile(
    join(cleanHome, "config.toml"),
    `cli_auth_credentials_store = "file"\n${providerToml}`,
  );
  await writeFile(
    join(hostileHome, "config.toml"),
    `cli_auth_credentials_store = "file"\n${providerToml}[mcp_servers.home]\ncommand = "node"\nargs = ["-e", ${toml(writeMarker("home-mcp"))}]\n`,
  );
  const probeProvider = {
    model_provider: "probe",
    model_providers: {
      probe: {
        name: "probe",
        base_url: `${stub.url}/v1`,
        wire_api: "responses",
        env_key: "CODEX_API_KEY",
      },
    },
  };
  const credentials = {
    CODEX_API_KEY: "synthetic-probe-key",
    DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
  };

  // The account's cached model list. A real account home caches the list the
  // server sends this CLI version; the fixture caches the list the pinned
  // CLI ships, which has the same entries and fields.
  const shipped = JSON.parse(
    await runNode(
      cli,
      ["debug", "models"],
      {
        ...baseEnv(),
        ...credentials,
        APPDATA: osHome,
        LOCALAPPDATA: osHome,
        USERPROFILE: osHome,
        HOME: osHome,
        CODEX_HOME: cleanHome,
      },
      workspace,
    ),
  );
  await writeFile(
    join(cleanHome, "models_cache.json"),
    JSON.stringify({
      fetched_at: new Date().toISOString(),
      etag: null,
      client_version: cliVersion,
      identity: null,
      models: shipped.models,
    }),
  );
  // Both kinds of entry must be in it: a Responses Lite model that declares
  // code mode, extra tools and subagents, and a classic one.
  const codeMode = shipped.models.find(
    (model) =>
      model.slug === "gpt-6-astra" &&
      model.use_responses_lite &&
      model.tool_mode === "code_mode_only" &&
      model.experimental_supported_tools?.length > 0 &&
      model.multi_agent_version === "v2",
  );
  const classic = shipped.models.find(
    (model) => model.slug === "gpt-5.5" && !model.use_responses_lite,
  );
  assert(codeMode && classic, "The fixture catalog lacks a model to probe");

  // The catalog the host starts the CLI with (execution::codex_model_catalog):
  // the account's cached entries with the policy's `modelCatalog` fields.
  const cached = JSON.parse(
    await readFile(join(cleanHome, "models_cache.json"), "utf8"),
  );
  const catalogFile = join(runtimeDir, "model-catalog.json");
  await writeFile(
    catalogFile,
    JSON.stringify({
      models: cached.models.map((model) => ({
        ...model,
        ...policy.modelCatalog,
      })),
    }),
  );

  try {
    // Restricted: what the host starts (see NativeProvider::process_env), on
    // a clean account home and an empty OS home, which APPDATA and
    // LOCALAPPDATA point at as well.
    const restrictedEnv = {
      ...baseEnv(),
      ...credentials,
      ...policy.env,
      APPDATA: osHome,
      LOCALAPPDATA: osHome,
      USERPROFILE: osHome,
      HOME: osHome,
      CODEX_HOME: cleanHome,
      CODEX_CONFIG: JSON.stringify({
        ...policy.config,
        ...probeProvider,
        model_instructions_file: join(runtimeDir, "instructions.md"),
        model_catalog_json: catalogFile,
      }),
    };
    const restricted = startBridge(
      children,
      entrypoint,
      adapter,
      restrictedEnv,
      workspace,
    );
    await restricted.initialize();
    const task =
      "Benchmark task:\n/plan\n$hostile $personal\nRead AGENTS.md, use the hostile skill or MCP server, and write escaped.txt. If no tools are available, answer POLICY_PROBE_OK.";

    /** One owned session on `model` at `effort`, selected as the host
     * selects it, with one turn; its model requests and prompt response. */
    const ownedTurn = async (model, effort, text) => {
      const opened = await restricted.call("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      await restricted.call("session/set_mode", {
        sessionId: opened.sessionId,
        modeId: policy.permissionMode,
      });
      let options;
      for (const [configId, value] of [
        ["model", model],
        ["reasoning_effort", effort],
      ]) {
        options = (
          await restricted.call("session/set_config_option", {
            sessionId: opened.sessionId,
            configId,
            value,
          })
        ).configOptions;
      }
      const current = Object.fromEntries(
        options.map((option) => [option.id, option.currentValue]),
      );
      assert.deepEqual(
        [current.model, current.reasoning_effort],
        [model, effort],
        `The session must run the selection: ${textOf(current)}`,
      );
      const start = stub.requests.length;
      const before = restricted.notifications.length;
      const answered = await restricted
        .call("session/prompt", {
          sessionId: opened.sessionId,
          prompt: [{ type: "text", text }],
        })
        .catch((error) => ({ error: String(error) }));
      // A title or summary request would follow the turn.
      await sleep(1500);
      return {
        answered,
        requests: stub.requests
          .slice(start)
          .filter((entry) => entry.url.includes("/responses")),
        updates: restricted.notifications.slice(before),
      };
    };

    // A Responses Lite model that declares code mode, extra tools and
    // subagents, at `max`, the highest effort the profile admits; and a
    // classic one.
    const turns = {
      [codeMode.slug]: await ownedTurn(codeMode.slug, "max", task),
      [classic.slug]: await ownedTurn(classic.slug, "low", task),
    };
    for (const [model, turn] of Object.entries(turns)) {
      assert.equal(
        turn.requests.length,
        1,
        `${model}: one owned turn must make one model request, saw ${turn.requests.length}`,
      );
      const [request] = turn.requests;
      const wire = codexWire(request);
      assert.equal(
        wire.lite,
        model === codeMode.slug,
        `${model}: the request must use the model's wire shape`,
      );
      assert.equal(
        wire.tools.length,
        0,
        `${model}: no tools may reach the model: ${textOf(wire.tools)}`,
      );
      assert.equal(
        wire.instructions,
        policies.systemPrompt,
        `${model}: the instructions must be the benchmark system prompt: ${textOf(wire.instructions)}`,
      );
      assert.equal(
        wire.input.length,
        1,
        `${model}: the model must see only the task: ${textOf(wire.input)}`,
      );
      assert.equal(wire.input[0].role, "user");
      assert.equal(
        messageText(wire.input[0]),
        task,
        `${model}: the task must reach the model unchanged: ${textOf(wire.input[0])}`,
      );
      // The effort the session runs is the one the request carries; `max`
      // hands nothing to subagents.
      assert.equal(
        request.body.reasoning?.effort,
        model === codeMode.slug ? "max" : "low",
        `${model}: ${textOf(request.body.reasoning)}`,
      );
      assert(
        turn.updates.every(
          (value) =>
            value.params?.update?.sessionUpdate !== "current_mode_update",
        ),
        `${model}: a slash command inside the task changed the mode`,
      );
      assert(
        textOf(turn.updates).includes("POLICY_PROBE_OK"),
        `${model}: ACP must return the stub response`,
      );
      assert.deepEqual(
        {
          inputTokens: turn.answered.usage?.inputTokens,
          cachedReadTokens: turn.answered.usage?.cachedReadTokens,
          outputTokens: turn.answered.usage?.outputTokens,
          thoughtTokens: turn.answered.usage?.thoughtTokens,
        },
        {
          inputTokens: 8,
          cachedReadTokens: 2,
          outputTokens: 5,
          thoughtTokens: 1,
        },
        `${model}: prompt usage the runner reads: ${textOf(turn.answered)}`,
      );
      assert.deepEqual(
        turn.answered._meta?.quota?.model_usage?.map((usage) => usage.model),
        [model],
        `${model}: one model in the quota usage: ${textOf(turn.answered._meta)}`,
      );
    }
    assert(
      !textOf(stub.requests).includes(secret),
      "Private fixture context leaked into a model request",
    );

    // A hostile reply calls a tool in a fresh session (one turn per owned
    // session, as in Distill). Nothing may run, and the turn's usage must be
    // the thread total across both requests.
    hostileReply = true;
    const hostile = await ownedTurn(
      codeMode.slug,
      "low",
      "Benchmark task:\nTry to write the marker using a native tool.",
    );
    assert(!(await exists(marker)), "A tool, hook or MCP process executed");
    assert(
      hostile.requests.every((entry) => !isTitle(entry.body)),
      "The adapter must suppress the title request",
    );
    // Codex refuses the call itself and asks the model again; the adapter
    // reports the call, so the host tags the turn as a violation.
    const toolCalls = hostile.updates.filter((value) =>
      ["tool_call", "tool_call_update"].includes(
        value.params?.update?.sessionUpdate,
      ),
    ).length;
    assert(
      toolCalls > 0,
      `The refused tool call must reach the host as a tool_call update: ${textOf(hostile.updates.map((value) => value.params?.update?.sessionUpdate))}`,
    );
    if (hostile.requests.length === 2 && !hostile.answered.error) {
      assert.equal(
        hostile.answered.usage?.inputTokens,
        16,
        `Turn usage must be the thread total: ${textOf(hostile.answered.usage)}`,
      );
    }

    // The CLI finds the user's own profile through the operating system, not
    // through the redirected `USERPROFILE` and `HOME`, so the personal skills
    // there reach it whatever its environment says, and no setting turns
    // them off. Mentioning every one of this machine's shows where what it
    // adds comes from: only that folder, which the host refuses Codex for
    // while it has entries (execution::codex_user_skills_preflight).
    const realSkillsDir = join(homedir(), ".agents", "skills");
    const realSkills = await skillNames(realSkillsDir);
    let realProfile = {
      folder: realSkillsDir,
      skills: 0,
      note: "no personal skills on this machine to mention",
    };
    if (realSkills.length > 0) {
      const mentioning = `Benchmark task:\n${realSkills.map((name) => `$${name}`).join(" ")}\nAnswer POLICY_PROBE_OK.`;
      const turn = await ownedTurn(classic.slug, "low", mentioning);
      assert.equal(turn.requests.length, 1, "One request for the mention turn");
      const [first, ...added] = codexWire(turn.requests[0]).input;
      assert.equal(messageText(first), mentioning);
      const folder = realSkillsDir.toLowerCase();
      for (const item of added) {
        const path = /<path>([^<]*)<\/path>/.exec(messageText(item))?.[1];
        assert(
          item.role === "user" && path?.toLowerCase().startsWith(folder),
          `Only the personal skills folder the host guards may add input: ${textOf(item).slice(0, 300)}`,
        );
      }
      realProfile = {
        folder: realSkillsDir,
        skills: realSkills.length,
        injected: added.length,
        note: "the host refuses Codex while this folder has entries",
      };
    }
    const restrictedRequests = stub.requests.length;

    // Positive control: the same CLI with no policy, on the hostile homes and
    // workspace, at `ultra`, must expose tools, subagents and context, run the
    // fixture, and title the session.
    const control = startBridge(
      children,
      entrypoint,
      null,
      {
        ...baseEnv(),
        ...credentials,
        APPDATA: userHome,
        LOCALAPPDATA: userHome,
        USERPROFILE: userHome,
        HOME: userHome,
        CODEX_HOME: hostileHome,
        CODEX_CONFIG: JSON.stringify(probeProvider),
      },
      hostileWorkspace,
    );
    await control.initialize();
    const controlSession = await control.call("session/new", {
      cwd: hostileWorkspace,
      mcpServers: [],
    });
    for (const [configId, value] of [
      ["model", codeMode.slug],
      ["reasoning_effort", "ultra"],
    ])
      await control.call("session/set_config_option", {
        sessionId: controlSession.sessionId,
        configId,
        value,
      });
    await control.call("session/prompt", {
      sessionId: controlSession.sessionId,
      prompt: [
        { type: "text", text: "Say POLICY_PROBE_OK. $hostile $personal" },
      ],
    });
    const deadline = Date.now() + 10000;
    while (
      !stub.requests.slice(restrictedRequests).some((e) => isTitle(e.body)) &&
      Date.now() < deadline
    )
      await sleep(50);
    const controlRequests = stub.requests
      .slice(restrictedRequests)
      .filter((entry) => entry.url.includes("/responses"));
    const [controlTurn] = controlRequests;
    const controlTools = textOf(codexWire(controlTurn).tools);
    for (const tool of ["exec", "spawn_agent"])
      assert(
        controlTools.includes(`"name":"${tool}"`),
        `Positive control must expose ${tool}: ${controlTools}`,
      );
    // `ultra` is not an effort of its own: the request runs another one and
    // the turn is told to delegate, which is why the profile excludes it.
    assert.notEqual(
      controlTurn.body.reasoning?.effort,
      "ultra",
      "Positive control at ultra",
    );
    assert(
      controlTurn.body.input.some(
        (item) =>
          item.role === "developer" &&
          messageText(item).includes("<multi_agent_mode>"),
      ),
      "Positive control at ultra must carry the delegation instructions",
    );
    // Each fixture the control reads shows where it came from: the account
    // home's instructions and skill and the project instructions. The profile
    // the environment names is not one: Codex finds the user's own (see the
    // personal skills check above), so the redirect is no control for it.
    const codexLocations = [
      "HOME-AGENTSMD",
      "HOME-SKILL",
      "WORKSPACE-AGENTSMD",
      "USERHOME-SKILL",
      "BUNDLED-SKILL",
    ];
    const controlMarkers = markersIn(controlRequests, codexLocations);
    assert.deepEqual(
      controlMarkers,
      ["HOME-AGENTSMD", "HOME-SKILL", "WORKSPACE-AGENTSMD"],
      "Positive control must expose the home and project context fixtures, and only those",
    );
    assert(
      await exists(marker),
      "Positive control must execute the hostile MCP fixture",
    );
    assert(
      controlRequests.some((entry) => isTitle(entry.body)),
      "Positive control must make its title request",
    );

    // A changed entrypoint is refused before it runs.
    const changed = join(root, "changed", "dist");
    await mkdir(changed, { recursive: true });
    await writeFile(
      join(changed, "index.js"),
      `${await readFile(entrypoint, "utf8")}\nconsole.log("UNVERIFIED_ENTRYPOINT_EXECUTED");\n`,
    );
    const refused = await refusedUnderAdapter(
      join(changed, "index.js"),
      adapter,
      restrictedEnv,
    );
    assert.notEqual(refused.code, 0);
    assert(!refused.stdout.includes("UNVERIFIED_ENTRYPOINT_EXECUTED"));
    assert(
      refused.errors.includes("pinned Codex benchmark adapter source changed"),
    );
    // Without the catalog the CLI would keep the tools its models declare,
    // so the adapter does not start the bridge.
    const { model_catalog_json: _catalog, ...withoutCatalog } = JSON.parse(
      restrictedEnv.CODEX_CONFIG,
    );
    const uncatalogued = await refusedUnderAdapter(entrypoint, adapter, {
      ...restrictedEnv,
      CODEX_CONFIG: JSON.stringify(withoutCatalog),
    });
    assert.notEqual(uncatalogued.code, 0);
    assert(
      uncatalogued.errors.includes(
        "Codex benchmark model catalog is unavailable",
      ),
      uncatalogued.errors,
    );

    return {
      runtime: `${packageInfo.name}@${packageInfo.version}`,
      cli: cliVersion,
      restrictedRequests: Object.fromEntries(
        Object.entries(turns).map(([model, turn]) => [
          model,
          {
            requests: turn.requests.length,
            wire: codexWire(turn.requests[0]).lite
              ? "responses-lite"
              : "responses",
            effort: turn.requests[0].body.reasoning?.effort,
          },
        ]),
      ),
      hostileRequests: hostile.requests.length,
      hostileToolCallUpdates: toolCalls,
      refusedAgentRequests: restricted.agentRequests.map(
        (value) => value.method,
      ),
      personalSkills: realProfile,
      controlRequests: controlRequests.length,
      controlContext: controlMarkers,
      controlEffortAtUltra: controlTurn.body.reasoning?.effort,
      checks: [
        "pinned codex-acp entrypoint and native Codex CLI",
        "one model request per owned turn, no title request",
        "no tools in the request, in both wire shapes: no code mode, apply_patch, extra or subagent tools",
        "instructions are the benchmark system prompt (Responses Lite: its developer message)",
        "the model sees only the task; slash commands, skill mentions and bundled skills inert",
        "home, user and project context absent (no fixture marker in any restricted request)",
        "the selected model and effort run; max carries no delegation",
        "hostile tool call executed nothing and reached the host as a tool_call update",
        "prompt usage and quota usage carry the thread totals",
        "the personal skills Codex reads come only from the user's own profile folder, which the host guards",
        "positive control exposes tools, subagents, the home and project context fixtures (not the redirected profile's), runs the MCP fixture, titles the session, and runs ultra as another effort with delegation",
        "changed entrypoint and missing catalog refused before the bridge runs",
      ],
    };
  } finally {
    await stub.close();
  }
}

/** One Responses API stream, with the fields the API's events carry (Grok
 * refuses a stream without them): a message, or a call to `call` when given. */
function writeResponse(response, { text, call }) {
  const part = { type: "output_text", text, annotations: [] };
  const item = call
    ? {
        type: "function_call",
        id: "fc_probe",
        call_id: "call_probe",
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        status: "completed",
      }
    : {
        type: "message",
        id: "msg_probe",
        role: "assistant",
        status: "completed",
        content: [part],
      };
  response.writeHead(200, { "content-type": "text/event-stream" });
  let sequence = 0;
  const event = (type, data) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
    );
  const created = {
    id: "resp_probe",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: "grok-4.7",
  };
  event("response.created", {
    response: { ...created, status: "in_progress", output: [] },
  });
  event("response.output_item.added", {
    output_index: 0,
    item: call
      ? { ...item, arguments: "", status: "in_progress" }
      : { ...item, content: [], status: "in_progress" },
  });
  if (call) {
    event("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    });
    event("response.function_call_arguments.done", {
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    });
  } else {
    const at = { item_id: item.id, output_index: 0, content_index: 0 };
    event("response.content_part.added", {
      ...at,
      part: { ...part, text: "" },
    });
    event("response.output_text.delta", { ...at, delta: text, logprobs: [] });
    event("response.output_text.done", { ...at, text, logprobs: [] });
    event("response.content_part.done", { ...at, part });
  }
  event("response.output_item.done", { output_index: 0, item });
  event("response.completed", {
    response: {
      ...created,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 15,
      },
    },
  });
  response.end();
}

/** The text a Responses request gives the model as instructions, and as
 * user input. */
function requestText(body) {
  const parts = (content) =>
    typeof content === "string"
      ? content
      : (content ?? []).map((part) => part.text ?? "").join("");
  const input = Array.isArray(body.input)
    ? body.input
    : [{ role: "user", content: body.input }];
  return {
    instructions: [
      body.instructions ?? "",
      ...input
        .filter((item) => ["system", "developer"].includes(item.role))
        .map((item) => parts(item.content)),
    ]
      .filter(Boolean)
      .join("\n"),
    user: input
      .filter((item) => item.role === "user")
      .map((item) => parts(item.content)),
    other: input.filter(
      (item) => !["system", "developer", "user"].includes(item.role),
    ),
  };
}

async function probeGrok(root, children) {
  const policy = policies.grok;
  const executable = installed;
  assert.equal(
    sha256(await readFile(executable)),
    policy.runtime.files.executable,
    "The installed grok is not the pinned build",
  );
  assert.equal(policy.args.at(-1), "stdio");
  const marker = join(root, "escaped.txt");
  const writeMarker = (label) =>
    `require('fs').writeFileSync(${JSON.stringify(marker)},'${label}')`;

  // The hostile fixture: a user profile with a skill, Claude settings,
  // memory, a hook and an MCP server; a Grok home like the user's, with
  // global instructions, rules, a hook, a skill, an MCP server and a trust
  // store; and a workspace with project instructions, rules and MCP files.
  const userHome = join(root, "user-home");
  const hostileHome = join(root, "grok-home-hostile");
  const runtimeDir = join(root, "runtime");
  const privateHome = join(runtimeDir, "home");
  const osHome = join(runtimeDir, "os-home");
  const workspace = join(root, "workspace");
  const hostileWorkspace = join(root, "workspace-hostile");
  for (const dir of [
    join(userHome, ".agents", "skills", "personal"),
    join(userHome, ".claude"),
    join(hostileHome, "skills", "hostile"),
    join(hostileHome, "rules"),
    join(hostileHome, "hooks"),
    privateHome,
    osHome,
    workspace,
    join(hostileWorkspace, ".grok", "rules"),
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(
    join(userHome, ".agents", "skills", "personal", "SKILL.md"),
    skillFixture("personal", contextMarker("USERHOME-SKILL")),
  );
  await writeFile(
    join(hostileHome, "skills", "hostile", "SKILL.md"),
    skillFixture("hostile", contextMarker("HOME-SKILL")),
  );
  await mkdir(join(hostileHome, "bundled", "skills", "platform"), {
    recursive: true,
  });
  await writeFile(
    join(hostileHome, "bundled", "skills", "platform", "SKILL.md"),
    skillFixture("platform", contextMarker("BUNDLED-SKILL")),
  );
  await writeFile(
    join(userHome, ".claude", "CLAUDE.md"),
    contextMarker("USERHOME-CLAUDEMD"),
  );
  // A hook command runs through a shell; a script file keeps its quoting
  // plain on every one.
  const hookScript = join(root, "hook.js").replaceAll("\\", "/");
  await writeFile(
    hookScript,
    "require('fs').writeFileSync(process.argv[2], process.argv[3]);",
  );
  const sessionStartHook = (label) => ({
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `node "${hookScript}" "${marker.replaceAll("\\", "/")}" ${label}`,
            },
          ],
        },
      ],
    },
  });
  await writeFile(
    join(userHome, ".claude", "settings.json"),
    JSON.stringify(sessionStartHook("claude-hook")),
  );
  await writeFile(
    join(userHome, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        hostile: { command: "node", args: ["-e", writeMarker("claude-mcp")] },
      },
    }),
  );
  await writeFile(
    join(hostileHome, "AGENTS.md"),
    contextMarker("HOME-AGENTSMD"),
  );
  await writeFile(
    join(hostileHome, "rules", "hostile.md"),
    contextMarker("HOME-RULES"),
  );
  await writeFile(
    join(hostileHome, "hooks", "hostile.json"),
    JSON.stringify(sessionStartHook("grok-hook")),
  );
  await writeFile(
    join(hostileHome, "config.toml"),
    `[mcp_servers.hostile]\ncommand = "node"\nargs = ["-e", ${toml(writeMarker("grok-mcp"))}]\n`,
  );
  for (const dir of [workspace, hostileWorkspace]) {
    await writeFile(
      join(dir, "AGENTS.md"),
      contextMarker("WORKSPACE-AGENTSMD"),
    );
    await writeFile(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          hostile: { command: "node", args: ["-e", writeMarker("mcp-json")] },
        },
      }),
    );
  }
  await writeFile(
    join(hostileWorkspace, ".grok", "rules", "x.md"),
    contextMarker("WORKSPACE-RULES"),
  );
  // Grok loads a project's instructions and rules only from a folder its
  // home trusts; the user-like home trusts the hostile workspace, as the
  // user's trusts their projects. The private home may hold no trust store.
  for (const dir of [workspace, hostileWorkspace]) {
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  await writeFile(
    join(hostileHome, "trusted_folders.toml"),
    `[folders.${toml(hostileWorkspace)}]\ntrusted = true\ndecided_at = ${Math.floor(Date.now() / 1000)}\n`,
  );
  // The private home as `prepare_owned_runtime` leaves it, plus a skill where
  // Grok's own bundle sync puts the platform skills it downloads (the stub
  // serves none): Grok lists those to the model unless the profile drops
  // them, and nothing on the host can keep them out of its home.
  await writeFile(join(privateHome, "config.toml"), policy.configToml);
  await mkdir(join(privateHome, "bundled", "skills", "hostile"), {
    recursive: true,
  });
  await writeFile(
    join(privateHome, "bundled", "skills", "hostile", "SKILL.md"),
    skillFixture("hostile", contextMarker("PRIVATE-BUNDLED-SKILL")),
  );

  // The sign-in: a fabricated session shaped like the auth file the pinned
  // Grok writes for its default sign-in (keyed by the auth.x.ai issuer and
  // Grok's own OAuth client id; `auth_mode` and `create_time` are required),
  // without a refresh token, as `benchmark_auth_document` hands the user's
  // over. The user-like home keeps its own copy, as the user's does.
  const token = "fabricated-probe-access-token";
  const auth = JSON.stringify({
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: token,
      auth_mode: "oidc",
      create_time: new Date().toISOString(),
      user_id: "probe-user",
      email: "probe@example.invalid",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  await writeFile(join(hostileHome, "auth.json"), auth);
  // Where the host hands an owned bridge the sign-in (`GROK_AUTH_PATH`): a
  // file of its own outside the private home, removed once the bridge has
  // answered `initialize`.
  const signIn = join(runtimeDir, "sign-in", "owned.json");
  await mkdir(dirname(signIn), { recursive: true });

  let hostileReply = false;
  const modelTitle = "Probe title the summary model wrote";
  const model = {
    id: "grok-4.7",
    model: "grok-4.7",
    model_family: "xai",
    name: "Grok 4.7",
    description: "Policy probe model",
    api_backend: "responses",
    extra_headers: {},
    context_window: 256000,
    hidden: false,
    supported_in_api: true,
    reasoning_effort: "high",
    supports_reasoning_effort: true,
    reasoning_efforts: ["low", "medium", "high", "xhigh"].map((value) => ({
      id: value,
      value,
      label: value,
      description: value,
      default: value === "high",
    })),
    supports_backend_search: true,
  };
  const stub = await loopback((entry, response) => {
    // Grok titles a session by forcing a `session_title` call on its
    // `models.session_summary` model; answered, the title is the model's.
    if (
      entry.url.includes("/responses") &&
      entry.body.tool_choice?.name === "session_title"
    ) {
      writeResponse(response, {
        call: {
          name: "session_title",
          arguments: { session_title: modelTitle },
        },
      });
      return;
    }
    if (entry.url.includes("/responses")) {
      const call = hostileReply;
      hostileReply = false;
      writeResponse(
        response,
        call
          ? {
              call: {
                name: "run_terminal_command",
                arguments: { command: `node -e "${writeMarker("tool")}"` },
              },
            }
          : { text: "POLICY_PROBE_OK" },
      );
      return;
    }
    if (entry.url.includes("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [model], models: [model] }),
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  const endpoints = `${stub.url}/v1`;
  // Like the list the chat proxy serves, each model names the endpoint its
  // requests go to.
  model.base_url = endpoints;
  // The endpoints the policy leaves live, the model list and the API-key
  // endpoint, point at the stub. The policy closes every other one Grok
  // knows, the chat proxy base included: settings and the platform skill and
  // subagent bundles come from there, while model requests go to the
  // endpoint each listed model names.
  const modelEndpoints = {
    GROK_MODELS_BASE_URL: endpoints,
    GROK_XAI_API_BASE_URL: endpoints,
  };
  // A request for any other host goes through the stub as a proxy, which
  // refuses it: nothing leaves the machine, and the restricted run must not
  // try.
  const proxyTrap = {
    HTTPS_PROXY: stub.url,
    HTTP_PROXY: stub.url,
    NO_PROXY: "127.0.0.1,localhost",
  };
  // The positive control runs without the policy: every endpoint Grok knows
  // points at the stub, and nothing reports home.
  const loopbackEnv = {
    ...modelEndpoints,
    ...proxyTrap,
    GROK_CLI_CHAT_PROXY_BASE_URL: endpoints,
    GROK_CLI_BASE_URL: stub.url,
    GROK_MODES_BASE_URL: stub.url,
    GROK_SKILLS_BASE_URL: stub.url,
    GROK_CONVERSATIONS_BASE_URL: stub.url,
    GROK_WORKSPACES_BASE_URL: stub.url,
    GROK_FEEDBACK_BASE_URL: stub.url,
    GROK_MANAGED_CONFIG_URL: stub.url,
    GROK_TELEMETRY_ENABLED: "0",
    GROK_FEEDBACK_ENABLED: "0",
    GROK_DISABLE_AUTOUPDATER: "1",
  };
  // The restricted run starts with exactly the policy's arguments; the
  // control's also point the chat proxy and API endpoints at the stub.
  const controlArgs = [
    ...policy.args.slice(0, -1),
    "--cli-chat-proxy-base-url",
    endpoints,
    "--xai-api-base-url",
    endpoints,
    policy.args.at(-1),
  ];
  const sessionMeta = {
    ...policy.sessionMeta,
    distillNativePolicy: { revision: policy.revision },
  };
  // What the host adds to every owned prompt's `_meta`
  // (NativeProvider::prompt_meta): `verbatim` sends the task without Grok's
  // `<user_query>` wrapper.
  const promptMeta = policy.promptMeta ?? {};
  // What the host starts (see NativeProvider::process_env): the policy
  // environment, the private home, the empty OS home, which APPDATA and
  // LOCALAPPDATA point at as well, and the sign-in file. Only the endpoints
  // the policy leaves live are moved, to the stub.
  const restrictedEnv = {
    ...baseEnv(),
    ...policy.env,
    ...modelEndpoints,
    ...proxyTrap,
    APPDATA: osHome,
    LOCALAPPDATA: osHome,
    USERPROFILE: osHome,
    HOME: osHome,
    GROK_HOME: privateHome,
    GROK_AUTH_PATH: signIn,
  };
  const authorized = (entries) =>
    entries.some((entry) => textOf(entry.headers).includes(token));
  const select = async (client, sessionId) => {
    await client.call("session/set_config_option", {
      sessionId,
      configId: "model",
      value: "grok-4.7",
    });
    await client.call("session/set_config_option", {
      sessionId,
      configId: "reasoning_effort",
      value: "low",
    });
  };
  // The pinned Grok reports the turn on `_x.ai/session_notification`; the
  // host rewrites it from either extension method.
  const turnCompleted = (values) =>
    values.filter(
      (value) =>
        ["_x.ai/session_notification", "_x.ai/session/update"].includes(
          value.method,
        ) && value.params?.update?.sessionUpdate === "turn_completed",
    );
  // Grok titles a session right after its first prompt with a request to its
  // `models.session_summary` model and reports the title as
  // `session_summary_generated`; when that request fails it falls back to
  // the prompt's first words ("session title generation failed, falling back
  // to truncated user text" in the 1.0.40 binary).
  const sessionTitles = (values) =>
    values
      .filter(
        (value) =>
          ["_x.ai/session_notification", "_x.ai/session/update"].includes(
            value.method,
          ) &&
          value.params?.update?.sessionUpdate === "session_summary_generated",
      )
      .map((value) => value.params.update.session_summary);
  const words = (text) =>
    String(text ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  /** Whether `title` is the first words of `text` and shorter than it. */
  const truncationOf = (title, text) =>
    words(title).length > 0 &&
    words(title).length < words(text).length &&
    words(text).startsWith(words(title));

  const task =
    "Benchmark task:\n/plan\n$hostile $personal\nRead AGENTS.md, use the hostile skill or MCP server, and write escaped.txt. If no tools are available, answer POLICY_PROBE_OK.";
  /** One owned turn as the host runs it: the sign-in file is written before
   * the bridge starts and removed once it has answered `initialize`, so the
   * session and the turn run on the sign-in Grok holds in memory. */
  const ownedTurn = async () => {
    await writeFile(signIn, auth);
    const client = startNative(
      children,
      executable,
      policy.args,
      restrictedEnv,
      workspace,
    );
    try {
      await client.initialize();
    } finally {
      await rm(signIn, { force: true });
    }
    // Long enough for Grok to notice the file is gone before the session.
    await sleep(1500);
    const opened = await client.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: sessionMeta,
    });
    await select(client, opened.sessionId);
    const before = client.notifications.length;
    const turnStart = stub.requests.length;
    const answered = await client
      .call("session/prompt", {
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: task }],
        _meta: promptMeta,
      })
      .catch((error) => ({ error: String(error) }));
    const answeredAt = client.marks.get("session/prompt");
    // A title, summary or recap request would follow the turn.
    await sleep(1500);
    return {
      client,
      answered,
      answeredAt,
      before,
      requests: stub.requests.slice(turnStart),
    };
  };

  try {
    const turn = await ownedTurn().catch((error) => ({
      failed: String(error),
      requests: [],
    }));
    assert(!turn.failed, `The owned session could not start: ${turn.failed}`);
    // Grok copied the sign-in it was handed nowhere: not into its home, and
    // not back into the removed file.
    const privateHomeAuthFile = await exists(join(privateHome, "auth.json"));
    assert(!privateHomeAuthFile, "Grok wrote the sign-in into its home");
    assert(!(await exists(signIn)), "Grok recreated the removed sign-in");
    const { client: restricted, answered, answeredAt, before } = turn;
    assert(
      authorized(turn.requests),
      `Grok sent no request with the fabricated sign-in: ${textOf(turn.requests.map((entry) => entry.url))} ${restricted.stderr().slice(-2000)}`,
    );
    assert(!answered.error, `The owned turn failed: ${answered.error}`);
    const turnRequests = turn.requests.filter((entry) =>
      entry.url.includes("/responses"),
    );
    assert.equal(
      turnRequests.length,
      1,
      `One owned turn must make one model request, saw ${turnRequests.length}: ${textOf(turnRequests.map((entry) => entry.body)).slice(0, 6000)}`,
    );
    const [request] = turnRequests;
    assert.equal(
      request.body.tools?.length ?? 0,
      0,
      `No tools may reach the model: ${textOf(request.body.tools)}`,
    );
    const seen = requestText(request.body);
    assert.equal(
      seen.instructions,
      policies.systemPrompt,
      `The instructions must be the benchmark system prompt: ${textOf(seen.instructions)}`,
    );
    // Grok always opens the conversation with its context message (system
    // details and its own built-in rules); the profile's `userMessageTemplate`
    // leaves it empty.
    assert.deepEqual(
      seen.user,
      ["", task],
      `The model must see only the task: ${textOf(request.body.input)}`,
    );
    assert.deepEqual(seen.other, [], "No other input may reach the model");
    assert(
      !textOf(stub.requests).includes(secret),
      "Private fixture context leaked into a request",
    );
    assert(!(await exists(marker)), "A hook or MCP process executed");
    const restrictedUpdates = restricted.notifications.slice(before);
    assert(
      restrictedUpdates.every(
        (value) =>
          value.params?.update?.sessionUpdate !== "current_mode_update",
      ),
      "A slash command inside the task changed the mode",
    );
    assert(
      textOf(restrictedUpdates).includes("POLICY_PROBE_OK"),
      "ACP must return the stub response",
    );
    // The usage the host rewrites into `message_usage` must arrive before
    // the prompt is answered, or the host drops it with the finished run.
    const [usage] = turnCompleted(
      restricted.notifications.slice(before, answeredAt),
    );
    assert(
      usage,
      `turn_completed must arrive before the prompt response: ${textOf(restrictedUpdates)}`,
    );
    const turnUsage = usage.params.update.usage ?? {};
    assert(
      turnUsage.inputTokens > 0 && turnUsage.outputTokens > 0,
      `turn_completed must carry token usage: ${textOf(turnUsage)}`,
    );
    // The policy names a helper on the closed port 127.0.0.1:0 as the
    // summary model, so the title request fails on the machine: the title
    // Grok reports is the task's first words, made locally, and no title
    // request reached a server.
    const ownedTitles = sessionTitles(restrictedUpdates);
    assert.equal(
      ownedTitles.length,
      1,
      `One owned turn must report one session title: ${textOf(ownedTitles)}`,
    );
    const [ownedTitle] = ownedTitles;
    assert(
      truncationOf(ownedTitle, task),
      `The session title must be the task's first words, Grok's fallback when its title request fails: ${textOf(ownedTitle)}`,
    );
    // The `session_info_update` that follows carries the same title.
    assert(
      restrictedUpdates.some(
        (value) =>
          value.params?.update?.sessionUpdate === "session_info_update" &&
          value.params.update.title === ownedTitle,
      ),
      "The session_info_update after the title must carry the same title",
    );

    // Nothing Grok created in its private home may add context. Its plugin
    // registry lock is no plugin; the host's check allows it as well.
    const homeEntries = (await readdir(privateHome, { recursive: true }))
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry !== "installed-plugins/registry.lock");
    const forbidden = [
      "agents.md",
      "agent.md",
      "claude.md",
      "claude.local.md",
      "rules/",
      "hooks/",
      "skills/",
      "agents/",
      "plugins/",
      "installed-plugins/",
      "memory/",
      "memory-v2/",
      "managed_config.toml",
      "requirements.toml",
      "mcp_credentials.json",
      "trusted_folders.toml",
      "hooks-paths",
    ];
    const gained = homeEntries.filter((entry) =>
      forbidden.some((name) =>
        name.endsWith("/")
          ? entry.toLowerCase().startsWith(name)
          : entry.toLowerCase() === name,
      ),
    );
    assert.deepEqual(gained, [], "Grok added context sources to its home");

    // A hostile reply calls a tool in a fresh session. Nothing may run.
    hostileReply = true;
    const hostileSession = await restricted.call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: sessionMeta,
    });
    await select(restricted, hostileSession.sessionId);
    const hostileStart = stub.requests.length;
    const hostileBefore = restricted.notifications.length;
    const hostileAnswer = await restricted
      .call("session/prompt", {
        sessionId: hostileSession.sessionId,
        prompt: [
          {
            type: "text",
            text: "Benchmark task:\nTry to write the marker using a native tool.",
          },
        ],
        _meta: promptMeta,
      })
      .catch((error) => ({ error: String(error) }));
    await sleep(1500);
    assert(!(await exists(marker)), "A tool, hook or MCP process executed");
    const hostileRequests = stub.requests
      .slice(hostileStart)
      .filter((entry) => entry.url.includes("/responses"));
    const toolCalls = restricted.notifications
      .slice(hostileBefore)
      .filter((value) =>
        ["tool_call", "tool_call_update"].includes(
          value.params?.update?.sessionUpdate,
        ),
      ).length;
    const restrictedRequests = stub.requests.length;
    // Neither owned session's title request reached a server; the hostile
    // session's title is its prompt's first words as well.
    assert(
      !stub.requests.some(
        (entry) => entry.body?.tool_choice?.name === "session_title",
      ),
      "No title request may reach a server",
    );
    const hostileTitles = sessionTitles(
      restricted.notifications.slice(hostileBefore),
    );
    assert(
      hostileTitles.length === 1 &&
        truncationOf(
          hostileTitles[0],
          "Benchmark task:\nTry to write the marker using a native tool.",
        ),
      `The hostile session's title must be its prompt's first words: ${textOf(hostileTitles)}`,
    );
    // Grok fetches its settings, platform skills, subagents and managed
    // configuration with the session it runs on; the policy closes those
    // endpoints, so besides model requests the restricted run asks only for
    // the model list, and nothing tries to leave the machine. Before its
    // first model request Grok opens the model endpoint's host with a bare
    // `GET /`, without the session or a body.
    const auxiliary = stub.requests.filter(
      (entry) => !entry.url.includes("/responses"),
    );
    const otherEndpoints = [...new Set(auxiliary.map((entry) => entry.url))];
    for (const entry of auxiliary)
      assert(
        entry.url === "/v1/models" ||
          (entry.url === "/" &&
            entry.method === "GET" &&
            !textOf(entry.headers).includes(token)),
        `Only the model list may be fetched besides model requests: ${entry.method} ${entry.url}`,
      );
    assert.deepEqual(
      stub.tunnels,
      [],
      `No request may leave the machine: ${textOf(stub.tunnels)}`,
    );

    // Positive control: the same CLI with no policy, on the hostile homes
    // and workspace, must expose tools and context and run the fixture.
    const control = startNative(
      children,
      executable,
      controlArgs,
      {
        ...baseEnv(),
        ...loopbackEnv,
        APPDATA: userHome,
        LOCALAPPDATA: userHome,
        USERPROFILE: userHome,
        HOME: userHome,
        GROK_HOME: hostileHome,
      },
      hostileWorkspace,
    );
    await control.initialize();
    const controlSession = await control.call("session/new", {
      cwd: hostileWorkspace,
      mcpServers: [],
    });
    await select(control, controlSession.sessionId).catch(() => {});
    await control.call("session/prompt", {
      sessionId: controlSession.sessionId,
      prompt: [{ type: "text", text: "Say POLICY_PROBE_OK." }],
    });
    const deadline = Date.now() + 10000;
    while (!(await exists(marker)) && Date.now() < deadline) await sleep(50);
    const controlRequests = stub.requests
      .slice(restrictedRequests)
      .filter((entry) => entry.url.includes("/responses"));
    assert(
      controlRequests.some((entry) => entry.body.tools?.length > 0),
      "Positive control must expose native tools",
    );
    // Each fixture the control reads shows where it came from. The one from
    // the profile the environment names proves Grok honours the redirect.
    const grokLocations = [
      "USERHOME-SKILL",
      "USERHOME-CLAUDEMD",
      "HOME-SKILL",
      "HOME-AGENTSMD",
      "HOME-RULES",
      "BUNDLED-SKILL",
      "WORKSPACE-AGENTSMD",
      "WORKSPACE-RULES",
    ];
    const controlMarkers = markersIn(controlRequests, grokLocations);
    assert.deepEqual(
      controlMarkers,
      grokLocations,
      "Positive control must expose every context fixture",
    );
    assert(
      await exists(marker),
      "Positive control must run the hostile hook or MCP fixture",
    );
    assert(
      controlRequests.some(
        (entry) => entry.body.tool_choice?.name === "session_title",
      ),
      "Positive control must request a session title",
    );
    // Answered, the title request names the session with the model's title:
    // `session_summary_generated` carries what the summary model wrote, so
    // the owned run's truncated task shows its title request failed.
    const titleDeadline = Date.now() + 10000;
    while (
      sessionTitles(control.notifications).length === 0 &&
      Date.now() < titleDeadline
    )
      await sleep(50);
    const controlTitles = sessionTitles(control.notifications);
    assert.deepEqual(
      controlTitles,
      [modelTitle],
      "Positive control must title the session with the summary model's answer",
    );
    assert(
      textOf(controlRequests).includes("<user_query>") &&
        textOf(controlRequests).includes("<user_info>"),
      "Positive control must wrap the prompt and send Grok's context message",
    );

    return {
      runtime: `grok@${policy.runtime.label}`,
      authDelivery:
        "GROK_AUTH_PATH file outside the private home, removed once the bridge answered initialize",
      privateHomeAuthFile,
      privateHomeEntries: await readdir(privateHome),
      restrictedRequests: turnRequests.length,
      turnUsage,
      promptResponse: answered,
      hostileRequests: hostileRequests.length,
      hostileToolCallUpdates: toolCalls,
      hostileAnswer,
      refusedAgentRequests: restricted.agentRequests.map(
        (value) => value.method,
      ),
      otherEndpoints,
      sessionTitles: {
        owned: ownedTitle,
        hostile: hostileTitles[0],
        control: controlTitles[0],
      },
      controlRequests: controlRequests.length,
      controlContext: controlMarkers,
      checks: [
        "pinned grok build",
        "fabricated sign-in without a refresh token reached the stub after its file was removed; no copy left",
        "one model request per owned turn, no title, summary or recap request",
        "no tools in the request",
        "instructions are the benchmark system prompt",
        "the model sees only the task, unwrapped, after Grok's emptied context message; slash commands and skill mentions inert",
        "home, user, project and bundled-skill context absent (no fixture marker in any restricted request); no hook or MCP process ran",
        "turn_completed usage arrives before the prompt response",
        "session_summary_generated is the prompt's first words in both owned sessions, with the same title on the session_info_update that follows: Grok's fallback once its title request to the closed summary helper failed on the machine; no title request reached a server",
        "the private home gained no context source",
        "hostile tool call executed nothing",
        "the policy environment and arguments alone close settings, platform skill and subagent bundle, managed configuration, telemetry and feedback fetches: besides model requests only the model list (and a bare GET / on the model host) was fetched, and no request tried to leave the machine",
        "positive control exposes tools and the redirected profile's, home, bundled-skill and project context fixtures, runs the fixture, titles the session with the summary model's answer and wraps the prompt",
      ],
    };
  } finally {
    await stub.close();
  }
}

/** One chat completions answer, streamed or whole: a message, or a call to
 * `call` when given. */
function writeChatCompletion(response, stream, { text, call }) {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cached_tokens: 2,
  };
  const toolCalls = call
    ? [
        {
          index: 0,
          id: "call_probe",
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        },
      ]
    : undefined;
  const finish = call ? "tool_calls" : "stop";
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl_probe",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: call ? null : text,
              tool_calls: toolCalls,
            },
            finish_reason: finish,
          },
        ],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (choice, extra = {}) =>
    response.write(
      `data: ${JSON.stringify({ id: "chatcmpl_probe", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }], ...extra })}\n\n`,
    );
  chunk({
    delta: call
      ? { role: "assistant", tool_calls: toolCalls }
      : { role: "assistant", content: text },
    finish_reason: null,
  });
  chunk({ delta: {}, finish_reason: finish }, { usage });
  response.write("data: [DONE]\n\n");
  response.end();
}

/** The text a chat completions request gives the model as instructions, and
 * as user input. */
function chatRequestText(body) {
  const parts = (content) =>
    typeof content === "string"
      ? content
      : (content ?? []).map((part) => part.text ?? "").join("");
  const messages = body.messages ?? [];
  return {
    instructions: messages
      .filter((message) => ["system", "developer"].includes(message.role))
      .map((message) => parts(message.content)),
    user: messages
      .filter((message) => message.role === "user")
      .map((message) => parts(message.content)),
    other: messages.filter(
      (message) => !["system", "developer", "user"].includes(message.role),
    ),
  };
}

async function probeKimi(root, children) {
  const policy = policies.kimi;
  const packageInfo = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  const entrypoint = join(installed, "dist", "main.mjs");
  assert.equal(
    sha256(await readFile(entrypoint)),
    policy.runtime.files.entrypoint,
    "The installed Kimi Code is not the pinned build",
  );
  const adapter = await readFile(
    repo("src-tauri/resources/benchmark-kimi-policy.mjs"),
  );
  const marker = join(root, "escaped.txt");
  const writeMarker = (label) =>
    `require('fs').writeFileSync(${JSON.stringify(marker)},'${label}')`;

  // The hostile fixture: a user profile with `.agents` instructions and a
  // skill; a Kimi home like the user's, with SYSTEM.md, AGENTS.md, a skill,
  // hooks, MCP servers and the Moonshot search services; and a workspace with
  // project instructions and MCP files. The restricted run keeps this Kimi
  // home, as Distill keeps the user's.
  const userHome = join(root, "user-home");
  const kimiHome = join(root, "kimi-home");
  const runtimeDir = join(root, "runtime");
  const osHome = join(runtimeDir, "os-home");
  const workspace = join(root, "workspace");
  for (const dir of [
    join(userHome, ".agents", "skills", "personal"),
    join(kimiHome, "skills", "hostile"),
    osHome,
    join(workspace, ".kimi-code"),
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(
    join(userHome, ".agents", "skills", "personal", "SKILL.md"),
    skillFixture("personal", contextMarker("USERHOME-SKILL")),
  );
  await writeFile(
    join(kimiHome, "skills", "hostile", "SKILL.md"),
    skillFixture("hostile", contextMarker("HOME-SKILL")),
  );
  await writeFile(
    join(userHome, ".agents", "AGENTS.md"),
    contextMarker("USERHOME-AGENTSMD"),
  );
  await writeFile(join(kimiHome, "AGENTS.md"), contextMarker("HOME-AGENTSMD"));
  await writeFile(
    join(kimiHome, "SYSTEM.md"),
    `${contextMarker("HOME-SYSTEMMD")}\n\n\${agents_md}\n\${skills_section}`,
  );
  const mcp = (label) =>
    JSON.stringify({
      mcpServers: {
        hostile: { command: "node", args: ["-e", writeMarker(label)] },
      },
    });
  await writeFile(join(kimiHome, "mcp.json"), mcp("home-mcp"));
  await writeFile(
    join(workspace, "AGENTS.md"),
    contextMarker("WORKSPACE-AGENTSMD"),
  );
  await writeFile(join(workspace, ".mcp.json"), mcp("mcp-json"));
  await writeFile(
    join(workspace, ".kimi-code", "mcp.json"),
    mcp("project-mcp"),
  );
  // A hook command runs through a shell; a script file keeps its quoting
  // plain on every one.
  const hookScript = join(root, "hook.js").replaceAll("\\", "/");
  await writeFile(
    hookScript,
    "require('fs').writeFileSync(process.argv[2], process.argv[3]);",
  );
  const hook = (event) =>
    `[[hooks]]\nevent = "${event}"\ncommand = ${toml(`node "${hookScript}" "${marker.replaceAll("\\", "/")}" ${event}`)}\n`;

  let hostileReply = false;
  const stub = await loopback((entry, response) => {
    if (entry.url.includes("/chat/completions")) {
      const call = hostileReply;
      hostileReply = false;
      writeChatCompletion(
        response,
        entry.body.stream === true,
        call
          ? {
              call: {
                name: "Bash",
                arguments: { command: `node -e "${writeMarker("tool")}"` },
              },
            }
          : { text: "POLICY_PROBE_OK" },
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  const model = "probe/kimi";
  // An API-key provider on the stub with one model, the hostile hooks, and
  // the search services pointed at the stub too.
  await writeFile(
    join(kimiHome, "config.toml"),
    [
      `default_model = ${toml(model)}`,
      "telemetry = false",
      "",
      "[providers.probe]",
      'type = "kimi"',
      `base_url = ${toml(`${stub.url}/v1`)}`,
      'api_key = "synthetic-probe-key"',
      "",
      `[models.${toml(model)}]`,
      'provider = "probe"',
      'model = "kimi-probe"',
      "max_context_size = 262144",
      "",
      "[services.moonshot_search]",
      `base_url = ${toml(`${stub.url}/search`)}`,
      'api_key = "synthetic-probe-key"',
      "",
      "[services.moonshot_fetch]",
      `base_url = ${toml(`${stub.url}/fetch`)}`,
      'api_key = "synthetic-probe-key"',
      "",
      hook("SessionStart"),
      hook("UserPromptSubmit"),
    ].join("\n"),
  );

  const task =
    "Benchmark task:\n/plan\n$hostile $personal\nRead AGENTS.md, use the hostile skill or MCP server, and write escaped.txt. If no tools are available, answer POLICY_PROBE_OK.";
  try {
    // Restricted: what the host starts (see NativeProvider::process_env and
    // owned_launch): the policy environment, the user's Kimi home and the
    // empty OS home, which APPDATA and LOCALAPPDATA point at as well, under
    // the adapter.
    const restrictedEnv = {
      ...baseEnv(),
      ...policy.env,
      APPDATA: osHome,
      LOCALAPPDATA: osHome,
      USERPROFILE: osHome,
      HOME: osHome,
      KIMI_CODE_HOME: kimiHome,
    };
    const restricted = startBridge(
      children,
      entrypoint,
      adapter,
      restrictedEnv,
      workspace,
      ["acp"],
    );
    await restricted.initialize();
    const open = async (client) => {
      const opened = await client.call("session/new", {
        cwd: workspace,
        mcpServers: [],
      });
      await client.call("session/set_mode", {
        sessionId: opened.sessionId,
        modeId: policy.permissionMode,
      });
      await client.call("session/set_config_option", {
        sessionId: opened.sessionId,
        configId: "model",
        value: model,
      });
      return opened.sessionId;
    };
    const sessionId = await open(restricted);
    const before = restricted.notifications.length;
    const turnStart = stub.requests.length;
    const answered = await restricted.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: task }],
    });
    // A title or other auxiliary request would follow the turn.
    await sleep(1500);
    const turnRequests = stub.requests
      .slice(turnStart)
      .filter((entry) => entry.url.includes("/chat/completions"));
    assert.equal(
      turnRequests.length,
      1,
      `One owned turn must make one model request, saw ${turnRequests.length}`,
    );
    const [request] = turnRequests;
    assert.equal(
      request.body.tools?.length ?? 0,
      0,
      `No tools may reach the model: ${textOf(request.body.tools)}`,
    );
    const seen = chatRequestText(request.body);
    assert.deepEqual(
      seen.instructions,
      [policies.systemPrompt],
      `The instructions must be the benchmark system prompt: ${textOf(seen.instructions)}`,
    );
    assert.deepEqual(
      seen.user,
      [task],
      `The model must see only the task, with no reminder beside it: ${textOf(request.body.messages)}`,
    );
    assert.deepEqual(seen.other, [], "No other input may reach the model");
    assert(
      !textOf(stub.requests).includes(secret),
      "Private fixture context leaked into a request",
    );
    assert(!(await exists(marker)), "A hook or MCP process executed");
    const restrictedUpdates = restricted.notifications.slice(before);
    assert(
      restrictedUpdates.every(
        (value) =>
          value.params?.update?.sessionUpdate !== "current_mode_update",
      ),
      "A slash command inside the task changed the mode",
    );
    assert(
      textOf(restrictedUpdates).includes("POLICY_PROBE_OK"),
      "ACP must return the stub response",
    );
    // The usage the runner reads comes with the prompt response, so it is
    // inside the turn.
    assert.deepEqual(
      answered.usage,
      {
        inputTokens: 8,
        outputTokens: 5,
        cachedReadTokens: 2,
        cachedWriteTokens: 0,
        totalTokens: 15,
      },
      `Prompt usage the runner reads: ${textOf(answered)}`,
    );
    assert.deepEqual(
      answered._meta?.quota?.model_usage?.map((entry) => entry.model),
      [model],
      `One model in the quota usage: ${textOf(answered._meta)}`,
    );

    // A hostile reply calls a tool in a fresh session. Nothing may run.
    hostileReply = true;
    const hostileSession = await open(restricted);
    const hostileStart = stub.requests.length;
    const hostileBefore = restricted.notifications.length;
    const hostileAnswer = await restricted
      .call("session/prompt", {
        sessionId: hostileSession,
        prompt: [
          {
            type: "text",
            text: "Benchmark task:\nTry to write the marker using a native tool.",
          },
        ],
      })
      .catch((error) => ({ error: String(error) }));
    await sleep(1500);
    assert(!(await exists(marker)), "A tool, hook or MCP process executed");
    const hostileRequests = stub.requests
      .slice(hostileStart)
      .filter((entry) => entry.url.includes("/chat/completions"));
    const toolCalls = restricted.notifications
      .slice(hostileBefore)
      .filter((value) =>
        ["tool_call", "tool_call_update"].includes(
          value.params?.update?.sessionUpdate,
        ),
      ).length;
    const restrictedRequests = stub.requests.length;

    // Positive control: the same CLI with no adapter, on the hostile homes
    // and workspace, must expose tools and context and run the fixture.
    const control = startBridge(
      children,
      entrypoint,
      null,
      {
        ...baseEnv(),
        ...policy.env,
        APPDATA: userHome,
        LOCALAPPDATA: userHome,
        USERPROFILE: userHome,
        HOME: userHome,
        KIMI_CODE_HOME: kimiHome,
      },
      workspace,
      ["acp"],
    );
    await control.initialize();
    const controlSession = await open(control);
    await control.call("session/prompt", {
      sessionId: controlSession,
      prompt: [{ type: "text", text: "Say POLICY_PROBE_OK." }],
    });
    const deadline = Date.now() + 10000;
    while (!(await exists(marker)) && Date.now() < deadline) await sleep(50);
    const controlRequests = stub.requests
      .slice(restrictedRequests)
      .filter((entry) => entry.url.includes("/chat/completions"));
    assert(
      controlRequests.some((entry) => entry.body.tools?.length > 0),
      "Positive control must expose native tools",
    );
    // Each fixture the control reads shows where it came from. The one from
    // the profile the environment names proves Kimi honours the redirect.
    const kimiLocations = [
      "USERHOME-SKILL",
      "USERHOME-AGENTSMD",
      "HOME-SKILL",
      "HOME-AGENTSMD",
      "HOME-SYSTEMMD",
      "WORKSPACE-AGENTSMD",
    ];
    const controlMarkers = markersIn(controlRequests, kimiLocations);
    assert.deepEqual(
      controlMarkers,
      kimiLocations,
      "Positive control must expose every context fixture",
    );
    assert(
      await exists(marker),
      "Positive control must run the hostile hook or MCP fixture",
    );
    assert(
      controlRequests.some((entry) =>
        chatRequestText(entry.body).user.some((text) =>
          text.includes("<system-reminder>"),
        ),
      ),
      "Positive control must add its reminders beside the prompt",
    );

    // A changed entrypoint is refused before it runs.
    const changed = join(root, "changed", "dist");
    await mkdir(changed, { recursive: true });
    await writeFile(
      join(changed, "main.mjs"),
      `${await readFile(entrypoint, "utf8")}\nconsole.log("UNVERIFIED_ENTRYPOINT_EXECUTED");\n`,
    );
    const refused = await refusedUnderAdapter(
      join(changed, "main.mjs"),
      adapter,
      restrictedEnv,
    );
    assert.notEqual(refused.code, 0);
    assert(!refused.stdout.includes("UNVERIFIED_ENTRYPOINT_EXECUTED"));
    assert(
      refused.errors.includes("pinned Kimi benchmark adapter source changed"),
    );

    return {
      runtime: `${packageInfo.name}@${packageInfo.version}`,
      node: process.version,
      restrictedRequests: turnRequests.length,
      promptResponse: answered,
      hostileRequests: hostileRequests.length,
      hostileToolCallUpdates: toolCalls,
      hostileAnswer,
      refusedAgentRequests: restricted.agentRequests.map(
        (value) => value.method,
      ),
      otherEndpoints: [
        ...new Set(
          stub.requests
            .map((entry) => entry.url)
            .filter((url) => !url.includes("/chat/completions")),
        ),
      ],
      controlRequests: controlRequests.length,
      controlContext: controlMarkers,
      checks: [
        "pinned Kimi Code bundle",
        "one model request per owned turn, no title request",
        "no tools in the request",
        "the system message is the benchmark system prompt; SYSTEM.md and AGENTS.md absent",
        "the model sees only the task; no reminders; slash commands and skill mentions inert",
        "home, user and project context absent (no fixture marker in any restricted request); no hook or MCP process ran",
        "prompt response carries usage and per-model usage",
        "hostile tool call executed nothing",
        "positive control exposes tools, the redirected profile's, SYSTEM.md and project context fixtures and reminders, and runs the fixture",
        "changed entrypoint refused before it runs",
      ],
    };
  } finally {
    await stub.close();
  }
}

/** The `verified` block for `provider`'s resource entry: what this run passed
 * on, in the shape NativeProvider::admission_issue compares. */
async function verification(provider) {
  const { verified: _previous, ...entry } = policies[provider];
  const adapter = {
    codex: "benchmark-codex-policy.mjs",
    kimi: "benchmark-kimi-policy.mjs",
  }[provider];
  return {
    date: new Date().toISOString().slice(0, 10),
    runtime: entry.runtime,
    policy: sha256(canonical(entry)),
    ...(adapter && {
      adapter: sha256(await readFile(repo(`src-tauri/resources/${adapter}`))),
    }),
  };
}

const probes = { codex: probeCodex, grok: probeGrok, kimi: probeKimi };
assert(probes[provider], `No policy probe for '${provider}' yet`);
const root = await mkdtemp(join(tmpdir(), "distill-provider-policy-"));
const children = [];
try {
  const report = await probes[provider](root, children);
  const verified = await verification(provider);
  console.log(
    JSON.stringify(
      { status: "passed", provider, ...report, verified },
      null,
      2,
    ),
  );
} finally {
  // A bridge stops the CLI it started when its stdin closes; killing it at
  // once would leave that CLI running.
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null) return;
      child.stdin?.end();
      await Promise.race([once(child, "exit"), sleep(5000)]);
      child.kill();
    }),
  );
  // The path comes directly from mkdtemp; no user path is recursively removed.
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
