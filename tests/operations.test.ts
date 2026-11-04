import test from "node:test";
import assert from "node:assert/strict";
import {
  createBackendExecutor,
  createExecutionEnv,
  spawnArguments,
} from "../src/operations.ts";
import type { BackendCandidate } from "../src/backends.ts";

const nodeCandidate: BackendCandidate = {
  id: "custom",
  kind: "bash",
  label: "Node test executor",
  path: process.execPath,
  args: ["-e"],
  commandTransport: "argv",
};

test("spawn arguments preserve Bash argv, legacy stdin, and PowerShell command transport", () => {
  assert.deepEqual(
    spawnArguments(
      {
        id: "gitbash",
        kind: "bash",
        label: "Git Bash",
        path: "C:\\Git\\bin\\bash.exe",
        args: ["-c"],
        commandTransport: "argv",
      },
      "printf '%s' ok",
    ),
    { args: ["-c", "printf '%s' ok"] },
  );
  assert.deepEqual(
    spawnArguments(
      {
        id: "custom",
        kind: "bash",
        label: "legacy WSL Bash",
        path: "C:\\Windows\\System32\\bash.exe",
        args: ["-s"],
        commandTransport: "stdin",
      },
      "printf '%s' ok",
    ),
    { args: ["-s"], stdin: "printf '%s' ok" },
  );
  const powershell = spawnArguments(
    {
      id: "pwsh7",
      kind: "powershell",
      label: "PowerShell 7",
      path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
      commandTransport: "argv",
    },
    "$PSVersionTable.PSVersion.ToString()",
  );
  assert.deepEqual(powershell.args.slice(0, -1), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  assert.match(powershell.args.at(-1) ?? "", /OutputEncoding/);
  assert.match(powershell.args.at(-1) ?? "", /PSVersionTable/);
});
test("explicit executor runs the selected executable without a shell wrapper", async () => {
  const executor = createBackendExecutor(nodeCandidate);
  const chunks: Buffer[] = [];
  const result = await executor.exec(
    "process.stdout.write('direct-executable')",
    process.cwd(),
    { onData: (chunk) => chunks.push(chunk) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(Buffer.concat(chunks).toString(), "direct-executable");
});

test("aborting an executor kills the running process tree", async () => {
  const executor = createBackendExecutor(nodeCandidate);
  const controller = new AbortController();
  const pending = executor.exec("setInterval(() => {}, 1000)", process.cwd(), {
    onData: () => undefined,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  assert.equal(result.exitCode, null);
});

test("aborting an executor kills a descendant even when taskkill is not on PATH", async () => {
  if (process.platform !== "win32") return;
  const executor = createBackendExecutor(nodeCandidate);
  const controller = new AbortController();
  let descendantPid: number | undefined;
  const originalPath = process.env.PATH;
  const pending = executor.exec(
    "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000)",
    process.cwd(),
    {
      onData: (chunk) => {
        const match = chunk.toString().match(/(?:^|\s)(\d+)(?:\s|$)/);
        if (match) descendantPid = Number(match[1]);
      },
      signal: controller.signal,
    },
  );
  try {
    const deadline = Date.now() + 2000;
    while (!descendantPid && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(descendantPid, "descendant PID was not reported");
    process.env.PATH = process.cwd();
    controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, null);
    const killDeadline = Date.now() + 2000;
    let alive = true;
    while (alive && Date.now() < killDeadline) {
      try {
        process.kill(descendantPid!, 0);
      } catch {
        alive = false;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(alive, false, `descendant ${descendantPid} survived abort`);
  } finally {
    process.env.PATH = originalPath;
  }
});
test("execution environment prefixes the Pi bin directory and exposes session metadata", () => {
  const env = createExecutionEnv(
    {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => "C:\\sessions\\session.jsonl",
      },
      model: { provider: "provider-1", id: "model-1" },
      thinkingLevel: "high",
    },
    {
      PATH: "C:\\tools",
      PI_SESSION_ID: "stale-session",
      PI_MODEL: "stale-model",
    },
  );
  assert.match(env.PATH ?? "", /(?:^|[;:])[^;:]+[\\/]bin(?:[;:]|$)/i);
  assert.equal(env.PI_SESSION_ID, "session-1");
  assert.equal(env.PI_SESSION_FILE, "C:\\sessions\\session.jsonl");
  assert.equal(env.PI_PROVIDER, "provider-1");
  assert.equal(env.PI_MODEL, "model-1");
  assert.equal(env.PI_REASONING_LEVEL, "high");
  assert.equal(env.PYTHONUNBUFFERED, "1");
});
