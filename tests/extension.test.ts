import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../index.ts";
import type { BackendCandidate } from "../src/backends.ts";
import { createBackendStateStore } from "../src/state.ts";

function fakePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  return {
    tools,
    handlers,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerEntryRenderer() {},
    registerFlag() {},
    getFlag() { return undefined; },
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
  };
}

const testBackend: BackendCandidate = {
  id: "gitbash",
  kind: "bash",
  label: "Git Bash (test executor)",
  path: process.execPath,
  args: ["-e"],
  commandTransport: "argv",
};

async function setupExtension(pi: any, dir: string): Promise<void> {
  createExtension(pi, {
    stateStore: createBackendStateStore({
      statePath: join(dir, "pi-bash-bg.json"),
    }),
    discoverBackends: () => [testBackend],
    outputDir: join(dir, "logs"),
  });
}

test("registers bash override plus bg_run/bg_status/bg_logs/bg_kill/bg_join", async () => {
  const pi: any = fakePi();
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
  try {
    await setupExtension(pi, dir);
    for (const name of [
      "bash",
      "bg_run",
      "bg_status",
      "bg_logs",
      "bg_kill",
      "bg_join",
    ]) {
      assert.ok(pi.tools.has(name), `missing tool: ${name}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash override cuts slow commands to background with task id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
  try {
    const pi: any = fakePi();
    await setupExtension(pi, dir);
    const bash = pi.tools.get("bash");
    const ctx: any = { cwd: dir };
    const result: any = await bash.execute(
      "call_1",
      {
        command: "setTimeout(()=>console.log('slow-done'),1500)",
        timeout: 1,
      },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text as string;
    assert.match(text, /background task created/);
    assert.match(text, /taskId: [0-9a-f]+/);
    assert.ok(result.details?.taskId);

    const bgLogs = pi.tools.get("bg_logs");
    let logs = "";
    for (let i = 0; i < 40; i++) {
      const out: any = await bgLogs.execute(
        "call_2",
        { taskId: result.details.taskId },
        undefined,
        undefined,
        ctx,
      );
      logs = out.content[0].text as string;
      if (/slow-done/.test(logs)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.match(logs, /slow-done/);

    const bgKill = pi.tools.get("bg_kill");
    await bgKill.execute(
      "call_3",
      { taskId: result.details.taskId },
      undefined,
      undefined,
      ctx,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bash override keeps fast commands in the foreground", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
  try {
    const pi: any = fakePi();
    await setupExtension(pi, dir);
    const bash = pi.tools.get("bash");
    const ctx: any = { cwd: dir };
    const result: any = await bash.execute(
      "call_1",
      { command: "console.log('hi-fg')", timeout: 30 },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text as string;
    assert.match(text, /hi-fg/);
    assert.doesNotMatch(text, /background task created/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bg_join blocks until the task finishes and shows its tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
  try {
    const pi: any = fakePi();
    await setupExtension(pi, dir);
    const ctx: any = { cwd: dir };
    const launched: any = await pi.tools.get("bg_run").execute(
      "call_1",
      {
        command: "setTimeout(()=>console.log('waited-output'),500)",
        name: "wait-me",
      },
      undefined,
      undefined,
      ctx,
    );
    const taskId = launched.details.taskId as string;
    const waited: any = await pi.tools
      .get("bg_join")
      .execute(
        "call_2",
        { taskId, timeoutSeconds: 10 },
        undefined,
        undefined,
        ctx,
      );
    const text = waited.content[0].text as string;
    assert.match(text, /status: done/);
    assert.match(text, /waited-output/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bg_join reports still running instead of hanging past its timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
  try {
    const pi: any = fakePi();
    await setupExtension(pi, dir);
    const ctx: any = { cwd: dir };
    const launched: any = await pi.tools.get("bg_run").execute(
      "call_1",
      {
        command: "setTimeout(()=>{},30000)",
        name: "long",
      },
      undefined,
      undefined,
      ctx,
    );
    const taskId = launched.details.taskId as string;
    const waited: any = await pi.tools
      .get("bg_join")
      .execute(
        "call_2",
        { taskId, timeoutSeconds: 1 },
        undefined,
        undefined,
        ctx,
      );
    assert.match(waited.content[0].text as string, /still running/);
    await pi.tools
      .get("bg_kill")
      .execute("call_3", { taskId }, undefined, undefined, ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bg_join requires an explicit timeoutSeconds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
  try {
    const pi: any = fakePi();
    await setupExtension(pi, dir);
    const ctx: any = { cwd: dir };
    const launched: any = await pi.tools.get("bg_run").execute(
      "call_1",
      {
        command: "setTimeout(()=>{},30000)",
        name: "long",
      },
      undefined,
      undefined,
      ctx,
    );
    const taskId = launched.details.taskId as string;
    await assert.rejects(
      pi.tools
        .get("bg_join")
        .execute("call_2", { taskId }, undefined, undefined, ctx),
      /timeoutSeconds is required/,
    );
    await pi.tools
      .get("bg_kill")
      .execute("call_3", { taskId }, undefined, undefined, ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aborting bg_join stops waiting but leaves the task running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-ext-"));
  try {
    const pi: any = fakePi();
    await setupExtension(pi, dir);
    const ctx: any = { cwd: dir };
    const launched: any = await pi.tools.get("bg_run").execute(
      "call_1",
      {
        command: "setTimeout(()=>{},30000)",
        name: "long",
      },
      undefined,
      undefined,
      ctx,
    );
    const taskId = launched.details.taskId as string;
    const controller = new AbortController();
    const pending = pi.tools
      .get("bg_join")
      .execute(
        "call_2",
        { taskId, timeoutSeconds: 30 },
        controller.signal,
        undefined,
        ctx,
      );
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(pending, /aborted/i);
    const status: any = await pi.tools
      .get("bg_status")
      .execute("call_3", { taskId }, undefined, undefined, ctx);
    assert.match(status.content[0].text as string, /status: running/);
    await pi.tools
      .get("bg_kill")
      .execute("call_4", { taskId }, undefined, undefined, ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
