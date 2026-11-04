import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackendExecutor } from "../src/operations.ts";
import { createTaskRegistry, formatCreated } from "../src/registry.ts";
import { runBash } from "../src/exec.ts";

async function withRegistry(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const nodeExecutor = createBackendExecutor({
  id: "custom",
  kind: "bash",
  label: "Node test executor",
  path: process.execPath,
  args: ["-e"],
  commandTransport: "argv",
});

function createTestRegistry(dir: string) {
  return createTaskRegistry({ dir, executor: nodeExecutor });
}

test("bg_run entry returns 'background task created' with task id", async () => {
  await withRegistry(async (dir) => {
    const registry = createTestRegistry(dir);
    try {
      const task = await registry.start("setTimeout(()=>{},5000)", {
        cwd: dir,
        name: "sleeper",
      });
      const text = formatCreated(task);
      assert.match(text, /background task created/);
      assert.match(text, new RegExp(task.id));
      assert.equal(task.status, "running");
      await registry.kill(task.id);
    } finally {
      registry.dispose();
    }
  });
});

test("slow bash converts to background after threshold", async () => {
  await withRegistry(async (dir) => {
    const registry = createTestRegistry(dir);
    try {
      const result = await runBash(
        registry,
        "setTimeout(()=>console.log('slow-done'),1500)",
        {
          cwd: dir,
          thresholdMs: 200,
        },
      );
      assert.equal(result.background, true);
      assert.match(result.text, /background task created/);
      assert.ok(result.taskId);
      const done = await registry.waitFor(result.taskId, 8000);
      assert.equal(done.status, "done");
      const logs = await registry.logs(result.taskId);
      assert.match(logs, /slow-done/);
    } finally {
      registry.dispose();
    }
  });
});

test("fast bash stays foreground without background marker", async () => {
  await withRegistry(async (dir) => {
    const registry = createTestRegistry(dir);
    try {
      const result = await runBash(registry, "console.log('hi-foreground')", {
        cwd: dir,
        thresholdMs: 5000,
      });
      assert.equal(result.background, false);
      assert.equal(result.taskId, undefined);
      assert.match(result.text, /hi-foreground/);
      assert.doesNotMatch(result.text, /background task created/);
    } finally {
      registry.dispose();
    }
  });
});

test("aborting a slow bash kills the task instead of leaking it", async () => {
  await withRegistry(async (dir) => {
    const registry = createTestRegistry(dir);
    try {
      const controller = new AbortController();
      const pending = runBash(
        registry,
        "setTimeout(()=>console.log('never'),30000)",
        {
          cwd: dir,
          thresholdMs: 5000,
          signal: controller.signal,
        },
      );
      setTimeout(() => controller.abort(), 200);
      await assert.rejects(pending, /aborted/i);
      const tasks = registry.list();
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].status, "killed");
    } finally {
      registry.dispose();
    }
  });
});

test("node output streams to bg_logs while the task is still running", async () => {
  await withRegistry(async (dir) => {
    const registry = createTestRegistry(dir);
    try {
      const task = await registry.start(
        "console.log('early-line'); setTimeout(()=>{},30000)",
        { cwd: dir, name: "node-stream" },
      );
      await new Promise((r) => setTimeout(r, 200));
      const logs = await registry.logs(task.id);
      assert.match(logs, /early-line/);
      await registry.kill(task.id);
    } finally {
      registry.dispose();
    }
  });
});

test("runBash can supply the selected executor per task", async () => {
  await withRegistry(async (dir) => {
    const registry = createTaskRegistry({ dir });
    try {
      const result = await runBash(registry, "console.log('per-task')", {
        cwd: dir,
        thresholdMs: 5000,
        executor: nodeExecutor,
      });
      assert.equal(result.background, false);
      assert.match(result.text, /per-task/);
    } finally {
      registry.dispose();
    }
  });
});
test("foreground reports a backend spawn failure instead of succeeding with null exit code", async () => {
  await withRegistry(async (dir) => {
    const registry = createTaskRegistry({ dir });
    const missingExecutor = createBackendExecutor({
      id: "custom",
      kind: "bash",
      label: "missing executor",
      path: join(dir, "missing-shell.exe"),
      args: ["-c"],
      commandTransport: "argv",
    });
    try {
      await assert.rejects(
        runBash(registry, "echo never", {
          cwd: dir,
          thresholdMs: 5000,
          executor: missingExecutor,
        }),
        /spawn error|ENOENT|not found/i,
      );
    } finally {
      registry.dispose();
    }
  });
});
test("foreground preserves a nonzero exit code from the selected executor", async () => {
  await withRegistry(async (dir) => {
    const registry = createTestRegistry(dir);
    try {
      const result = await runBash(registry, "process.exitCode=7", {
        cwd: dir,
        thresholdMs: 5000,
      });
      assert.equal(result.background, false);
      assert.equal(result.exitCode, 7);
    } finally {
      registry.dispose();
    }
  });
});

test("bg_status / bg_logs / bg_kill organize tasks naturally", async () => {
  await withRegistry(async (dir) => {
    const registry = createTestRegistry(dir);
    try {
      const task = await registry.start(
        "setTimeout(()=>console.log('tick'),30000)",
        {
          cwd: dir,
          name: "long",
        },
      );
      const listed = registry.list();
      assert.ok(listed.some((t) => t.id === task.id && t.status === "running"));
      const killed = await registry.kill(task.id);
      assert.equal(killed.status, "killed");
      const after = registry.get(task.id);
      assert.equal(after.status, "killed");
    } finally {
      registry.dispose();
    }
  });
});
