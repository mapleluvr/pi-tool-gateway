import test from "node:test";
import assert from "node:assert/strict";
import { pwsh } from "./helpers/mxc-fixture.ts";
import { controlRuntime, deferred, withSlash } from "./helpers/slash-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const text = (notices: { text: string }[]) => notices.map((notice) => notice.text).join("\n");

// A successful command needs a receipt, but its live mode belongs in the footer.
test("on reports completion without duplicating the live mode or routine advice", windows, async () => {
  await withSlash(async ({ command, statuses }) => {
    const report = text(await command("on"));
    assert.match(report, /完成.*MXC on/);
    assert.equal(report, report.trimEnd(), "A result-only receipt must not allocate an empty body row");
    assert.ok(report.trim().split("\n").length <= 2, report);
    assert.doesNotMatch(report, /当前实际|请求:|下一步|不迁移|不删除|旧启动权限后台任务: 0/);
    assert.match(statuses.at(-1)!, /pwsh: MXC.*files: MXC/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("repeating off reports no change rather than leaving an unexplained silence", windows, async () => {
  await withSlash(async ({ command, statuses }) => {
    const report = text(await command("off"));
    assert.match(report, /未发生变更|无变更/);
    assert.match(report, /MXC off/);
    assert.ok(report.trim().split("\n").length <= 2, report);
    assert.doesNotMatch(report, /当前实际|下一步|不迁移|不删除/);
    assert.match(statuses.at(-1)!, /Native/);
  }, () => ({ gateway: { enabled: false } }));
});

// A retry must never become an implicit permission-mode enable.
test("retry while disabled explains how to enable without loading MXC", windows, async () => {
  let loads = 0;
  await withSlash(async ({ command, pi }) => {
    const report = text(await command("retry"));
    assert.match(report, /未发生变更|未开启/);
    assert.match(report, /\/mxc on/);
    assert.ok(report.trim().split("\n").length <= 2, report);
    assert.equal(loads, 0);
    assert.equal(pi.tools.has("write"), false);
  }, () => ({ gateway: { enabled: false, runtimeFactory: async () => { loads++; throw new Error("must remain unloaded"); } } }));
});

// Fallback notification and command receipt must agree, not double-report success.
test("a failed on emits one fallback receipt with the raw cause and retained preference", windows, async () => {
  await withSlash(async ({ command }) => {
    const report = await command("on");
    assert.equal(report.filter((notice) => notice.kind === "warning").length, 1);
    assert.match(text(report), /已回退/);
    assert.match(text(report), /runner missing fixture/);
    assert.match(text(await command("status")), /请求.*(?:开启|on)/i);
    assert.match(text(report), /Native.*(?:宿主|原生权限)|(?:宿主|原生权限).*Native/);
    assert.match(text(report), /\/mxc retry/);
    assert.doesNotMatch(text(report), /\[完成\].*MXC 已生效/);
  }, () => ({ gateway: { enabled: false, runtimeFactory: async () => { throw new Error("runner missing fixture"); } } }));
});

// Keeping only a footer change cannot tell a user whether their command is stuck.
test("a slow real gateway check publishes progress before completion and clears it afterwards", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withSlash(async ({ command, widgets, widgetHistory, statuses }) => {
    const pending = command("on");
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail("Checker never entered"))]);
      assert.ok(widgets.size > 0, "No visible operation progress while the check is pending");
      assert.match([...widgets.values()].flat().join("\n"), /开启|验证|检查/);
      assert.doesNotMatch(statuses.at(-1)!, /pwsh: MXC/);
    } finally { release.resolve(); }
    assert.match(text(await pending), /完成/);
    assert.equal(widgets.size, 0);
    assert.ok(widgetHistory.some((item) => item.lines === undefined));
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async check() { entered.resolve(); await release.promise; },
  }) as any } }));
});

test("a superseded on cannot restore progress or claim MXC after a later off", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withSlash(async ({ command, widgets, statuses, notices }) => {
    const pending = command("on");
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail("Checker never entered"))]);
      const off = text(await command("off"));
      assert.match(off, /完成.*MXC off/);
      assert.equal(widgets.size, 0);
      release.resolve(); await pending;
      assert.equal(widgets.size, 0);
      assert.match(statuses.at(-1)!, /Native/);
      assert.ok(notices.some((notice) => /取代|配置.*变化|changed/i.test(notice.text)));
      assert.doesNotMatch(notices.at(-1)!.text, /pwsh: MXC/);
    } finally { release.resolve(); await pending; }
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async check() { entered.resolve(); await release.promise; },
  }) as any } }));
});

// An invalid access token must not be guessed into a grant.
test("malformed allow identifies the invalid argument and its precise recovery syntax", windows, async () => {
  await withSlash(async ({ command }) => {
    const report = text(await command("allow rx D:\\Temp\\sample"));
    assert.match(report, /拒绝/);
    assert.match(report, /ro.*rw/);
    assert.match(report, /原配置|未提交|不变/);
    assert.match(report, /\/mxc allow/);
  }, () => ({ gateway: { enabled: false } }));
});

test("escaping the shell selector reports cancellation and preserves persisted selection", windows, async () => {
  await withSlash(async ({ pi, ctx, state, notices }) => {
    const before = state.read().selection;
    await pi.commands.get("bash-select").handler("", ctx);
    assert.deepEqual(state.read().selection, before);
    assert.match(text(notices), /已取消/);
    assert.ok(text(notices).trim().split("\n").length <= 2, text(notices));
  });
});

test("successful Shell selection reports the saved choice without routine diagnostics", windows, async () => {
  await withSlash(async ({ pi, ctx, state, notices }) => {
    await pi.commands.get("bash-select").handler("pwsh7", ctx);
    assert.equal(state.read().selection.backend, "pwsh7");
    const report = text(notices);
    assert.match(report, /完成/); assert.match(report, /pwsh7/);
    assert.ok(report.trim().split("\n").length <= 2, report);
    assert.doesNotMatch(report, /当前实际|下一步|已有任务|旧启动权限后台任务: 0/);
  }, () => ({ gateway: { enabled: false } }));
});

// The save is real; only the subsequent external read failure is controlled.
test("shell selection saved before refresh failure is never reported as unchanged", windows, async () => {
  let written = false;
  await withSlash(async ({ pi, ctx, state, notices }) => {
    await pi.commands.get("bash-select").handler("pwsh7", ctx);
    assert.equal(state.read().selection.backend, "pwsh7");
    assert.match(text(notices), /已保存/);
    assert.match(text(notices), /refresh read fixture/);
    assert.doesNotMatch(text(notices), /backend not changed/);
    assert.match(text(notices), /未知|未确认|刷新失败/);
  }, (_fixture, state) => ({ stateStore: {
    ...state,
    read: () => { if (written) throw new Error("refresh read fixture"); return state.read(); },
    write: (selection) => { state.write(selection); written = true; },
  } }));
});

test("shell save failure reports unchanged state and the actual storage cause", windows, async () => {
  await withSlash(async ({ pi, ctx, state, notices }) => {
    const before = state.read().selection;
    await pi.commands.get("bash-select").handler("pwsh7", ctx);
    assert.deepEqual(state.read().selection, before);
    assert.match(text(notices), /state locked fixture/);
    assert.match(text(notices), /未保存|不变/);
    assert.doesNotMatch(text(notices), /\[完成\]/);
  }, (_fixture, state) => ({ stateStore: { ...state, write: () => { throw new Error("state locked fixture"); } } }));
});

assert.ok(process.platform !== "win32" || pwsh, "Windows slash tests require the measured pwsh backend");
