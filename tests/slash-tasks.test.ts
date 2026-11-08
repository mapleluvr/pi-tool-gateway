import test from "node:test";
import assert from "node:assert/strict";
import { controlRuntime, deferred, withSlash } from "./helpers/slash-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 40_000 };
const text = (notices: { text: string }[]) => notices.map((notice) => notice.text).join("\n");

function exitGate() {
  let resolve!: (result: { exitCode: number }) => void;
  const promise = new Promise<{ exitCode: number }>((done) => { resolve = done; });
  return { promise, resolve: () => resolve({ exitCode: 0 }) };
}

test("stop rejects even a unique task prefix without aborting the registered execution", windows, async () => {
  const exit = exitGate(); let signal: AbortSignal | undefined;
  await withSlash(async ({ call, command, pi }) => {
    const started = await call("bg_run", { command: "controlled executor waiting", name: "exact-target" });
    const id = started.details.taskId;
    try {
      const report = text(await command(`stop ${id.slice(0, 4)}`));
      assert.match(report, /完整.*taskId|unknown task|未知.*任务/i);
      assert.equal(signal?.aborted, false);
      assert.equal((await call("bg_status", { taskId: id })).details.status, "running");
      const completions = pi.commands.get("mxc").getArgumentCompletions("stop ");
      assert.ok(completions.some((item: any) => item.value === `stop ${id}`));
    } finally { exit.resolve(); await call("bg_join", { taskId: id, timeoutSeconds: 5 }); }
  }, (fixture) => ({ gateway: { enabled: true, runtimeFactory: async () => controlRuntime(fixture, {
    createExecutor() { return { candidate: fixture.options.candidate, exec(_command: string, _cwd: string, options: any) { signal = options.signal; return exit.promise; } }; },
  }) as any } }));
});

test("stop reports confirmed MXC completion only when the executor acknowledges cancellation", windows, async () => {
  await withSlash(async ({ call, command, statuses }) => {
    const started = await call("bg_run", { command: "controlled executor waiting", name: "acknowledged-stop" });
    try {
      const report = text(await command(`stop ${started.details.taskId}`));
      assert.match(report, /已退出|退出.*已确认/);
      assert.ok(report.includes(started.details.taskId));
      assert.ok(report.trim().split("\n").length <= 2, report);
      assert.doesNotMatch(report, /policyId:|Shell:|本次没有改变|下一步/);
      assert.equal((await call("bg_status", { taskId: started.details.taskId })).details.status, "killed");
      assert.match(statuses.at(-1)!, /MXC/);
    } finally { await call("bg_kill", { taskId: started.details.taskId }); await call("bg_join", { taskId: started.details.taskId, timeoutSeconds: 5 }); }
  }, (fixture) => ({ gateway: { enabled: true, runtimeFactory: async () => controlRuntime(fixture, {
    createExecutor() { return { candidate: fixture.options.candidate, exec(_command: string, _cwd: string, options: any) {
      return new Promise<{ exitCode: number }>((resolve) => options.signal.addEventListener("abort", () => resolve({ exitCode: 0 }), { once: true }));
    } }; },
  }) as any } }));
});

test("a stop timeout remains visible as running and exit unconfirmed", windows, async () => {
  const exit = exitGate();
  await withSlash(async ({ call, command }) => {
    const started = await call("bg_run", { command: "controlled executor waiting", name: "late-acknowledgement" });
    const id = started.details.taskId;
    try {
      const report = text(await command(`stop ${id}`));
      assert.match(report, /退出.*未确认|未确认.*退出/);
      assert.match(report, /\/mxc tasks/);
      assert.equal((await call("bg_status", { taskId: id })).details.status, "running");
      assert.ok(text(await command("tasks")).includes(id));
    } finally { exit.resolve(); await call("bg_join", { taskId: id, timeoutSeconds: 5 }); }
  }, (fixture) => ({ gateway: { enabled: true, runtimeFactory: async () => controlRuntime(fixture, {
    createExecutor() { return { candidate: fixture.options.candidate, exec() { return exit.promise; } }; },
  }) as any } }));
});

// Exercise the actual host pwsh executor, not a forged killed task snapshot.
test("Native killed records stay queryable without pretending to prove process exit", windows, async () => {
  await withSlash(async ({ call, command }) => {
    const started = await call("bg_run", { command: "Start-Sleep -Seconds 30", name: "native-stop-record" });
    const id = started.details.taskId;
    try {
      const report = text(await command(`stop ${id}`));
      assert.match(report, /退出.*未确认|未确认.*退出/);
      assert.match(report, /Native/);
      assert.equal((await call("bg_status", { taskId: id })).details.status, "killed");
      const listed = text(await command("tasks"));
      assert.ok(listed.includes(id)); assert.match(listed, /未确认/);
    } finally { await call("bg_kill", { taskId: id }); await call("bg_join", { taskId: id, timeoutSeconds: 5 }); }
  }, () => ({ gateway: { enabled: false } }));
});

test("turning on MXC identifies pre-existing Native tasks with a usable user stop command", windows, async () => {
  await withSlash(async ({ call, command }) => {
    const started = await call("bg_run", { command: "Start-Sleep -Seconds 30", name: "old-native-identity" });
    const id = started.details.taskId;
    try {
      const report = text(await command("on"));
      assert.ok(report.includes(id)); assert.match(report, /Native/);
      assert.ok(report.includes(`/mxc stop ${id}`));
      assert.doesNotMatch(report, /bg_kill|不迁移|不删除|policyId:/);
      assert.equal((await call("bg_status", { taskId: id })).details.execution.mode, "native");
    } finally { await call("bg_kill", { taskId: id }); await call("bg_join", { taskId: id, timeoutSeconds: 5 }); }
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("cancelling the task-menu confirmation leaves the execution running", windows, async () => {
  await withSlash(async ({ call, command, ctx }) => {
    const started = await call("bg_run", { command: "Start-Sleep -Seconds 30", name: "keep-on-cancel" });
    const id = started.details.taskId;
    try {
      ctx.ui.select = async (_title: string, values: string[]) => values.find((value) => value.includes(id));
      ctx.ui.confirm = async () => false;
      assert.match(text(await command("tasks")), /已取消/);
      assert.equal((await call("bg_status", { taskId: id })).details.status, "running");
    } finally { await call("bg_kill", { taskId: id }); await call("bg_join", { taskId: id, timeoutSeconds: 5 }); }
  }, () => ({ gateway: { enabled: false } }));
});

test("leaving the task query completes the query without requesting cancellation", windows, async () => {
  const exit = exitGate();
  await withSlash(async ({ call, command }) => {
    const started = await call("bg_run", { command: "controlled query target", name: "query-only" });
    const id = started.details.taskId;
    try {
      const report = await command("tasks");
      assert.match(report.at(-1)!.text, /完成.*MXC tasks/);
      assert.equal((await call("bg_status", { taskId: id })).details.status, "running");
    } finally { exit.resolve(); await call("bg_join", { taskId: id, timeoutSeconds: 5 }); }
  }, (fixture) => ({ gateway: { enabled: true, runtimeFactory: async () => controlRuntime(fixture, {
    createExecutor() { return { candidate: fixture.options.candidate, exec() { return exit.promise; } }; },
  }) as any } }));
});

test("a cancelled session cannot persist a choice from its old shell-selector dialog", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withSlash(async ({ pi, ctx, state, restart, widgets }) => {
    const before = state.read().selection;
    ctx.ui.select = async (_title: string, values: string[]) => { entered.resolve(); await release.promise; return values.find((value) => value.startsWith("pwsh7 ")); };
    const pending = pi.commands.get("bash-select").handler("", ctx);
    try {
      await entered.promise; await restart(); release.resolve(); await pending;
      assert.deepEqual(state.read().selection, before);
      assert.equal(widgets.size, 0);
    } finally { release.resolve(); await pending; }
  });
});
