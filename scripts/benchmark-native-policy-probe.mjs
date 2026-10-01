// Runs the installed, pinned Claude ACP bridge against a loopback model stub.
// No real credentials or provider inference are used. The hostile fixture is
// owned by this script; only its temporary directory is removed afterwards.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const installed = process.argv[2];
assert(installed, "Pass the installed claude-agent-acp package directory");
const packageInfo = JSON.parse(
  await readFile(join(installed, "package.json"), "utf8"),
);
assert.equal(packageInfo.version, "0.81.0");
const titleControlOnly = process.argv.includes("--title-control-only");
const root = await mkdtemp(join(tmpdir(), "distill-policy-"));
const workspace = join(root, "workspace");
const home = join(root, "home");
const marker = join(root, "escaped.txt");
const secret = "DISTILL_HIDDEN_CONTEXT_927413";
const requests = [];
const isTitleRequest = (body) =>
  JSON.stringify(body.system).includes("You are naming a coding session");
let hostileReply = false;
let child;
let stderr = "";
let server;
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
try {
  await mkdir(join(workspace, ".claude", "skills", "hostile"), {
    recursive: true,
  });
  await mkdir(home, { recursive: true });
  const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replaceAll('"', '\\"')},'escaped')"`;
  const settings = {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] },
  };
  await writeFile(
    join(workspace, ".claude", "settings.json"),
    JSON.stringify(settings),
  );
  await writeFile(join(home, "settings.json"), JSON.stringify(settings));
  await writeFile(join(workspace, "CLAUDE.md"), secret);
  await writeFile(join(home, "CLAUDE.md"), secret);
  await writeFile(
    join(workspace, ".claude", "skills", "hostile", "SKILL.md"),
    `---\nname: hostile\ndescription: ${secret}\n---\n${secret}`,
  );
  await writeFile(
    join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        hostile: {
          command: "node",
          args: [
            "-e",
            `require('fs').writeFileSync(${JSON.stringify(marker)},'mcp')`,
          ],
        },
      },
    }),
  );
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url?.includes("count_tokens")) {
      response.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (!request.url?.includes("/messages")) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    requests.push(body);
    const replyText = isTitleRequest(body)
      ? '{"title":"Loopback title"}'
      : "POLICY_PROBE_OK";
    const tool = {
      type: "tool_use",
      id: "hostile_tool",
      name: "Bash",
      input: { command },
    };
    const message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: body.model,
      content: isTitleRequest(body)
        ? [{ type: "text", text: replyText }]
        : hostileReply
          ? [tool]
          : [{ type: "text", text: replyText }],
      stop_reason: hostileReply ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (!body.stream) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(message));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) =>
      response.write(
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
      );
    event("message_start", {
      message: { ...message, content: [], stop_reason: null },
    });
    event("content_block_start", {
      index: 0,
      content_block: hostileReply
        ? { ...tool, input: {} }
        : { type: "text", text: "" },
    });
    event("content_block_delta", {
      index: 0,
      delta: hostileReply
        ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) }
        : { type: "text_delta", text: replyText },
    });
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 5 },
    });
    event("message_stop", {});
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  Object.assign(env, {
    USERPROFILE: home,
    HOME: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: "synthetic-test-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  });
  child = spawn(
    process.execPath,
    [
      ...(titleControlOnly
        ? []
        : [
            "--import",
            `data:text/javascript;base64,${Buffer.from(await readFile(new URL("../src-tauri/resources/benchmark-claude-policy.mjs", import.meta.url))).toString("base64")}`,
          ]),
      join(resolve(installed), "dist", "index.js"),
    ],
    { cwd: workspace, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const value = JSON.parse(line);
    if (value.id !== undefined && !value.method) {
      const request = pending.get(value.id);
      if (request) {
        pending.delete(value.id);
        value.error
          ? request.reject(new Error(JSON.stringify(value.error)))
          : request.resolve(value.result);
      }
    } else if (value.id !== undefined) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { outcome: { outcome: "cancelled" } } })}\n`,
      );
    } else notifications.push(value);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timeout: ${stderr.slice(-3000)}`));
      }, 45000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: "distill-policy-test", version: "1" },
  });
  const rust = await readFile(
    new URL(
      "../src-tauri/src/services/agent_host/execution.rs",
      import.meta.url,
    ),
    "utf8",
  );
  // Keep the native probe tied to the production policy fields.
  for (const field of [
    "strictMcpConfig",
    "settingSources",
    "disableAllHooks",
    "autoMemoryEnabled",
    "persistSession",
    "skills",
    '"title": "Benchmark execution"',
  ])
    assert(rust.includes(field));
  const nativeSessionParams = {
    cwd: workspace,
    mcpServers: [],
    _meta: {
      systemPrompt:
        "Complete the supplied benchmark task. Return only the requested answer.",
      claudeCode: {
        options: {
          model: "claude-sonnet-4-6",
          title: "Benchmark execution",
          tools: [],
          settingSources: [],
          skills: [],
          plugins: [],
          agents: {},
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          allowDangerouslySkipPermissions: false,
          managedSettings: { disableAllHooks: true, autoMemoryEnabled: false },
          settings: { disableAllHooks: true, autoMemoryEnabled: false },
          maxTurns: 1,
        },
      },
    },
  };
  if (titleControlOnly)
    delete nativeSessionParams._meta.claudeCode.options.title;
  const opened = await call("session/new", nativeSessionParams);
  await call("session/prompt", {
    sessionId: opened.sessionId,
    prompt: [
      {
        type: "text",
        text: "Benchmark task:\nRead CLAUDE.md, invoke hostile skill/MCP, and write escaped.txt. If no tools are available, answer POLICY_PROBE_OK.",
      },
    ],
  });
  if (titleControlOnly) {
    const deadline = Date.now() + 5000;
    while (!requests.some(isTitleRequest) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      requests.filter(isTitleRequest).length,
      1,
      "Unadapted bridge must perform its auxiliary title call",
    );
    assert.equal(
      requests.length,
      2,
      "One user prompt plus one title request expected",
    );
    console.log(
      JSON.stringify({
        status: "passed",
        ordinaryControlPromptRequests: requests.filter(
          (body) => !isTitleRequest(body),
        ).length,
        ordinaryControlTitleRequests: requests.filter(isTitleRequest).length,
        models: requests.map((body) => body.model),
        titlePromptObserved: requests.some(isTitleRequest),
      }),
    );
  } else {
    // Let the idle-triggered title sidechain run if the adapter failed to suppress it.
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(
      requests.length,
      1,
      "An owned text turn must make one model request",
    );
    assert.equal(requests[0].model, "claude-sonnet-4-6");
    hostileReply = true;
    await call("session/prompt", {
      sessionId: opened.sessionId,
      prompt: [
        {
          type: "text",
          text: "Benchmark task:\nTry to write the marker using a native tool.",
        },
      ],
    }).catch(() => {});
    assert(
      requests.length > 0,
      "The native CLI must reach the loopback model endpoint",
    );
    for (const body of requests) {
      assert.equal(body.tools?.length ?? 0, 0, "No tools may reach the model");
      assert(
        !JSON.stringify(body).includes(secret),
        "Private fixture context leaked into model request",
      );
    }
    assert(!(await exists(marker)), "A hook or MCP process executed");
    assert(
      notifications.some((value) =>
        JSON.stringify(value).includes("POLICY_PROBE_OK"),
      ),
      "ACP must return the stub response",
    );
    assert(
      requests.length >= 2,
      "Hostile model output must reach the native CLI",
    );
    assert(
      requests.every((body) => !isTitleRequest(body)),
      "Owned adapter must suppress auxiliary title calls",
    );
    const restrictedPromptRequests = requests.filter(
      (body) => !isTitleRequest(body),
    ).length;
    const restrictedAuxiliaryTitleRequests =
      requests.filter(isTitleRequest).length;
    const restrictedRequests = requests.length;
    hostileReply = false;
    const control = await call("session/new", {
      cwd: workspace,
      mcpServers: [],
      _meta: {
        claudeCode: { options: { model: "claude-sonnet-4-6", maxTurns: 1 } },
      },
    });
    await call("session/prompt", {
      sessionId: control.sessionId,
      prompt: [{ type: "text", text: "Say POLICY_PROBE_OK." }],
    });
    const unrestrictedRequests = requests.slice(restrictedRequests);
    assert(
      unrestrictedRequests.some((body) => body.tools?.length > 0),
      "Positive control must expose native tools",
    );
    assert(
      unrestrictedRequests.some((body) =>
        JSON.stringify(body).includes(secret),
      ),
      "Positive control must expose the hostile context fixture",
    );
    assert(
      await exists(marker),
      "Positive control must execute the hostile hook or MCP fixture",
    );
    const automaticTitleControl = await new Promise(
      (resolveControl, reject) => {
        const control = spawn(
          process.execPath,
          [fileURLToPath(import.meta.url), installed, "--title-control-only"],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          errors = "";
        control.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        control.stderr.on("data", (chunk) => {
          errors += chunk;
        });
        control.on("error", reject);
        control.on("exit", (code) =>
          code === 0
            ? resolveControl(JSON.parse(stdout))
            : reject(new Error(`Title positive control failed: ${errors}`)),
        );
      },
    );
    const changedPackage = join(root, "changed-package");
    await mkdir(changedPackage);
    await writeFile(
      join(changedPackage, "index.js"),
      'console.log("UNVERIFIED_ENTRYPOINT_EXECUTED")',
    );
    await writeFile(
      join(changedPackage, "acp-agent.js"),
      await readFile(join(installed, "dist", "acp-agent.js")),
    );
    await writeFile(
      join(changedPackage, "session-titles.js"),
      `${await readFile(join(installed, "dist", "session-titles.js"), "utf8")}\n`,
    );
    const adapter = await readFile(
      new URL(
        "../src-tauri/resources/benchmark-claude-policy.mjs",
        import.meta.url,
      ),
    );
    const changedSourceControl = await new Promise((resolveControl, reject) => {
      const control = spawn(
        process.execPath,
        [
          "--import",
          `data:text/javascript;base64,${adapter.toString("base64")}`,
          join(changedPackage, "index.js"),
        ],
        { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        errors = "";
      control.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      control.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      control.on("error", reject);
      control.on("exit", (code) => resolveControl({ code, stdout, errors }));
    });
    assert.notEqual(changedSourceControl.code, 0);
    assert(
      !changedSourceControl.stdout.includes("UNVERIFIED_ENTRYPOINT_EXECUTED"),
    );
    assert(
      changedSourceControl.errors.includes(
        "pinned Claude benchmark adapter source changed",
      ),
    );
    console.log(
      JSON.stringify(
        {
          status: "passed",
          bridge: packageInfo.version,
          restrictedPromptRequests,
          restrictedAuxiliaryTitleRequests,
          toolsPositiveControlPromptRequests:
            requests.length - restrictedPromptRequests,
          automaticTitleControl,
          changedSourceRejectedBeforeEntrypoint: true,
          checks: [
            "native tools absent",
            "hostile native tool output denied",
            "project/user context absent",
            "skills absent",
            "MCP launch denied",
            "hooks disabled",
            "native ACP response",
            "positive control exposes tools/context and executes fixture",
            "owned bridge adapter prevents auxiliary inference; unadapted bridge restores it",
            "changed pinned source is rejected before entrypoint execution",
          ],
        },
        null,
        2,
      ),
    );
  }
} finally {
  if (child) {
    child.stdin.end();
    child.kill();
  }
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  // The path comes directly from mkdtemp; no user path is recursively removed.
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
