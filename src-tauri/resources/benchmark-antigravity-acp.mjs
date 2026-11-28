// One sandboxed repository attempt. Flock selects the account, model and
// effort before launch. Antigravity's headless CLI loads the runner's agent
// profile and identifies it before seeing the task.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AGENT = "flock-benchmark";
const MAX_LINE = 16 * 1024 * 1024;
const toolKinds = new Map([
  ["read_file", "read"],
  ["write_file", "edit"],
  ["edit_file", "edit"],
  ["run_command", "execute"],
  ["manage_task", "other"],
]);

// Both pipes are NDJSON. Bound even an unterminated line.
function readLines(stream, consume, fail) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    try {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop();
      if (pending.length > MAX_LINE) throw Error();
      for (const line of lines) {
        if (line.length > MAX_LINE) throw Error();
        if (line.trim()) consume(JSON.parse(line));
      }
    } catch {
      stream.pause();
      fail();
    }
  });
  stream.on("error", fail);
}

export function serve({
  argv,
  input,
  output,
  launch = spawn,
  cwd = "/workspace",
}) {
  const [modelFlag, model, effortFlag, effort] = argv;
  if (
    modelFlag !== "--model" ||
    !model ||
    model.startsWith("-") ||
    !(
      argv.length === 2 ||
      (argv.length === 4 &&
        effortFlag === "--effort" &&
        ["low", "medium", "high", "xhigh", "max"].includes(effort))
    )
  ) {
    throw Error(
      "Expected one benchmark model and an optional supported effort",
    );
  }
  // The CLI acknowledges only its model ID in the init event. Select the
  // effort-qualified model itself so init can attest the complete selection.
  const selectedModel =
    effort && !model.endsWith(`-${effort}`) ? `${model}-${effort}` : model;
  let child, session, opening, turn;
  const toolCalls = new Map();
  const option = (id, category, value) => ({
    id,
    category,
    name: id,
    type: "select",
    currentValue: value,
    options: [{ value, name: value }],
  });
  const configOptions = [option("model", "model", model)];
  if (effort)
    configOptions.push(option("thought_level", "thought_level", effort));
  const send = (obj) =>
    output.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");
  const ok = (id, result) => send({ id, result });
  const reject = (id, message, code = -32602) =>
    send({ id, error: { code, message } });
  const update = (payload) =>
    send({
      method: "session/update",
      params: { sessionId: session, update: payload },
    });
  function stop(reason) {
    const running = child;
    child = session = undefined;
    running?.kill("SIGKILL");
    if (opening !== undefined) reject(opening, reason, -32603);
    if (turn !== undefined) reject(turn, reason, -32603);
    opening = turn = undefined;
  }
  function onEvent(event) {
    if (opening !== undefined && event.event === "result") {
      stop(
        "capability_missing: Antigravity could not start the selected benchmark model, effort and agent",
      );
      return;
    }
    if (event.event === "init") {
      if (
        opening === undefined ||
        event.init?.agent !== AGENT ||
        event.init?.cwd !== cwd ||
        event.init?.model !== selectedModel ||
        typeof event.conversation_id !== "string" ||
        !event.conversation_id
      ) {
        stop(
          "Antigravity did not acknowledge the benchmark agent, workspace and model",
        );
        return;
      }
      session = event.conversation_id;
      ok(opening, { sessionId: session, configOptions });
      opening = undefined;
      return;
    }
    if (turn === undefined) return;
    if (event.event === "step_update") {
      const step = event.step_update;
      if (step?.conversation_id !== session || step.step_type !== "tool")
        return;
      const name = step.tool_name ?? step.tool_info?.name;
      if (
        typeof name !== "string" ||
        !name ||
        !Number.isSafeInteger(step.step_index) ||
        step.step_index < 0 ||
        !["ACTIVE", "DONE", "ERROR"].includes(step.state)
      ) {
        stop("Antigravity reported an invalid repository tool event");
        return;
      }
      const toolCallId = String(step.step_index);
      if (
        toolCalls.has(toolCallId) &&
        toolCalls.get(toolCallId).name !== name
      ) {
        stop("Antigravity changed the identity of a repository tool call");
        return;
      }
      const status =
        step.state === "DONE"
          ? "completed"
          : step.state === "ERROR"
            ? "failed"
            : "in_progress";
      if (status === "completed" && !toolKinds.has(name)) {
        stop(
          "Antigravity reported a tool outside the protected repository profile",
        );
        return;
      }
      update({
        sessionUpdate: toolCalls.has(toolCallId)
          ? "tool_call_update"
          : "tool_call",
        toolCallId,
        title: name,
        kind: toolKinds.get(name) ?? "other",
        status,
      });
      toolCalls.set(toolCallId, { name, status });
      return;
    }
    if (event.event !== "result") return;
    const r = event.result;
    if (
      r?.status !== "SUCCESS" ||
      r.conversation_id !== session ||
      typeof r.response !== "string" ||
      !Number.isSafeInteger(r.num_turns) ||
      r.num_turns < 1 ||
      Array.from(toolCalls.values()).some((t) => t.status === "in_progress")
    ) {
      // Do not relay command output, prompts or credential paths in errors.
      const detail = typeof r?.error === "string" ? r.error : "";
      stop(
        /RESOURCE_EXHAUSTED|\b429\b|rate limit/i.test(detail)
          ? "Antigravity rate limit reached"
          : "Antigravity did not complete this benchmark turn",
      );
      return;
    }
    const u = r.usage;
    if (
      !u ||
      ![
        u.input_tokens,
        u.output_tokens,
        u.total_tokens,
        u.cache_read_tokens ?? 0,
        u.thinking_tokens ?? 0,
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    ) {
      stop("Antigravity did not report valid token usage");
      return;
    }
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: r.response },
    });
    ok(turn, {
      stopReason: "end_turn",
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        totalTokens: u.total_tokens,
        cachedReadTokens: u.cache_read_tokens ?? 0,
        thoughtTokens: u.thinking_tokens ?? 0,
      },
    });
    turn = undefined;
  }
  function request({ id, method, params = {} }) {
    if (method === "initialize") {
      ok(id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
    } else if (method === "session/new") {
      if (
        child ||
        params.cwd !== cwd ||
        !Array.isArray(params.mcpServers) ||
        params.mcpServers.length
      ) {
        reject(id, "Expected a new isolated repository session");
        return;
      }
      opening = id;
      const proc = launch(
        "/opt/distill-tools/antigravity/agy",
        [
          "--agent",
          AGENT,
          "--model",
          selectedModel,
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--disable-slash-commands",
          "--settings",
          JSON.stringify({
            useG1Credits: false,
            toolPermission: "always-proceed",
          }),
        ],
        {
          cwd,
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            ...process.env,
            AGY_CLI_DISABLE_AUTO_UPDATE: "1",
            AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
          },
        },
      );
      child = proc;
      const ended = () => {
        if (child === proc)
          stop("Antigravity CLI stopped before completing its request");
      };
      proc.on("close", ended);
      proc.on("error", ended);
      proc.stdin.on("error", ended);
      readLines(
        proc.stdout,
        (event) => {
          if (child === proc) onEvent(event);
        },
        ended,
      );
    } else if (!session || params.sessionId !== session) {
      if (id !== undefined) reject(id, "Unknown Antigravity benchmark session");
    } else if (method === "session/set_config_option") {
      if (
        configOptions.some(
          (o) => o.id === params.configId && o.currentValue === params.value,
        )
      )
        ok(id, { configOptions });
      else reject(id, "This benchmark session has a fixed selection");
    } else if (method === "session/prompt") {
      if (
        turn !== undefined ||
        !Array.isArray(params.prompt) ||
        !params.prompt.length ||
        !params.prompt.every(
          (p) => p?.type === "text" && typeof p.text === "string",
        )
      ) {
        reject(id, "Expected one text prompt in an idle repository session");
        return;
      }
      turn = id;
      toolCalls.clear();
      child.stdin.write(
        JSON.stringify({
          event: "user",
          message: {
            content: params.prompt.map((p) => ({ type: "text", text: p.text })),
          },
        }) + "\n",
      );
    } else if (method === "session/cancel" || method === "session/close") {
      if (turn !== undefined) ok(turn, { stopReason: "cancelled" });
      turn = undefined;
      stop("Antigravity benchmark session closed");
      if (id !== undefined) ok(id, {});
    } else if (id !== undefined)
      reject(id, "Unsupported benchmark operation", -32601);
  }
  readLines(input, request, () => stop("Invalid benchmark request"));
  input.on("end", () => stop("Benchmark client disconnected"));
  return () => stop("Benchmark adapter stopped");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const stop = serve({
    argv: process.argv.slice(2),
    input: process.stdin,
    output: process.stdout,
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      stop();
      process.exit(0);
    });
}
