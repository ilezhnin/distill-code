import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { serve } from "../src-tauri/resources/benchmark-antigravity-acp.mjs";

function fixture() {
  const input = new PassThrough();
  const frames = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true;
    },
  });
  const prompts = [];
  child.stdin.on("data", (b) => prompts.push(JSON.parse(b)));
  const send = (id, method, params) =>
    input.write(JSON.stringify({ id, method, params }) + "\n");
  const emit = (event) => child.stdout.write(JSON.stringify(event) + "\n");
  serve({
    argv: ["--model", "test-google-model", "--effort", "high"],
    input,
    launch(bin, args, opts) {
      assert.equal(bin, "/opt/distill-tools/antigravity/agy");
      assert.equal(opts.cwd, "/workspace");
      assert.deepEqual(args.slice(0, 4), [
        "--agent",
        "flock-benchmark",
        "--model",
        "test-google-model-high",
      ]);
      return child;
    },
    output: {
      write(line) {
        frames.push(JSON.parse(line));
      },
    },
  });
  send(1, "initialize", { protocolVersion: 1 });
  send(2, "session/new", { cwd: "/workspace", mcpServers: [] });
  const init = (agent = "flock-benchmark", model = "test-google-model-high") =>
    emit({
      event: "init",
      conversation_id: "session",
      init: { agent, cwd: "/workspace", model },
    });
  const prompt = (id = 3) =>
    send(id, "session/prompt", {
      sessionId: "session",
      prompt: [{ type: "text", text: "A\nB" }],
    });
  return { child, input, frames, prompts, send, emit, init, prompt };
}

test("repository prompt waits for the named agent, reports activity and reconciles the final usage", () => {
  const f = fixture();
  assert.equal(f.frames.length, 1);
  f.init();
  assert.equal(f.frames.at(-1).result.configOptions[1].currentValue, "high");
  f.prompt();
  f.prompt(4);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].message.content[0].text, "A\nB");
  assert.equal(f.frames.at(-1).error.code, -32602);
  f.emit({
    event: "step_update",
    step_update: {
      conversation_id: "session",
      step_type: "tool",
      step_index: 1,
      tool_name: "read_file",
      state: "DONE",
    },
  });
  assert.equal(f.frames.at(-1).params.update.kind, "read");
  f.emit({
    event: "result",
    result: {
      status: "SUCCESS",
      num_turns: 1,
      conversation_id: "session",
      response: "answer",
      usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
    },
  });
  assert.equal(f.frames.at(-2).params.update.content.text, "answer");
  assert.equal(f.frames.at(-1).result.usage.totalTokens, 8);
  f.input.end();
});

test("a missing custom agent prevents transmission of the task", () => {
  const f = fixture();
  f.init("default");
  f.prompt();
  assert.equal(f.child.killed, true);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.frames.find((v) => v.id === 2).error.code, -32603);
  f.input.end();
});

test("an unavailable tool can fail, but a completed tool must belong to the profile", () => {
  const f = fixture();
  f.init();
  f.prompt();
  const step = {
    conversation_id: "session",
    step_type: "tool",
    step_index: 1,
    tool_name: "unregistered_tool",
  };
  f.emit({ event: "step_update", step_update: { ...step, state: "ERROR" } });
  assert.equal(f.frames.at(-1).params.update.status, "failed");
  assert.equal(f.child.killed, false);
  f.emit({ event: "step_update", step_update: { ...step, state: "DONE" } });
  assert.equal(f.frames.at(-1).error.code, -32603);
  assert.equal(f.child.killed, true);
  f.input.end();
});

test("a rejected effort fails session creation before the first turn", () => {
  const f = fixture();
  f.emit({ event: "result", result: { status: "ERROR", num_turns: 0 } });
  assert.match(f.frames.at(-1).error.message, /capability_missing/);
  assert.equal(f.child.killed, true);
  assert.equal(f.prompts.length, 0);
  f.input.end();
});

test("an acknowledgement of the base model cannot attest a requested effort", () => {
  const f = fixture();
  f.init("flock-benchmark", "test-google-model");
  f.prompt();
  assert.equal(f.child.killed, true);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.frames.find((v) => v.id === 2).error.code, -32603);
  f.input.end();
});

test("an unfinished tool call prevents capturing a successful answer", () => {
  const f = fixture();
  f.init();
  f.prompt();
  f.emit({
    event: "step_update",
    step_update: {
      conversation_id: "session",
      step_type: "tool",
      step_index: 1,
      tool_name: "read_file",
      state: "ACTIVE",
    },
  });
  f.emit({
    event: "result",
    result: {
      status: "SUCCESS",
      conversation_id: "session",
      response: "answer",
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  assert.equal(f.frames.at(-1).error.code, -32603);
  assert.equal(f.child.killed, true);
  f.input.end();
});

test("cancel ends the running CLI and returns exactly one cancelled prompt result", () => {
  const f = fixture();
  f.init();
  f.prompt();
  f.send(undefined, "session/cancel", { sessionId: "session" });
  f.child.emit("close", null, "SIGKILL");
  assert.equal(f.child.killed, true);
  assert.deepEqual(
    f.frames.filter((r) => r.id === 3).map((r) => r.result.stopReason),
    ["cancelled"],
  );
  f.input.end();
});
