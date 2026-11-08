import test from "node:test";
import assert from "node:assert/strict";
import { controlRuntime, deferred, withSlash } from "./helpers/slash-fixture.ts";
import { pwsh } from "./helpers/mxc-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const text = (notices: { text: string }[]) => notices.map((notice) => notice.text).join("\n");

test("an old Shell dialog cannot overwrite a newer saved choice in the same session", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withSlash(async ({ pi, ctx, state, notices }) => {
    ctx.ui.select = async (_title: string, values: string[]) => {
      entered.resolve(); await release.promise;
      return values.find((value) => value.startsWith("pwsh7 "));
    };
    const old = pi.commands.get("bash-select").handler("", ctx);
    try {
      await entered.promise;
      await pi.commands.get("bash-select").handler("gitbash", ctx);
      release.resolve(); await old;
      assert.equal(state.read().selection.backend, "gitbash");
      assert.match(text(notices), /取代/);
    } finally { release.resolve(); await old; }
  }, () => ({ discoverBackends: () => [pwsh!, {
    id: "gitbash", kind: "bash", label: "Native fixture", path: process.execPath,
    args: ["-e"], commandTransport: "argv",
  }], gateway: { enabled: false } }));
});

test("a superseded directory candidate immediately clears its stale progress without committing", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withSlash(async ({ command, widgets, fixture, notices }) => {
    const pending = command(`allow ro "${fixture.outside}"`);
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail("Candidate checker never entered"))]);
      await command("off");
      assert.equal(widgets.size, 0);
      release.resolve(); await pending;
      assert.match(text(notices), /取代/);
      assert.ok(!text(await command("paths")).includes(`[session] RO ${fixture.outside}`));
    } finally { release.resolve(); await pending; }
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async check() { entered.resolve(); await release.promise; },
  }) as any } }));
});

test("an executor rejection during cancellation preserves cleanup errors and is not exit evidence", windows, async () => {
  await withSlash(async ({ call, command, statuses }) => {
    const task = await call("bg_run", { command: "controlled cancellation failure", name: "cleanup-failure" });
    const id = task.details.taskId;
    try {
      const report = text(await command(`stop ${id}`));
      assert.match(report, /退出.*未确认|退出尚未确认/);
      assert.match(report, /ORIGINAL_CLEANUP_FAILURE.*effects may already exist/);
      assert.doesNotMatch(report, /退出已确认|退出确认: 已确认/);
      const logs = await call("bg_logs", { taskId: id });
      assert.match(logs.content[0].text, /ORIGINAL_CLEANUP_FAILURE/);
      const listed = text(await command("tasks"));
      assert.ok(listed.includes(id)); assert.match(listed, /ORIGINAL_CLEANUP_FAILURE/);
      assert.match(statuses.at(-1)!, /files: MXC/);
    } finally { await call("bg_kill", { taskId: id }); await call("bg_join", { taskId: id, timeoutSeconds: 5 }); }
  }, (fixture) => ({ gateway: { enabled: true, runtimeFactory: async () => controlRuntime(fixture, {
    createExecutor() { return { candidate: fixture.options.candidate, exec(_command: string, _cwd: string, options: any) {
      return new Promise<{ exitCode: number }>((_resolve, reject) => options.signal.addEventListener("abort", () => {
        reject(new Error("ORIGINAL_CLEANUP_FAILURE; effects may already exist; residual: fixture/job"));
      }, { once: true }));
    } }; },
  }) as any } }));
});
