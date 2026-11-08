import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { inspectProcess, sameProcess } from "./helpers/process-identity.ts";
import { createServer, createConnection } from "node:net";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createMxcRuntime } from "../src/mxc/runtime.ts";
import { createTaskRegistry } from "../src/registry.ts";
import { createBackendExecutor, killProcessTree } from "../src/operations.ts";
import { createMxcFixture } from "./helpers/mxc-fixture.ts";

const local = { skip: process.platform !== "win32" };
async function withRuntime(run: (runtime: Awaited<ReturnType<typeof createMxcRuntime>>, fixture: Awaited<ReturnType<typeof createMxcFixture>>) => Promise<void>) {
  const fixture = await createMxcFixture();
  let runtime: Awaited<ReturnType<typeof createMxcRuntime>> | undefined;
  try {
    runtime = await createMxcRuntime(fixture.options);
    await runtime.check();
    await run(runtime, fixture);
  } finally { await runtime?.dispose(); await fixture.cleanup(); }
}
async function until<T>(read: () => Promise<T | undefined>, budgetMs = 12_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the fixture's observable state");
}

test("a workspace junction cannot redirect real MXC reads/writes to the ungranted host sentinel", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    const alias = join(fixture.workspace, "outside-junction");
    await symlink(fixture.outside, alias, "junction");
    const target = join(alias, "sentinel.txt");
    assert.equal(await readFile(target, "utf8"), "OUTSIDE_CANARY\n", "The host must actually be able to follow this alias");
    await assert.rejects(runtime.executeFile("read", { path: target }), /EACCES|EPERM|denied|permission/i);
    await assert.rejects(runtime.executeFile("write", { path: target, content: "ESCAPED" }), /EACCES|EPERM|denied|permission/i);
    assert.equal(await readFile(join(fixture.outside, "sentinel.txt"), "utf8"), "OUTSIDE_CANARY\n");
  });
});

test("an exact deny under a renameable RW workspace is rejected as an ineffective protected layout", local, async () => {
  const fixture = await createMxcFixture();
  let runtime: Awaited<ReturnType<typeof createMxcRuntime>> | undefined;
  try {
    await assert.rejects(async () => {
      runtime = await createMxcRuntime({ ...fixture.options, deniedPaths: [join(fixture.workspace, "protected.txt")] });
    }, /denied|deny.*RW|rename|protected layout/i);
  } finally { await runtime?.dispose(); await fixture.cleanup(); }
});

test("a readonly alias pointing inside the RW workspace is rejected by its canonical location", local, async () => {
  const fixture = await createMxcFixture();
  let runtime: Awaited<ReturnType<typeof createMxcRuntime>> | undefined;
  try {
    const alias = join(fixture.dir, "readonly-alias");
    await symlink(fixture.workspace, alias, "junction");
    await assert.rejects(async () => { runtime = await createMxcRuntime({ ...fixture.options, readonlyPaths: [alias] }); }, /inside.*RW|protected layout/i);
  } finally { await runtime?.dispose(); await fixture.cleanup(); }
});

test("a denied future path through an alias of a RW ancestor is rejected before launch", local, async () => {
  const fixture = await createMxcFixture();
  let runtime: Awaited<ReturnType<typeof createMxcRuntime>> | undefined;
  try {
    const alias = join(fixture.dir, "denied-alias");
    await symlink(fixture.workspace, alias, "junction");
    await assert.rejects(async () => { runtime = await createMxcRuntime({ ...fixture.options, deniedPaths: [join(alias, "future.txt")] }); }, /deny|denied|rename|protected layout/i);
  } finally { await runtime?.dispose(); await fixture.cleanup(); }
});

test("private control material in the model-writable workspace is unavailable before a workload starts", local, async () => {
  const fixture = await createMxcFixture();
  try {
    await assert.rejects(createMxcRuntime({ ...fixture.options, scratchRoot: join(fixture.workspace, "control") }), /outside.*RW|control materials/i);
  } finally { await fixture.cleanup(); }
});

test("real MXC network denial blocks a reachable host loopback listener", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    let connections = 0;
    const server = createServer((socket) => { connections++; socket.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(address.port, "127.0.0.1");
        socket.once("connect", () => { socket.end(); resolve(); }); socket.once("error", reject);
      });
      assert.equal(connections, 1, "The host listener/control must be functional");
      const command = `$client=[System.Net.Sockets.TcpClient]::new(); try { $task=$client.ConnectAsync('127.0.0.1',${address.port}); if (-not $task.Wait(1200)) { throw 'blocked timeout' }; Write-Output 'UNEXPECTED_NETWORK_ACCESS'; exit 91 } catch { Write-Output 'MXC_NETWORK_DENIED' } finally { $client.Dispose() }`;
      let controlOutput = "";
      const control = await createBackendExecutor(runtime.candidate).exec(command, fixture.workspace, {
        onData: (data) => { controlOutput += data.toString("utf8"); },
      });
      assert.equal(control.exitCode, 91, controlOutput);
      assert.match(controlOutput, /UNEXPECTED_NETWORK_ACCESS/);
      assert.equal(connections, 2, "The same native PowerShell/TcpClient must connect successfully");
      let output = "";
      const result = await runtime.createExecutor().exec(command, fixture.workspace, {
        onData: (data) => { output += data.toString("utf8"); },
      });
      assert.equal(result.exitCode, 0, output);
      assert.match(output, /MXC_NETWORK_DENIED/);
      assert.doesNotMatch(output, /UNEXPECTED_NETWORK_ACCESS/);
      assert.equal(connections, 2);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

test("real bg_kill reaps the MXC PowerShell PID and leaves an unrelated same-image process alive", { ...local, timeout: 25_000 }, async () => {
  await withRuntime(async (runtime, fixture) => {
    const logs = join(fixture.dir, "task-logs");
    await mkdir(logs);
    const registry = createTaskRegistry({ dir: logs, executor: runtime.createExecutor() });
    const env = { SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", HOME: fixture.dir, USERPROFILE: fixture.dir, LOCALAPPDATA: fixture.dir, TEMP: fixture.dir, TMP: fixture.dir };
    const unrelated = spawn(runtime.candidate.path, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { env, stdio: "ignore", windowsHide: true });
    const unrelatedClosed = new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
    try {
      assert.ok(unrelated.pid);
      const task = await registry.start("Write-Output ('MXC_OWNED_PID=' + $PID); [Console]::Out.Flush(); while ($true) { Start-Sleep -Milliseconds 100 }", {
        cwd: fixture.workspace,
        execution: { mode: "mxc", shellPath: runtime.candidate.path, workspace: fixture.workspace, policyId: runtime.policyId },
      });
      const ownedPid = await until(async () => {
        const match = (await registry.logs(task.id)).match(/MXC_OWNED_PID=(\d+)\r?\n/);
        return match ? Number(match[1]) : undefined;
      });
      const before = inspectProcess(runtime.candidate.path, ownedPid, env);
      const unrelatedBefore = inspectProcess(runtime.candidate.path, unrelated.pid, env);
      assert.ok(before.observed); assert.ok(unrelatedBefore.observed);
      const stopped = await registry.kill(task.id);
      assert.equal(stopped.status, "killed");
      assert.equal(stopped.executionError, undefined);
      assert.equal(sameProcess(before.observed, inspectProcess(runtime.candidate.path, ownedPid, env).observed), false, "Logical killed is not enough: the original PowerShell identity must be gone");
      assert.equal(sameProcess(unrelatedBefore.observed, inspectProcess(runtime.candidate.path, unrelated.pid, env).observed), true, "The original unrelated process must survive");
    } finally {
      registry.dispose(); killProcessTree(unrelated); await unrelatedClosed;
    }
  });
});
